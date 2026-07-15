#!/usr/bin/env python3
# pen-nodes.json 에서 고유 아이콘별 대표 노드ID 맵을 생성 -> _icon_ids.json
# 이 맵으로 Claude 가 export_nodes(format:"pdf") 를 호출해 아이콘마다 개별 PDF 를 뽑는다.
# 사용법: python3 make-icon-ids.py --data <데이터폴더>   (생략 시 CWD / env PENCIL_DATA)
# 출력: <데이터폴더>/_icon_ids.json  ({ "아이콘이름": "대표노드ID", ... })

import json
import os
import sys

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

DATA, _ = _pop_data(sys.argv[1:])
DATA = os.path.abspath(DATA)

def walk(n, rep):
    if isinstance(n, dict):
        if n.get("type") == "icon" and n.get("icon") and (n.get("library") or "lucide") == "lucide":
            rep.setdefault(n["icon"], n.get("id"))
        for c in n.get("children", []) or []:
            walk(c, rep)
        for ov in (n.get("descendants") or {}).values():
            if isinstance(ov, dict):
                walk(ov, rep)
    elif isinstance(n, list):
        for x in n:
            walk(x, rep)

def main():
    nodes = json.load(open(os.path.join(DATA, "pen-nodes.json"), encoding="utf-8"))
    rep = {}
    walk(nodes, rep)
    out = os.path.join(DATA, "_icon_ids.json")
    json.dump(rep, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"고유 아이콘 {len(rep)}종 -> {out}")
    print("다음: Claude 가 각 노드ID 를 export_nodes(format='pdf') 로 추출 후, 이 맵으로 '아이콘이름.pdf' 로 rename → pad-icons.py")

if __name__ == "__main__":
    main()
