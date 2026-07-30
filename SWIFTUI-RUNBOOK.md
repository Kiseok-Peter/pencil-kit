# SwiftUI 변환 런북 (단계별 진행)

이 런북은 **한 번에 다 진행하지 않습니다.** 각 단계는 **당신이 프롬프트로 트리거**하고,
Claude 는 **그 단계 하나만 수행한 뒤 멈춥니다.** 결과를 확인하고 다음 단계를 직접 진행하세요.

> 트리거 예시는 그대로 복붙해도 되고, 말로 풀어 써도 됩니다("런북 Step 1 해줘" 등).

---

## ⚠️ Claude 에게 (모든 단계 공통 규칙)

1. **요청받은 단일 단계만** 수행하고 멈춘다. **자동으로 다음 단계로 넘어가지 않는다.**
2. 상세 변환 규칙 → `SWIFTUI-GUIDE.md`, 화면↔모듈 매핑 → `SCREEN-MODULE-MAP.md` 를 따른다.
3. 컴포넌트는 **DesignSystem 모듈에 한 번만** 생성. Feature 에서는 **import 해서 조립만** (재생성 금지).
4. 생성물은 **레이아웃·스타일·토큰·컴포넌트 구조**까지. 상태·로직·네비·네트워킹은 **TODO 골격**(TCA Reducer 등).
5. 단계 끝에 **무엇을 만들었는지 + 다음 단계 트리거**를 한 줄로 안내하고 멈춘다.

## 사전 조건
- `pencil-kit/`(키트)와 `<프로젝트>/export/`(데이터, `design-data.json` 최신)가 있어야 함
  (Pencil 디자인을 바꿨으면 재추출 — 절차는 `RUNBOOK.md`, 증분이면 `merge-nodes.py` 병합)
- **Step 2(아이콘)만 Pencil 에서 `.pen` 이 열려 있어야** 함 (`export_nodes`). 나머지 단계는 MCP 불필요.
- 아래 스크립트는 `pencil-kit/` 에서 실행하며 `--data <프로젝트>/export` 로 데이터 폴더를 가리킨다.

---

## Step 0 — 점검 (선택)
**트리거:** "SWIFTUI-RUNBOOK Step 0: pencil-kit 상태 점검해줘"
**Claude 가 할 일:** `design-data.json` 존재/크기, 화면·컴포넌트 수, `SCREEN-MODULE-MAP.md` 요약을 보고하고 멈춘다.

## Step 1 — DesignSystem: 토큰
**트리거:** "SWIFTUI-RUNBOOK Step 1: DesignSystem 토큰 만들어줘"
**Claude 가 할 일:** `design-data.json` 의 `variables` →
- color 변수 → Asset Catalog **Color Set(Any/Dark)** 또는 `Color` extension (light/dark 자동)
- number 변수(`radius-*`, `spacing-*`, `fontsize-*`, `lineheight-*`, `tracking-*`) → 상수(enum)
- string 변수는 갈린다: `font-*`(패밀리) → **무시** (시스템 폰트 — GUIDE 고정 규칙 1) /
  `fontweight-*` → **`Font.Weight` 매핑 상수** ("string 전부 무시" 아님. 접두 규약은 GUIDE 3-1절)
DesignSystem 모듈에 배치하고 멈춘다.
⚠️ **`Font.custom` 금지 · 폰트 파일/Info.plist 등록 불필요** (GUIDE 고정 규칙 1 — 커스텀 폰트를 쓰지 않는다)

## Step 2 — DesignSystem: 아이콘  ⚠️ Pencil 필요
**트리거:** "SWIFTUI-RUNBOOK Step 2: 아이콘 PDF 뽑아서 Asset Catalog 에 넣어줘"
**Claude 가 할 일:**
1. `python3 make-icon-ids.py --data <프로젝트>/export` → `<export>/_icon_ids.json`
2. 각 노드ID `export_nodes(format:"pdf")` → 아이콘 이름으로 rename (outputDir = DesignSystem Asset Catalog)
3. **`python3 pad-icons.py <아이콘폴더>`** (tight-crop → 균일 정사각 정규화, 필수)
4. Xcode 설정 안내: 'Preserve Vector Data' + 'Render As: Template Image'
멈춘다. (Pencil 이 안 열려 있으면 여기서 알리고 대기)

## Step 3 — DesignSystem: 컴포넌트 View
**트리거:** "SWIFTUI-RUNBOOK Step 3: 컴포넌트들 재사용 View 로 만들어줘"
**Claude 가 할 일:** `design-data.json` 의 `components`(reusable 52개) → 각각 재사용 SwiftUI `View`.
- 인스턴스가 자주 바꾸는 값(텍스트/아이콘/상태) → View 파라미터
- Step 1 토큰 + Step 2 아이콘 사용
DesignSystem 모듈에 배치하고 멈춘다.

> 여기까지가 **공유 기반**. 이제 Feature 는 이걸 import 만 함.

## Step 4 — Feature 모듈 (하나씩 반복)
**트리거(예):** "SWIFTUI-RUNBOOK Step 4: RegistrationFeature 생성해줘"
**Claude 가 할 일:**
1. `<프로젝트>/export/SCREEN-MODULE-MAP.md` 에서 그 Feature 의 화면 목록 확인
2. main 화면을 `python3 extract-for-swiftui.py --data <프로젝트>/export "<프레임명>"` 로 추출 (상태·다크 변형은 State 분기로, 별도 추출 불필요)
3. 화면 조립 View + State + TCA Reducer 골격 생성 — **DesignSystem 컴포넌트 import 해서 조립만**
그 Feature **하나만** 만들고 멈춘다. 다음 Feature 는 당신이 다시 트리거.

**Feature 체크리스트** (원하는 순서로, 하나씩):
- [ ] AuthFeature — Login / Profile Setup
- [ ] OnboardingFeature
- [ ] RegistrationFeature — 등록 폼 + 주소검색 + 시트/팝업
- [ ] MyListFeature — 리스트 + 상태들
- [ ] RestaurantDetailFeature — 상세 + 재방문
- [ ] ReviewFeature — 리뷰 작성/수정 + 팝업
- [ ] SearchFeature
- [ ] SettingsFeature
- [ ] WithdrawalFeature

---

## 한 줄 요약
**Step 1→2→3 으로 DesignSystem 을 먼저 깔고, Step 4 를 Feature 마다 반복.**
각 단계는 당신이 트리거 → Claude 는 한 단계만 하고 멈춤 → 확인 후 다음.
