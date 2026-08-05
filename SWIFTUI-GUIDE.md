# design-data.json → SwiftUI 변환 가이드

Figma 없이, **다른 컴퓨터의 Claude Code에 이 JSON을 주면서 SwiftUI로 변환**하는 방법입니다.
특별한 에이전트·스킬·MCP 불필요 — 일반 Claude Code 세션이 JSON을 읽어 SwiftUI를 만듭니다.

## 0) 핸드오프 준비 (pencil-kit 폴더에서, `--data` 로 프로젝트 export 지정)

base64 이미지가 든 `design-data.json`(수 MB)을 통째로 주면 무거우니, **경량 입력**을 만드세요:

```bash
cd pencil-kit
python3 extract-for-swiftui.py --data ../초코로드/export "<화면이름 일부>"   # 한 화면 + 의존 컴포넌트만
python3 extract-for-swiftui.py --data ../초코로드/export                      # 전체
```
→ `<export>/swiftui-input.json` 생성 (구조 + 토큰 + 이미지 파일명만, base64 제거).

> 화면 하나씩 변환하는 걸 권장합니다 (작고, 결과 검토가 쉬움).

## 1) 작업 컴퓨터의 Claude Code에 줄 프롬프트 (그대로 복붙)

> 이 `swiftui-input.json`은 Pencil 디자인을 추출한 거야. `pencil-kit/SWIFTUI-GUIDE.md`의 매핑 규칙대로 **SwiftUI로 변환**해줘.
> - `variables`(토큰)는 light/dark를 가진 `Color` 에셋 또는 테마 enum으로
> - `components`(reusable)는 **재사용 SwiftUI View**로, 각 `screens`는 그 View들을 조립해서
> - 레이아웃/스타일/토큰만 생성하고, 상태·로직·네비게이션은 TODO 주석으로 비워둬

(가이드 파일도 같이 그 컴퓨터로 복사해두면 Claude가 참조합니다.)

## 2) 매핑 규칙 (Pencil → SwiftUI)

| Pencil | SwiftUI |
|---|---|
| `frame` `layout:"vertical"` | `VStack(alignment:, spacing: gap)` |
| `frame` `layout:"horizontal"` | `HStack(alignment:, spacing: gap)` |
| `frame` `layout` 없음 | 기본 `HStack` (Pencil 기본=horizontal) |
| `layout:"none"` | `ZStack` + `.offset`/절대배치 |
| `padding` | `.padding(.init(top:leading:bottom:trailing:))` |
| `justifyContent` | 메인축 정렬 (`Spacer()` 또는 stack alignment) |
| `alignItems` | stack `alignment` |
| `width/height: 숫자` | `.frame(width:height:)` |
| `fill_container` | `.frame(maxWidth: .infinity)` (또는 maxHeight) |
| `fit_content` / 생략 | 내용 크기 (frame 미지정) |
| `text` + **`preset`** | `Text(content).dsText(.프리셋)` — 프리셋이 크기·굵기·행간·자간을 통째로 소유 (3-1절). `preset` 이 없을 때만 아래 낱개 매핑으로 폴백 |
| `fontFamily` (`"Outfit"` / `$font-*` 변수 참조여도) | **무시** — 항상 `.system` (고정 규칙 1) |
| `fontSize` (숫자 / `$fontsize-*`) | `.font(.system(size:))` — pt 그대로 |
| `fontWeight` `"400"`·`"normal"` / `"500"` / `"600"` / `"700"` | `.regular` / `.medium` / `.semibold` / `.bold` |
| `lineHeight` (fontSize **배수**: 1.5 등) | `.lineSpacing(fontSize × (배수 − 1))` ⚠️ SwiftUI 는 "줄 사이 추가 여백(pt)" — 배수를 그대로 넣으면 오변환. 미지정(대부분)이면 `.lineSpacing` 붙이지 않음(시스템 기본) |
| `letterSpacing` (**pt**: 1, 0.5, −1) | `.tracking(값)` |
| `textAlign` | `.multilineTextAlignment(.leading/.center/.trailing)` |
| `textAlignVertical` | 프레임 `alignment` (`.frame(…, alignment: .top/.center/.bottom)`) 또는 `VStack`+`Spacer()` |
| `fontStyle:"italic"` | `.italic()` |
| `textGrowth:"fixed-width"` | `.frame(maxWidth:, alignment:)` + 줄바꿈 허용 (그 외: `auto`=한 줄·크기 자동 → `.fixedSize()`, `fixed-width-height`=`.frame(width:height:)`) |
| `fill: "$토큰"` | `Color("토큰")` 또는 `Theme.토큰` |
| `fill: "#hex"` | `Color(hex: "...")` |
| `fill: {type:"image"}` | `AsyncImage`/placeholder `Rectangle` (⚠️ 목업이라 번들 X — "고정 규칙" 참고) |
| `fill: {type:"gradient"}` | `LinearGradient`/`RadialGradient` |
| `cornerRadius` | `.cornerRadius()` 또는 `.clipShape(RoundedRectangle())` |
| `stroke` + `strokeWidth` | `.overlay(RoundedRectangle().stroke())`; per-side는 `.border` 대용 |
| `effect:{type:"shadow"}` | `.shadow(color:radius:x:y:)` |
| `effect:{type:"blur"}` | `.blur(radius:)` |
| `icon`(lucide) | **Pencil PDF 벡터** (5절) — Asset Catalog Template. SF Symbols 는 급할 때 대안 |
| `ref` (인스턴스) | 해당 컴포넌트 View 호출, `descendants` → 파라미터/오버라이드 |
| `descendants` | **배열이 아니라 `{자식id: 오버라이드}` 객체.** 값에 `type` 이 있으면 그 자리를 통째로 갈아끼우는 **교체 트리**, 없으면 **속성만 덮어쓰기** |
| `slot: []` (프레임의 **속성** — 노드 타입 아님) | 인스턴스가 자식 트리를 갈아끼우면 `@ViewBuilder` 파라미터, 라벨만 바꾸면 구체 파라미터 |
| `context: "platform-chrome"` | **코드 생성 대상 아님** — OS 가 그리는 영역(상태바·홈 인디케이터). 직접 그리면 실기기에서 두 벌로 겹친다 |
| `context: "native-substitute:ios"` | iOS 만 시스템 컨트롤로 대체(`NavigationStack` 툴바·`TabView`). **다른 플랫폼은 디자인대로 그린다** |
| `opacity` / `rotation` | `.opacity()` / `.rotationEffect()` |

