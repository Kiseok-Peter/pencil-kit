# Pencil MCP 실전 주의점 (v1.2.2 / .pen v2.14)

`.pen` 을 MCP 로 **편집**할 때 실측으로 확인한 함정들. 프로젝트 무관하게 적용됩니다.
(추출 절차는 `RUNBOOK.md`, SwiftUI 규칙은 `SWIFTUI-GUIDE.md`)

## 1. 새 노드를 `Insert` 로 처음부터 만들면 렌더가 비는 경우가 있다

섹션/행 프레임과 텍스트를 `Insert` 로 새로 조립했더니 **노드 데이터는 정상인데 화면이 통째로 빈** 상태가 됐습니다.
리터럴 텍스트(빨간 24px)로 격리 시험해도 동일 → 변수 바인딩 문제가 아니었습니다. `Get` 으로 읽으면 자식·bounds·높이 합계가
모두 정상이라 진단이 어렵습니다. **손대지 않은 동일 구조 프레임과 비교**해서야 원인이 잡혔습니다.

→ **기존 정상 노드를 `Copy` 한 뒤 `Update` 로 내용만 바꾸는 방식으로 전환하니 즉시 해결.**
Pencil 앱 지침의 *"새로 생성하기보다 기존 내용을 복사해 수정하라"* 는 스타일 권고가 아니라 **실질 제약**으로 취급할 것.

## 2. `Update` 는 `descendants` 를 **병합**한다 — 키 삭제가 안 됨

```js
Update(refId, {descendants: {childId: {/* fontFamily 없이 */}}})   // ❌ 기존 fontFamily 가 남는다
```
오버라이드 키를 **제거**하려면 `Get` 으로 노드를 읽어 키를 지우고 `Replace` 해야 합니다.
`Get` 결과는 그대로 round-trip 되므로 안전합니다:
```js
const o = Get(id, {resolveVariables:false})
const c = JSON.parse(JSON.stringify(o)); delete c.id; delete c.descendants.childId.fontFamily
Replace(id, c)     // 새 id 를 발급받는다
```
같은 방식이 일반 노드 속성 삭제(예: `letterSpacing`)에도 필요합니다. `Replace` 는 **새 id** 를 주지만
형제 위치·bounds 는 유지됩니다(미변경 인스턴스와 bounds 대조로 확인).

## 3. 변수 바인딩은 **타입이 엄격**하다

| 속성 | 필요한 변수 타입 |
|---|---|
| `fontSize` · `lineHeight` · `letterSpacing` · `gap` · `padding` | `number` |
| `fontFamily` · `fontWeight` | **`string`** |

`fontWeight` 에 number 변수를 주면 `Variable 'x' has type 'number' (expected 'string')` 로 **`execute` 블록 전체가 롤백**됩니다.

## 4. `resolveVariables:true` 는 기본값을 **생략**한다

`fontWeight: "$fontweight-regular"`(="400")를 resolved 로 읽으면 키가 **아예 안 보입니다** — 400 이 기본값이라 생략되는 것.
저장된 바인딩은 정상이므로 **버그로 오해하지 말 것**. 검증은 `resolveVariables:false` 로 저장값을 보거나,
기본값이 아닌 다른 토큰(예: `$fontweight-bold` → `"700"`)으로 대조하세요.

## 5. `Get` 의 방문자는 `descendants` 를 순회하지 않는다

`Get(id, visitor)` 는 `children` 만 내려갑니다. 인스턴스 오버라이드와 교체(replacement) subtree 안의 노드는 **따로 처리**해야 합니다.
경로는 `refId/childId` 형태이고, **교체 subtree 안의 노드는 descendants 키가 아니라 그 노드 자신의 id** 로 접근합니다:
```js
Get("RCCfg/3VXJD")   // ❌ Can't find node   (3VXJD = 원본 컴포넌트의 키)
Get("RCCfg/g9E1t")   // ✅                   (g9E1t = 교체본 안 실제 노드 id)
```

## 6. 편집하면 좌표가 미세하게 재계산된다

텍스트 크기를 20→22px 로 바꾸자 그 아래 **절대배치 형제들의 저장된 `y` 가 정확히 +3px** 갱신됐습니다(텍스트 높이 29→32).
또 레이아웃 재계산으로 `x` 값이 **부동소수점 말단 1 ULP**(`48.166666666666664` ↔ `48.16666666666667`)만큼 흔들립니다.

→ 재추출 결과를 이전 데이터와 비교할 때 **의미 있는 차이(정수 좌표 이동)와 표현 차이(float 말단)를 구분**하세요.
숫자를 일정 자리로 반올림한 정규화 해시로 대조하면 둘을 갈라낼 수 있습니다.

## 7. 컴포넌트는 DS 페이지 **안에 중첩**돼 있다

`reusable` 컴포넌트가 물리적으로 카탈로그 프레임(`DS - *`) 자식으로 들어있고, 추출 시 최상위 배열에도 같은 id 로 등재됩니다.
→ 단순 순회하면 **컴포넌트 텍스트가 이중 계상**됩니다. 집계할 때는 최상위 `DS - *` 를 건너뛰면
컴포넌트가 자기 항목으로 정확히 1회만 세어집니다 (`verify.py` 가 이 방식).

또 `c.depth===0` 필터로 컴포넌트를 찾으면 **하나도 안 잡힙니다**(최상위가 아니므로). `n.reusable` 로 찾으세요.

## 8. 대량 수정은 `execute` 한 번에 — 롤백이 안전망

`execute` 는 실패 시 **블록 전체를 롤백**합니다. 부분 적용으로 어긋난 상태가 남지 않으므로,
매핑 테이블 + `Get(id, visitor)` + `Update` 조합으로 한 번에 처리하는 편이 안전합니다.
단 콜 하나가 크면 실패 시 그 작업 전량을 다시 해야 하니, 화면 그룹 단위로 나누는 정도가 균형점입니다.
