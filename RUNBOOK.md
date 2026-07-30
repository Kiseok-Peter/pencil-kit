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

> 데이터 폴더는 `<프로젝트>/export/` (없으면 만든다). 아래 `<DATA>` = 그 경로, `<PEN>` = `.pen` **절대경로**.
> Pencil v1.2.2+ 기준 — MCP 는 `get_app_state` + `execute`(내부 `Get`/`GetVariables`) 를 쓴다.
> `execute` 는 **`filePath`(=`<PEN>`) 가 필수**이고, 데이터를 밖으로 내는 유일한 통로는 `Print(...)` 다.

### ⚠️ 토큰 비용 — 기본은 증분

- `execute` 는 파일을 직접 못 쓴다 → **`Print` → (에이전트 컨텍스트) → 파일 저장** 경로뿐이다.
- **전체 재추출 1회 ≈ 120~135K 토큰** (초코로드 기준). 그래서 **기본은 바뀐 화면만 뽑아 `merge-nodes.py` 로 병합**.
  "전부 재추출"은 사용자가 명시할 때만.
- `execute` 는 실패 시 블록 전체 롤백 → 큰 콜 하나가 죽으면 그 데이터 전량 유실. 청크를 작게.
- `Print` 응답 절단은 조용히 일어난다 → 파트마다 `merge-nodes.py --expect-ids` 로 대조.

### 단계

1. **스키마 확보 — 세션당 1회만** (응답이 커서 반복 호출 금지):
   `get_app_state(include_schema: true, include_canvas_design: true, include_scripts_and_shaders: false, include_browser: false)`
2. **인벤토리** (싸다 — 목록만). `execute` 로:
   ```js
   Get((n,c)=>{ if(c.depth===0){ Print(JSON.stringify({id:n.id,name:n.name,reusable:!!n.reusable})); c.skipChildren(); } })
   ```
   → 사용자에게 제시하고, 배열로 묶어 **`<DATA>/_inventory.json`** 저장 (나중에 삭제 감지용)
3. **사이즈 프로브** (청크 계획). 대상 id 들에 대해:
   ```js
   for (const id of ["ID1","ID2"]) Print(JSON.stringify(Get(id,{resolveVariables:false,resolveInstances:false,includePathGeometry:true})).length, id)
   ```
   문자수 ÷ 4 ≈ 토큰. 개별값으로 청크 경계를 정한다.
4. **컴포넌트 — 1콜 일괄** (초코로드 실측 52개 = 36K자 ≈ 9K 토큰):
   ```js
   const ids=[/* reusable 또는 필요분 */]
   Print(JSON.stringify(ids.map(id=>Get(id,{resolveVariables:false,resolveInstances:false,includePathGeometry:true}))))
   ```
   → 출력을 **`<DATA>/pen-nodes.part-components.json`** 저장
5. **화면 — 청크 반복** (청크 합계 ≤ 80K자 ≈ 20K 토큰; 더 큰 단일 화면은 그것만 1콜):
   4와 같은 스니펫, id 만 교체 → `pen-nodes.part-01.json`, `-02.json`, …
6. **병합**: `cd pencil-kit && python3 merge-nodes.py --data <DATA> --inventory _inventory.json`
   - `누락 ref` 가 보고되면 그 id 들만 5 로 추가 추출 후 재실행
   - 삭제된 노드가 보고되면 확인 후 `--prune`
7. **변수 — 항상 전체** (3~4KB 라 증분 불필요). `execute` 로 `Print(JSON.stringify(GetVariables()))`
   → **`{themes, variables}` 전체 그대로** `<DATA>/variables.json` 저장. 평탄화(`{이름:"#hex"}`) **금지** —
   테마별(light/dark) 값 + number/string 변수가 소실된다. (build 보다 먼저 — hex 역복원 맵의 기준)
8. **검증 → 빌드**:
   ```bash
   python3 verify.py --data <DATA> && python3 diff.py --data <DATA>
   python3 build.py --data <DATA> <펜프로젝트폴더>   # <펜프로젝트폴더> = images/ 가 있는 .pen 폴더
   ```
   → `<DATA>/design-data.json` 생성 → "Figma 데스크톱에서 플러그인 임포트" 안내

### `Get` 옵션 규약 (전 추출 공통)

| 옵션 | 값 | 이유 |
|---|---|---|
| `resolveVariables` | **false (필수)** | `$변수` 보존 = Figma 변수 바인딩 + 다크모드. `true` 로 뽑으면 색은 build.py 가 hex→`$` 역복원하지만 **number/string(타이포·spacing)은 복구 경로가 없다** → 그 데이터는 폐기하고 재추출 |
| `resolveInstances` | **false (항상 명시)** | `ref`+`descendants` 구조 유지. `true` 면 인스턴스가 전개돼 용량 폭발 + 컴포넌트 재사용 소실 |
| `includePathGeometry` | true | 벡터 패스 보존 |
| `depth` | 기본(전체) 또는 30 | 자식이 `"..."` 로 잘리면 depth 부족 — **그 id 만** 재조회 (merge 가 upsert) |

