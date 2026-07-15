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
| `text` | `Text(content)` + `.font(.system(size: fontSize, weight:))` |
| `fontWeight` "600"/"500"/"normal" | `.semibold`/`.medium`/`.regular` |
| `textGrowth:"fixed-width"` | `.frame(maxWidth:, alignment:)` + 줄바꿈 허용 |
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
| `opacity` / `rotation` | `.opacity()` / `.rotationEffect()` |

## ⚠️ 고정 규칙 (이 프로젝트 — 반드시 지킬 것)

**1. 폰트 = 시스템 폰트만.**
- 토큰의 폰트 패밀리(`font-body`/`font-heading`="Outfit", `font-system`="Inter")는 **커스텀 폰트지만 무시**한다.
- **`Font.custom("Outfit")` / `Font.custom("Inter")` 절대 금지.** 항상 `.font(.system(size:, weight:))` 사용.
- 폰트 파일 추가·`Info.plist`(`UIAppFonts`) 등록 **불필요** (시스템 폰트라 필요 없음).
- 토큰은 **size/weight 매핑에만** 쓴다. (600→`.semibold`, 500→`.medium`, normal→`.regular`)
- ※ 생성 AI 가 토큰에서 "Outfit"을 보면 습관적으로 `Font.custom` 을 넣는다 — **넣지 마라.**

**2. 이미지 fill = 전부 목업 → 번들하지 않는다.**
- `design-data.json`/`imageRefs`의 이미지(식당 사진·히어로·리뷰 사진·온보딩 일러스트 전부)는 **AI 생성 목업**이다.
- 실제 이미지는 런타임(API/사용자 업로드)에 채워짐 → **Asset Catalog 에 번들 금지.**
- 이미지 fill → `AsyncImage(url:)` 또는 회색 placeholder `Rectangle`/`Color("surface")` + `// TODO: 실제 이미지 소스(데이터 레이어)` 로 생성.
- (예외: 나중에 진짜 정적 아트가 생기면 그때만 선별 번들. 지금은 없음.)

**3. 아이콘 = Pencil PDF 벡터** (5절). 사진(래스터)과 달리 아이콘은 벡터라 PDF. 혼동 주의.

## 3) 토큰(변수) → Color

`variables`는 `{themes:{mode:[light,dark]}, variables:{name:{type, value:[{theme,value}]}}}` 구조.
- **color** 변수 → Asset Catalog의 Color Set(Any/Dark 두 값) 또는 `Color` extension
- **number** 변수(`radius-lg:14`, `spacing-md:16`) → 상수(`enum Spacing { static let md=16.0 }`)
- **string** 변수(`font-body:"Outfit"` 등) → **무시** (위 고정 규칙 1: 시스템 폰트만 씀. 폰트 이름 상수 만들지 않음)

라이트/다크는 Asset Catalog가 자동 전환하므로, 토큰을 Color Set으로 만들면 다크모드가 공짜로 됩니다.

## 4) 컴포넌트 → 재사용 View

`components`(reusable=true)는 각각 SwiftUI `View`로:
- 컴포넌트의 텍스트/이미지 중 인스턴스가 오버라이드하는 것(`descendants`로 자주 바뀌는 값) → **View의 파라미터**
- 예: `Restaurant Card` → `struct RestaurantCard: View { let name, category, rating, distance, imageName ... }`
- 화면의 `ref` 인스턴스 → `RestaurantCard(name: "을지로 골목식당", ...)` 호출

## 5) 아이콘 → **Pencil PDF 추출** (권장)

이 프로젝트 아이콘 65종은 전부 **lucide(오픈소스)** 입니다. 하지만 가장 충실한 방법은
**Pencil이 렌더한 그대로 PDF로 추출**하는 것입니다 (Figma·SVG 불필요, 벡터 안정적).

**아이콘 PDF 추출은 `.pen`/Pencil MCP 가 있는 컴퓨터에서** 수행 (iOS 프로젝트 셋업 때 함께). 절차:
1. `python3 make-icon-ids.py --data <프로젝트>/export` → `<export>/_icon_ids.json` 생성 (`{아이콘이름: 대표노드ID}`, pen-nodes.json 기준)
2. Claude 가 각 노드ID 를 `export_nodes(filePath, outputDir, nodeIds:[ID], format:"pdf")` 로 추출
   (PDF 는 노드ID로 저장됨 → `_icon_ids.json` 로 `아이콘이름.pdf` 로 rename)
   - **아이콘당 1회 호출** (여러 노드ID 를 한 번에 주면 멀티페이지 1파일로 합쳐짐)
   - outputDir 은 iOS 프로젝트의 Asset Catalog 위치로 바로 지정하면 좋음
3. **⚠️ 패딩 정규화 (필수)**: `python3 pad-icons.py <아이콘PDF폴더>`
   - **이유**: `export_nodes` 는 아이콘을 **보이는 패스에 tight crop** 한다 (노드 박스도, lucide 내장 패딩도 무시). 예: chevron 24×24 노드 → PDF 7×13. 종횡비가 제각각이라 그대로 `.frame()` 에 넣으면 아이콘마다 크기·왜곡이 들쭉날쭉.
   - 이 스크립트가 각 PDF 의 MediaBox 만 **중앙 정사각 + 여백**으로 넓혀 균일 캔버스로 만든다 (콘텐츠는 그대로 → 자동 중앙정렬, PDF 라이브러리 불필요). 여백 조절: `MARGIN=0.10`
4. Xcode: Asset Catalog 에 PDF 추가 → 'Preserve Vector Data' + 'Render As: Template Image'
5. 사용: `Image("heart").renderingMode(.template).resizable().scaledToFit().frame(width:24,height:24).foregroundColor(Color("text-primary"))`

> PDF 로 통일하는 이유: SVG 는 복잡한 패스에서 렌더러별로 깨질 수 있으나, PDF 벡터는 Xcode 네이티브 지원으로 안정적.
> tight-crop 주의: pad-icons.py 를 건너뛰면 `.frame()` 안에서 chevron 등 가는 아이콘이 거대해지거나 비율이 깨진다. 추출 후 반드시 1회 실행.

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
- ✅ **이미지 = 목업, 번들 안 함** (고정 규칙 2) → AsyncImage/placeholder + TODO
- ✅ **아이콘 = Pencil PDF 벡터** (5절, `pad-icons.py` 정규화 필수)

## 한 줄 요약
**`extract-for-swiftui.py`로 화면 하나 뽑기 → 그 `swiftui-input.json` + 이 가이드를 작업 컴퓨터 Claude Code에 주고 "SwiftUI로 변환해줘".**
