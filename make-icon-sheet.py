#!/usr/bin/env python3
# 아이콘 PDF 폴더를 한 장짜리 검수 시트(_review.html)로 만든다.
# 사용법: python3 make-icon-sheet.py --data <데이터폴더>   (생략 시 CWD / env PENCIL_DATA)
# 입력: <데이터폴더>/icons/*.pdf  +  <데이터폴더>/_icon_ids.json
# 출력: <데이터폴더>/icons/_review.html  (PNG 를 base64 로 품은 단일 파일)
#
# ⚠️ 그림만 늘어놓으면 "정렬이 어긋난 아이콘"을 눈으로 못 잡는다. 실제로 그래서 놓쳤다.
#    export_nodes 가 뽑아준 크기가 아이콘마다 다르면 pad-icons.py 가 공통 캔버스로 넓히면서
#    **가운데 정렬**을 하는데, 그러면 lucide 가 의도한 자리에서 벗어난다. 잉크가 좌우로 치우친
#    아이콘(star-half 등)일수록 크게 밀린다 — 초코로드 실측 5.51pt(24pt 중 23%).
#    그래서 이 시트는 아이콘마다 **추출 원본 크기와 잉크 위치를 같이 찍고**, 원본 크기가
#    최빈값과 다른 것을 빨갛게 표시한다. 시트만 봐도 어긋난 아이콘이 보이게 하는 게 목적이다.
#
# PDF -> PNG 는 macOS 기본 `sips` 로 처리한다 (외부 라이브러리·MCP 호출 불필요).

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter

MB = re.compile(rb'/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]')
FLIP = re.compile(r"1 0 0 -1 0 ([\d.]+) cm")
SRCBOX = re.compile(r"0 0 ([\d.]+) ([\d.]+) re")
SHIFT = re.compile(r"1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm")
PT = re.compile(r"(-?\d+\.?\d*) (-?\d+\.?\d*) [ml]")


def _pop(argv, flag, default=None):
    if flag in argv:
        i = argv.index(flag)
        return argv[i + 1], argv[:i] + argv[i + 2:]
    return default, argv


def measure(path):
    """PDF 한 장에서 페이지 크기 · 추출 원본 크기 · 잉크 위치를 잰다.

    좌표계: 콘텐츠는 `1 0 0 -1 0 H cm` 로 Y 가 뒤집힌 뒤 `1 0 0 1 tx ty cm` 로 옮겨진다.
    그래서 경로점 (x,y) 의 페이지 좌표는 (x+tx, H-(y+ty)) 이고, MediaBox 원점을 빼면
    "페이지 안에서 잉크가 앉은 자리"가 된다.
    """
    import zlib

    data = open(path, "rb").read()
    boxes = MB.findall(data)
    if not boxes:
        return {"err": "MediaBox 없음"}
    if len({tuple(b) for b in boxes}) > 1:
        return {"err": "MediaBox 여러 종류 = 멀티페이지? (아이콘당 1파일이어야 함)"}
    mb = tuple(map(float, boxes[0]))

    cs = ""
    for m in re.finditer(rb"stream\r?\n(.*?)\nendstream", data, re.S):
        try:
            cs = zlib.decompress(m.group(1)).decode("latin1")
            break
        except Exception:
            continue

    out = {"page": (round(mb[2] - mb[0], 2), round(mb[3] - mb[1], 2)), "src": None, "ink": None}
    flip, src, shift = FLIP.search(cs), SRCBOX.search(cs), SHIFT.search(cs)
    if src:
        out["src"] = (float(src.group(1)), float(src.group(2)))
    if flip and shift:
        h = float(flip.group(1))
        tx, ty = float(shift.group(1)), float(shift.group(2))
        pts = [(float(a), float(b)) for a, b in PT.findall(cs)]
        if pts:
            fx = [x + tx - mb[0] for x, _ in pts]
            fy = [h - (y + ty) - mb[1] for _, y in pts]
            out["ink"] = (round(min(fx), 1), round(min(fy), 1), round(max(fx), 1), round(max(fy), 1))
    return out


def to_png(path, size):
    """sips 로 PDF 를 size×size PNG(투명 배경) 로 굽고 bytes 를 돌려준다."""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "o.png")
        r = subprocess.run(["sips", "-s", "format", "png", "-Z", str(size), path, "--out", out],
                           capture_output=True)
        if r.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(f"sips 실패: {os.path.basename(path)} — {r.stderr.decode(errors='replace')[:200]}")
        return open(out, "rb").read()


CSS = """
 :root{--bg:#fff;--fg:#1A1918;--mut:#6D6C6A;--line:#E5E4E1;--card:#F5F4F1;--bad:#C0392B}
 @media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#F5F4F1;--mut:#A0A0A0;--line:#333;--card:#1E1E1E;--bad:#E74C3C}}
 :root[data-theme=dark]{--bg:#121212;--fg:#F5F4F1;--mut:#A0A0A0;--line:#333;--card:#1E1E1E;--bad:#E74C3C}
 :root[data-theme=light]{--bg:#fff;--fg:#1A1918;--mut:#6D6C6A;--line:#E5E4E1;--card:#F5F4F1;--bad:#C0392B}
 body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:28px}
 h1{font-size:20px;margin:0 0 4px} p.sub{color:var(--mut);margin:0 0 22px;font-size:13px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:14px}
 figure{margin:0;text-align:center}
 .sw{background:var(--card);border:1px solid var(--line);border-radius:10px;aspect-ratio:1;
      display:flex;align-items:center;justify-content:center;padding:8px}
 figure.bad .sw{border-color:var(--bad);border-width:2px}
 .sw img{width:100%;height:100%;object-fit:contain}
 @media (prefers-color-scheme:dark){.sw img{filter:invert(1)}}
 :root[data-theme=dark] .sw img{filter:invert(1)}
 :root[data-theme=light] .sw img{filter:none}
 figcaption{font-size:10.5px;color:var(--mut);margin-top:6px;word-break:break-all;line-height:1.35}
 figcaption b{color:var(--fg);font-weight:600;display:block}
 figure.bad figcaption em{color:var(--bad);font-style:normal;display:block}
 .note{margin-top:26px;padding:14px 16px;border:1px solid var(--line);border-radius:10px;
        background:var(--card);font-size:13px;color:var(--mut)}
 .note b{color:var(--fg)} .note .bad{color:var(--bad)}
 code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:var(--fg)}
"""


