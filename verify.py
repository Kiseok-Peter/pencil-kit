#!/usr/bin/env python3
# 추출 데이터 무결성 검증 (Figma 임포트/SwiftUI 생성 전 프리플라이트)
# 사용법: python3 verify.py --data <데이터폴더>   (생략 시 CWD / env PENCIL_DATA)
# 검사: ref 해소 / 절단(...) / 아이콘 라이브러리 / 변수 참조 정의 여부
# 종료코드: 0=이상 없음, 1=문제 있음

import json
import os
import sys

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

DATA, _ = _pop_data(sys.argv[1:])
DATA = os.path.abspath(DATA)
SUPPORTED_ICON_LIBS = {"lucide", "feather", "phosphor",
                       "Material Symbols Outlined", "Material Symbols Rounded", "Material Symbols Sharp"}

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
        if v.startswith("$"):
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

    comp_ids = {n["id"] for n in nodes if isinstance(n, dict) and n.get("reusable")}
    comps = sum(1 for n in nodes if isinstance(n, dict) and n.get("reusable"))
    screens = sum(1 for n in nodes if isinstance(n, dict) and not n.get("reusable"))

    orphan_refs, bad_icons, var_refs = set(), {}, set()
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
            if k not in ("children", "descendants"):
                collect_var_refs(v, var_refs)
    walk(nodes, check)

    trunc = json.dumps(nodes, ensure_ascii=False).count('"..."')
    undefined_vars = sorted(v for v in var_refs if v not in variables)

    print(f"검증 대상: 컴포넌트 {comps} · 화면 {screens} · 변수 {len(variables)} (@ {DATA})")
    issues = 0
    def line(ok, msg):
        nonlocal issues
        print(("  ✅ " if ok else "  ❌ ") + msg)
        if not ok: issues += 1

    line(not orphan_refs, f"ref 해소: 끊긴 참조 {len(orphan_refs)}개" + (f" {sorted(orphan_refs)}" if orphan_refs else ""))
    line(trunc == 0, f"절단 마커(...): {trunc}개" + (" — readDepth 부족, 재추출 필요" if trunc else ""))
    line(not bad_icons, f"미지원 아이콘 라이브러리: {bad_icons}" if bad_icons else "아이콘 라이브러리: 전부 지원됨")
    line(not undefined_vars, f"정의 안 된 변수 참조: {undefined_vars}" if undefined_vars else "변수 참조: 전부 정의됨")

    print("결과: " + ("✅ 이상 없음 — 변환 진행 가능" if issues == 0 else f"❌ 문제 {issues}종 — 위 항목 확인"))
    sys.exit(1 if issues else 0)

if __name__ == "__main__":
    main()
