#!/usr/bin/env python3
# design-data.json -> SwiftUI 변환용 경량 JSON (base64 이미지 제거, 화면 선택 가능)
# 사용법:
#   python3 extract-for-swiftui.py --data <데이터폴더>                 # 전체 화면
#   python3 extract-for-swiftui.py --data <데이터폴더> "리뷰 작성"       # 이름 부분매칭 화면(+의존 컴포넌트)
#   --data 생략 시 현재 폴더(CWD). 환경변수 PENCIL_DATA 도 가능.
# 출력: <데이터폴더>/swiftui-input.json  (구조 + 토큰 + 이미지 파일명만)

import json
import os
import sys

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

DATA, ARGS = _pop_data(sys.argv[1:])
DATA = os.path.abspath(DATA)

def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)

# 프리셋 주입 — 낱개 토큰(fontsize/fontweight/…)만 넘기면 호출부가 매번 조합을 기억해야 한다.
# 각 텍스트 노드에 어느 프리셋인지 적어 보내면 생성기가 `.dsText(.bodyEmphasis)` 한 줄로 쓸 수 있다.
# 5축 신원은 make-typography-styles.py / verify.py TYPO_AXES 와 같은 계약 (조합 유일성 보장됨).
TYPO_AXES = ("fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight")
DOC_PREFIX = "DS - "   # 디자인시스템 카탈로그 = 쇼케이스. 주입은 하되 커버리지 집계에서는 뺀다
                       # (문서용 라벨은 토큰조차 안 쓰는 게 정상 — verify.py 와 같은 규약)

def preset_index(styles):
    idx = {}
    for name, s in (styles or {}).items():
        idx[tuple(s.get(a) for a in TYPO_AXES)] = name
    return idx

def inject_presets(node, idx, stat, counted=True):
    if isinstance(node, dict):
        if node.get("type") == "text":
            key = tuple((v[1:] if isinstance(v, str) and v.startswith("$") else v)
                        for v in (node.get(a) for a in TYPO_AXES))
            name = idx.get(key)
            if name:
                node["preset"] = name          # 미매칭은 키 자체를 안 넣는다 → 생성기가 낱개 토큰으로 폴백
            if counted:
                stat["total"] += 1
                if name:
                    stat["hit"] += 1
                else:
                    stat["miss"].append(node.get("name") or node.get("id"))
        for c in node.get("children", []) or []:
            inject_presets(c, idx, stat, counted)
        # descendants 오버라이드는 부분정보(굵기만 등)라 5축 신원을 만들 수 없다 → 주입하지 않는다
    elif isinstance(node, list):
        for x in node:
            inject_presets(x, idx, stat, counted)

def collect_refs(node, out):
    if isinstance(node, dict):
        if node.get("type") == "ref" and node.get("ref"):
            out.add(node["ref"])
        for c in node.get("children", []) or []:
            collect_refs(c, out)
        for ov in (node.get("descendants") or {}).values():
            if isinstance(ov, dict):
                collect_refs(ov, out)

def needed_components(screens, all_components):
    by_id = {c["id"]: c for c in all_components}
    need, stack = set(), []
    for s in screens:
        seed = set(); collect_refs(s, seed)
        stack += list(seed)
    while stack:
        cid = stack.pop()
        if cid in need or cid not in by_id:
            continue
        need.add(cid)
        inner = set(); collect_refs(by_id[cid], inner)
        stack += [x for x in inner if x not in need]
    return [by_id[i] for i in need]

def main():
    d = load("design-data.json")
    filt = ARGS[0] if ARGS else None

    screens = d.get("screens", [])
    if filt:
        screens = [s for s in screens if filt in (s.get("name") or "")]
        if not screens:
            print(f"'{filt}' 에 해당하는 화면 없음. 가능한 화면:")
            for s in d.get("screens", []):
                print("  -", s.get("name"))
            return

    comps = needed_components(screens, d.get("components", []))

    ts = d.get("typographyStyles") or {}
    stat = {"total": 0, "hit": 0, "miss": []}
    if ts.get("styles"):
        idx = preset_index(ts["styles"])
        for c in comps:
            inject_presets(c, idx, stat)
        for s in screens:
            inject_presets(s, idx, stat, counted=not str(s.get("name") or "").startswith(DOC_PREFIX))

    out = {
        "variables": d.get("variables", {}),     # 토큰(light/dark) → SwiftUI Color
        "typographyStyles": ts,                    # 프리셋 정의 + 역할 별칭 (소비 규칙은 SWIFTUI-GUIDE §3-1)
        "components": comps,                       # 선택 화면이 쓰는 컴포넌트만
        "screens": screens,
        "imageRefs": sorted(d.get("images", {}).keys()),  # base64 대신 파일명만
    }
    out_path = os.path.join(DATA, "swiftui-input.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"완료 -> {out_path} (화면 {len(screens)}, 컴포넌트 {len(comps)}, {size_kb:.0f} KB)")
    if ts.get("styles"):
        pct = 100 * stat["hit"] / stat["total"] if stat["total"] else 0
        print(f"  프리셋 {len(ts['styles'])}개 · 별칭 {len(ts.get('aliases', {}))}개 · "
              f"텍스트 {stat['hit']}/{stat['total']} 주입 ({pct:.0f}%, 카탈로그 '{DOC_PREFIX}*' 제외)")
        if stat["miss"]:
            print(f"  ⚠️ 프리셋 밖 조합 {len(stat['miss'])}곳: {' '.join(stat['miss'][:6])}"
                  + (" …" if len(stat["miss"]) > 6 else "")
                  + " — python3 verify.py --data <DATA> --strict-typo 로 확인")
    else:
        print("  ⚠️ 프리셋 없음 — make-typography-styles.py 를 먼저 실행하세요 (낱개 토큰으로만 생성됨)")

if __name__ == "__main__":
    main()
