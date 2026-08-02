#!/usr/bin/env python3
# DS - Typography 프레임에서 타이포 프리셋을 뽑아 typography-styles.json 으로 배출한다.
# 사용법: python3 make-typography-styles.py --data <데이터폴더> [--check]
#         (--data 생략 시 CWD / env PENCIL_DATA. --check = "전부 맞춰져 있나" 확인 모드 —
#          재생성 결과가 기존 파일과 같은지 + 아래 자기점검 2종의 경고까지 전부 실패로 본다)
# 입력:  <데이터폴더>/pen-nodes.json, variables.json, (선택) typography-aliases.json
# 출력:  <데이터폴더>/typography-styles.json
#
# ── 왜 필요한가 ────────────────────────────────────────────────────────────────
# Pencil 의 변수 타입은 boolean/color/number/string 4종뿐이라 "프리셋"(크기·굵기·행간·자간 세트)을
# 변수로 등록할 수 없다. Figma 도 마찬가지고(변수 4종), 프리셋은 Text Style 이라는 별개 개념이다.
# 그래서 프리셋의 단일 진실을 `DS - Typography` 프레임에 두고, 이 스크립트가 기계가독 형태로 옮긴다.
# Figma(Text Style)·iOS(생성 enum)·Android 가 모두 이 파일 하나를 소비한다.
#
# ── 프레임 규약 (이걸 어기면 에러) ─────────────────────────────────────────────
#   DS - Typography
#     └ <섹션>Sec          headingSec / bodySec / captionSec / systemSec  → group
#         ├ [0] 섹션 제목 텍스트                                          (건너뜀)
#         └ 프리셋 행(frame)  frame.name = **프리셋 이름**
#             ├ [0] 견본 텍스트  ← 축(fontFamily/fontSize/fontWeight/letterSpacing/lineHeight)을 여기서 읽는다
#             └ [1] 설명 텍스트  (사람이 읽는 글. 배출에는 안 쓰지만 실제 값과 맞는지 검사한다 — 자기점검 2)
#   weightSec 는 "굵기는 크기와 독립"임을 보여주는 축 견본이라 프리셋이 아니다 → 제외.
#
# 값은 반드시 `$토큰` 참조여야 한다(수치 인라인 금지) — 변수 갱신이 프리셋에 자동 반영되도록.
# 미지정 축은 키를 생략한다(null 아님) — 소비 측이 "미지정 = 플랫폼 기본"으로 처리한다.
#
# ── 자기점검 2종 (경고. --check 에서만 실패) ───────────────────────────────────
# 둘 다 "프로그램은 멀쩡히 돌아가고 사람만 속는" 종류라 따로 잡아주지 않으면 조용히 어긋난다.
#  1. 라이트판·다크판 대조 — 배출은 라이트만 읽으므로, 라이트에만 행을 넣어도 프로그램은 정상 동작하고
#     다크 프레임만 낡는다. 두 프레임의 행 목록·값이 같은지 본다.
#  2. 설명글·실제값 대조 — 견본만 고치고 설명글을 안 고치면 카탈로그가 틀린 말을 하게 된다.

import json
import os
import re
import sys

SECTION_GROUP = {"headingSec": "heading", "bodySec": "body",
                 "captionSec": "caption", "systemSec": "system"}
FRAME_NAME = "DS - Typography"                 # 라이트판이 정본 (다크판은 색만 다르고 타이포는 동일)
DARK_FRAME_NAME = FRAME_NAME + " (Dark)"       # 있으면 대조, 없으면 건너뜀
# 축 이름 -> variables.json 이 가져야 할 타입 (verify.py TYPO_STR_KEYS/TYPO_NUM_KEYS 와 같은 계약)
AXES = {"fontFamily": "string", "fontSize": "number", "fontWeight": "string",
        "letterSpacing": "number", "lineHeight": "number"}