## ⚠️ 고정 규칙 (이 프로젝트 — 반드시 지킬 것)

**1. 폰트 = 시스템 폰트만. (무시 대상은 "패밀리"뿐)**
- **패밀리** 토큰(`font-body`/`font-heading`="Outfit", `font-system`="Inter")은 **커스텀 폰트지만 무시**한다.
- **`Font.custom("Outfit")` / `Font.custom("Inter")` 절대 금지.** 항상 `.font(.system(size:, weight:))` 사용.
- 폰트 파일 추가·`Info.plist`(`UIAppFonts`) 등록 **불필요** (시스템 폰트라 필요 없음).
- 단, **타이포 스케일 토큰은 소비한다**: `fontsize-*`(number)→size, `fontweight-*`(string "400"~"700")→`Font.Weight`,
  `lineheight-*`(number 배수)→`.lineSpacing` 환산, `tracking-*`(number pt)→`.tracking`. 무시하는 건 패밀리뿐.
- ※ 생성 AI 가 토큰에서 "Outfit"을 보면 습관적으로 `Font.custom` 을 넣는다 — **넣지 마라.**

**2. 이미지 fill = 전부 목업 → 번들하지 않는다.**
- `design-data.json`/`imageRefs`의 이미지(식당 사진·히어로·리뷰 사진·온보딩 일러스트 전부)는 **AI 생성 목업**이다.
- 실제 이미지는 런타임(API/사용자 업로드)에 채워짐 → **Asset Catalog 에 번들 금지.**
- 이미지 fill → `AsyncImage(url:)` 또는 회색 placeholder `Rectangle`/`Color("surface")` + `// TODO: 실제 이미지 소스(데이터 레이어)` 로 생성.
- (예외: 나중에 진짜 정적 아트가 생기면 그때만 선별 번들. 지금은 없음.)

**3. 아이콘 = Pencil PDF 벡터** (5절). 사진(래스터)과 달리 아이콘은 벡터라 PDF. 혼동 주의.

## 3) 토큰(변수) → Color / 상수

