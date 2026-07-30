#!/usr/bin/env python3
# 부분 추출 결과(part)를 pen-nodes.json 에 id 기준으로 병합 (증분 추출의 병합기)
# 새 Pencil MCP(execute+Get)는 추출 데이터가 에이전트 컨텍스트를 거치므로 전체 재추출이 비싸다.
# → 바뀐 화면/컴포넌트만 part 로 뽑아 이 스크립트로 upsert 한다.
#
# 사용법:
#   python3 merge-nodes.py --data <데이터폴더> [part.json ...] [옵션]
#   part 생략 시 <데이터폴더>/pen-nodes.part*.json 을 이름순으로 병합.
# 옵션:
#   --out <파일명>        출력 (기본 pen-nodes.json, <데이터폴더> 기준)
#   --base <파일명>|none  병합 기반 (기본 --out 과 동일. none = 기존 무시하고 새로)
#   --inventory <파일>    top-level id 전체 목록(추출 2단계 산출물). 목록에 없는 잔존 노드 = 삭제된 것 → 보고
#   --prune               inventory 에 없는 노드를 실제로 제거 (기본은 보고만)
#   --expect-ids a,b,c    이번 병합이 반드시 담아야 할 id — 누락 시 실패 (조용한 Print 절단 탐지)
#   --dry-run             리포트만, 파일 미변경
#   --clean               성공 후 part 파일을 <데이터폴더>/.parts/ 로 이동
#   --allow-truncated     "..." 절단 마커가 있어도 강행
# 종료코드: 0=정상, 1=문제 (verify.py 와 동일 규약)
#
# 병합 규칙: 노드 단위 통째 교체(deep merge 안 함 — children 배열/descendants 부분 병합은 유령을 남김).
# 직렬화: json.dump(ensure_ascii=False, sort_keys=True) — 기존 pen-nodes.json 과 바이트 호환(검증됨).
# ※ diff.py 의 .snapshot/ 은 절대 건드리지 않는다 (비교 기준). 백업은 .merge-backup/ 에 1부.

import glob
import json
import os
import sys
import time

def _pop_flag(argv, flag):
    if flag in argv:
        return True, [a for a in argv if a != flag]
    return False, argv

def _pop_opt(argv, opt):
    if opt in argv:
        i = argv.index(opt); return argv[i + 1], argv[:i] + argv[i + 2:]
    return None, argv

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

ARGV = sys.argv[1:]
DRY, ARGV = _pop_flag(ARGV, "--dry-run")
PRUNE, ARGV = _pop_flag(ARGV, "--prune")
CLEAN, ARGV = _pop_flag(ARGV, "--clean")
ALLOW_TRUNC, ARGV = _pop_flag(ARGV, "--allow-truncated")
OUT_NAME, ARGV = _pop_opt(ARGV, "--out")
BASE_NAME, ARGV = _pop_opt(ARGV, "--base")
INVENTORY, ARGV = _pop_opt(ARGV, "--inventory")
EXPECT, ARGV = _pop_opt(ARGV, "--expect-ids")
DATA, ARGV = _pop_data(ARGV)
DATA = os.path.abspath(DATA)
OUT_NAME = OUT_NAME or "pen-nodes.json"
OUT_PATH = os.path.join(DATA, OUT_NAME)

problems = []      # 하드 실패 (쓰지 않고 exit 1)
warnings = []      # 소프트 경고

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

def load_part(path):
    """허용 입력: [node,...] / 단일 node / {"nodes":[...]}. 그 외는 에러."""
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    if isinstance(d, list):
        nodes = d
    elif isinstance(d, dict) and isinstance(d.get("nodes"), list):
        nodes = d["nodes"]
    elif isinstance(d, dict) and "id" in d and "type" in d:
        nodes = [d]
    else:
        problems.append(f"{os.path.basename(path)}: 알 수 없는 형태 — [node,...] / node / {{\"nodes\":[...]}} 만 허용")
        return []
    for n in nodes:
        if not isinstance(n, dict) or "id" not in n or "type" not in n:
            problems.append(f"{os.path.basename(path)}: id/type 없는 top-level 요소")
            return []
    return nodes

