#!/usr/bin/env python3
# pencil-kit 통합 런처 (표준 라이브러리만: curses 화살표 메뉴 + readline 탭완성)
# 흩어진 스크립트/옵션을 한 화면에서 골라 실행. 데이터 폴더는 한 번 지정하면 기억됨.
#
# 사용법:  python3 launcher.py
#   ↑/↓ 이동, Enter 실행, q 종료. 경로 입력 시 Tab 자동완성.
#
# ※ MCP 필요한 단계(.pen 추출·아이콘 PDF 추출·SwiftUI 코드생성)는 Claude 가 하는 일이라
#   런처가 아니라 RUNBOOK/SWIFTUI-RUNBOOK 프롬프트로 진행합니다. 런처는 "스크립트 쪽" 작업용.

import curses
import glob
import os
import subprocess
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
LASTFILE = os.path.join(HERE, ".launcher_last")

# ---------- 상태(데이터 폴더) ----------
def load_last():
    try:
        with open(LASTFILE, encoding="utf-8") as f:
            p = f.read().strip()
            return p if p and os.path.isdir(p) else ""
    except Exception:
        return ""

def save_last(p):
    try:
        with open(LASTFILE, "w", encoding="utf-8") as f:
            f.write(p)
    except Exception:
        pass

# ---------- readline 경로 탭완성 (정상 터미널에서) ----------
def _path_completer(text, state):
    exp = os.path.expanduser(text)
    matches = [m + ("/" if os.path.isdir(m) else "") for m in glob.glob(exp + "*")]
    return matches[state] if state < len(matches) else None

def _setup_readline(completer):
    """macOS 기본 파이썬은 readline 이 libedit 라 tab 바인딩 문법이 다름 → 둘 다 대응."""
    try:
        import readline
    except Exception:
        return
    if "libedit" in (getattr(readline, "__doc__", "") or ""):
        readline.parse_and_bind("bind ^I rl_complete")   # macOS libedit
    else:
        readline.parse_and_bind("tab: complete")          # GNU readline
    readline.set_completer_delims(" \t\n")
    readline.set_completer(completer)

def ask_path(prompt, default=""):
    _setup_readline(_path_completer)
    s = input(f"{prompt}" + (f" [{default}]" if default else "") + ": ").strip()
    return os.path.abspath(os.path.expanduser(s)) if s else default

def ask(prompt):
    _setup_readline(None)  # 완성기 끄고 일반 입력
    return input(f"{prompt}: ").strip()

def run(args):
    print("\n$ " + " ".join(args) + "\n" + "-" * 50)
    try:
        subprocess.run(args)
    except Exception as e:
        print(f"실행 오류: {e}")

# ---------- 액션들 (정상 터미널에서 실행) ----------
def py(name, *a):
    run([sys.executable, os.path.join(HERE, name), *a])

def act_set_data(state):
    p = ask_path("데이터 폴더 경로 (Tab 완성)", state.get("data", ""))
    if p and os.path.isdir(p):
        state["data"] = p; save_last(p)
        print(f"데이터 폴더 = {p}")
    else:
        print("유효한 폴더가 아닙니다.")

def _need_data(state):
    if not state.get("data"):
        print("먼저 '데이터 폴더 설정'을 하세요."); return False
    return True

def act_build(state):
    if not _need_data(state): return
    pen = ask_path("펜프로젝트 폴더(images 위치, Tab 완성)", os.path.dirname(state["data"]))
    py("build.py", "--data", state["data"], pen)

def act_merge(state):
    if not _need_data(state): return
    inv = os.path.join(state["data"], "_inventory.json")
    args = ["--data", state["data"]] + (["--inventory", "_inventory.json"] if os.path.exists(inv) else [])
    py("merge-nodes.py", *args)

def act_typostyles(state):
    if _need_data(state): py("make-typography-styles.py", "--data", state["data"])

def act_verify(state):
    if _need_data(state): py("verify.py", "--data", state["data"])