REQUIRED = ("fontFamily", "fontSize", "fontWeight")

# 설명글에서 토큰 이름을 찾는 패턴. fontsize/fontweight 를 font 보다 먼저 둬야
# "fontsize-body" 가 "font"+"size-body" 로 잘리지 않는다.
CAPTION_TOKEN_RE = re.compile(r"\b(?:fontsize|fontweight|lineheight|tracking|font)-[a-z0-9-]+")
# 설명글에서 글꼴 종류(fontFamily)는 관례상 생략된다 — font-body/font-heading 은 안 적고
# font-system 만 적는다(26행 실측). 그래서 "빠졌다" 검사에서만 제외하고, 적혀 있으면 값은 검사한다.
CAPTION_OPTIONAL_AXES = ("fontFamily",)
# 설명글의 −(U+2212 빼기표)·–(en dash) 는 눈으로는 마이너스지만 코드로는 다른 글자다
MINUS_CHARS = {"−": "-", "–": "-", "—": "-"}


def _pop_flag(argv, flag):
    if flag in argv:
        return True, [a for a in argv if a != flag]
    return False, argv


def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv


CHECK, ARGV = _pop_flag(sys.argv[1:], "--check")
DATA, ARGV = _pop_data(ARGV)
DATA = os.path.abspath(DATA)
OUT = os.path.join(DATA, "typography-styles.json")


def load(name, required=True):
    path = os.path.join(DATA, name)
    if not os.path.exists(path):
        if required:
            sys.exit(f"❌ 없음: {path}")
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def find_frame(nodes, name, required=True):
    frames = [n for n in nodes if n.get("name") == name]
    if len(frames) > 1:
        sys.exit(f"❌ '{name}' 최상위 프레임이 {len(frames)}개 (1개여야 함)")
    if not frames:
        if required:
            sys.exit(f"❌ '{name}' 최상위 프레임 없음")
        return None
    return frames[0]


def collect_styles(frame, var_defs, errors, label=""):
    """프레임 하나에서 프리셋을 읽는다. 라이트·다크가 **같은 코드**를 타야 두 판이 갈라지지 않는다.
    반환: (프리셋 dict, 프리셋이름 -> 설명글)"""
    styles, captions = {}, {}
    pre = f"{label} " if label else ""
    for section in frame.get("children") or []:
        group = SECTION_GROUP.get(section.get("name"))
        if not group:
            continue                                     # weightSec 등 프리셋 아닌 섹션
        for row in section.get("children") or []:
            if row.get("type") != "frame":
                continue                                 # 섹션 제목 텍스트
            name = row.get("name")
            kids = row.get("children") or []
            if not name:
                errors.append(f"{pre}{group}: 이름 없는 프리셋 행 {row.get('id')}"); continue
            if name in styles:
                errors.append(f"{pre}프리셋 이름 중복: {name}"); continue
            if not kids or kids[0].get("type") != "text":
                errors.append(f"{pre}{name}: 첫 자식이 견본 텍스트가 아님"); continue

            spec = kids[0]
            style = {"group": group}
            for axis, want in AXES.items():
                raw = spec.get(axis)
                if raw is None:
                    if axis in REQUIRED:
                        errors.append(f"{pre}{name}: 필수 축 {axis} 없음")
                    continue
                if not (isinstance(raw, str) and raw.startswith("$")):
                    errors.append(f"{pre}{name}.{axis}: 리터럴 {raw!r} — $토큰 참조여야 한다")
                    continue
                token = raw[1:]
                got = (var_defs.get(token) or {}).get("type")
                if got is None:
                    errors.append(f"{pre}{name}.{axis}: 정의 안 된 토큰 ${token}")
                elif got != want:
                    errors.append(f"{pre}{name}.{axis}: ${token} 타입 {got} (={want} 이어야)")
                style[axis] = token
            if spec.get("textGrowth") in ("fixed-width", "fixed-width-height"):
                style["multiline"] = True
            styles[name] = style
            if len(kids) > 1 and kids[1].get("type") == "text":
                captions[name] = str(kids[1].get("content") or "")
    return styles, captions