def count_trunc(nodes):
    return json.dumps(nodes, ensure_ascii=False).count('"..."')

def main():
    # ---- 입력 수집 ----
    parts = ARGV or sorted(glob.glob(os.path.join(DATA, "pen-nodes.part*.json")))
    parts = [p if os.path.isabs(p) else (p if os.path.exists(p) else os.path.join(DATA, p)) for p in parts]
    if not parts:
        print(f"병합할 part 없음 (<데이터폴더>/pen-nodes.part*.json 또는 인자로 지정) @ {DATA}")
        sys.exit(1)
    missing = [p for p in parts if not os.path.exists(p)]
    if missing:
        print("파일 없음: " + ", ".join(missing)); sys.exit(1)

    base_name = BASE_NAME or OUT_NAME
    base = []
    if base_name != "none" and os.path.exists(os.path.join(DATA, base_name)):
        with open(os.path.join(DATA, base_name), encoding="utf-8") as f:
            base = json.load(f)
        if not isinstance(base, list):
            print(f"기반 {base_name} 이 배열이 아님"); sys.exit(1)

    part_nodes = []                    # (파일명, [nodes])
    for p in parts:
        ns = load_part(p)
        if ns:
            # 절단 게이트 — 오염 데이터를 쓰기 전에 막는다
            t = count_trunc(ns)
            if t and not ALLOW_TRUNC:
                bad = []
                for n in ns:
                    c = count_trunc([n])
                    if c:
                        bad.append(f"{n.get('id')}({c})")
                problems.append(f"{os.path.basename(p)}: 절단 마커 \"...\" {t}개 — {' '.join(bad)} → depth 늘려 해당 id 재추출")
            part_nodes.append((os.path.basename(p), ns))

    if problems:
        print("=== merge-nodes: 병합 중단 (파일 미변경) ===")
        for m in problems:
            print("  ❌ " + m)
        sys.exit(1)

    # ---- 병합 (id upsert, base 순서 유지 + 신규 append) ----
    merged = {n["id"]: n for n in base if isinstance(n, dict) and "id" in n}
    order = [n["id"] for n in base if isinstance(n, dict) and "id" in n]
    added, replaced = [], []
    seen_in_parts = set()
    for fname, ns in part_nodes:
        for n in ns:
            nid = n["id"]
            if nid in seen_in_parts:
                warnings.append(f"중복 id {nid} (여러 part) — 나중 것 채택")
            seen_in_parts.add(nid)
            if nid in merged:
                old = merged[nid]
                old_len = len(json.dumps(old, ensure_ascii=False))
                new_len = len(json.dumps(n, ensure_ascii=False))
                old_ch = len(old.get("children") or [])
                new_ch = len(n.get("children") or [])
                if new_len < old_len * 0.7 or new_ch < old_ch:
                    warnings.append(f"축소 의심 [{n.get('name') or nid}] {old_len:,} → {new_len:,}자, children {old_ch}→{new_ch}")
                replaced.append(nid)
                merged[nid] = n
            else:
                merged[nid] = n
                order.append(nid)
                added.append(nid)

    # ---- expect-ids ----
    if EXPECT:
        want = {x for x in (s.strip() for s in EXPECT.split(",")) if x}
        got = seen_in_parts
        miss = sorted(want - got)
        if miss:
            print("=== merge-nodes: 병합 중단 (파일 미변경) ===")
            print(f"  ❌ --expect-ids 누락 {len(miss)}개: {miss} — Print 응답 절단 가능성, 해당 id 재추출")
            sys.exit(1)

    out_nodes = [merged[i] for i in order]

    # ---- inventory 대조 (삭제 감지) ----
    stale = []
    if INVENTORY:
        inv_path = INVENTORY if os.path.isabs(INVENTORY) else os.path.join(DATA, INVENTORY)
        with open(inv_path, encoding="utf-8") as f:
            inv = json.load(f)
        inv_ids = {e["id"] for e in inv if isinstance(e, dict) and "id" in e}
        stale = [i for i in order if i not in inv_ids]
        if stale and PRUNE:
            out_nodes = [n for n in out_nodes if n["id"] not in stale]

    # ---- ref 정합성 (병합 결과 기준) ----
    final_ids = {n["id"] for n in out_nodes}
    comp_ids = {n["id"] for n in out_nodes if n.get("reusable")}
    refs, not_reusable = set(), set()
    def see(n):
        if n.get("type") == "ref" and n.get("ref"):
            refs.add(n["ref"])
    walk(out_nodes, see)
    missing_refs = sorted(r for r in refs if r not in final_ids)
    for r in refs:
        if r in final_ids and r not in comp_ids:
            not_reusable.add(r)
    if not_reusable:
        warnings.append(f"reusable 플래그 없는 ref 대상 {sorted(not_reusable)} — build.py 가 화면으로 오분류함")

    # ---- 리포트 ----
    n_comp = sum(1 for n in out_nodes if n.get("reusable"))
    n_scr = len(out_nodes) - n_comp
    a_comp = sum(1 for i in added if merged[i].get("reusable"))
    r_comp = sum(1 for i in replaced if merged[i].get("reusable"))
    print(f"=== merge-nodes @ {DATA} ===")
    print(f"기반: {base_name}" + (f" ({len(base)} 노드)" if base_name != 'none' else " (없음 — 새로 생성)"))
    print("파트: " + "  ".join(f"{f}({len(ns)})" for f, ns in part_nodes))
    print(f"컴포넌트: +{a_comp} ~{r_comp}    화면: +{len(added) - a_comp} ~{len(replaced) - r_comp}")
    print("누락 ref: " + (f"❌ {len(missing_refs)}개 {missing_refs} → 이 id 들을 part 로 추가 추출 후 재실행" if missing_refs else "없음"))
    if stale:
        print(f"{'제거됨' if PRUNE else '⚠️ 인벤토리에 없는 잔존(삭제된?) 노드'} {len(stale)}개: "
              + ", ".join(f"{merged[i].get('name') or i}" for i in stale)
              + ("" if PRUNE else " — 제거하려면 --prune"))
    for w in warnings:
        print("  ⚠️ " + w)

    if missing_refs:
        print("병합 중단 (파일 미변경)")
        sys.exit(1)

    if DRY:
        print(f"(dry-run) 결과 미저장 — 컴포넌트 {n_comp} · 화면 {n_scr} · {len(out_nodes)} 노드")
        sys.exit(0)

    # ---- 원자적 쓰기 + 백업 ----
    if os.path.exists(OUT_PATH):
        bdir = os.path.join(DATA, ".merge-backup")
        os.makedirs(bdir, exist_ok=True)
        with open(OUT_PATH, encoding="utf-8") as r:
            prev = r.read()
        with open(os.path.join(bdir, f"pen-nodes.{time.strftime('%Y%m%d-%H%M%S')}.json"), "w", encoding="utf-8") as w:
            w.write(prev)
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out_nodes, f, ensure_ascii=False, sort_keys=True)
    os.replace(tmp, OUT_PATH)
    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"결과 -> {OUT_NAME} (컴포넌트 {n_comp} · 화면 {n_scr} · {len(out_nodes)} 노드, {size_kb:,.0f} KB)")

    if CLEAN:
        pdir = os.path.join(DATA, ".parts")
        os.makedirs(pdir, exist_ok=True)
        for p in parts:
            os.replace(p, os.path.join(pdir, os.path.basename(p)))
        print(f"part {len(parts)}개 → .parts/ 이동")

    print("다음: python3 verify.py --data <DATA>  →  diff.py  →  build.py")
    sys.exit(0)

if __name__ == "__main__":
    main()