def act_diff(state):
    if _need_data(state): py("diff.py", "--data", state["data"])

def act_diff_update(state):
    if _need_data(state): py("diff.py", "--data", state["data"], "--update")

def act_extract(state):
    if not _need_data(state): return
    f = ask("화면 이름 필터(부분매칭, 비우면 전체)")
    args = ["--data", state["data"]] + ([f] if f else [])
    py("extract-for-swiftui.py", *args)

def act_iconids(state):
    if _need_data(state): py("make-icon-ids.py", "--data", state["data"])

def act_padicons(state):
    d = ask_path("아이콘 PDF 폴더(Asset Catalog, Tab 완성)")
    if d and os.path.isdir(d): py("pad-icons.py", d)
    else: print("유효한 폴더가 아닙니다.")

MENU = [
    ("데이터 폴더 설정/변경", act_set_data,
     "작업할 프로젝트의 export 폴더를 지정합니다. 여기의 pen-nodes/variables/design-data 를 "
     "대상으로 아래 작업들이 실행됩니다. 한 번 정하면 기억됩니다."),
    ("── 공통 ──────────────", None, ""),
    ("merge   · 부분 추출 결과 병합", act_merge,
     "증분 추출한 pen-nodes.part*.json 들을 pen-nodes.json 에 id 기준으로 병합합니다. 절단·"
     "끊긴 ref 를 쓰기 전에 차단하고, _inventory.json 이 있으면 삭제된 노드도 알려줘요."),
    ("build   · design-data.json 재생성", act_build,
     "pen-nodes.json + variables.json + 이미지를 합쳐 design-data.json 을 다시 만듭니다. "
     ".pen 을 추출/수정한 뒤 실행하세요. (Figma 임포트·SwiftUI 추출의 재료 파일)"),
    ("typo    · 타이포 프리셋 배출", act_typostyles,
     "DS - Typography 프레임의 견본 노드를 읽어 typography-styles.json 을 만듭니다. "
     "Figma 는 이걸로 Text Style 을, iOS 는 프리셋 열거형을 만들어요. .pen 의 프레임을 고쳤으면 다시 실행하세요."),
    ("verify  · 데이터 무결성 검사", act_verify,
     "export 데이터가 멀쩡한지 검사합니다: 끊긴 ref, 절단(...), 미지원 아이콘, 정의 안 된 변수. "
     "변환 전에 돌려 문제를 미리 잡는 프리플라이트."),
    ("diff    · 변경 감지(지난 추출 대비)", act_diff,
     "지난 스냅샷과 비교해 추가/수정/삭제된 컴포넌트·화면·토큰을 보여줍니다. 재추출 후 "
     "'바뀐 것만' 골라 작업할 때. (기준 스냅샷은 바꾸지 않음)"),
    ("diff    · 기준 스냅샷 갱신(--update)", act_diff_update,
     "지금 상태를 새 비교 기준(스냅샷)으로 저장합니다. 변경분을 반영하고, 다음 diff 부터 "
     "여기를 기준으로 비교합니다."),
    ("── SwiftUI ───────────", None, ""),
    ("extract · SwiftUI 경량 입력 생성", act_extract,
     "design-data.json 에서 base64 이미지를 뺀 가벼운 swiftui-input.json 을 만듭니다. 화면 "
     "이름 일부로 필터해 한 화면씩 뽑을 수 있어요. SwiftUI 변환용 입력."),
    ("icon-ids · 아이콘ID 맵 생성", act_iconids,
     "pen-nodes.json 에서 '아이콘이름 → 대표 노드ID' 맵(_icon_ids.json)을 만듭니다. 이 맵으로 "
     "Claude 가 아이콘 PDF 를 뽑아 이름 붙입니다."),
    ("pad-icons · 아이콘 PDF 정사각 정규화", act_padicons,
     "추출된 아이콘 PDF(보이는 선에 tight-crop 됨)를 균일 정사각 캔버스로 넓혀 정규화합니다. "
     "iOS 에서 크기·정렬이 일관되게. 대상은 Asset Catalog 아이콘 폴더."),
    ("── ────────────────", None, ""),
    ("종료", "quit", "런처를 종료합니다."),
]

