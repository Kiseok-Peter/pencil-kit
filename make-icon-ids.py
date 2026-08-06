#!/usr/bin/env python3
# pen-nodes.json 에서 고유 아이콘별 대표 노드ID 맵을 생성 -> _icon_ids.json
# 이 맵으로 Claude 가 export_nodes(format:"pdf") 를 호출해 아이콘마다 개별 PDF 를 뽑는다.
# 사용법: python3 make-icon-ids.py --data <데이터폴더>   (생략 시 CWD / env PENCIL_DATA)
# 출력: <데이터폴더>/_icon_ids.json  ({ "아이콘이름": "대표노드ID", ... })
#
# ⚠️ 대표 노드 선택이 결과 품질을 좌우한다.
#    export_nodes 는 "그 노드가 화면에서 보이는 모습 그대로" 뽑으므로, 사용처를 아무거나 고르면
#    크기(12~36px)와 색(흰색·브랜드색 등)이 제각각인 PDF 가 나온다. 크기가 섞이면 Asset Catalog 에서
#    같은 .frame() 에 넣어도 **획 두께가 달라지고**(작은 원본을 키우면 획이 굵어진다) 이건 pad-icons.py
#    로도 못 고친다. 그래서 아래 점수로 "규격 견본"에 해당하는 노드를 고른다.

import json
import os
import sys
from collections import Counter

# 디자인시스템 카탈로그 = 규격 견본. `.pen` 의 표식(`context`)을 먼저 보고, 없으면 이름 접두로
# 폴백한다 (verify.py · extract-for-swiftui.py 와 같은 규약 — 피드백 5 §5).
CATALOG_CONTEXT = "design-system-catalog"
DOC_PREFIX = "DS - "

def is_catalog(node):
    ctx = node.get("context")
    if isinstance(ctx, str) and ctx:
        return ctx == CATALOG_CONTEXT
    return str(node.get("name") or "").startswith(DOC_PREFIX)

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i + 0] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

DATA, _ = _pop_data(sys.argv[1:])
DATA = os.path.abspath(DATA)

def _num(v, var_nums):
    """크기는 토큰일 수 있다(`$iconsize-20`). 점수 계산이 숫자 비교라 여기서 풀어 둔다 —
    안 풀면 `abs(문자열 - 문자열)` 로 터지거나 크기 편차 경고가 통째로 무력해진다."""
    if isinstance(v, str) and v.startswith("$"):
        return var_nums.get(v[1:], v)
    return v

def collect(n, top, dark, out, var_nums, doc):
    """모든 아이콘 노드를 후보로 모은다 (첫 등장만 쓰면 사용처 크기·색을 물려받는다)."""
    if isinstance(n, dict):
        if n.get("type") == "icon" and n.get("icon") and (n.get("library") or "lucide") == "lucide":
            out.append({
                "icon": n["icon"], "id": n.get("id"), "top": top, "dark": dark,
                "w": _num(n.get("width"), var_nums), "h": _num(n.get("height"), var_nums),
                "fill": n.get("fill"),
                "doc": doc,
            })
        for c in n.get("children", []) or []:
            collect(c, top, dark, out, var_nums, doc)
        for ov in (n.get("descendants") or {}).values():
            if isinstance(ov, dict):
                collect(ov, top, dark, out, var_nums, doc)
    elif isinstance(n, list):
        for x in n:
            collect(x, top, dark, out, var_nums, doc)

def main():
    nodes = json.load(open(os.path.join(DATA, "pen-nodes.json"), encoding="utf-8"))
    # 크기 토큰(`$iconsize-*`)을 풀기 위한 number 변수 표
    vpath = os.path.join(DATA, "variables.json")
    var_nums = {}
    if os.path.exists(vpath):
        vd = json.load(open(vpath, encoding="utf-8"))
        for k, v in (vd.get("variables") or vd).items():
            if isinstance(v, dict) and v.get("type") == "number" and not isinstance(v.get("value"), list):
                var_nums[k] = v["value"]
    cands = []
    for t in nodes if isinstance(nodes, list) else [nodes]:
        if not isinstance(t, dict):
            continue
        # ⚠️ 라이트/다크 판을 구분한다. 같은 $text-primary 라도 다크판은 #F5F4F1(거의 흰색)로 렌더돼
        #    흰 배경에서 안 보이는 PDF 가 나온다. export_nodes 는 "보이는 대로" 뽑기 때문.
        dark = ((t.get("theme") or {}).get("mode") == "dark")
        collect(t, t.get("name"), dark, cands, var_nums, is_catalog(t))
    if not cands:
        print("아이콘 노드가 없습니다."); return

    # 프로젝트 전체의 표준 크기·색 = 최빈값. 하드코딩(24 등) 대신 데이터에서 뽑아 프로젝트 무관하게 동작.
    std_size = Counter(c["w"] for c in cands if c["w"] == c["h"] and c["w"]).most_common(1)[0][0]
    std_fill = Counter(str(c["fill"]) for c in cands).most_common(1)[0][0]

    def score(c):
        # 낮을수록 좋음. 라이트 > 카탈로그 > 정사각 > 표준크기 근접 > 표준색 > id 사전순(재현성)
        sq = 0 if (c["w"] == c["h"] and c["w"]) else 1
        dist = abs((c["w"] or 0) - std_size)
        return (1 if c["dark"] else 0, 0 if c["doc"] else 1, sq, dist,
                0 if str(c["fill"]) == std_fill else 1, c["id"] or "")

    best = {}
    for c in cands:
        if c["icon"] not in best or score(c) < score(best[c["icon"]]):
            best[c["icon"]] = c

    rep = {k: v["id"] for k, v in sorted(best.items())}
    out = os.path.join(DATA, "_icon_ids.json")
    json.dump(rep, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    chosen = list(best.values())
    off_doc = [c for c in chosen if not c["doc"]]
    off_size = [c for c in chosen if c["w"] != std_size or c["h"] != std_size]
    off_fill = [c for c in chosen if str(c["fill"]) != std_fill]
    off_dark = [c for c in chosen if c["dark"]]

    print(f"고유 아이콘 {len(rep)}종 -> {out}")
    print(f"  기준: 크기 {std_size}x{std_size} · 색 {std_fill} · 라이트판 (데이터 최빈값)")
    print(f"  카탈로그(context='{CATALOG_CONTEXT}') 에서 선택: {len(chosen) - len(off_doc)}/{len(chosen)}")
    for label, bad in (("카탈로그 밖", off_doc), ("크기 불일치", off_size),
                       ("색 불일치", off_fill), ("다크판에서 선택(흰색 위험)", off_dark)):
        if bad:
            ex = ", ".join(f"{c['icon']}({c['w']}x{c['h']} {c['fill']} @{c['top']})" for c in bad[:4])
            print(f"  ⚠️ {label} {len(bad)}종 — {ex}{' …' if len(bad) > 4 else ''}")
    if not (off_size or off_fill or off_dark):
        print("  ✅ 전량 균일 — 크기·색 편차 없음, 전부 라이트판")
    else:
        print(f"  → 카탈로그에 {len(rep)}종을 {std_size}px·{std_fill} 로 모두 실어두면 편차가 사라진다.")

    print("다음: Claude 가 각 노드ID 를 export_nodes(filePath, outputDir, nodeIds, format='pdf') 로 추출 후,")
    print("      이 맵으로 '아이콘이름.pdf' 로 rename → pad-icons.py")
    print("      (filePath 필수. PDF 는 여러 nodeIds 를 1파일로 합치므로 아이콘당 1회 호출)")

if __name__ == "__main__":
    main()