> 추출은 **읽기 전용 함수만** 쓴다(`Get`/`GetVariables`/`Print`). `execute` 는 쓰기(`Insert`/`Update`/`SetVariables`…)도
> 할 수 있으므로, 디자인 변경은 사용자가 명시 요청할 때만.

## Figma 토큰 바인딩 (플러그인이 하는 일)

플러그인은 `variables.json` 의 토큰을 **Figma Variables 로 만들고**(COLOR/FLOAT/STRING), 노드 속성에 바인딩한다.
UI 의 **"토큰 바인딩"** 체크박스를 끄면 색 변수만 만들고 나머지는 값으로 인라인한다(이전 동작).

| Pencil 속성 | Figma 필드 | 변수 타입 | 비고 |
|---|---|---|---|
| `fill` `stroke` | paint | COLOR | `setBoundVariableForPaint` |
| `fontSize` | `fontSize` | FLOAT | |
| `fontFamily` | `fontFamily` | STRING | **폰트가 실제 설치돼 있을 때만** 바인딩. 미설치 폰트를 걸면 텍스트 전체가 missing font 가 된다 |
| `fontWeight` | `fontWeight` | **FLOAT** | Pencil 은 string `"600"`, Figma 는 number 를 요구 → 플러그인이 `600` 으로 변환 생성 |
| `letterSpacing` | `letterSpacing` | FLOAT | Pencil·Figma 모두 px |
| `cornerRadius` | `cornerRadius` / per-side | FLOAT | |
| `gap` `padding` `strokeWidth` | `itemSpacing` / `padding*` / `strokeWeight` | FLOAT | 배관만 완료 — `.pen` 이 토큰화되면 자동 작동 |
| `lineHeight` | — | — | **바인딩 불가**(아래) |

**Figma Plugin API 제약 (실측·문서 확인)**
- `lineHeight` 에 number 변수를 걸면 **단위가 PIXELS 로 강제**된다. Pencil 의 `lineHeight` 는 배수(1.5)라 1.5px 이 되어버린다. 우회 방법이 없어 **영구 제외** — 변수는 만들되 `description` 으로 오용을 막고 렌더는 `PERCENT` 리터럴로 한다.
- `fontWeight` 는 `TextNode` 에서 **읽기 전용 number**(`fontName.style` 로만 실제 변경). number 변수 바인딩이 캔버스에 반영되지 않는다는 보고가 있어, 플러그인은 `fontName` 을 리터럴로 먼저 정확히 세팅한 뒤 바인딩을 덧붙인다 → 반영되든 무시되든 **시각은 동일**하고 Dev Mode 에는 토큰이 뜬다. 실제 반영 여부는 실행 로그의 `바인딩 프로브:` 줄에 나온다.
- `boundVariables` 의 **텍스트 필드 값은 배열**(`boundVariables.fontSize[0].id`), 노드 필드는 단일 별칭.

**안전 설계**: 모든 바인딩은 리터럴을 정확히 대입한 **뒤에** 시도하고, 직후 같은 속성을 다시 읽어 어긋나면 즉시 언바인딩 + 리터럴 복구한다. 최악의 경우에도 결과물이 바인딩 없는 것과 동일하다 — `node test/verify-bindings.js` 가 이를 기계적으로 증명한다.

임포트 후 UI 로그의 **`=== 토큰 바인딩 요약 ===`** 에서 필드별 `성공/되돌림/예외/건너뜀` 을 확인한다.
`되돌림`·`예외` 가 0 이 아니면 그 필드는 이 파일에서 기대대로 동작하지 않는 것이다.

---

## 무엇을 어디서 실행하나

| 단계 | 실행 위치 | 필요한 것 |
|---|---|---|
| 1. 추출 (`.pen` → `export/pen-nodes.json`, `variables.json`) | **프로젝트 컴퓨터** | Pencil 앱(v1.2.2+) + Claude Code — MCP `get_app_state` / `execute`(`Get`·`GetVariables`) |
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

→ Claude 가 위 "추출 절차" 1~7 수행 (읽기 전용). 이미지는 `.pen` 의 `images/` 에 이미 있어 별도 추출 불필요.

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
  레이아웃 수치 검증은 `execute` 의 `Get` 방문자에서 `ctx.bounds`/`ctx.problems` 로 (구 스냅샷 전용 도구는 v1.2.2 에서 제거됨).

## 한 줄 요약
**추출(읽기 전용) → `export/design-data.json` 자체 완결 → 그 파일 + 플러그인만 들고 Figma 컴퓨터에서 임포트.**