# ---------- curses 메뉴 루프 ----------
def _wrap_wide(text, width):
    """한글(2셀 폭) 고려한 줄바꿈."""
    lines, cur, cw = [], "", 0
    for ch in text:
        cwid = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if cw + cwid > width:
            lines.append(cur); cur, cw = ch, cwid
        else:
            cur += ch; cw += cwid
    if cur:
        lines.append(cur)
    return lines

def draw(stdscr, idx, state):
    stdscr.clear()
    h, w = stdscr.getmaxyx()
    stdscr.addstr(0, 0, "pencil-kit 런처  (↑/↓ 이동 · Enter 실행 · q 종료)"[:w - 1], curses.A_BOLD)
    data = state.get("data") or "(미설정 — 첫 항목에서 지정)"
    stdscr.addstr(1, 0, f"데이터: {data}"[:w - 1], curses.A_DIM)

    help_top = max(4, h - 5)                    # 하단 설명 패널 시작 줄
    for i, item in enumerate(MENU):
        label, action = item[0], item[1]
        y = 3 + i
        if y >= help_top:
            break
        if action is None:                       # 구분선
            stdscr.addstr(y, 2, label[:w - 3], curses.A_DIM)
        elif i == idx:
            stdscr.addstr(y, 0, ("▶ " + label)[:w - 1], curses.A_REVERSE)
        else:
            stdscr.addstr(y, 2, label[:w - 3])

    # 선택 항목 설명 (하단 고정)
    desc = MENU[idx][2] if len(MENU[idx]) > 2 else ""
    if desc and help_top + 1 < h:
        try:
            stdscr.addstr(help_top, 0, "─" * (w - 1), curses.A_DIM)
            for j, line in enumerate(_wrap_wide(desc, w - 2)[:3]):
                stdscr.addstr(help_top + 1 + j, 1, line)
        except curses.error:
            pass
    stdscr.refresh()

def selectable(i, step):
    n = len(MENU)
    for _ in range(n):
        i = (i + step) % n
        if MENU[i][1] is not None:
            return i
    return i

def menu_loop(stdscr, state):
    curses.curs_set(0)
    idx = selectable(-1, 1)
    while True:
        draw(stdscr, idx, state)
        k = stdscr.getch()
        if k in (curses.KEY_UP, ord("k")):
            idx = selectable(idx, -1)
        elif k in (curses.KEY_DOWN, ord("j")):
            idx = selectable(idx, 1)
        elif k in (ord("q"),):
            return
        elif k in (curses.KEY_ENTER, 10, 13):
            action = MENU[idx][1]
            if action == "quit":
                return
            if callable(action):
                # curses 를 잠시 나갔다 정상 터미널에서 실행 (출력·탭완성 위해)
                curses.def_prog_mode(); curses.endwin()
                print("\033[2J\033[H", end="")  # 화면 클리어
                try:
                    action(state)
                except Exception as e:
                    print(f"오류: {e}")
                input("\n[엔터] 메뉴로 돌아가기...")
                curses.reset_prog_mode(); stdscr.clear(); stdscr.refresh()

def main():
    if not sys.stdout.isatty():
        print("이 런처는 대화형 터미널에서 실행하세요 (python3 launcher.py).")
        print("스크립트를 직접 쓰려면 README.md 참고.")
        return
    state = {"data": load_last()}
    if not state["data"]:
        # 시작하자마자 데이터 폴더부터 (일반 터미널이라 Tab 완성 동작)
        print("pencil-kit 런처 — 먼저 데이터 폴더(<프로젝트>/export)를 지정하세요. (Tab 자동완성)")
        act_set_data(state)
    curses.wrapper(menu_loop, state)
    print("종료했습니다.")

if __name__ == "__main__":
    main()