def token_value(var_defs, token):
    """변수의 실제 값. 타이포 토큰은 테마를 안 타지만, 배열이면 첫 값을 쓴다."""
    v = (var_defs.get(token) or {}).get("value")
    if isinstance(v, list):
        return (v[0] or {}).get("value") if v and isinstance(v[0], dict) else None
    return v


def same_value(claimed, actual):
    """설명글에 적힌 값 == 실제 변수 값 인가. 특수 빼기표를 일반 빼기표로 바꾼 뒤 비교한다."""
    c = claimed.strip().strip('"').strip("'")
    for bad, good in MINUS_CHARS.items():
        c = c.replace(bad, good)
    if isinstance(actual, bool) or actual is None:
        return False
    if isinstance(actual, (int, float)):
        try:
            return float(c) == float(actual)
        except ValueError:
            return False
    return c == str(actual)


def check_captions(styles, captions, var_defs, warnings):
    """설명글이 실제 값과 맞는지. 형식: '이름 · <토큰> <값> / <토큰> … — 자유 메모'
    첫 '·' 뒤부터 첫 '—' 앞까지가 검사 구간이고, 그 뒤 자유 메모는 건드리지 않는다."""
    for name in sorted(styles):
        cap = captions.get(name)
        if cap is None:
            warnings.append(f"{name}: 설명글(둘째 줄)이 없다")
            continue
        i = cap.find("·")
        recipe = cap[i + 1:] if i >= 0 else cap
        j = recipe.find("—")
        if j >= 0:
            recipe = recipe[:j]

        used = {styles[name][a]: a for a in AXES if a in styles[name]}
        mentioned = set()
        for seg in recipe.split("/"):
            m = CAPTION_TOKEN_RE.search(seg)
            if not m:
                continue                                  # 토큰 없는 조각은 무시
            token = m.group(0)
            mentioned.add(token)
            if token not in used:
                warnings.append(f"{name}: 설명글의 '{token}' 을 견본은 쓰지 않는다 "
                                f"(실제: {', '.join(sorted(used)) or '없음'})")
                continue
            claimed = seg[m.end():].strip()
            if not claimed:
                continue                                  # 값을 안 적은 건 정상 (fontweight-* 관례)
            actual = token_value(var_defs, token)
            if not same_value(claimed, actual):
                warnings.append(f"{name}: 설명글은 '{token} {claimed}' 인데 실제 값은 {actual!r}")
        for token, axis in sorted(used.items()):
            if axis in CAPTION_OPTIONAL_AXES:
                continue                                  # 글꼴 종류는 관례상 생략 가능
            if token not in mentioned:
                warnings.append(f"{name}: 견본은 '{token}' 을 쓰는데 설명글에 없다")


def check_dark(light, dark, warnings):
    """라이트판·다크판이 서로 같은지. 타이포는 두 판이 동일해야 한다(다른 건 색뿐)."""
    only_light = sorted(set(light) - set(dark))
    only_dark = sorted(set(dark) - set(light))
    if only_light:
        warnings.append(f"다크판에 없는 행 {len(only_light)}개: {' '.join(only_light)}")
    if only_dark:
        warnings.append(f"라이트판에 없는 행 {len(only_dark)}개: {' '.join(only_dark)}")
    for name in sorted(set(light) & set(dark)):
        if light[name] != dark[name]:
            diff = [k for k in set(light[name]) | set(dark[name])
                    if light[name].get(k) != dark[name].get(k)]
            warnings.append(f"{name}: 라이트/다크 값이 다르다 — "
                            + ", ".join(f"{k}(라이트 {light[name].get(k)!r} / 다크 {dark[name].get(k)!r})"
                                        for k in sorted(diff)))


