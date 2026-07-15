#!/usr/bin/env python3
# 디자인 시스템 변경 감지 — 지난 스냅샷 대비 추가/수정/삭제된 컴포넌트·화면·토큰을 보고.
# 재추출(다른 프로젝트/나중/디자인 갱신) 후 "바뀐 것만" 골라 증분 작업하기 위한 도구.
#
# 사용법:
#   python3 diff.py --data <데이터폴더>            # 스냅샷 대비 변경 리포트
#   python3 diff.py --data <데이터폴더> --update    # 리포트 후 현재 상태를 새 스냅샷으로 저장(수락)
#   (--data 생략 시 CWD / env PENCIL_DATA)
# 스냅샷 위치: <데이터폴더>/.snapshot/{pen-nodes.json, variables.json}
#
# 원리: top-level 컴포넌트/화면 id 는 안정적이라 id 로 매칭.
#       "수정" 판정은 내부 자식 id(편집 시 바뀜)를 제거한 정규화 해시로 비교 → id 변동에 강함.

import json
import os
import sys
import hashlib

def _pop_flag(argv, flag):
    if flag in argv:
        argv = [a for a in argv if a != flag]; return True, argv
    return False, argv

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

DO_UPDATE, ARGV = _pop_flag(sys.argv[1:], "--update")
DATA, _ = _pop_data(ARGV)
DATA = os.path.abspath(DATA)
SNAP = os.path.join(DATA, ".snapshot")

def strip_ids(n):
    if isinstance(n, dict):
        return {k: strip_ids(v) for k, v in n.items() if k != "id"}
    if isinstance(n, list):
        return [strip_ids(x) for x in n]
    return n

def sig(node):
    return hashlib.md5(json.dumps(strip_ids(node), sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def index(nodes):
    comps, screens = {}, {}
    for n in nodes:
        if not isinstance(n, dict):
            continue
        (comps if n.get("reusable") else screens)[n["id"]] = n
    return comps, screens

def diff_map(old, new):
    """id→node 두 맵 비교 → (added_names, changed_names, removed_names)"""
    nm = lambda d, i: (d[i].get("name") or i)
    added = [nm(new, i) for i in new if i not in old]
    removed = [nm(old, i) for i in old if i not in new]
    changed = [nm(new, i) for i in new if i in old and sig(new[i]) != sig(old[i])]
    return sorted(added), sorted(changed), sorted(removed)

def diff_tokens(old, new):
    ov, nv = old.get("variables", {}), new.get("variables", {})
    added = sorted(k for k in nv if k not in ov)
    removed = sorted(k for k in ov if k not in nv)
    changed = sorted(k for k in nv if k in ov and json.dumps(nv[k], sort_keys=True) != json.dumps(ov[k], sort_keys=True))
    return added, changed, removed

def save_snapshot():
    os.makedirs(SNAP, exist_ok=True)
    for f in ("pen-nodes.json", "variables.json"):
        src = os.path.join(DATA, f)
        if os.path.exists(src):
            with open(src, encoding="utf-8") as r, open(os.path.join(SNAP, f), "w", encoding="utf-8") as w:
                w.write(r.read())

def fmt(added, changed, removed):
    parts = []
    if added:   parts.append(f"+{len(added)} {added}")
    if changed: parts.append(f"~{len(changed)} {changed}")
    if removed: parts.append(f"-{len(removed)} {removed}")
    return "  ".join(parts) if parts else "변경 없음"

def main():
    cur_nodes = load(os.path.join(DATA, "pen-nodes.json"))
    cur_vars = load(os.path.join(DATA, "variables.json")) if os.path.exists(os.path.join(DATA, "variables.json")) else {}

    snap_nodes_path = os.path.join(SNAP, "pen-nodes.json")
    if not os.path.exists(snap_nodes_path):
        print(f"기준 스냅샷 없음 — 현재 상태를 스냅샷으로 저장합니다 ({SNAP})")
        save_snapshot()
        print("다음 추출 후 다시 실행하면 그 사이 변경분을 보여줍니다.")
        return

    old_nodes = load(snap_nodes_path)
    old_vars = load(os.path.join(SNAP, "variables.json")) if os.path.exists(os.path.join(SNAP, "variables.json")) else {}

    oc, os_ = index(old_nodes); nc, ns = index(cur_nodes)
    tok = diff_tokens(old_vars, cur_vars)
    comp = diff_map(oc, nc)
    scrn = diff_map(os_, ns)

    print(f"=== 변경 감지 (현재 vs .snapshot) @ {DATA} ===")
    print(f"토큰:    {fmt(*tok)}")
    print(f"컴포넌트: {fmt(*comp)}")
    print(f"화면:    {fmt(*scrn)}")
    total = sum(len(x) for grp in (tok, comp, scrn) for x in grp)
    if total == 0:
        print("→ 이전 스냅샷과 동일 (작업할 변경 없음)")
    else:
        print("→ 위 '+추가 / ~수정 / -삭제' 목록이 재작업 대상 (Figma 컴포넌트 갱신 / SwiftUI View 재생성)")

    if DO_UPDATE:
        save_snapshot()
        print("스냅샷 갱신 완료 (지금 상태를 새 기준으로 저장)")
    elif total:
        print("이 변경을 기준으로 삼으려면: 같은 명령에 --update 추가")

if __name__ == "__main__":
    main()
