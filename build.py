#!/usr/bin/env python3
# Pencil(.pen) 추출 데이터 -> Figma 플러그인용 design-data.json 빌드
# 사용법:
#   python3 build.py --data <데이터폴더> [펜프로젝트폴더]
#   예) python3 build.py --data ../초코로드/export ../초코로드
#   --data 생략 시 현재 폴더(CWD). 펜프로젝트폴더 생략 시 데이터폴더의 상위(images/ 위치).
# 전제: <데이터폴더>/pen-nodes.json, variables.json 존재. 이미지 원본은 <펜프로젝트폴더>/images/.

import json
import os
import sys
import base64
import subprocess
import tempfile

def _pop_data(argv):
    if "--data" in argv:
        i = argv.index("--data"); return argv[i + 1], argv[:i] + argv[i + 2:]
    return os.environ.get("PENCIL_DATA") or ".", argv

DATA, _argv = _pop_data(sys.argv[1:])
DATA = os.path.abspath(DATA)               # pen-nodes.json / variables.json / design-data.json 위치
# 이미지(.pen 의 images/ 폴더)가 있는 위치 = .pen 프로젝트 폴더.
# 우선순위: 1) 남은 CLI 인자  2) 환경변수 PEN_DIR  3) 기본값(데이터폴더의 상위)
PEN_DIR = (_argv[0] if _argv else None) or os.environ.get("PEN_DIR") or os.path.dirname(DATA)
IMAGES_DIR = os.path.abspath(PEN_DIR)      # url 이 'images/...' 형태라 이 폴더 기준
MAX_DIM = int(os.environ.get("MAX_DIM", "600"))  # 썸네일 최대 변(px). 용량/화질 균형

def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)

def walk(node, fn):
    fn(node)
    for c in node.get("children", []) or []:
        walk(c, fn)
    # descendants: 속성 오버라이드뿐 아니라 교체(replacement) subtree 도 재귀
    # (교체 안의 아이콘/이미지까지 수집해야 함)
    for ov in (node.get("descendants") or {}).values():
        if isinstance(ov, dict):
            walk(ov, fn)

def collect(nodes):
    icons, images = {}, set()  # icons: (library, name) -> True
    def add_fill(f):
        if isinstance(f, list):
            for x in f:
                add_fill(x)
        elif isinstance(f, dict) and f.get("type") == "image" and f.get("url"):
            images.add(f["url"])
    def visit(n):
        if not isinstance(n, dict):
            return
        if n.get("type") == "icon" and n.get("icon"):
            icons[(n.get("library") or "lucide", n["icon"])] = True
        add_fill(n.get("fill"))
    for root in nodes:
        walk(root, visit)
    icon_list = [{"library": lib, "icon": name} for (lib, name) in sorted(icons.keys())]
    return icon_list, sorted(images)

# ---- raw hex -> $변수 역복원 ----
# (구) resolveVariables:true 로 뽑혀 hex 로 박제된 색을 복구하는 하위호환 경로.
# 현행 절차(RUNBOOK)는 resolveVariables:false 필수 — 이 경우 이 맵은 사실상 no-op.
# ※ 색만 복구 가능. number/string(타이포·spacing) 토큰은 역복원 경로가 없다.
def build_color_map(variables_full):
    """light hex(대문자) -> 변수명. 전체형식 {themes,variables} / 평탄형식 {name:hex} 모두 지원.

    같은 light hex 를 여러 토큰이 가질 때(예: #FFFFFF = background(테마별) / text-on-primary(고정))
    **테마 없는(스칼라) 토큰을 우선**한다. 디자인에 생 hex 로 박혀 있던 색은 정의상 테마 불변이므로,
    테마별 토큰으로 역복원하면 다크모드에서 색이 뒤집힌다(흰 아이콘이 검게 변하는 등).
    """
    defs = variables_full.get("variables", variables_full) if isinstance(variables_full, dict) else {}
    cands = {}   # HEX -> [(name, themed)]
    for name, defn in defs.items():
        if isinstance(defn, dict):
            if defn.get("type") != "color":
                continue
            val = defn.get("value")
        else:
            val = defn
        hexv, themed = None, False
        if isinstance(val, list):
            themed = True
            for e in val:
                if isinstance(e, dict) and (e.get("theme") or {}).get("mode") == "light":
                    hexv = e.get("value"); break
            if hexv is None and val and isinstance(val[0], dict):
                hexv = val[0].get("value")
        elif isinstance(val, str):
            hexv = val
        if isinstance(hexv, str) and hexv.startswith("#"):
            cands.setdefault(hexv.upper(), []).append((name, themed))
    m = {}
    for hexv, lst in cands.items():
        scalars = [n for n, t in lst if not t]
        m[hexv] = scalars[0] if scalars else lst[0][0]
        if len(lst) > 1:
            print(f"  [알림] {hexv} 를 {len(lst)}개 토큰이 공유 → '{m[hexv]}' 채택"
                  f" ({'테마 없음 우선' if scalars else '테마별 중 첫 항목'}; 후보 {[n for n, _ in lst]})")
    return m

