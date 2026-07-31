#!/usr/bin/env python3
# Pencil export_nodes(pdf) 는 아이콘을 "보이는 패스에 tight crop" 으로 내보낸다
# (lucide 내장 패딩 제거 + 종횡비 제각각). 이걸 그대로 iOS Asset Catalog 에 넣으면
# .frame() 안에서 아이콘마다 크기/왜곡이 들쭉날쭉해진다.
#
# 이 스크립트는 각 PDF 의 MediaBox 만 "중앙 정사각 + 여백" 으로 넓혀서
# 모든 아이콘을 균일 캔버스로 만든다. 콘텐츠(벡터 패스)는 건드리지 않으므로
# 글리프는 제자리에서 자동 중앙정렬된다. PDF 라이브러리 불필요.
#
# ⚠️ 캔버스는 **전 아이콘 공통(절대)** 이어야 한다.
#    파일마다 "긴 변 × 배율" 로 캔버스를 잡으면 모든 아이콘이 .frame() 을 똑같이 꽉 채워서,
#    원래 작아야 할 chevron 이 x 만큼 커진다(디자인의 크기 관계가 사라짐).
#    대표 노드가 전부 같은 크기(예: 24x24 카탈로그)라면 --canvas 24 로 원본 노드 박스를 그대로 복원하는 게 최선.
#
# 사용법:
#   python3 pad-icons.py <아이콘PDF폴더>            # 공통 캔버스 = 폴더 내 최대 변 + 여백
#   python3 pad-icons.py <폴더> --canvas 24         # 공통 캔버스를 24pt 로 고정 (원본 노드 크기를 알 때 권장)
#   MARGIN=0.10 python3 pad-icons.py <폴더>          # 여백 비율(--canvas 미지정일 때만 적용)
#   python3 pad-icons.py <폴더> --per-file          # (구동작) 파일별 상대 캔버스 — 소스 크기가 섞였을 때만
#
# 권장 순서: make-icon-ids.py -> export_nodes(format:"pdf") 로 추출/리네임 -> 이 스크립트 1회 실행.

import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MARGIN = float(os.environ.get("MARGIN", "0.10"))  # 긴 변 한쪽 여백 비율
MB = re.compile(rb'/MediaBox\s*\[\s*([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s*\]')

def read_box(path):
    data = open(path, "rb").read()
    boxes = MB.findall(data)
    if not boxes:
        return data, None, "MediaBox 없음"
    if len({tuple(b) for b in boxes}) > 1:
        return data, None, "MediaBox 여러 종류 = 멀티페이지? (아이콘당 1파일이어야 함)"
    return data, tuple(map(float, boxes[0])), None

def pad_pdf(path, side):
    """MediaBox 를 현재 중심 기준 side×side 정사각으로 교체. 콘텐츠는 그대로(자동 중앙정렬)."""
    data, box, err = read_box(path)
    if err:
        return f"  건너뜀({err}): {os.path.basename(path)}"
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    nb = f"/MediaBox [ {cx-side/2:.3f} {cy-side/2:.3f} {cx+side/2:.3f} {cy+side/2:.3f} ]".encode()
    open(path, "wb").write(MB.sub(nb, data))
    return f"  {os.path.basename(path):28} {w:g}x{h:g} -> {side:g}x{side:g}  (내용 {max(w,h)/side:.0%})"

def main():
    argv = sys.argv[1:]
    per_file = "--per-file" in argv
    if per_file: argv.remove("--per-file")
    canvas = None
    if "--canvas" in argv:
        i = argv.index("--canvas"); canvas = float(argv[i + 1]); argv = argv[:i] + argv[i + 2:]
    d = argv[0] if argv else HERE
    pdfs = sorted(os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".pdf"))
    if not pdfs:
        print(f"PDF 없음: {d}"); return

    if per_file:
        print(f"패딩 대상 {len(pdfs)}개 — ⚠️ 파일별 상대 캔버스(여백 {MARGIN:.0%}) — 크기 관계가 사라진다:")
        for p in pdfs:
            _, box, err = read_box(p)
            print(pad_pdf(p, (max(box[2]-box[0], box[3]-box[1]) * (1 + 2*MARGIN)) if box else 0))
    else:
        extents = []
        for p in pdfs:
            _, box, err = read_box(p)
            if box: extents.append(max(box[2]-box[0], box[3]-box[1]))
        biggest = max(extents) if extents else 0
        side = canvas if canvas else biggest * (1 + 2 * MARGIN)
        if canvas and biggest > canvas:
            # MediaBox 만 보고 재므로 "이미 패딩된 파일"이면 콘텐츠가 아니라 이전 캔버스를 잰다.
            # 추출 직후(tight crop) 1회 실행이 원칙 — 그때는 이 값이 곧 콘텐츠 크기다.
            print(f"  ⚠️ 현재 MediaBox 최대 변 {biggest:g} > 캔버스 {canvas:g}"
                  f" — 추출 직후라면 콘텐츠가 잘립니다(--canvas 를 키울 것)."
                  f" 이미 패딩한 파일을 다시 돌린 거라면 무시해도 됩니다(중심은 보존됨).")
        print(f"패딩 대상 {len(pdfs)}개 — 공통 캔버스 {side:g}x{side:g}"
              f"{' (지정)' if canvas else f' (최대 변 {biggest:g} + 여백 {MARGIN:.0%})'}:")
        for p in pdfs:
            print(pad_pdf(p, side))
    print("완료 — Xcode Asset Catalog 에 'Preserve Vector Data' + 'Render As: Template Image' 로 추가")

if __name__ == "__main__":
    main()