def build():
    nodes = load("pen-nodes.json")
    var_defs = (load("variables.json") or {}).get("variables", {})
    errors, warnings = [], []

    styles, captions = collect_styles(find_frame(nodes, FRAME_NAME), var_defs, errors)

    # 자기점검 1 — 라이트판·다크판 대조 (다크 프레임이 없는 프로젝트면 건너뜀)
    dark_frame = find_frame(nodes, DARK_FRAME_NAME, required=False)
    if dark_frame is not None:
        dark_styles, _ = collect_styles(dark_frame, var_defs, errors, label="[다크]")
        check_dark(styles, dark_styles, warnings)

    # 자기점검 2 — 설명글·실제값 대조
    check_captions(styles, captions, var_defs, warnings)

    # 5축 조합은 유일해야 한다 — 겹치면 노드에서 프리셋을 되찾을 수 없다(verify/플러그인/추출 공통 계약)
    seen = {}
    for name, s in styles.items():
        key = tuple(s.get(a) for a in AXES)
        if key in seen:
            errors.append(f"5축 조합 중복: {seen[key]} == {name} — 매칭이 모호해진다")
        seen[key] = name

    aliases = load("typography-aliases.json", required=False) or {}
    if isinstance(aliases, dict) and "aliases" in aliases:
        aliases = aliases["aliases"]
    for alias, target in sorted(aliases.items()):
        if alias in styles:
            errors.append(f"별칭 {alias}: 같은 이름의 프리셋이 있다")
        if target not in styles:
            errors.append(f"별칭 {alias} -> {target}: 그런 프리셋 없음")

    if errors:
        print(f"❌ {len(errors)}건:")
        for e in errors:
            print("   -", e)
        sys.exit(1)

    out = {"styles": styles}
    if aliases:
        out["aliases"] = dict(sorted(aliases.items()))
    return out, warnings


def main():
    out, warnings = build()
    text = json.dumps(out, ensure_ascii=False, indent=2) + "\n"

    def show_warnings(header):
        if not warnings:
            return
        print(f"  {header} {len(warnings)}건:")
        for w in warnings:
            print("   -", w)

    if CHECK:
        if not os.path.exists(OUT):
            sys.exit(f"❌ {OUT} 없음 — --check 전에 한 번 생성해야 한다")
        with open(OUT, encoding="utf-8") as f:
            cur = f.read()
        if cur != text:
            sys.exit("❌ 드리프트: DS - Typography 프레임과 typography-styles.json 이 다르다 "
                     "— --check 없이 재실행해 갱신하세요")
        # --check 는 "전부 맞춰져 있나" 확인 모드라 카탈로그 자기점검도 실패로 본다
        if warnings:
            print("❌ 카탈로그가 어긋나 있다 — 배출물은 정상이지만 사람이 보는 카탈로그가 틀린 말을 한다")
            show_warnings("")
            sys.exit(1)
        print(f"✅ 최신 ({len(out['styles'])} 프리셋) @ {OUT} · 카탈로그 자기점검 통과")
        return

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)

    from collections import Counter
    by = Counter(s["group"] for s in out["styles"].values())
    ml = sum(1 for s in out["styles"].values() if s.get("multiline"))
    print(f"완료 -> {OUT}")
    print(f"  프리셋 {len(out['styles'])}개 (" + " · ".join(f"{g} {n}" for g, n in by.items()) + f") · 멀티라인 전용 {ml}")
    print(f"  별칭 {len(out.get('aliases', {}))}개")
    # 배출물 자체는 라이트판만 보므로 이 경고들은 결과에 영향이 없다 → 작업을 막지 않고 알리기만 한다
    show_warnings("⚠️ 카탈로그 어긋남")
    if not warnings:
        print("  ✅ 카탈로그 자기점검 통과 (라이트·다크 대조, 설명글·실제값 대조)")


if __name__ == "__main__":
    main()