_remap_count = [0]

def _map_color(v, cmap):
    if isinstance(v, str) and v.startswith("#") and v.upper() in cmap:
        _remap_count[0] += 1
        return "$" + cmap[v.upper()]
    return v

def _remap_value(val, cmap):
    if isinstance(val, str):
        return _map_color(val, cmap)
    if isinstance(val, list):
        return [_remap_value(x, cmap) for x in val]
    if isinstance(val, dict):
        if isinstance(val.get("color"), str):
            val["color"] = _map_color(val["color"], cmap)
        if isinstance(val.get("colors"), list):
            for stop in val["colors"]:
                if isinstance(stop, dict) and isinstance(stop.get("color"), str):
                    stop["color"] = _map_color(stop["color"], cmap)
        return val
    return val

def remap_colors(node, cmap):
    if not isinstance(node, dict):
        return
    for key in ("fill", "stroke"):
        if key in node:
            node[key] = _remap_value(node[key], cmap)
    for c in node.get("children", []) or []:
        remap_colors(c, cmap)
    for ov in (node.get("descendants") or {}).values():
        if isinstance(ov, dict):
            remap_colors(ov, cmap)

def _have_sips():
    from shutil import which
    return which("sips") is not None

def _read_source_bytes(url):
    """로컬 경로 또는 원격 http(s) URL 에서 원본 바이트 획득."""
    if url.startswith("http://") or url.startswith("https://"):
        import urllib.request
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    src = os.path.join(IMAGES_DIR, url)
    if not os.path.exists(src):
        raise FileNotFoundError(src)
    with open(src, "rb") as f:
        return f.read()

def encode_image(url):
    try:
        raw = _read_source_bytes(url)
    except Exception as e:
        print(f"  [경고] 이미지 못 읽음: {str(url)[:70]} ({e})")
        return None
    data_bytes = raw
    # sips 로 최대 변 MAX_DIM 다운스케일 (있으면)
    if _have_sips():
        try:
            tin = tempfile.NamedTemporaryFile(suffix=".img", delete=False); tin.write(raw); tin.close()
            tout = tempfile.NamedTemporaryFile(suffix=".png", delete=False); tout.close()
            subprocess.run(
                ["sips", "-Z", str(MAX_DIM), tin.name, "--out", tout.name],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            with open(tout.name, "rb") as f:
                data_bytes = f.read()
            os.unlink(tin.name); os.unlink(tout.name)
        except Exception as e:
            print(f"  [경고] sips 실패, 원본 임베드: {e}")
            data_bytes = raw
    return "data:image/png;base64," + base64.b64encode(data_bytes).decode("ascii")

def main():
    nodes = load("pen-nodes.json")
    variables = load("variables.json")

    # raw hex -> $변수 역복원 (light hex 기준, 충돌 없음 검증됨)
    cmap = build_color_map(variables)
    for n in nodes:
        remap_colors(n, cmap)
    print(f"색상 변수 역복원: {_remap_count[0]}곳 → $변수 (맵 {len(cmap)}개)")

    components = [n for n in nodes if n.get("reusable")]
    screens = [n for n in nodes if not n.get("reusable")]

    icon_names, image_urls = collect(nodes)
    print(f"이미지 기준 폴더: {IMAGES_DIR}")
    print(f"컴포넌트 {len(components)}개, 화면 {len(screens)}개")
    print(f"아이콘 {len(icon_names)}종, 이미지 {len(image_urls)}개")

    images = {}
    for url in image_urls:
        print(f"  이미지 인코딩: {url}")
        data = encode_image(url)
        if data:
            images[url] = data

    out = {
        "variables": variables,
        "components": components,
        "screens": screens,
        "icons": icon_names,   # UI 에서 lucide CDN 으로 받아옴
        "images": images,
    }
    out_path = os.path.join(DATA, "design-data.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"완료 -> design-data.json ({size_mb:.1f} MB)")

if __name__ == "__main__":
    main()