`variables`는 `{themes:{mode:[light,dark]}, variables:{name:{type, value:[{theme,value}]}}}` 구조.
- **color** 변수 → Asset Catalog의 Color Set(Any/Dark 두 값) 또는 `Color` extension
- **number** 변수(`radius-*`, `spacing-*`, `border-*`, `fontsize-*`, `lineheight-*`, `tracking-*`) → 상수(`enum DSSpacing { static let s16=16.0 }` 류)
- **string** 변수는 둘로 갈린다:
  - `font-body`/`font-heading`/`font-system` (패밀리) → **무시** (고정 규칙 1. 폰트 이름 상수 만들지 않음)
  - `fontweight-*` (값 "400"~"700") → **소비** — `Font.Weight` 매핑 상수로 ("string 전부 무시" 아님!)

라이트/다크는 Asset Catalog가 자동 전환하므로, 토큰을 Color Set으로 만들면 다크모드가 공짜로 됩니다.

### 3-1) 타이포: **프리셋을 쓴다. 낱개 토큰은 프리셋 정의에서만 참조한다.**

`swiftui-input.json` / `design-data.json` 의 **`typographyStyles`** 가 단일 진실이다.

```json
"typographyStyles": {
  "styles": {
    "body-emphasis":        { "group":"body", "fontFamily":"font-body",
                              "fontSize":"fontsize-body", "fontWeight":"fontweight-semibold" },
    "body-small-multiline": { "group":"body", "fontFamily":"font-body",
                              "fontSize":"fontsize-body-small", "fontWeight":"fontweight-regular",
                              "lineHeight":"lineheight-body", "multiline": true }
  },
  "aliases": { "input-text": "body", "chip-label": "label-subtle" }
}
```

- 각 텍스트 노드에는 **`preset` 필드**가 붙어 있다(`extract-for-swiftui.py` 주입) → 그 이름을 그대로 쓴다.
  인스턴스 오버라이드도 마찬가지다 — `descendants` 의 교체 subtree 는 그 안 텍스트 노드에,
  부분 오버라이드(굵기만 바꾸는 식)는 마스터 축과 합성해 오버라이드 객체에 붙는다.
  **필드가 없으면 진짜 프리셋 밖 조합**이므로 낱개 폴백 후 상류에 알린다.
- **`preset` 이 붙은 노드에는 낱개 5축이 아예 없다.** `extract-for-swiftui.py` 가 프리셋이 소유한
  축(`fontFamily`·`fontSize`·`fontWeight`·`letterSpacing`·`lineHeight`)을 지우고 내보낸다.
  값이 같은 순수 중복이었는데, `lineSpacing`·`tracking` 은 **더해지는 값**이라 프리셋을 적용한 뒤
  낱개 축을 또 읽으면 조용히 벌어졌다(실측: 컴포넌트 6곳 + 화면 50곳).
- **`aliases` 는 값을 갖지 않는다** — 가리키는 프리셋에 위임한다. 복제하면 두 벌이 갈라진다.
- **미지정 축은 키가 없다** = "그 축을 건드리지 않는다". `lineHeight` 키가 없으면 `.lineSpacing` 을 붙이지 않는다.
- **`multiline: true`** 는 여러 줄 전용(행간 포함). 단일라인에 쓰면 줄간격이 벌어진다 —
  실측상 이 디자인의 행간은 `textGrowth: fixed-width` 노드에만 붙는다.

> ⚠️ **낱개 축을 공개 API 로 노출하지 마라.** `dsText(.appTitle, .bold).tracking(...)` 처럼 되면
> 호출부가 매번 조합을 기억해야 하고, 프리셋을 바꿔도 호출부가 안 따라온다. 공개하는 건 프리셋뿐이다.

프리셋이 참조하는 **낱개 토큰의 접두 규약** (프리셋 정의를 구현할 때만 쓴다):

| 접두 | 타입 | 예 | SwiftUI |
|---|---|---|---|
| `fontsize-` | number | `fontsize-body: 15` | `.font(.system(size:))` 의 size |
| `fontweight-` | **string** | `fontweight-body: "500"` | `Font.Weight` (`.medium`) |
| `lineheight-` | number (배수) | `lineheight-body-small: 1.5` | `.lineSpacing(size × (배수−1))` |
| `tracking-` | number (pt) | `tracking-app-title: -1` | `.tracking(-1)` |

> **왜 프리셋이 별도 파일인가**: Pencil·Figma 모두 변수 타입이 4종(bool/color/number/string)뿐이라
> "세트"를 변수로 등록할 수 없다. 그래서 프리셋의 단일 진실을 `.pen` 의 `DS - Typography` 프레임에 두고
> `make-typography-styles.py` 가 기계가독 형태로 옮긴다. Figma 는 같은 파일로 **Text Style** 을 만든다.

