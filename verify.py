#!/usr/bin/env python3
# 추출 데이터 무결성 검증 (Figma 임포트/SwiftUI 생성 전 프리플라이트)
# 사용법: python3 verify.py --data <데이터폴더> [--strict-typo] [--strict-tokens]
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
DATA, _ = _pop_data(ARGV)
DATA = os.path.abspath(DATA)
SUPPORTED_ICON_LIBS = {"lucide", "feather", "phosphor",
                       "Material Symbols Outlined", "Material Symbols Rounded", "Material Symbols Sharp"}

# 타이포 변수 타입 규약: string 이어야 하는 키 / number 여야 하는 키
# (Pencil 이 타입을 강제하고, Figma 플러그인 resolveStr/resolveNum 도 각각 VAR_STR/VAR_NUM 만 본다)
TYPO_STR_KEYS = ("fontFamily", "fontWeight")
TYPO_NUM_KEYS = ("fontSize", "lineHeight", "letterSpacing")

# 토큰 이름 버킷: iOS Scripts/gen-design-tokens.py 가 name.partition("-") 의 첫 조각으로 분류하고
# 미등록 버킷은 ValueError. 예: font-size-body ❌ / fontsize-app-title ✅
# (color 토큰은 자유 — 이 규칙은 number/string 토큰에만 적용)
TOKEN_BUCKETS = {"radius", "spacing", "fontsize", "fontweight", "lineheight", "tracking", "font"}

# 변수 참조 판별: $ 뒤 소문자 시작 kebab (텍스트 내용의 "$5" 같은 값 오인 방지)
_VAR_RE = re.compile(r"^\$[a-z][a-z0-9-]*$")

# 타이포 커버리지 집계에서 제외할 최상위 프레임 접두 — 디자인시스템 카탈로그(쇼케이스)는
# 코드 생성 대상이 아니고 문서 전용 크기(9px 아이콘 라벨 등)를 써서 스케일을 오염시킨다.
# 재사용 컴포넌트는 카탈로그 안에 물리적으로 들어있지만 최상위에 reusable 로도 등재되므로,
# 카탈로그를 건너뛰어도 정확히 1회 계상된다(= 중복 계상 해소).
DOC_PREFIX = "DS - "

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

    comp_ids = {n["id"] for n in nodes if isinstance(n, dict) and n.get("reusable")}
    comps = sum(1 for n in nodes if isinstance(n, dict) and n.get("reusable"))
    screens = sum(1 for n in nodes if isinstance(n, dict) and not n.get("reusable"))

    orphan_refs, bad_icons, var_refs = set(), {}, set()
    typo_type_bad = []                      # (변수명, 실제타입, 기대타입)
    typo_lit = {k: 0 for k in TYPO_STR_KEYS + TYPO_NUM_KEYS}   # 리터럴 개수
    typo_set = {k: 0 for k in TYPO_STR_KEYS + TYPO_NUM_KEYS}   # 값이 있는 개수
    fam_dist, size_dist, weight_dist = {}, {}, {}
    override_typo = [0]                     # descendants 오버라이드의 타이포 — Figma 플러그인 미적용
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
        return bool(n.get("reusable")) or not str(n.get("name") or "").startswith(DOC_PREFIX)

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
        for k, v in n.items():
            if k not in ("children", "descendants", "content"):
                collect_var_refs(v, var_refs)
    walk(nodes, check)

    # 타이포 집계 — 대상 범위만 (컴포넌트 + 제품 화면)
    def typo_check(n):
        if n.get("type") == "text":
            text_total[0] += 1
            tally_typo(n, is_override=False)
        elif "type" not in n and any(k in n for k in TYPO_STR_KEYS + TYPO_NUM_KEYS):
            tally_typo(n, is_override=True)   # descendants 오버라이드 객체 (type 없음 = 속성 오버라이드)
    scope_n = 0
    for n in nodes:
        if isinstance(n, dict) and typo_scope(n):
            scope_n += 1
            walk(n, typo_check)

    trunc = json.dumps(nodes, ensure_ascii=False).count('"..."')
    undefined_vars = sorted(v for v in var_refs if v not in variables)
    bad_buckets = sorted({v for v in var_refs
                          if v in variables and var_types.get(v) != "color"
                          and v.partition("-")[0] not in TOKEN_BUCKETS})

    print(f"검증 대상: 컴포넌트 {comps} · 화면 {screens} · 변수 {len(variables)} (@ {DATA})")
    print(f"  타이포 집계 범위: 최상위 {scope_n}개(카탈로그 '{DOC_PREFIX}*' 제외) · 텍스트 {text_total[0]}개")
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
    # 이것은 토큰화 여부가 아니라 Figma 플러그인의 한계(applyOverride 가 타이포를 적용하지 않음)라
    # --strict-typo 게이트에 포함하지 않는다. 인스턴스별 정당한 예외가 있을 수 있다.
    warn(override_typo[0] == 0,
         f"인스턴스 오버라이드 타이포 {override_typo[0]}곳 — Figma 플러그인 미적용(값은 토큰이어도 무시됨)")
    warn(not bad_buckets,
         f"토큰 버킷 규약 밖 이름 {len(bad_buckets)}개: {bad_buckets} — iOS gen-design-tokens.py 가 첫 하이픈 앞({sorted(TOKEN_BUCKETS)})만 인식",
         strict=STRICT_TOKENS)

    tail = f" (경고 {warns}건)" if warns else ""
    print("결과: " + (("✅ 이상 없음 — 변환 진행 가능" + tail) if issues == 0 else f"❌ 문제 {issues}종 — 위 항목 확인{tail}"))
    sys.exit(1 if issues else 0)

if __name__ == "__main__":
    main()
