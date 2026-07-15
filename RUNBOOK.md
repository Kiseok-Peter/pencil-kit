# 다른 컴퓨터에서 Pencil → Figma 변환하기 (이식 가이드)

이 `pencil-kit/` 은 **프로젝트 무관 범용 키트**입니다. 프로젝트 데이터는 `<프로젝트>/export/` 에 쌓입니다.
`.pen` 은 암호화 + 로컬 파일이라 **추출은 `.pen` 이 있는 컴퓨터에서만** 가능하고,
추출이 끝난 `design-data.json` 은 자체 완결(이미지 내장)이라 Figma 가 있는 아무 컴퓨터로나 옮길 수 있습니다.

## 폴더 구조
```
pencil-kit/                  ← 이 키트 (스크립트·플러그인, 재사용)
<프로젝트>/
  <프로젝트>.pen
  images/
  export/                    ← 이 프로젝트 데이터 (pen-nodes.json / variables.json / design-data.json)
```

## 한 줄 트리거 (프로젝트 컴퓨터의 Claude 에게)

`.pen` 을 Pencil 에서 열어둔 뒤, 그 컴퓨터의 Claude Code 에:

> **pencil-kit/RUNBOOK.md 보고 이 Pencil 프로젝트 Figma로 변환해줘**

- `RUNBOOK.md 보고` 를 꼭 넣으세요. 그래야 Claude 가 이 문서를 읽고 정확한 절차를 따릅니다.
- 기본 동작: **top-level 노드 목록 제시 → 고른 것만 + 의존 컴포넌트만 추출** → `export/` 에 저장 → `build.py`.
- 처음부터 다 가져오려면 "전부 변환해줘" 추가.

---

## Claude 가 따라야 할 추출 절차 (위 트리거를 받으면)

> 데이터 폴더는 `<프로젝트>/export/` (없으면 만든다). 아래 `<DATA>` = 그 경로.

1. `get_editor_state(include_schema: true)` 로 스키마 + top-level 노드 목록 확보 → 사용자에게 제시
2. 사용자가 고른 화면(top-level 프레임) 확인
3. **고른 화면 + 그 화면이 `ref` 로 쓰는 컴포넌트(전이 포함)** 를 `batch_get` 으로 추출
   - `includePathGeometry: true`
   - **`resolveVariables: false` (중요)** — 변수 참조(`$primary` 등)를 그대로 보존해야 Figma 변수 바인딩 + 다크모드 전환이 동작. `true` 면 색이 한 테마 hex 로 박제됨.
   - `readDepth` 를 충분히 크게(예: 14). 자식이 `"..."` 로 잘리면 그 ID 로 재조회 (많으면 묶음 나눠 추출 후 병합)
4. 추출 결과 배열을 **`<DATA>/pen-nodes.json`** 에 저장 (reusable=true 가 컴포넌트, 나머지가 화면)
5. `get_variables` 결과를 **JSON 전체(`{themes, variables}`) 그대로** **`<DATA>/variables.json`** 에 저장
   - 평탄화(`{이름:"#hex"}`) 금지 — 테마별(light/dark) 값 + number/string 변수 보존
6. **`cd pencil-kit && python3 build.py --data <DATA> <펜프로젝트폴더>`** → `<DATA>/design-data.json` 생성
   - `<펜프로젝트폴더>` = `images/` 가 있는 `.pen` 폴더 (생략 시 `<DATA>` 의 상위로 가정)
7. "Figma 데스크톱에서 플러그인 임포트" 안내

> 추출은 **읽기 전용**이라 원본 `.pen` 을 수정하지 않습니다.

---

## 무엇을 어디서 실행하나

| 단계 | 실행 위치 | 필요한 것 |
|---|---|---|
| 1. 추출 (`.pen` → `export/pen-nodes.json`, `variables.json`) | **프로젝트 컴퓨터** | Pencil 앱 + Claude Code(Pencil MCP) |
| 2. 빌드 (`build.py` → `export/design-data.json`) | 아무 컴퓨터 | Python 3 (macOS면 `sips` 자동) |
| 3. 임포트 (`design-data.json` → Figma) | Figma 쓰는 컴퓨터 | Figma **데스크톱** 앱 |

> 1~2를 끝내면 **`export/design-data.json` 한 파일 + 플러그인 3파일**(`pencil-kit/` 의 `manifest.json`/`code.js`/`ui.html`)만 들고 Figma 컴퓨터로 가면 됩니다.

---

## 프로젝트 컴퓨터에서 (1 + 2)

### 0) 키트 배치
`pencil-kit/` 을 프로젝트 컴퓨터로 복사. `.pen` 프로젝트 폴더 안에 `export/` 를 만들어 데이터를 모읍니다
(예: `초코로드/export/`). 키트와 `.pen` 프로젝트가 같은 상위 폴더에 있으면 경로가 단순해집니다.

### 1) 추출 — Claude Code 에게 (권장)
Pencil 에서 `.pen` 을 열고:

> "pencil-kit 으로 이 Pencil 프로젝트를 Figma로 변환할 거야. top-level 노드 목록 보여주고, 내가 고른 것만 `초코로드/export` 에 추출해줘."

→ Claude 가 위 "추출 절차" 1~5 수행 (읽기 전용). 이미지는 `.pen` 의 `images/` 에 이미 있어 별도 추출 불필요.

### 2) 빌드
```bash
cd pencil-kit
python3 build.py --data ../초코로드/export ../초코로드   # --data=export폴더, 마지막=images 위치
# MAX_DIM=1000 python3 build.py --data ... ...           # 이미지 화질/용량 조절
```
→ `초코로드/export/design-data.json` 생성 (수 MB, 화면 수 비례).

---

## Figma 쓰는 컴퓨터에서 (3)

`export/design-data.json` + `pencil-kit/` 의 `manifest.json`·`code.js`·`ui.html` 을 준비:

1. Figma **데스크톱** 앱 → `Plugins → Development → Import plugin from manifest…` → `pencil-kit/manifest.json`
2. `Plugins → Development → Pencil to Figma Import` 실행
3. 플러그인 창에서 `design-data.json` 선택 → **가져올 화면 체크 + 페이지 지정 + 변수 컬렉션명** → **가져오기**
4. lucide 아이콘은 자동으로 CDN(unpkg/jsdelivr)에서 받아옴 (인터넷 필요)

> 플러그인 임포트는 Figma **데스크톱 앱에서만** (웹 X).

---

## 체크리스트 / 문제 대응
- 빌드 후 플러그인 로그에 `=== 빌드 경고 ===` → 미지원 노드 타입. 매핑을 `code.js` 에 추가.
- 폰트 어긋남 → 해당 Google Font 가 Figma 에 있는지 확인 (Outfit/Inter 기본 제공).
- 한글 이상 → `code.js` 의 `resolveFont` 폴백을 한글 폰트로 조정.
- 레이아웃 깨짐 → Pencil `get_screenshot` 과 대조, 플러그인 로그의 노드 크기 확인.

## 한 줄 요약
**추출(읽기 전용) → `export/design-data.json` 자체 완결 → 그 파일 + 플러그인만 들고 Figma 컴퓨터에서 임포트.**