> 이름 규칙: iOS `Scripts/gen-design-tokens.py` 가 **첫 하이픈 앞** 세그먼트로 버킷을 분류한다
> (`name.partition("-")`). `font-size-body` 는 버킷이 `font` 로 잡혀 **에러** — `fontsize-body` 처럼 붙여 쓴다.
> `fontweight-*` 를 number 로 만들면 Pencil 이 타입 에러로 거부한다(string 필수).

### 3-0) 이미지: 에셋 vs 콘텐츠 (노드 이름으로 구분)

| 노드 이름 접두 | 뜻 | SwiftUI |
|---|---|---|
| `asset/…` | 앱에 번들되는 **에셋** (온보딩 일러스트 등) | Asset Catalog → `Image("onboarding-1")` |
| `content/…` | 서버·사용자가 채우는 **콘텐츠** (식당 사진·리뷰 사진·썸네일) | `AsyncImage` + placeholder. **에셋으로 만들지 말 것** |

> 초코로드 실측: image fill 45곳 중 에셋은 **3곳**(온보딩 1·2·3)뿐이고 나머지는 전부 목업용 더미 콘텐츠다.
> Unsplash 원격 URL 도 콘텐츠이므로 다운로드 대상이 아니다.

### 3-2) 치수 토큰 접두 규약 (치수 토큰화 Phase 에서 도입)

| 접두 | 타입 | 명명 | 예 | SwiftUI |
|---|---|---|---|---|
| `spacing-` | number | **값 기반** (`spacing-<값>`) | `spacing-16: 16` | `gap`→stack `spacing:`, `padding`→`.padding()` |
| `radius-` | number | t-shirt(구) + 값 기반(신) 혼재 | `radius-md: 12`, `radius-18: 18` | `.cornerRadius()` / `RoundedRectangle` |
| `border-` | number | 시맨틱 | `border-thin: 1`, `border-thick: 2` | `.stroke(lineWidth:)` / `.border()` |
| `iconsize-` | number | **값 기반** (11종: 12·14·16·18·20·22·24·28·36·44·48) | `iconsize-20: 20` | 아이콘 `.frame(width:height:)` |
| `controlheight-` | number | **값 기반** (4종: 44·48·52·56) | `controlheight-52: 52` | 버튼·입력 등 컨트롤 높이 |

> ⚠️ **`iconsize-*`·`controlheight-*` 는 노드에 바인딩되어 있지 않다.** Pencil 이 `width`/`height` 의
> 변수 참조를 무시하기 때문에(스키마엔 있으나 구현이 안 따름 — `PENCIL-MCP-NOTES.md` 8번)
> 노드에는 숫자가 그대로 남는다. **토큰은 "허용된 값 목록"** 이고, 규격 밖 크기가 새는 것은
> `verify.py` 의 아이콘 크기 게이트가 막는다. 생성기는 이 정의로 스케일만 만들면 된다.
>
> **`controlheight-*` 대상이 아닌 것**: 원형 아바타(`radius-full`)·아이콘 감싸개·아이콘 서클.
> 값이 48·44·56 으로 같아도 의미가 달라 공유하면 안 된다(실측: 아바타 2곳·감싸개 1곳·서클 2곳).
>
> `spacing-xs/sm/md/lg/xl` 5개는 **미사용 레거시**다(값 기반 신설 전 선언만 있었음) — 생성기에서 건너뛰거나
> 값 기반과 함께 생성해도 무방하나, 화면 데이터는 값 기반만 참조한다.
> `padding` 의 `0` 만 의도적 리터럴 — 나머지는 전부 토큰(예전에 예외였던 탭바 `21` 은 `spacing-20` 으로 통일).
> `strokeWidth` 는 면별 dict(`{top:"$border-thin"}`)로도 온다 — per-side `.overlay` 로 처리.

## 4) 컴포넌트 → 재사용 View

`components`(reusable=true)는 각각 SwiftUI `View`로:
- 컴포넌트의 텍스트/이미지 중 인스턴스가 오버라이드하는 것(`descendants`로 자주 바뀌는 값) → **View의 파라미터**
- 예: `Restaurant Card` → `struct RestaurantCard: View { let name, category, rating, distance, imageName ... }`
- 화면의 `ref` 인스턴스 → `RestaurantCard(name: "을지로 골목식당", ...)` 호출

## 5) 아이콘 → **Pencil PDF 추출** (권장)

