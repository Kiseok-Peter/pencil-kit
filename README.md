# pencil-kit — Pencil → Figma / SwiftUI 변환 키트

Pencil `.pen` 디자인을 **Figma(편집 가능 레이어)** 또는 **SwiftUI(iOS 코드)** 로 옮기는 범용 키트입니다.
Figma 직접 연동이 없어서, Pencil MCP로 추출한 JSON을 중간 산출물로 삼아 변환합니다.

## 요구사항

| | 무엇에 필요 |
|---|---|
| **Python 3.6+** | `build.py` 등 스크립트·런처. 외부 패키지 불필요(표준 라이브러리만) — `pip install` 없음 |
| **Pencil v1.2.2+ MCP** (Claude Code 등) | `.pen` 은 암호화되어 있어 추출·아이콘 PDF 뽑기는 MCP 로만 가능. v1.2.2 에서 MCP 도구 세트가 전면 교체됨(`get_app_state`+`execute`) — 절차는 RUNBOOK.md |
| **Figma 데스크톱** | Figma 파이프라인에서 플러그인(`manifest.json`) 임포트용 |
| **Node.js** (선택) | 플러그인 오프라인 검증(`node test/verify-bindings.js`)에만 필요. 변환 자체에는 불필요 |

## 설치

```bash
git clone <이 저장소 URL>
cd pencil-kit
python3 launcher.py        # 바로 실행 (설치 단계 없음)
```

## 폴더 구조 (키트 ↔ 데이터 분리)

이 `pencil-kit/` 은 **프로젝트 무관 범용 키트**입니다. 프로젝트별 데이터는 각 프로젝트 폴더의 `export/` 에 둡니다.

```
pencil/
  pencil-kit/                 ← 이 폴더 (스크립트·플러그인·범용 문서, 재사용)
  <프로젝트>/
    <프로젝트>.pen
    images/                   ← .pen 의 이미지 원본
    export/                   ← 이 프로젝트의 데이터 (아래 파일들)
      pen-nodes.json          Pencil MCP(execute+Get) 추출 노드 트리 (컴포넌트+화면)
      variables.json          색상/숫자/문자 토큰 (light/dark)
      typography-styles.json  타이포 프리셋 (make-typography-styles.py 산출물 — 프리셋의 단일 진실)
      typography-aliases.json (선택) 역할 별칭 — 손으로 관리, 값 없이 프리셋을 가리킴
      design-data.json        build.py 산출물 (Figma 플러그인 입력, 이미지 base64 임베드)
      SCREEN-MODULE-MAP.md     (SwiftUI) 화면→Feature 모듈 매핑 — 프로젝트별
      _link_*.json _screen_ids.json  분석 기록
```

> 다른 Pencil 프로젝트에 쓰려면 `pencil-kit/` 은 그대로, 데이터만 `<새프로젝트>/export/` 에 새로 쌓으면 됩니다.

## 빠른 시작 — 통합 런처

옵션을 일일이 외울 필요 없이 **런처 하나로** 스크립트 작업을 고릅니다 (표준 라이브러리만, ↑/↓ 화살표 + Tab 경로완성):

```bash
cd pencil-kit && python3 launcher.py
```
데이터 폴더를 한 번 지정하면 기억되고, build/verify/diff/extract/아이콘 작업을 메뉴에서 실행합니다.
> MCP 필요한 단계(.pen 추출·아이콘 PDF·SwiftUI 코드생성)는 런처가 아니라 Claude(RUNBOOK/SWIFTUI-RUNBOOK)가 합니다.

## 키트 구성

