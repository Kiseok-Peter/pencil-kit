#!/usr/bin/env python3
# 추출 데이터 무결성 검증 (Figma 임포트/SwiftUI 생성 전 프리플라이트)
# 사용법: python3 verify.py --data <데이터폴더> [--strict-typo] [--strict-tokens] [--strict-dims] [--strict-colors]
#   (--data 생략 시 CWD / env PENCIL_DATA)
# 검사: ref 해소 / 절단(...) / 아이콘 라이브러리 / 변수 참조 정의 여부 / 타이포 변수 타입
# 경고: 타이포 리터럴 커버리지(+분포) / 토큰 이름 버킷 — --strict-* 로 하드 실패 승격
# 종료코드: 0=이상 없음, 1=문제 있음

import json
import os
import re
import sys

def _pop_flag(argv, flag):
    if flag in argv:
        return True, [a for a in argv if a != flag]
    return False, argv

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

STRICT_TYPO, ARGV = _pop_flag(sys.argv[1:], "--strict-typo")
STRICT_TOKENS, ARGV = _pop_flag(ARGV, "--strict-tokens")
STRICT_DIMS, ARGV = _pop_flag(ARGV, "--strict-dims")
STRICT_COLORS, ARGV = _pop_flag(ARGV, "--strict-colors")
DATA, _ = _pop_data(ARGV)
DATA = os.path.abspath(DATA)
SUPPORTED_ICON_LIBS = {"lucide", "feather", "phosphor",
                       "Material Symbols Outlined", "Material Symbols Rounded", "Material Symbols Sharp"}

# 타이포 변수 타입 규약: string 이어야 하는 키 / number 여야 하는 키
# (Pencil 이 타입을 강제하고, Figma 플러그인 resolveStr/resolveNum 도 각각 VAR_STR/VAR_NUM 만 본다)
TYPO_STR_KEYS = ("fontFamily", "fontWeight")
TYPO_NUM_KEYS = ("fontSize", "lineHeight", "letterSpacing")

# 프리셋(typography-styles.json) 매칭 축. 이 5개가 프리셋의 신원이며 조합은 유일해야 한다
# (make-typography-styles.py 가 중복을 거부한다). 행간은 프리셋을 가르는 축이다 —
# 실측상 행간은 멀티라인 노드에만 붙어서, 같은 크기·굵기라도 `-multiline` 변형과 구분해야 한다.
TYPO_AXES = ("fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight")

# 토큰 이름 버킷: iOS Scripts/gen-design-tokens.py 가 name.partition("-") 의 첫 조각으로 분류하고
# 미등록 버킷은 ValueError. 예: font-size-body ❌ / fontsize-app-title ✅
# (color 토큰은 자유 — 이 규칙은 number/string 토큰에만 적용)
TOKEN_BUCKETS = {"radius", "spacing", "fontsize", "fontweight", "lineheight", "tracking", "font", "border",
                 "iconsize", "controlheight"}

# 치수(레이아웃) 토큰화 커버리지 — 타이포와 같은 범위(카탈로그 제외)에서 리터럴을 센다.
# 화이트리스트: 0 만 (토큰 불필요 — "없음"의 표현). padding 21 은 spacing-20 으로 통일해 뺐다.
DIM_WHITELIST_PAD = {0}

# 아이콘 크기 규격 — ⚠️ width/height 는 **변수 바인딩을 못 받는다**(실측: Pencil 이 조용히 무시).
# 그래서 노드에는 숫자가 그대로 남고, `iconsize-*` 토큰은 "허용된 값 목록" 역할만 한다.
# 소비 측(iOS DSIconSize 등)은 이 토큰으로 스케일을 생성하고, 여기서는 그 밖의 크기가
# 새로 생기는 것을 막는다. 정사각만 검사한다 — 배터리 아이콘처럼 비정사각인 것도 있다.
ICONSIZE_PREFIX = "iconsize-"

# 색 토큰화 커버리지에서 예외로 두는 리터럴 — 완전 투명은 "색"이 아니라 "없음"의 표현이라 토큰이 없다.
COLOR_WHITELIST = {"#00000000"}

# 변수 참조 판별: $ 뒤 소문자 시작 kebab (텍스트 내용의 "$5" 같은 값 오인 방지)
_VAR_RE = re.compile(r"^\$[a-z][a-z0-9-]*$")

