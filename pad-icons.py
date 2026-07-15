#!/usr/bin/env python3
# Pencil export_nodes(pdf) 는 아이콘을 "보이는 패스에 tight crop" 으로 내보낸다
# (lucide 내장 패딩 제거 + 종횡비 제각각). 이걸 그대로 iOS Asset Catalog 에 넣으면
# .frame() 안에서 아이콘마다 크기/왜곡이 들쭉날쭉해진다.
#
# 이 스크립트는 각 PDF 의 MediaBox 만 "중앙 정사각 + 여백" 으로 넓혀서
# 모든 아이콘을 균일 캔버스로 만든다. 콘텐츠(벡터 패스)는 건드리지 않으므로
# 글리프는 제자리에서 자동 중앙정렬된다. PDF 라이브러리 불필요.
#
# 사용법:
#   python3 pad-icons.py <아이콘PDF폴더>            # 폴더 내 모든 *.pdf 패딩
#   MARGIN=0.10 python3 pad-icons.py <폴더>          # 여백 비율 조절(긴 변 기준, 한쪽 10%)
#
# 권장 순서: export_nodes(format:"pdf") 로 아이콘 추출/리네임 -> 이 스크립트 1회 실행.

import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MARGIN = float(os.environ.get("MARGIN", "0.10"))  # 긴 변 한쪽 여백 비율
MB = re.compile(rb'/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]')

def pad_pdf(path):
    data = open(path, "rb").read()
    boxes = MB.findall(data)
    if not boxes:
        return f"  건너뜀(MediaBox 없음): {os.path.basename(path)}"
    if len({tuple(b) for b in boxes}) > 1:
        return f"  주의(MediaBox 여러 종류 = 멀티페이지?): {os.path.basename(path)} — 아이콘당 1파일이어야 함"
    x0, y0, x1, y1 = map(float, boxes[0])
    w, h = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = max(w, h) * (1 + 2 * MARGIN)          # 긴 변 + 양쪽 여백
    nx0, ny0 = cx - side / 2, cy - side / 2
    nx1, ny1 = cx + side / 2, cy + side / 2
    newbox = f"/MediaBox [ {nx0:.3f} {ny0:.3f} {nx1:.3f} {ny1:.3f} ]".encode()
    data = MB.sub(newbox, data)
    open(path, "wb").write(data)
    return f"  {os.path.basename(path):28} {w:g}x{h:g} -> {side:.1f}x{side:.1f} (정사각)"

def main():
    d = sys.argv[1] if len(sys.argv) > 1 else HERE
    pdfs = [os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".pdf")]
    if not pdfs:
        print(f"PDF 없음: {d}"); return
    print(f"패딩 대상 {len(pdfs)}개 (여백 한쪽 {MARGIN:.0%}):")
    for p in sorted(pdfs):
        print(pad_pdf(p))
    print("완료 — Xcode Asset Catalog 에 'Preserve Vector Data' + 'Render As: Template Image' 로 추가")

if __name__ == "__main__":
    main()