| 파일 | 역할 | 파이프라인 |
|---|---|---|
| `launcher.py` | **통합 런처**(화살표 메뉴+탭완성) — 아래 스크립트를 감쌈 | 진입점 |
| `build.py` | pen-nodes+variables+images → `design-data.json` | 공통 |
| `merge-nodes.py` | 부분 추출 결과(part)를 id 기준 병합 — 증분 추출 지원 | 공통 |
| `verify.py` | export 데이터 무결성 검증(ref·절단·아이콘·변수·타이포·프리셋 커버리지·아이콘 크기 규격) | 공통 |
| `make-typography-styles.py` | `DS - Typography` 프레임 → `typography-styles.json` (Figma Text Style · iOS 프리셋 공용 원본). 카탈로그 자기점검 2종 포함 — 라이트·다크판 대조, 설명글·실제값 대조 | 공통 |
| `diff.py` | 지난 스냅샷 대비 변경(컴포넌트/화면/토큰 +~-) 감지 | 공통 |
| `PENCIL-MCP-NOTES.md` | `.pen` 편집 시 MCP 함정 모음(실측) | 공통 |
| `manifest.json` `code.js` `ui.html` | Figma 플러그인 본체 | Figma |
| `test/verify-bindings.js` | 플러그인 오프라인 검증(Figma 없이 `node` 로) | Figma |
| `RUNBOOK.md` | Figma 변환 절차(추출→빌드→임포트) | Figma |
| `extract-for-swiftui.py` | design-data → 경량 `swiftui-input.json`(화면 선택) | SwiftUI |
| `make-icon-ids.py` | pen-nodes → 아이콘ID 맵 `_icon_ids.json` | SwiftUI |
| `pad-icons.py` | 추출된 아이콘 PDF를 균일 정사각으로 정규화 | SwiftUI |
| `make-icon-sheet.py` | 아이콘 PDF 폴더 → 검수 시트 `icons/_review.html` (그림 + 추출 원본 크기·잉크 위치, 어긋난 것 표시) | SwiftUI |
| `SWIFTUI-GUIDE.md` | Pencil→SwiftUI 매핑 규칙 | SwiftUI |
| `SWIFTUI-RUNBOOK.md` | SwiftUI 변환 단계별 런북 | SwiftUI |

## 스크립트 사용법 (`--data` 로 데이터 폴더 지정)

모든 스크립트는 `--data <데이터폴더>` 로 대상 프로젝트의 `export/` 를 가리킵니다 (생략 시 현재 폴더 CWD, 또는 환경변수 `PENCIL_DATA`).

```bash
cd pencil-kit
# design-data.json 빌드 (.pen 수정 후):  --data <export폴더>  [펜프로젝트폴더(images 위치)]
python3 build.py --data ../초코로드/export ../초코로드
# SwiftUI 경량 입력 (화면 부분매칭)
python3 extract-for-swiftui.py --data ../초코로드/export "리뷰 작성"
# 아이콘ID 맵
python3 make-icon-ids.py --data ../초코로드/export
# 아이콘 PDF 정사각 정규화 (Asset Catalog 폴더 대상) — --canvas 는 대표 노드 크기
python3 pad-icons.py <아이콘PDF폴더> --canvas 24
# 아이콘 검수 시트 (경고 0 이어야 정상)
python3 make-icon-sheet.py --data ../초코로드/export
# 타이포 프리셋 배출 (DS - Typography 프레임 → 프리셋 JSON)
#   --check = "전부 맞춰져 있나" 확인 모드: 프레임↔JSON 어긋남 + 카탈로그 자기점검을 전부 실패로 본다
python3 make-typography-styles.py --data ../초코로드/export
# 무결성 검증 (변환 전 프리플라이트; --strict-typo = 타이포 토큰화 + 프리셋 커버리지 게이트)
python3 verify.py --data ../초코로드/export
# 부분 추출 병합 (증분 재추출 — RUNBOOK.md 절차 5~6)
python3 merge-nodes.py --data ../초코로드/export --inventory _inventory.json
# 변경 감지 (재추출 후 바뀐 것만 확인) — --update 로 기준 갱신
python3 diff.py --data ../초코로드/export
# 플러그인 오프라인 검증 (code.js 를 고쳤다면 — Figma 없이 시각 회귀 0 을 증명)
node test/verify-bindings.js --data ../초코로드/export
```