def _num(v):
    """숫자 리터럴인가 (bool 은 int 의 하위형이라 명시적으로 제외)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)

# 타이포 커버리지 집계에서 제외할 최상위 프레임 접두 — 디자인시스템 카탈로그(쇼케이스)는
# 코드 생성 대상이 아니고 문서 전용 크기(9px 아이콘 라벨 등)를 써서 스케일을 오염시킨다.
# 재사용 컴포넌트는 카탈로그 안에 물리적으로 들어있지만 최상위에 reusable 로도 등재되므로,
# 카탈로그를 건너뛰어도 정확히 1회 계상된다(= 중복 계상 해소).
# 판정은 `.pen` 이 직접 단 표식(`context`)을 먼저 본다 — 이름 접두는 표식이 없을 때의 폴백이다
# (화면 이름을 바꾸면 조용히 깨지는 짐작이므로. 피드백 5 §5 · extract-for-swiftui.py 와 같은 규약).
CATALOG_CONTEXT = "design-system-catalog"
DOC_PREFIX = "DS - "

def is_catalog(node):
    ctx = node.get("context")
    if isinstance(ctx, str) and ctx:
        return ctx == CATALOG_CONTEXT
    return str(node.get("name") or "").startswith(DOC_PREFIX)

def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)

def walk(n, fn):
    if isinstance(n, dict):
        fn(n)
        for c in n.get("children", []) or []:
            walk(c, fn)
        for ov in (n.get("descendants") or {}).values():
            if isinstance(ov, dict):
                walk(ov, fn)
    elif isinstance(n, list):
        for x in n:
            walk(x, fn)

def collect_var_refs(v, out):
    if isinstance(v, str):
        if _VAR_RE.match(v):
            out.add(v[1:])
    elif isinstance(v, dict):
        for x in v.values():
            collect_var_refs(x, out)
    elif isinstance(v, list):
        for x in v:
            collect_var_refs(x, out)

def main():
    nodes = load("pen-nodes.json")
    try:
        variables = load("variables.json").get("variables", {})
    except FileNotFoundError:
        variables = {}
    var_types = {k: (d.get("type") if isinstance(d, dict) else "color") for k, d in variables.items()}
    try:
        typo_styles = load("typography-styles.json").get("styles", {})
    except FileNotFoundError:
        typo_styles = {}          # 미생성 프로젝트 — 프리셋 검사만 건너뛴다
    # 5축 조합 -> 프리셋 이름. 노드는 "$토큰", 프리셋은 "토큰" 이라 노드 쪽에서 $ 를 떼고 맞춘다.
    preset_by_axes = {tuple(s.get(a) for a in TYPO_AXES): name for name, s in typo_styles.items()}

    comp_ids = {n["id"] for n in nodes if isinstance(n, dict) and n.get("reusable")}
    comps = sum(1 for n in nodes if isinstance(n, dict) and n.get("reusable"))
    screens = sum(1 for n in nodes if isinstance(n, dict) and not n.get("reusable"))

    orphan_refs, bad_icons, var_refs = set(), {}, set()
    node_icons, override_icons = set(), set()   # 아이콘 수집 커버리지 (build.py 와 같은 기준)
    icon_sizes, icon_off, icon_nonsquare = {}, {}, {}   # 아이콘 크기 규격 검사
    iconsize_vals = {v.get("value") for k, v in variables.items()
                     if k.startswith(ICONSIZE_PREFIX) and isinstance(v, dict) and _num(v.get("value"))}
    typo_type_bad = []                      # (변수명, 실제타입, 기대타입)
    typo_lit = {k: 0 for k in TYPO_STR_KEYS + TYPO_NUM_KEYS}   # 리터럴 개수
    typo_set = {k: 0 for k in TYPO_STR_KEYS + TYPO_NUM_KEYS}   # 값이 있는 개수
    fam_dist, size_dist, weight_dist = {}, {}, {}
    override_typo = [0]                     # descendants 오버라이드의 타이포 (인스턴스별 예외 — 개수만 보고)
    text_total = [0]
    seen_type_bad = set()

    def tally_typo(n, is_override):
        for key, want in [(k, "string") for k in TYPO_STR_KEYS] + [(k, "number") for k in TYPO_NUM_KEYS]:
            v = n.get(key)
            if v is None:
                continue
            if is_override and key in ("fontFamily", "fontWeight", "fontSize"):
                override_typo[0] += 1
            typo_set[key] += 1
            if isinstance(v, str) and _VAR_RE.match(v):
                name = v[1:]
                got = var_types.get(name)
                if got is not None and got != want and (name, key) not in seen_type_bad:
                    seen_type_bad.add((name, key))
                    typo_type_bad.append((name, got, want))
            else:
                typo_lit[key] += 1
                if key == "fontFamily":
                    fam_dist[v] = fam_dist.get(v, 0) + 1
                elif key == "fontSize":
                    size_dist[v] = size_dist.get(v, 0) + 1
                elif key == "fontWeight":
                    weight_dist[str(v)] = weight_dist.get(str(v), 0) + 1

    def typo_scope(n):
        """타이포 커버리지 대상 최상위 노드인가 (컴포넌트 + 제품 화면, 카탈로그 제외)"""
        return bool(n.get("reusable")) or not is_catalog(n)

    # 무결성 검사 — 카탈로그 포함 전체 범위
    def check(n):
        if n.get("type") == "ref":
            r = n.get("ref")
            if r and r not in comp_ids:
                orphan_refs.add(r)
        if n.get("type") == "icon":
            lib = n.get("library") or "lucide"
            if isinstance(lib, str) and lib not in SUPPORTED_ICON_LIBS:
                bad_icons[lib] = bad_icons.get(lib, 0) + 1
            if n.get("icon"):
                node_icons.add(n["icon"])
            w, h = n.get("width"), n.get("height")
            if _num(w) and w == h:
                (icon_sizes if w in iconsize_vals else icon_off)[w] = \
                    (icon_sizes if w in iconsize_vals else icon_off).get(w, 0) + 1
            elif _num(w) and _num(h):
                icon_nonsquare[(w, h)] = icon_nonsquare.get((w, h), 0) + 1
        elif "type" not in n and n.get("icon"):
            # descendants 오버라이드의 아이콘 교체 — icon 노드가 한 번도 안 쓴 아이콘이면
            # build.py 가 SVG 를 수집하는지가 중요하다 (예전엔 놓쳐서 15종이 다운로드되지 않았다)
            override_icons.add(n["icon"])
        for k, v in n.items():
            if k not in ("children", "descendants", "content"):
                collect_var_refs(v, var_refs)
    walk(nodes, check)

    # 타이포 + 치수 집계 — 대상 범위만 (컴포넌트 + 제품 화면)
    dim_lit = {"gap": 0, "padding": 0, "cornerRadius": 0, "strokeWidth": 0}
    dim_dist = {k: {} for k in dim_lit}
    def tally_dims(n):
        def hit(key, v, white=()):
            if _num(v) and v not in white:
                dim_lit[key] += 1
                dim_dist[key][v] = dim_dist[key].get(v, 0) + 1
        hit("gap", n.get("gap"), (0,))
        p = n.get("padding")
        if isinstance(p, list):
            for x in p:
                hit("padding", x, DIM_WHITELIST_PAD)
        else:
            hit("padding", p, DIM_WHITELIST_PAD)
        cr = n.get("cornerRadius")
        if isinstance(cr, list):
            for x in cr:
                hit("cornerRadius", x, (0,))
        else:
            hit("cornerRadius", cr, (0,))
        sw = n.get("strokeWidth")
        if isinstance(sw, dict):
            for x in sw.values():
                hit("strokeWidth", x, (0,))
        else:
            hit("strokeWidth", sw, (0,))
    color_lit = {}
    def tally_colors(n):
        """fill/stroke/effect.color 의 생 hex 를 센다 (문자열·배열·{color}·그라데이션 stop 전부)"""
        def hit(v):
            if isinstance(v, str) and v.startswith("#"):
                u = v.upper()
                if u not in COLOR_WHITELIST:
                    color_lit[u] = color_lit.get(u, 0) + 1
            elif isinstance(v, list):
                for x in v:
                    hit(x)
            elif isinstance(v, dict):
                hit(v.get("color"))
                for st in v.get("colors") or []:
                    if isinstance(st, dict):
                        hit(st.get("color"))
        hit(n.get("fill"))
        hit(n.get("stroke"))
        eff = n.get("effect")
        for e in (eff if isinstance(eff, list) else [eff] if eff else []):
            if isinstance(e, dict):
                hit(e.get("color"))

    # 프리셋 커버리지 — 오버라이드는 부분정보(굵기만 등)라 5축 신원을 만들 수 없어 제외한다
    preset_hit, preset_off = {}, {}
    cur_top = [""]
    def tally_preset(n):
        if not preset_by_axes:
            return
        key = tuple(v[1:] if isinstance(v, str) and v.startswith("$") else v
                    for v in (n.get(a) for a in TYPO_AXES))
        name = preset_by_axes.get(key)
        if name:
            preset_hit[name] = preset_hit.get(name, 0) + 1
        else:
            label = " / ".join(str(x) for x in key if x is not None)
            e = preset_off.setdefault(label, [0, []])
            e[0] += 1
            if len(e[1]) < 3:
                e[1].append(f"{cur_top[0]} > {n.get('name') or n.get('id')}")

    def typo_check(n):
        if n.get("type") == "text":
            text_total[0] += 1
            tally_typo(n, is_override=False)
            tally_preset(n)
        elif "type" not in n and any(k in n for k in TYPO_STR_KEYS + TYPO_NUM_KEYS):
            tally_typo(n, is_override=True)   # descendants 오버라이드 객체 (type 없음 = 속성 오버라이드)
        tally_dims(n)                          # 치수는 노드 종류 무관 (frame·rect·오버라이드 전부)
        tally_colors(n)
    scope_n = 0
    for n in nodes:
        if isinstance(n, dict) and typo_scope(n):
            scope_n += 1
            cur_top[0] = str(n.get("name") or n.get("id"))
            walk(n, typo_check)

    trunc = json.dumps(nodes, ensure_ascii=False).count('"..."')
    undefined_vars = sorted(v for v in var_refs if v not in variables)
    bad_buckets = sorted({v for v in var_refs
                          if v in variables and var_types.get(v) != "color"
                          and v.partition("-")[0] not in TOKEN_BUCKETS})

    print(f"검증 대상: 컴포넌트 {comps} · 화면 {screens} · 변수 {len(variables)} (@ {DATA})")
    print(f"  타이포 집계 범위: 최상위 {scope_n}개(카탈로그 context='{CATALOG_CONTEXT}' 제외) · "
          f"텍스트 {text_total[0]}개")
    issues = 0
    warns = 0
    def line(ok, msg):
        nonlocal issues
        print(("  ✅ " if ok else "  ❌ ") + msg)
        if not ok: issues += 1
    def warn(ok, msg, strict=False):
        nonlocal warns
        if ok:
            return
        if strict:
            line(False, msg)
        else:
            warns += 1
            print("  ⚠️ " + msg)

    line(not orphan_refs, f"ref 해소: 끊긴 참조 {len(orphan_refs)}개" + (f" {sorted(orphan_refs)}" if orphan_refs else ""))
    line(trunc == 0, f"절단 마커(...): {trunc}개" + (" — depth 부족, 해당 id 만 재추출 필요" if trunc else ""))
    line(not bad_icons, f"미지원 아이콘 라이브러리: {bad_icons}" if bad_icons else "아이콘 라이브러리: 전부 지원됨")
    # 아이콘 크기 규격 — iconsize-* 토큰 값 밖의 정사각 크기를 잡는다.
    # 바인딩이 불가능해 숫자가 그대로 남으므로, 이 검사가 유일한 방어선이다.
    if iconsize_vals:
        n_ok, n_off = sum(icon_sizes.values()), sum(icon_off.values())
        warn(not icon_off,
             f"iconsize 규격 밖 아이콘 {n_off}곳: "
             + " ".join(f"{k:g}px×{v}" for k, v in sorted(icon_off.items()))
             + f" — 허용 {sorted(int(v) for v in iconsize_vals)}",
             strict=STRICT_DIMS)
        if not icon_off:
            extra = (f" · 비정사각 {sum(icon_nonsquare.values())}곳 "
                     + " ".join(f"{int(a)}x{int(b)}" for a, b in sorted(icon_nonsquare))) if icon_nonsquare else ""
            line(True, f"아이콘 크기: 정사각 {n_ok}곳 전부 iconsize-* 규격{extra}")
    ov_only = sorted(override_icons - node_icons)
    line(True, f"아이콘: icon 노드 {len(node_icons)}종 + 오버라이드 전용 {len(ov_only)}종 = 수집 대상 {len(node_icons | override_icons)}종"
         + (f" (오버라이드 전용: {' '.join(ov_only)})" if ov_only else ""))
    # 카탈로그 제목 1:1 — 소비 측(iOS 카탈로그)이 이 제목을 캡션으로 그대로 복사해 눈으로 대조한다.
    # 제목이 **없으면** 눈에 띄지만 **틀린 이름이 붙어 있으면** 맞는 줄 알고 지나간다(실측 8곳).
    # 한 프레임 안의 (제목 텍스트, 바로 뒤 컴포넌트) 쌍이 문자열까지 같은지 본다.
    #
    # ⚠️ 라이트 프레임의 항목은 `reusable` 마스터 그 자체이고, 다크는 그 마스터를 가리키는 `ref` 다.
    #    `ref` 만 세면 라이트가 0 으로 나온다 — 소비 측이 실제로 그렇게 세어 "라이트가 비었다"고 오해했다.
    comp_name = {n["id"]: n.get("name") for n in nodes
                 if isinstance(n, dict) and n.get("reusable")}
    cat_pairs = cat_bad = 0
    for s in nodes:
        if not is_catalog(s):
            continue
        kids = s.get("children") or []
        for i, k in enumerate(kids):
            cid = k["id"] if k.get("reusable") else (k.get("ref") if k.get("type") == "ref" else None)
            if cid not in comp_name:
                continue
            cat_pairs += 1
            prev = kids[i - 1] if i > 0 else None
            if not (prev and prev.get("type") == "text" and prev.get("content") == comp_name[cid]):
                cat_bad += 1
                warn(False, f"카탈로그 제목 불일치: {s.get('name')} 의 '{comp_name[cid]}' "
                            f"제목={prev.get('content')!r}" if prev and prev.get("type") == "text"
                            else f"카탈로그 제목 없음: {s.get('name')} 의 '{comp_name[cid]}'")
    if cat_pairs and not cat_bad:
        line(True, f"카탈로그 제목: {cat_pairs}곳 전부 컴포넌트 이름과 일치 "
                   f"(라이트=마스터 · 다크=ref, 둘 다 셈)")

    line(not undefined_vars, f"정의 안 된 변수 참조: {undefined_vars}" if undefined_vars else "변수 참조: 전부 정의됨")
    line(not typo_type_bad,
         "타이포 변수 타입: fontFamily/fontWeight=string · fontSize/lineHeight/letterSpacing=number 일치"
         if not typo_type_bad else
         "타이포 변수 타입 불일치 " + str(len(typo_type_bad)) + "건: "
         + " · ".join(f"{n}({g}, {w} 이어야)" for n, g, w in typo_type_bad))

    # 타이포 리터럴 커버리지 — fontFamily/fontWeight/fontSize 는 사실상 전 텍스트가 갖는 속성이라 전체 대비,
    # lineHeight/letterSpacing 은 미설정이 정상이라 "설정된 것 중" 리터럴만 본다. (--strict-typo = Phase 2 완료 게이트)
    def pct(k):
        s = typo_set[k]
        return f"{k} {typo_lit[k]}/{s} 리터럴" + (f"(토큰 {100 * (s - typo_lit[k]) / s:.0f}%)" if s else "(없음)")
    cover_ok = all(typo_lit[k] == 0 for k in ("fontFamily", "fontWeight", "fontSize"))
    warn(cover_ok, "타이포 토큰화 미완: " + " · ".join(pct(k) for k in ("fontFamily", "fontWeight", "fontSize"))
         + " · " + " · ".join(f"{k} 설정 {typo_set[k]}중 리터럴 {typo_lit[k]}" for k in ("lineHeight", "letterSpacing")),
         strict=STRICT_TYPO)
    if not cover_ok:
        if fam_dist:
            print("     리터럴 패밀리: " + " ".join(f"{k}:{v}" for k, v in sorted(fam_dist.items(), key=lambda x: -x[1])))
        if size_dist:
            print("     리터럴 fontSize 분포: " + " ".join(f"{k}:{v}" for k, v in sorted(size_dist.items(), key=lambda x: -x[1])) + f" ({len(size_dist)}종)")
        if weight_dist:
            print("     리터럴 fontWeight 분포: " + " ".join(f"{k}:{v}" for k, v in sorted(weight_dist.items(), key=lambda x: -x[1])))
    # 프리셋 커버리지 — 낱개 토큰이 다 붙어도 "프리셋 밖 조합"이면 소비 측(Figma Text Style / iOS enum)이
    # 프리셋으로 못 바꾼다. 이탈이 보이면 디자인을 프리셋으로 수렴시키거나 그 조합을 프리셋으로 승격한다.
    if not typo_styles:
        warn(False, "타이포 프리셋 미생성 — typography-styles.json 없음 "
                    "(python3 make-typography-styles.py --data <DATA>)")
    else:
        off_n = sum(v[0] for v in preset_off.values())
        hit_n = sum(preset_hit.values())
        if off_n == 0:
            line(True, f"프리셋 커버리지: 텍스트 {hit_n}곳 전부 {len(typo_styles)}개 프리셋에 매칭")
        else:
            warn(False, f"프리셋 밖 조합 {off_n}곳 / 텍스트 {hit_n + off_n} ({len(preset_off)}종)"
                        " — 디자인을 프리셋으로 수렴시키거나 그 조합을 프리셋으로 승격",
                 strict=STRICT_TYPO)
            for label, (cnt, samples) in sorted(preset_off.items(), key=lambda x: -x[1][0]):
                print(f"     ×{cnt} {label}")
                for s in samples:
                    print(f"        {s}")
        unused = sorted(set(typo_styles) - set(preset_hit))
        warn(not unused, f"미사용 프리셋 {len(unused)}개: {' '.join(unused)} — 쓰이지 않는 프리셋은 지우거나 적용처를 확인")

    # 인스턴스별 정당한 예외일 수 있으므로 --strict-typo 게이트에 넣지 않는다.
    # Figma 플러그인은 이제 이걸 적용한다(리터럴+바인딩). 단 오버라이드는 부분정보라
    # (원래 패밀리 × 새 굵기) 조합이 프리로드돼 있어야 폰트가 바뀐다 — 안 되면 플러그인이 현행 유지 + 집계.
    warn(override_typo[0] == 0,
         f"인스턴스 오버라이드 타이포 {override_typo[0]}곳 — 플러그인이 적용하지만 폰트 조합 프리로드에 의존")
    warn(not bad_buckets,
         f"토큰 버킷 규약 밖 이름 {len(bad_buckets)}개: {bad_buckets} — iOS gen-design-tokens.py 가 첫 하이픈 앞({sorted(TOKEN_BUCKETS)})만 인식",
         strict=STRICT_TOKENS)
    # 치수 토큰화 커버리지 (--strict-dims = 치수 Phase 완료 게이트. 0 과 padding 21 은 화이트리스트)
    dims_ok = all(v == 0 for v in dim_lit.values())
    warn(dims_ok, "치수 토큰화 미완: " + " · ".join(f"{k} 리터럴 {v}" for k, v in dim_lit.items()),
         strict=STRICT_DIMS)
    if dims_ok:
        print("     (치수 리터럴 0 — gap·padding·cornerRadius·strokeWidth 전부 토큰)")
    else:
        for k, d in dim_dist.items():
            if d:
                print(f"     {k} 분포: " + " ".join(f"{v}:{c}" for v, c in sorted(d.items(), key=lambda x: -x[1])[:12]))
    # 색 토큰화 커버리지 (--strict-colors = 색 Phase 완료 게이트)
    n_color = sum(color_lit.values())
    warn(n_color == 0, f"색 토큰화 미완: fill/stroke/effect 생 hex {n_color}곳 ({len(color_lit)}종)",
         strict=STRICT_COLORS)
    if n_color:
        print("     분포: " + " ".join(f"{k}:{v}" for k, v in sorted(color_lit.items(), key=lambda x: -x[1])[:12]))
    else:
        print(f"     (색 리터럴 0 — 화이트리스트 {sorted(COLOR_WHITELIST)} 제외)")

    tail = f" (경고 {warns}건)" if warns else ""
    print("결과: " + (("✅ 이상 없음 — 변환 진행 가능" + tail) if issues == 0 else f"❌ 문제 {issues}종 — 위 항목 확인{tail}"))
    sys.exit(1 if issues else 0)

if __name__ == "__main__":
    main()