이 프로젝트 아이콘 70종은 전부 **lucide(오픈소스)** 입니다. 하지만 가장 충실한 방법은
**Pencil이 렌더한 그대로 PDF로 추출**하는 것입니다 (Figma·SVG 불필요, 벡터 안정적).

**아이콘 PDF 추출은 `.pen`/Pencil MCP 가 있는 컴퓨터에서** 수행 (iOS 프로젝트 셋업 때 함께). 절차:
1. `python3 make-icon-ids.py --data <프로젝트>/export` → `<export>/_icon_ids.json` 생성 (`{아이콘이름: 대표노드ID}`, pen-nodes.json 기준)
   - **⚠️ 대표 노드를 아무거나 고르면 안 된다.** `export_nodes` 는 "그 노드가 화면에서 보이는 모습 그대로" 뽑으므로,
     사용처를 잡으면 크기(12~36px)와 색(흰색·브랜드색)이 제각각인 PDF 가 나온다. 스크립트가
     **라이트판 → `DS - *` 카탈로그 → 정사각 → 표준크기 → 표준색** 순으로 점수를 매겨 "규격 견본"을 고른다.
   - 실행 결과에 `✅ 전량 균일` 이 떠야 정상. `⚠️ 다크판에서 선택` 이 뜨면 그 아이콘은 **거의 흰색**으로 나온다
     (다크판 `$text-primary` = `#F5F4F1`). `⚠️ 크기 불일치` 가 뜨면 **획 두께가 달라진다** — 아래 3번으로도 못 고친다.
   - 경고가 뜨면 카탈로그(`DS - Icons`)에 **전 아이콘을 같은 크기·같은 색으로** 실어두면 사라진다.
2. Claude 가 각 노드ID 를 `export_nodes(filePath, outputDir, nodeIds:[ID], format:"pdf")` 로 추출
   (PDF 는 노드ID로 저장됨 → `_icon_ids.json` 로 `아이콘이름.pdf` 로 rename)
   - **아이콘당 1회 호출** (여러 노드ID 를 한 번에 주면 멀티페이지 1파일로 합쳐짐)
   - outputDir 은 iOS 프로젝트의 Asset Catalog 위치로 바로 지정하면 좋음
3. **⚠️ 패딩 정규화 (필수, 추출 직후 1회)**: `python3 pad-icons.py <아이콘PDF폴더> --canvas 24`
   - **이유**: `export_nodes` 는 **보이는 패스에 tight crop** 한다 (노드 박스도, lucide 내장 패딩도 무시).
     1번이 규격 견본을 제대로 골랐으면 24 그리드에 사방 1pt 여백이 있어 **전량 22×22 로 균일하게** 나오지만,
     대표 노드가 잘못 잡히면 아이콘마다 제각각이 된다 (초코로드 구본 실측: 13×7 ~ 22×22, 19종).
   - 이 스크립트가 각 PDF 의 MediaBox 만 **중앙 정사각**으로 넓혀 균일 캔버스로 만든다 (콘텐츠는 그대로 → 자동 중앙정렬, PDF 라이브러리 불필요).
   - **`--canvas <원본 노드 크기>` 를 반드시 준다** (1번에서 전량 24×24 로 확인됐으면 `--canvas 24`).
     생략하면 캔버스 = 폴더 내 최대 변 + 여백이라 원본 노드 박스가 복원되지 않고, `--per-file` 은 **파일별**
     상대 캔버스라 모든 아이콘이 `.frame()` 을 똑같이 꽉 채워 **chevron 이 x 만큼 커진다**(크기 관계 소실).
   - MediaBox 를 덮어쓰므로 **추출 직후 1회만** 실행한다. 두 번 돌리면 경고 수치가 콘텐츠가 아닌 이전 캔버스를 가리킨다(중심은 보존됨).
4. **검수 시트로 확인**: `python3 make-icon-sheet.py --data <프로젝트>/export` → `<export>/icons/_review.html`
   - 아이콘마다 **추출 원본 크기와 잉크 위치**를 같이 찍고, 최빈값과 다른 것을 빨갛게 표시한다.
   - **경고 0 이어야 정상.** 경고가 뜨면 그 아이콘은 1번의 대표 노드가 잘못 골라진 것이다.
5. Xcode: Asset Catalog 에 PDF 추가 → 'Preserve Vector Data' + 'Render As: Template Image'
6. 사용: `Image("heart").renderingMode(.template).resizable().scaledToFit().frame(width:24,height:24).foregroundColor(Color("text-primary"))`

