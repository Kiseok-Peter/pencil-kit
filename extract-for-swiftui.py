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

def _strip(v):
    return v[1:] if isinstance(v, str) and v.startswith("$") else v

def _axes_key(src, base=None):
    """5축 키. base 를 주면 그 위에 src 를 덮어쓴다 (부분 오버라이드 합성)."""
    return tuple(_strip(src.get(a, base.get(a) if base else None)) for a in TYPO_AXES)

def strip_axes(node, spec, stat):
    """프리셋이 소유한 축을 노드에서 **지운다**.

    프리셋은 5축이 전부 같아야 매칭되므로 남은 축은 값이 프리셋과 동일한 순수 중복이다.
    그런데 소비 측에서 행간·자간은 **더해지는 값**이라(SwiftUI `lineSpacing`·`tracking`,
    웹 `line-height`+`letter-spacing`) 프리셋을 적용한 뒤 낱개 축을 또 읽으면 벌어진다.
    남겨두면 조용히 틀리므로 아예 안 보낸다 — 피드백 4 §2-2.
    """
    for a in TYPO_AXES:
        if a in node and a in spec:
            del node[a]
            stat["stripped"] += 1


def inject_presets(node, idx, styles, stat, comp_children=None, counted=True):
    """comp_children: 컴포넌트 자식 id -> 노드. `ref` 의 부분 오버라이드를 마스터와 합성할 때 쓴다."""
    if isinstance(node, dict):
        if node.get("type") == "text":
            name = idx.get(_axes_key(node))
            if name:
                node["preset"] = name          # 미매칭은 키 자체를 안 넣는다 → 생성기가 낱개 토큰으로 폴백
                strip_axes(node, styles.get(name, {}), stat)
            if counted:
                stat["total"] += 1
                if name:
                    stat["hit"] += 1
                else:
                    stat["miss"].append(node.get("name") or node.get("id"))
        for c in node.get("children", []) or []:
            inject_presets(c, idx, styles, stat, comp_children, counted)

        # descendants 두 종류를 모두 처리한다 (예전엔 통째로 건너뛰어 11곳이 비었다 — 피드백 3 §2-1)
        for key, ov in (node.get("descendants") or {}).items():
            if not isinstance(ov, dict):
                continue
            if "type" in ov:
                # 교체(replacement) subtree = 온전한 노드 트리. 5축이 다 있어 그냥 주입하면 된다.
                inject_presets(ov, idx, styles, stat, comp_children, counted)
            elif any(a in ov for a in TYPO_AXES):
                # 부분 오버라이드(굵기만 등) = 그것만으로는 신원이 안 된다.
                # `ref` 가 가리키는 컴포넌트에서 같은 id 의 원본을 찾아 축을 합성한다.
                base = (comp_children or {}).get((node.get("ref"), key.split("/")[-1]))
                if base is None:
                    continue
                nm = idx.get(_axes_key(ov, base))
                if nm:
                    ov["preset"] = nm
                    strip_axes(ov, styles.get(nm, {}), stat)
                if counted:
                    stat["ov_total"] += 1
                    if nm:
                        stat["ov_hit"] += 1
                    else:
                        stat["miss"].append(f"{node.get('name') or node.get('id')}/{key}(오버라이드)")
    elif isinstance(node, list):
        for x in node:
            inject_presets(x, idx, styles, stat, comp_children, counted)

# 부모가 flex 레이아웃이면 자식의 x/y 는 스키마상 무시된다("IGNORED when parent uses flex layout").
# 남겨두면 소비 측이 절대배치로 오해한다 — 피드백 4 §2-8. 프레임의 layout 기본값은 horizontal 이라
# 키가 없어도 flex 다. `layoutPosition:"absolute"` 는 레이아웃에서 빠지므로 x/y 가 살아있다.
FLEX = ("vertical", "horizontal")

def drop_dead_xy(node, stat, parent=None):
    if isinstance(node, dict):
        if parent is not None and node.get("layoutPosition") != "absolute":
            for k in ("x", "y"):
                if k in node:
                    del node[k]
                    stat["xy"] += 1
        kids_in_flex = (node.get("type") == "frame"
                        and node.get("layout", "horizontal") in FLEX)
        for c in node.get("children", []) or []:
            drop_dead_xy(c, stat, node if kids_in_flex else None)
        # 오버라이드는 부모 레이아웃을 알 수 없다(교체본은 원본 자리에 들어간다) → 건드리지 않는다.
    elif isinstance(node, list):
        for x in node:
            drop_dead_xy(x, stat, parent)

def component_children(components):
    """(컴포넌트 id, 자식 id) -> 마스터의 5축 **사본**. 부분 오버라이드를 합성할 때 쓴다.

    ⚠️ 노드를 그대로 담으면 안 된다. `strip_axes` 가 마스터 노드에서 축을 지우므로,
    화면 차례가 왔을 때 합성할 원본이 이미 비어 있다(실측: 5/5 → 0/5 로 깨졌다).
    그래서 지우기 전에 축만 떠 둔다.
    """
    out = {}
    def walk(cid, n):
        if isinstance(n, dict):
            if n.get("id"):
                out[(cid, n["id"])] = {a: n[a] for a in TYPO_AXES if a in n}
            for c in n.get("children", []) or []:
                walk(cid, c)
    for c in components:
        walk(c.get("id"), c)
    return out

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
    stat = {"total": 0, "hit": 0, "ov_total": 0, "ov_hit": 0, "miss": [], "stripped": 0, "xy": 0}
    if ts.get("styles"):
        idx = preset_index(ts["styles"])
        cc = component_children(d.get("components", []))   # 부분 오버라이드 합성용 (전체 컴포넌트 기준)
        for c in comps:
            inject_presets(c, idx, ts["styles"], stat, cc)
        for s in screens:
            inject_presets(s, idx, ts["styles"], stat, cc,
                           counted=not str(s.get("name") or "").startswith(DOC_PREFIX))
    for r in comps + screens:
        drop_dead_xy(r, stat)

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
        if stat["ov_total"]:
            print(f"  인스턴스 부분 오버라이드 {stat['ov_hit']}/{stat['ov_total']} 주입 "
                  f"(마스터 축과 합성 — 굵기만 바꾸는 식이라 단독으론 신원이 안 된다)")
        print(f"  프리셋이 소유한 낱개 축 {stat['stripped']}개 제거 (중복 — 프리셋만 읽으면 된다)")
        if stat["miss"]:
            print(f"  ⚠️ 프리셋 밖 조합 {len(stat['miss'])}곳: {' '.join(stat['miss'][:6])}"
                  + (" …" if len(stat["miss"]) > 6 else "")
                  + " — python3 verify.py --data <DATA> --strict-typo 로 확인")
    else:
        print("  ⚠️ 프리셋 없음 — make-typography-styles.py 를 먼저 실행하세요 (낱개 토큰으로만 생성됨)")
    print(f"  죽은 x/y {stat['xy']}개 제거 (부모가 flex 라 무시되는 값)")

if __name__ == "__main__":
    main()