> `verify-bindings.js` 는 `figma` API 를 스텁으로 갈아끼워 `code.js` 를 `vm` 에 격리 실행한다.
> 핵심은 **쌍둥이 차분** — 같은 데이터를 바인딩 ON/OFF 로 각각 임포트해 트리를 비교하고, 차분이 0이면
> "바인딩이 시각 결과를 바꾸지 않는다"가 증명된다. Figma 의 실동작이 문서와 어긋나는 경우(폰트 미설치,
> 굵기 변수 무반응, 행간 단위 강제 등) 5종을 모두 돌린다.

## 동작 원리 (Figma)

```
.pen ──(Pencil MCP)──▶ export/pen-nodes.json ──(build.py)──▶ export/design-data.json ──(플러그인)──▶ Figma
```

- **컴포넌트 먼저** → Figma Component 등록 → 화면의 `ref` 를 **인스턴스**로 연결 (descendants 오버라이드)
- **토큰 → Figma Variables** 컬렉션 (플러그인 UI에서 이름 지정, 기본 "Pencil Tokens", light/dark 모드)
  - 색(COLOR)은 fill/stroke 에, 타이포(fontSize·fontFamily·fontWeight·letterSpacing)와 cornerRadius 는 해당 필드에 **바인딩**된다
  - 리터럴을 먼저 정확히 대입한 뒤 바인딩하고, 리드백이 어긋나면 되돌린다 → 바인딩이 실패해도 **결과물이 나빠지지 않는다**
  - `lineHeight` 는 Figma 가 변수 바인딩 시 단위를 PIXELS 로 강제해서 제외 (자세히는 RUNBOOK.md)
- **lucide 아이콘** → 플러그인이 unpkg/jsdelivr CDN에서 SVG 받아 벡터화
  - **아이콘마다 단일 컴포넌트**(24px, 선을 면으로 구움 → `DS - Icon Components` 페이지)를 만들고 화면에는 인스턴스만 리사이즈해 배치 — 라이브러리에서 재사용·스왑 가능. 인스턴스의 아이콘 교체 오버라이드는 `swapComponent` 로 적용(컴포넌트 연결 유지). `outlineStroke`/스왑 미지원 환경이면 크기별 마스터 → 기존 벡터 방식 순으로 자동 폴백
- **이미지** → base64 → `figma.createImage` fill
- **auto-layout / 패딩 / 정렬 / fill_container·fit_content / absolute** → Figma auto-layout 매핑

`code.js` 지원 범위:
- 노드: `frame` `group` `text` `icon`(lucide 등) `ref`(인스턴스) `rectangle` `ellipse` `polygon` `path` `line`
- fill: 단색·변수 바인딩·이미지·그라데이션(linear/radial/angular)·다중 fill
- 레이아웃: auto-layout, fill_container/fit_content/고정, absolute(`layoutPosition`), 회전, cornerRadius(개별), stroke(정렬/두께/per-side), shadow/blur, 텍스트 wrapping
- 건너뜀: `note` `prompt` `context` `connection` `script` / 미지원: shader·mesh_gradient fill, material·phosphor 아이콘

## 두 파이프라인 진입점

- **Figma 변환** → `RUNBOOK.md` ("RUNBOOK 보고 Figma로 변환해줘")
- **SwiftUI 변환** → `SWIFTUI-RUNBOOK.md`(단계별) + `SWIFTUI-GUIDE.md`(규칙) + 프로젝트의 `export/SCREEN-MODULE-MAP.md`(모듈 매핑)

## 알려진 한계
- 아이콘은 lucide 기준 / 이미지는 기본 최대 600px 다운스케일(`MAX_DIM` 조정)
- shader/mesh_gradient fill 미구현 / 폰트는 Figma에 해당 Google Font 필요(Outfit·Inter 기본 제공)
- SwiftUI 아이콘은 Pencil PDF가 tight-crop 되므로 `pad-icons.py --canvas <노드크기>` 필수,
  이어서 `make-icon-sheet.py` 로 경고 0 확인 (자세히는 SWIFTUI-GUIDE.md)

## 라이선스

[MIT](LICENSE) — 자유롭게 사용·수정·재배포 가능.
