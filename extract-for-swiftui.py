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

    out = {
        "variables": d.get("variables", {}),     # 토큰(light/dark) → SwiftUI Color
        "components": comps,                       # 선택 화면이 쓰는 컴포넌트만
        "screens": screens,
        "imageRefs": sorted(d.get("images", {}).keys()),  # base64 대신 파일명만
    }
    out_path = os.path.join(DATA, "swiftui-input.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    size_kb = os.path.getsize(out_path) / 1024
    print(f"완료 -> {out_path} (화면 {len(screens)}, 컴포넌트 {len(comps)}, {size_kb:.0f} KB)")

if __name__ == "__main__":
    main()