def main():
    argv = sys.argv[1:]
    data, argv = _pop(argv, "--data", os.environ.get("PENCIL_DATA") or ".")
    size, argv = _pop(argv, "--size", "160")
    out_path, argv = _pop(argv, "--out")
    data = os.path.abspath(data)
    icons = os.path.join(data, "icons")
    out_path = out_path or os.path.join(icons, "_review.html")
    size = int(size)

    if not os.path.isdir(icons):
        print(f"아이콘 폴더 없음: {icons}")
        return 1
    pdfs = sorted(p for p in os.listdir(icons) if p.lower().endswith(".pdf"))
    if not pdfs:
        print(f"PDF 없음: {icons}")
        return 1

    ids = {}
    id_path = os.path.join(data, "_icon_ids.json")
    if os.path.exists(id_path):
        ids = json.load(open(id_path, encoding="utf-8"))

    rows = []
    for f in pdfs:
        name = f[:-4]
        m = measure(os.path.join(icons, f))
        m["name"], m["id"] = name, ids.get(name)
        rows.append(m)

    # "정상"의 기준은 하드코딩하지 않고 데이터 최빈값에서 뽑는다 (프로젝트 무관하게 동작).
    std_page = Counter(r["page"] for r in rows if r.get("page")).most_common(1)[0][0]
    src_all = [r["src"] for r in rows if r.get("src")]
    std_src = Counter(src_all).most_common(1)[0][0] if src_all else None

    for r in rows:
        bad = []
        if r.get("err"):
            bad.append(r["err"])
        else:
            if r["page"] != std_page:
                bad.append(f"페이지 {r['page'][0]:g}×{r['page'][1]:g}")
            if std_src and r["src"] and r["src"] != std_src:
                bad.append(f"추출 원본 {r['src'][0]:g}×{r['src'][1]:g}")
            if not r.get("id"):
                bad.append("노드ID 없음")
        r["bad"] = bad

    cards = []
    for r in rows:
        png = to_png(os.path.join(icons, r["name"] + ".pdf"), size)
        b64 = base64.b64encode(png).decode()
        ink = r.get("ink")
        meta = f"{r['id'] or '—'}"
        if ink:
            meta += f" · 잉크 {ink[0]:g},{ink[1]:g}–{ink[2]:g},{ink[3]:g}"
        warn = f"<em>{' / '.join(r['bad'])}</em>" if r["bad"] else ""
        cards.append(
            f'<figure class="{"bad" if r["bad"] else ""}">'
            f'<div class="sw"><img src="data:image/png;base64,{b64}" alt="{r["name"]}"></div>'
            f'<figcaption><b>{r["name"]}</b>{meta}{warn}</figcaption></figure>'
        )

    n_bad = sum(1 for r in rows if r["bad"])
    verdict = (f'<span class="bad"><b>{n_bad}종이 기준과 다릅니다</b> — 빨간 테두리</span>'
               if n_bad else "<b>전량 균일</b> — 기준과 다른 아이콘 없음")
    note = (
        f'<div class="note">{verdict}<br>'
        f'기준(데이터 최빈값): 페이지 <code>{std_page[0]:g}×{std_page[1]:g}pt</code>'
        + (f' · 추출 원본 <code>{std_src[0]:g}×{std_src[1]:g}pt</code>' if std_src else "")
        + '<br>«잉크»는 페이지 안에서 그림이 실제로 차지한 범위(좌하–우상)입니다. '
          '추출 원본 크기가 제각각이면 <code>pad-icons.py</code> 가 가운데 정렬하면서 '
          '그림이 원래 자리에서 밀립니다.</div>'
    )

    html = (f"<title>아이콘 {len(rows)}종 검수</title>\n<style>{CSS}</style>\n"
            f"<h1>아이콘 {len(rows)}종</h1>\n"
            f'<p class="sub">{os.path.relpath(icons, os.path.dirname(data) or ".")} · '
            f"PNG {size}px (sips 렌더)</p>\n"
            f'<div class="grid">\n' + "\n".join(cards) + "\n</div>\n" + note + "\n")
    open(out_path, "w", encoding="utf-8").write(html)

    print(f"검수 시트 {len(rows)}종 -> {out_path} ({os.path.getsize(out_path)//1024}KB)")
    print(f"  기준: 페이지 {std_page[0]:g}×{std_page[1]:g}"
          + (f" · 추출 원본 {std_src[0]:g}×{std_src[1]:g}" if std_src else ""))
    if n_bad:
        for r in rows:
            if r["bad"]:
                print(f"  ⚠️ {r['name']:22} {' / '.join(r['bad'])}")
    else:
        print("  ✅ 전량 균일")
    return 0


if __name__ == "__main__":
    sys.exit(main())