> PDF 로 통일하는 이유: SVG 는 복잡한 패스에서 렌더러별로 깨질 수 있으나, PDF 벡터는 Xcode 네이티브 지원으로 안정적.
>
> **4번을 건너뛰면 안 되는 이유 (실측)** — 추출 원본이 제각각인 채로 3번을 돌리면 잉크가
> **가운데로 재정렬**되면서 lucide 가 의도한 자리에서 밀린다. 크기·획 두께는 그대로라 그림만
> 봐서는 안 보인다. 초코로드에서 70종 중 36종이 밀려 있었는데 35종은 0.5pt 이하라 눈에 안
> 띄었고, `star-half` 만 **5.5pt(24pt 중 23%)** 밀려 `star` 위에 겹쳐 그리는 별점이 어긋났다.
> 시트에 수치를 찍기 전까지 이걸 못 잡았다.

### (대안) SF Symbols 빠른 매핑

급할 때 근사치로 `Image(systemName:)` 사용 가능 — 단 lucide 와 모양이 달라 디자인과 100% 일치하지 않음.

| lucide | SF Symbol | | lucide | SF Symbol |
|---|---|---|---|---|
| apple | applelogo | | message-circle | message |
| arrow-right | arrow.right | | pen-line | pencil |
| battery-full | battery.100 | | phone | phone |
| bell | bell | | plus | plus |
| bookmark | bookmark | | refresh-cw | arrow.clockwise |
| bookmark-check | bookmark.fill | | rotate-ccw | arrow.counterclockwise |
| bookmark-plus | bookmark | | search | magnifyingglass |
| calendar | calendar | | settings | gearshape |
| calendar-check | calendar.badge.checkmark | | shield-check | checkmark.shield |
| camera | camera | | signal | cellularbars |
| check | checkmark | | star | star |
| chevron-down | chevron.down | | star-half | star.leadinghalf.filled |
| chevron-left | chevron.left | | store | storefront |
| chevron-right | chevron.right | | trash-2 | trash |
| circle | circle | | triangle-alert | exclamationmark.triangle |
| circle-check | checkmark.circle | | user | person |
| circle-x | xmark.circle | | user-x | person.fill.xmark |
| copy | doc.on.doc | | users | person.2 |
| crosshair | scope | | utensils-crossed | fork.knife |
| ellipsis | ellipsis | | wifi | wifi |
| eye | eye | | wifi-off | wifi.slash |
| fish | fish | | wine | wineglass |
| flame | flame | | x | xmark |
| globe | globe | | map-pin | mappin |
| heart | heart | | map-pin-check | mappin.circle.fill |
| image | photo | | map-pin-off | mappin.slash |
| info | info.circle | | lock | lock |
| list | list.bullet | | | |

**SF Symbols에 없음 (대체/번들 필요):**
`beef, beer, cake-slice, coffee, ice-cream-cone, salad, sandwich, soup` → 음식류: `fork.knife` 대체 또는 lucide SVG 번들
`instagram, youtube` → 브랜드: 번들 SVG 또는 공식 에셋

> 변환하는 Claude는 SF Symbol 이름이 실제 존재하는지 확인하고, 없으면 가장 가까운 것으로 대체하거나 번들 SVG로 폴백할 것.

## 6) 한계 (생성되는 것 / 아닌 것)

- ✅ 레이아웃(stack/spacing/padding), 스타일(색·모서리·그림자), 토큰(light/dark), 컴포넌트 구조
- ❌ 상태/바인딩/액션/네비게이션/네트워킹 — 이건 별도 (TCA Reducer 등은 골격만 TODO로)
- ✅ **폰트 = 시스템 폰트** (고정 규칙 1) → 폰트 파일·Info.plist 불필요
- ✅ **타이포 스케일(fontsize/fontweight/lineheight/tracking) = 토큰으로 생성** (3-1절 — Phase 2 도입 후)
- ✅ **이미지 = 목업, 번들 안 함** (고정 규칙 2) → AsyncImage/placeholder + TODO
- ✅ **아이콘 = Pencil PDF 벡터** (5절, `pad-icons.py` 정규화 필수)

## 한 줄 요약
**`extract-for-swiftui.py`로 화면 하나 뽑기 → 그 `swiftui-input.json` + 이 가이드를 작업 컴퓨터 Claude Code에 주고 "SwiftUI로 변환해줘".**
