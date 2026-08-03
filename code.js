// Pencil(.pen) -> Figma 변환기 (플러그인 메인 스레드)
// UI 가 design-data.json 과 lucide 아이콘 SVG 를 읽어 postMessage 로 전달하면
// 이 코드가 Figma 노드 트리를 재구성한다.

figma.showUI(__html__, { width: 440, height: 520 });

// ---- 전역 상태 ----
// 전부 let: importDesign 진입 시 resetState() 로 재초기화한다(세션 내 재실행 안전).
let VARS = {};              // 변수명 -> Figma Variable (COLOR 전용)
let VAR_OBJ = {};           // 변수명 -> Figma Variable (FLOAT/STRING). 색과 분리 — makeSolidPaint 가 VARS 를 무조건 색으로 쓴다
let IMAGE_HASHES = {};      // url -> imageHash
let COMP_MAP = {};          // pencil 컴포넌트 id -> ComponentNode
let COMP_PATHS = {};        // pencil 컴포넌트 id -> { 자식 pencilId: [인덱스경로] }
let COMP_SPEC = {};         // pencil 컴포넌트 id -> 컴포넌트 spec (치수 상속용)
let ICONS = {};             // 아이콘명 -> SVG 문자열
let DBG = [];               // 진단 로그
let ROOT_FILL_OVR = 0;      // ref 루트 fill 오버라이드 적용 횟수 (코드 반영 확인용)
let LOADED = new Set();     // 실제 로드에 성공한 "family||style" (동기 경로에서 폰트 교체 가능 여부 판단)
let OPT = { bindTokens: true, iconSwap: true };  // 실행 옵션 (ui.html)
let ICON_COMP = {};         // "lucide/fish@22x22" -> ComponentNode (아이콘 마스터, 크기별)
let ICON_COMP_IDS = new Set();  // 아이콘 마스터의 Figma id (isIconNode 보조 판별)
let ICON_SLOTS = {};        // 컴포넌트 안 icon 노드의 Pencil id -> {icon, library, width, height, fill, candidates:Set}

// 재실행 시 전역이 남아 있으면 사고가 난다. 특히 COMP_MAP 이 남으면 buildOneComponent(가 조기 반환해)
// 지난 실행의 컴포넌트를 재사용하고, 사용자가 그걸 지웠으면 createInstance 가 예외를 던진다.
function resetState() {
  VARS = {}; VAR_OBJ = {};
  VAR_HEX = {}; VAR_NUM = {}; VAR_STR = {};
  IMAGE_HASHES = {}; COMP_MAP = {}; COMP_PATHS = {}; COMP_SPEC = {};
  DBG = []; ROOT_FILL_OVR = 0;
  LOADED = new Set(); FONT_RESOLVED = {};
  BIND_STAT = {}; CAP = {};
  TEXT_STYLES = {}; STYLE_BY_AXES = {}; TS_ALIASES = {}; TS_QUEUE = [];
  ICON_COMP = {}; ICON_COMP_IDS = new Set(); ICON_SLOTS = {};
}

function dumpTree(node, depth, out) {
  const pad = "  ".repeat(depth);
  let size = "?";
  try { size = Math.round(node.width) + "x" + Math.round(node.height); } catch (e) {}
  let extra = "";
  try {
    if (node.layoutMode && node.layoutMode !== "NONE") extra += " " + node.layoutMode[0];
    if ("layoutSizingHorizontal" in node) extra += " H:" + node.layoutSizingHorizontal + " V:" + node.layoutSizingVertical;
  } catch (e) {}
  out.push(pad + (node.name || "?") + " [" + node.type + "] " + size + extra + (node.visible === false ? " HIDDEN" : ""));
  if ("children" in node) for (const c of node.children) dumpTree(c, depth + 1, out);
}

// ---- 폰트 weight -> 후보 스타일명 (Figma 폰트마다 표기가 다름: SemiBold vs Semi Bold) ----
const STYLE_CANDIDATES = {
  "100": ["Thin"],
  "200": ["ExtraLight", "Extra Light"],
  "300": ["Light"],
  "400": ["Regular"],
  "500": ["Medium"],
  "600": ["SemiBold", "Semi Bold", "DemiBold", "Demi Bold"],
  "700": ["Bold"],
  "800": ["ExtraBold", "Extra Bold"],
  "900": ["Black", "Heavy"],
  normal: ["Regular"],
  bold: ["Bold"],
};

let AVAILABLE = new Set();      // "family||style"
let ANY_FONT = { family: "Roboto", style: "Regular" };
let FONT_RESOLVED = {};         // "family|weight|italic" -> {family, style} (로드 보장됨)

async function buildFontIndex() {
  AVAILABLE = new Set();
  const fonts = await figma.listAvailableFontsAsync();
  for (const f of fonts) AVAILABLE.add(f.fontName.family + "||" + f.fontName.style);
  if (fonts.length) ANY_FONT = fonts[0].fontName;
  if (AVAILABLE.has("Inter||Regular")) ANY_FONT = { family: "Inter", style: "Regular" };
}

// 요청한 (family, weight, italic) 에 대해 실제 설치된 폰트로 해석. 항상 로드 가능한 값 반환.
function resolveFont(family, weight, italic) {
  const key = family + "|" + weight + "|" + italic;
  if (FONT_RESOLVED[key]) return FONT_RESOLVED[key];
  const bases = STYLE_CANDIDATES[String(weight == null ? "400" : weight)] || ["Regular"];
  const styles = [];
  for (const b of bases) {
    if (italic) { styles.push(b === "Regular" ? "Italic" : b + " Italic", b + "Italic"); }
    else styles.push(b);
  }
  const fams = [family, "Inter", ANY_FONT.family];
  let resolved = null;
  for (const fam of fams) {
    for (const st of styles) { if (AVAILABLE.has(fam + "||" + st)) { resolved = { family: fam, style: st }; break; } }
    if (resolved) break;
    if (AVAILABLE.has(fam + "||Regular")) { resolved = { family: fam, style: "Regular" }; break; }
  }
  if (!resolved) resolved = ANY_FONT;
  FONT_RESOLVED[key] = resolved;
  return resolved;
}

// ---- 색상 파싱 ----
function hexToRGBA(hex) {
  hex = String(hex).replace("#", "");
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  let a = 1;
  if (hex.length === 8) { a = parseInt(hex.slice(6, 8), 16) / 255; hex = hex.slice(0, 6); }
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    a,
  };
}

// ---- fill 스펙 -> Figma Paint ----
function isImageFill(f) { return f && typeof f === "object" && f.type === "image"; }

function makeImagePaint(f) {
  const hash = IMAGE_HASHES[f.url];
  const mode = f.mode === "fit" ? "FIT" : f.mode === "stretch" ? "FILL" : "FILL";
  if (!hash) return null;
  return { type: "IMAGE", scaleMode: mode, imageHash: hash, opacity: f.opacity == null ? 1 : f.opacity };
}

function makeSolidPaint(spec) {
  // spec: "$var" | "#hex" | {type:'color', color}
  let colorRef = spec;
  if (spec && typeof spec === "object") colorRef = spec.color;
  let variable = null;
  let hex = colorRef;
  if (typeof colorRef === "string" && colorRef[0] === "$") {
    const name = colorRef.slice(1);
    variable = VARS[name] || null;
    hex = VAR_HEX[name] || "#000000";
  }
  const c = hexToRGBA(hex);
  let paint = { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
  if (variable) {
    try { paint = figma.variables.setBoundVariableForPaint(paint, "color", variable); } catch (e) {}
  }
  return paint;
}

let VAR_HEX = {};
let VAR_NUM = {};
let VAR_STR = {};

// 토큰 이름 규약 (verify.py 의 TOKEN_BUCKETS 와 같은 계약)
// fontweight-* 는 Pencil 에서 string("600") 이지만 Figma 는 fontWeight 에 number 변수를 요구한다 → FLOAT 로 변환 생성.
const WEIGHT_RE = /^fontweight[-.]/i;
// lineheight-* 는 배수(1.5). Figma 는 lineHeight 에 변수를 걸면 단위를 PIXELS 로 강제해 1.5px 이 되므로
// 변수는 만들되 절대 바인딩하지 않는다 (BINDABLE 화이트리스트에 lineHeight 없음).
const LINEHEIGHT_RE = /^lineheight[-.]/i;

function resolveColorRGBA(ref) {
  let hex = ref;
  if (typeof ref === "string" && ref[0] === "$") hex = VAR_HEX[ref.slice(1)] || "#000000";
  return hexToRGBA(hex);
}
function rgbaToHex(c) {
  const h = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

function makeGradientPaint(f) {
  const stops = (f.colors || []).map((s) => {
    const c = resolveColorRGBA(s.color);
    return { position: s.position == null ? 0 : s.position, color: { r: c.r, g: c.g, b: c.b, a: c.a } };
  });
  const type = f.gradientType === "radial" ? "GRADIENT_RADIAL"
    : f.gradientType === "angular" ? "GRADIENT_ANGULAR" : "GRADIENT_LINEAR";
  // Pencil rotation: 0°=위, CCW. 방향각(x오른쪽,y아래) 계산 후 중심 기준 회전 행렬
  const r = ((f.rotation || 0) * Math.PI) / 180;
  const phi = Math.atan2(-Math.cos(r), -Math.sin(r));
  const cos = Math.cos(phi), sin = Math.sin(phi), cx = 0.5, cy = 0.5;
  const gradientTransform = [
    [cos, -sin, cx - (cos * cx - sin * cy)],
    [sin, cos, cy - (sin * cx + cos * cy)],
  ];
  const paint = { type, gradientStops: stops, gradientTransform };
  if (f.opacity != null) paint.opacity = f.opacity;
  return paint;
}

function makePaint(spec) {
  if (spec == null) return null;
  if (typeof spec === "object") {
    if (spec.type === "image") return makeImagePaint(spec);
    if (spec.type === "gradient") return makeGradientPaint(spec);
    if (spec.type === "shader" || spec.type === "mesh_gradient") {
      DBG.push("미지원 fill 타입(" + spec.type + ") → 건너뜀");
      return null;
    }
  }
  return makeSolidPaint(spec);
}

// 단일/배열 fill → Paint 배열
function makePaints(spec) {
  if (spec === undefined) return undefined;
  const arr = Array.isArray(spec) ? spec : [spec];
  const out = [];
  for (const f of arr) { const p = makePaint(f); if (p) out.push(p); }
  return out;
}

function setFills(node, spec) {
  if (spec.fill === undefined) return;
  if (!("fills" in node)) return;
  node.fills = makePaints(spec.fill) || [];
}

function setStroke(node, spec) {
  if (spec.stroke === undefined || !("strokes" in node)) return;
  const sp = makePaints(spec.stroke);
  if (sp && sp.length) node.strokes = sp;
  const sw = resolveNum(spec.strokeWidth);
  const perSide = sw && typeof sw === "object";
  // 정렬: per-side(면별) 두께는 Figma 에서 INSIDE 정렬에서만 동작
  if (perSide && "strokeTopWeight" in node) {
    try { node.strokeAlign = "INSIDE"; } catch (e) {}
  } else if (spec.strokeAlignment && "strokeAlign" in node) {
    node.strokeAlign = { inner: "INSIDE", center: "CENTER", outer: "OUTSIDE" }[spec.strokeAlignment] || "INSIDE";
  }
  if (typeof sw === "number") {
    try { node.strokeWeight = sw; bindField(node, "strokeWeight", spec.strokeWidth, "FLOAT", sw); } catch (e) {}
  } else if (perSide) {
    if ("strokeTopWeight" in node) {
      // 면별 두께 (예: 하단 밑줄 {bottom:2}, 상단 구분선 {top:1})
      const SIDE_FIELDS = { top: "strokeTopWeight", right: "strokeRightWeight", bottom: "strokeBottomWeight", left: "strokeLeftWeight" };
      for (const side in SIDE_FIELDS) {
        const rv = resolveNum(sw[side]);
        const num = typeof rv === "number" ? rv : 0;   // 미해석 "$..." 를 대입하면 예외
        try { node[SIDE_FIELDS[side]] = num; } catch (e) { continue; }
        bindField(node, SIDE_FIELDS[side], sw[side], "FLOAT", num);
      }
    } else {
      const vals = Object.keys(sw).map((k) => sw[k]).filter((v) => typeof v === "number");
      if (vals.length) { try { node.strokeWeight = Math.max.apply(null, vals); } catch (e) {} }
    }
  }
  if (spec.strokeLinecap && "strokeCap" in node) node.strokeCap = { butt: "NONE", round: "ROUND", square: "SQUARE" }[spec.strokeLinecap] || "NONE";
  if (spec.strokeLinejoin && "strokeJoin" in node) node.strokeJoin = { miter: "MITER", bevel: "BEVEL", round: "ROUND" }[spec.strokeLinejoin] || "MITER";
}

// ---- 패딩 정규화 ----
const PADDING_FIELDS = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"];
function setPadding(node, p) {
  const rv = (x) => { const v = resolveNum(x); return typeof v === "number" ? v : 0; };
  let vals = [0, 0, 0, 0];          // [상, 우, 하, 좌]
  let refs = [null, null, null, null];   // 같은 순서의 원시 spec ($ref 보존)
  if (Array.isArray(p)) {
    if (p.length === 2) { vals = [rv(p[0]), rv(p[1]), rv(p[0]), rv(p[1])]; refs = [p[0], p[1], p[0], p[1]]; }
    else if (p.length === 4) { vals = p.slice(0, 4).map(rv); refs = p.slice(0, 4); }
  } else if (p != null) { const v = rv(p); vals = [v, v, v, v]; refs = [p, p, p, p]; }
  for (let i = 0; i < 4; i++) {
    node[PADDING_FIELDS[i]] = vals[i];
    bindField(node, PADDING_FIELDS[i], refs[i], "FLOAT", vals[i]);
  }
}

const ALIGN_PRIMARY = { start: "MIN", center: "CENTER", end: "MAX", space_between: "SPACE_BETWEEN", space_around: "SPACE_BETWEEN" };
const ALIGN_CROSS = { start: "MIN", center: "CENTER", end: "MAX" };

// ---- 효과(그림자) ----
function setEffects(node, eff) {
  if (!eff) return;
  const arr = Array.isArray(eff) ? eff : [eff];
  const out = [];
  for (const e of arr) {
    if (e.type === "shadow") {
      const c = resolveColorRGBA(e.color || "#00000040");   // "$변수" 도 해석 (hexToRGBA 만 쓰면 NaN)
      out.push({
        type: e.shadowType === "inner" ? "INNER_SHADOW" : "DROP_SHADOW",
        color: { r: c.r, g: c.g, b: c.b, a: c.a },
        offset: { x: (e.offset && e.offset.x) || 0, y: (e.offset && e.offset.y) || 0 },
        radius: e.blur || 0,
        spread: e.spread || 0,
        visible: e.enabled !== false,
        blendMode: "NORMAL",
      });
    } else if (e.type === "blur") {
      out.push({ type: "LAYER_BLUR", radius: e.radius || 0, visible: e.enabled !== false });
    } else if (e.type === "background_blur") {
      out.push({ type: "BACKGROUND_BLUR", radius: e.radius || 0, visible: e.enabled !== false });
    }
  }
  if (out.length) node.effects = out;
}

// ---- 모서리 ----
const CORNER_FIELDS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
function setCorner(node, cr) {
  if (cr == null) return;
  const raw = cr;                    // $ref 원본 보존 — 바인딩에 필요
  const val = resolveNum(cr);
  if (typeof val === "number") {
    node.cornerRadius = val;
    bindField(node, "cornerRadius", raw, "FLOAT", val);
    return;
  }
  if (Array.isArray(raw)) {
    for (let i = 0; i < 4 && i < raw.length; i++) {
      const v = resolveNum(raw[i]);
      if (typeof v !== "number") continue;   // 미해석 "$..." 대입은 예외 → 노드 통째 실패
      node[CORNER_FIELDS[i]] = v;
      bindField(node, CORNER_FIELDS[i], raw[i], "FLOAT", v);
    }
  }
}

// ---- 사이징 (부모 레이아웃 컨텍스트 필요, append 후 호출) ----
function applySizing(node, spec, parentLayout) {
  const canHug = node.type === "TEXT" || ("layoutMode" in node && node.layoutMode !== "NONE");
  // 인스턴스(ref): 치수를 생략했으면 컴포넌트 spec 의 치수를 상속해 적용
  // (컴포넌트 마스터는 부모가 없어 fill_container 가 안 먹으므로, 인스턴스에서 직접 해석)
  let w = spec.width, h = spec.height;
  if (spec.type === "ref") {
    const cs = COMP_SPEC[spec.ref];
    if (cs) { if (w == null) w = cs.width; if (h == null) h = cs.height; }
  }
  w = resolveNum(w); h = resolveNum(h);  // "$radius" 등 숫자 변수 → 값
  const apply = (axis, val) => {
    const prop = axis === "h" ? "layoutSizingHorizontal" : "layoutSizingVertical";
    const sv = typeof val === "string" ? val : null;
    if (sv && sv.indexOf("fill_container") === 0) {           // "fill_container" / "fill_container(123)"
      if (parentLayout && parentLayout !== "none") { try { node[prop] = "FILL"; return; } catch (e) {} }
    } else if (sv && sv.indexOf("fit_content") === 0) {       // "fit_content" / "fit_content(123)"
      if (canHug) { try { node[prop] = "HUG"; return; } catch (e) {} }
    } else if (typeof val === "number") {
      try { node[prop] = "FIXED"; return; } catch (e) {}
    } else if (canHug) {
      // 치수 미지정 = Pencil 기본값 fit_content → 내용에 맞춰 HUG
      try { node[prop] = "HUG"; } catch (e) {}
    }
  };
  const nw = typeof w === "number" ? w : node.width;
  const nh = typeof h === "number" ? h : node.height;
  if (typeof w === "number" || typeof h === "number") {
    try { node.resize(Math.max(1, nw), Math.max(1, nh)); } catch (e) {}
  }
  apply("h", w);
  apply("v", h);
}

// ---- 공통 속성 ----
function applyCommon(node, spec) {
  if (spec.name) node.name = spec.name;
  if (spec.opacity != null && typeof spec.opacity === "number") node.opacity = spec.opacity;
  if (spec.rotation != null && typeof spec.rotation === "number") node.rotation = spec.rotation;
  if (spec.enabled === false) node.visible = false;
}

// ---- 노드 색상 변경 (아이콘 stroke / 도형·텍스트 fill) ----
function recolor(node, fillSpec) {
  const vectors = [];
  const collect = (n) => {
    if (n.type === "VECTOR" || n.type === "LINE" || n.type === "ELLIPSE" || n.type === "POLYGON" || n.type === "STAR") vectors.push(n);
    if ("children" in n) for (const c of n.children) collect(c);
  };
  collect(node);
  const paint = makeSolidPaint(fillSpec);
  // INSTANCE 도 포함해야 한다 — 빼면 else 분기가 아이콘 인스턴스 전체에 단색 fills 를 깔아
  // 아이콘이 색깔 사각형이 된다 (인스턴스 자식 벡터의 paint 변경은 정당한 오버라이드)
  if (vectors.length && (node.type === "FRAME" || node.type === "INSTANCE")) {
    // lucide 아이콘: stroke 기반
    for (const v of vectors) {
      if ("strokes" in v && v.strokes.length) v.strokes = [paint];
      else if ("fills" in v && v.fills.length) v.fills = [paint];
      else if ("strokes" in v) v.strokes = [paint];
    }
  } else if ("fills" in node) {
    node.fills = [paint];
  }
}

// ---- 아이콘 빌드 (lucide/feather/phosphor 등) ----
// 마스터 키: 기본은 아이콘당 1개(단일 마스터 — 실무 라이브러리 표준). outlineStroke 미지원 환경만 크기별.
function iconKey(lib, name, w, h) {
  return CAP.iconOutline !== false ? lib + "/" + name : lib + "/" + name + "@" + w + "x" + h;
}
const ICON_BASE = 24;   // 단일 마스터 기준 크기 (lucide 원본 viewBox)

// 단일 마스터 생성: 24px 로 정규화 후 **선을 면으로 굽는다(outlineStroke)**.
// 이유: 인스턴스 리사이즈는 constraints 스케일이라 live stroke 의 굵기(strokeWeight)를 스케일하지 않는다 —
// 굽지 않으면 14px 아이콘이 2px 선 그대로 뚱뚱해진다. 구우면 기하 전체가 비례 스케일되어
// 기존 rescale 방식과 렌더가 동일해진다.
function makeIconMaster(lib, name) {
  const frame = makeIconFrame({ library: lib, icon: name, width: ICON_BASE, height: ICON_BASE });
  if (!frame) return null;
  const vecs = [];
  (function g(n) { for (const c of n.children || []) { vecs.push(c); g(c); } })(frame);
  for (const v of vecs) {
    try {
      if (typeof v.outlineStroke === "function" && v.strokes && v.strokes.length) {
        const o = v.outlineStroke();
        if (o) { const p = v.parent, i = p.children.indexOf(v); p.insertChild(i, o); v.remove(); }
      }
    } catch (e) {}
  }
  // 리사이즈 시 자식이 비례 스케일되도록
  (function s(n) { for (const c of n.children || []) { try { c.constraints = { horizontal: "SCALE", vertical: "SCALE" }; } catch (e) {} s(c); } })(frame);
  return frame;
}

// SVG → 프레임 (기하만 — 이름·색·플러그인데이터는 호출자 몫).
// 아이콘 마스터와 일반(폴백) 경로가 문자 그대로 같은 기하를 쓰도록 분리해 둔다.
function makeIconFrame(spec) {
  const key = (spec.library || "lucide") + "/" + spec.icon;
  const svg = ICONS[key] || ICONS[spec.icon];
  if (!svg) return null;
  const node = figma.createNodeFromSvg(svg);
  // 라이브러리마다 viewBox 가 다름(lucide/feather=24, phosphor=256) → 현재 폭 기준 리스케일
  const target = spec.width || spec.height || node.width || 24;
  try { if (node.width) node.rescale(target / node.width); } catch (e) {}
  return node;
}

function buildIcon(spec) {
  let node = null;
  // 인스턴스 경로: 같은 (라이브러리, 아이콘, 크기) 마스터가 있으면 어디서든 인스턴스로 만든다.
  // 키가 Pencil id 와 무관해서 DS 카탈로그의 id 중복 사본도 안전하다.
  // 마스터가 없거나 스왑 미지원 환경이면 기존과 완전히 같은 프레임 경로.
  if (CAP["ov.icon"] !== false && spec.icon
      && typeof spec.width === "number" && typeof spec.height === "number") {
    const comp = ICON_COMP[iconKey(spec.library || "lucide", spec.icon, spec.width, spec.height)];
    if (comp) { try { node = comp.createInstance(); } catch (e) { node = null; } }
    // 인스턴스에 rescale 은 걸지 않는다(자식 기하 변경 금지 가능성). 크기는 resize 로 —
    // 단일 마스터(24px, 외곽선화+SCALE constraints)는 resize 가 비례 스케일이 된다.
    if (node && CAP.iconOutline !== false) {
      try { node.resize(Math.max(1, spec.width), Math.max(1, spec.height)); } catch (e) {}
    }
  }
  if (!node) {
    node = makeIconFrame(spec);
    if (!node) {
      DBG.push("아이콘 SVG 없음: " + (spec.library || "lucide") + "/" + spec.icon + " (CDN 미수신)");
      node = figma.createFrame();
      node.resize(spec.width || 16, spec.height || 16);
      node.fills = [];
    }
  }
  node.name = spec.name || spec.icon || "icon";
  try { node.setPluginData("pcIcon", "1"); } catch (e) {}  // 아이콘 태그 (오버라이드 시 벡터 재색 구분용)
  if (spec.fill) recolor(node, spec.fill);
  return node;
}

// 컴포넌트 spec 에서 아이콘 슬롯을 수집한다 (순수 데이터 패스 — 노드 생성 없음).
// ICON_SLOTS 는 두 용도: ① isIconNode 의 1순위 판별(48개 전부) ② 교체 슬롯(candidates>0)의 인스턴스화 결정.
// 컴포넌트 목록만 걷는 이유: DS 카탈로그 화면이 같은 Pencil id 의 평면 사본을 담고 있어(실측 226건)
// 화면까지 걷으면 슬롯 정의가 사본과 섞인다.
function collectIconSlots(allComponents, allScreens) {
  ICON_SLOTS = {};
  const walkIcons = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "icon" && n.icon && typeof n.width === "number" && typeof n.height === "number") {
      ICON_SLOTS[n.id] = { icon: n.icon, library: n.library || "lucide", width: n.width, height: n.height, fill: n.fill, candidates: new Set() };
    }
    for (const c of n.children || []) walkIcons(c);
  };
  for (const c of allComponents) walkIcons(c);
  // ref 오버라이드를 훑어 슬롯별 교체 후보를 채운다 (화면 + 컴포넌트 안의 ref + 교체 subtree 안의 ref 까지)
  const walkRefs = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "ref") {
      const ds = n.descendants || {};
      for (const pid in ds) {
        const ov = ds[pid];
        if (ov && typeof ov === "object" && !ov.type && ov.icon && ICON_SLOTS[pid]) ICON_SLOTS[pid].candidates.add(ov.icon);
      }
    }
    for (const c of n.children || []) walkRefs(c);
    const d = n.descendants;
    if (d) for (const k in d) if (d[k] && typeof d[k] === "object") walkRefs(d[k]);
  };
  for (const s of allScreens) walkRefs(s);
  for (const c of allComponents) walkRefs(c);
}

// 디자인 전체에서 쓰이는 (라이브러리, 아이콘, 크기) 조합 전부의 마스터를 생성한다 (프로브 통과 시에만 호출).
// 모든 아이콘이 인스턴스가 되어 라이브러리 페이지가 완성되고, SVG 파싱도 배치 수 → 조합 수로 줄어든다.
// 크기별로 따로 만든다 — 같은 크기끼리만 스왑하면 인스턴스 리사이즈가 아예 필요 없어진다.
async function buildIconComponents(allComponents, allScreens, offsets) {
  const single = CAP.iconOutline !== false;   // 단일 마스터 모드 (기본) vs 크기별 폴백
  const need = {};   // key -> {library, icon, width, height}
  const add = (lib, name, w, h) => {
    if (!ICONS[lib + "/" + name] && !ICONS[name]) return;   // SVG 없으면 마스터 안 만듦 (빈 마스터 = 아이콘 소멸)
    need[iconKey(lib, name, w, h)] = { library: lib, icon: name, width: w, height: h };
  };
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "icon" && n.icon && typeof n.width === "number" && typeof n.height === "number")
      add(n.library || "lucide", n.icon, n.width, n.height);
    for (const c of n.children || []) walk(c);
    const d = n.descendants;   // 교체 subtree 안의 아이콘도
    if (d) for (const k in d) if (d[k] && typeof d[k] === "object") walk(d[k]);
  };
  for (const c of allComponents) walk(c);
  for (const s of allScreens) walk(s);
  // 교체 후보 (슬롯 크기로) — 화면에 노드로 등장하지 않고 오버라이드 값으로만 존재하는 아이콘
  for (const pid in ICON_SLOTS) {
    const s = ICON_SLOTS[pid];
    if (!s.candidates.size) continue;
    // 기본 아이콘의 SVG 가 없으면 슬롯 통째 포기 — 슬롯이 인스턴스가 안 되므로 스왑도 불가
    if (!ICONS[s.library + "/" + s.icon] && !ICONS[s.icon]) {
      DBG.push("아이콘 슬롯 포기: " + s.icon + " SVG 없음 → 이 슬롯의 교체 미적용(현행 유지)");
      s.candidates = new Set();
      continue;
    }
    for (const cand of s.candidates) add(s.library, cand, s.width, s.height);
  }
  const keys = Object.keys(need).sort();
  if (!keys.length) return;
  const page = getOrCreatePage("DS - Icon Components");   // .pen 의 "DS - Icons" 카탈로그 화면과 충돌하지 않는 이름
  await switchToPage(page);
  const PITCH = 60, PER_ROW = 10;
  keys.forEach((k, i) => {
    const d = need[k];
    const frame = single ? makeIconMaster(d.library, d.icon) : makeIconFrame(d);
    if (!frame) return;
    frame.name = single ? "icon/" + d.icon : "icon/" + d.icon + "/" + d.width;
    let comp;
    try { comp = figma.createComponentFromNode(frame); }
    catch (e) { DBG.push("아이콘 마스터 생성 실패 " + k + ": " + (e && e.message)); try { frame.remove(); } catch (e2) {} return; }
    comp.x = (i % PER_ROW) * PITCH;
    comp.y = Math.floor(i / PER_ROW) * PITCH;
    ICON_COMP[k] = comp;
    ICON_COMP_IDS.add(comp.id);
  });
  // 사용자가 화면/컴포넌트를 이 페이지 이름으로 매핑해도 마스터 그리드와 겹치지 않게
  offsets[page.id] = PER_ROW * PITCH + 80;
  DBG.push("아이콘 마스터 " + Object.keys(ICON_COMP).length + "개 생성 (DS - Icon Components)");
}

// 중첩 인스턴스(컴포넌트 인스턴스 안의 아이콘 인스턴스)에서 swapComponent 가 동작하는지 1회 측정.
// 실전과 같은 구조로 시험하고 즉시 지운다. 실패 시 마스터를 하나도 만들지 않아 부작용이 0.
async function probeIconSwap() {
  if (!OPT.iconSwap) { CAP["ov.icon"] = false; return; }
  let a = null, b = null, w = null, wi = null;
  try {
    const mk = () => { const f = figma.createFrame(); f.resize(10, 10); f.fills = []; return f; };
    a = figma.createComponentFromNode(mk());
    b = figma.createComponentFromNode(mk());
    const holder = mk();
    holder.appendChild(a.createInstance());
    w = figma.createComponentFromNode(holder);
    wi = w.createInstance();
    const nested = wi.children && wi.children[0];
    if (!nested || nested.type !== "INSTANCE" || typeof nested.swapComponent !== "function") {
      CAP["ov.icon"] = false;
      DBG.push("아이콘 스왑 프로브: 중첩 인스턴스 접근 불가 — 교체 미적용(현행 유지)");
    } else {
      nested.swapComponent(b);
      const got = nested.mainComponent;
      if (!got || got.id !== b.id) {
        CAP["ov.icon"] = false;
        DBG.push("아이콘 스왑 프로브: 무반응 — 교체 미적용(현행 유지)");
      } else {
        DBG.push("아이콘 스왑 프로브: 지원됨");
      }
    }
  } catch (e) {
    CAP["ov.icon"] = false;
    DBG.push("아이콘 스왑 프로브: 예외(" + (e && e.message) + ") — 교체 미적용(현행 유지)");
  } finally {
    const tmp = [wi, w, a, b];
    for (const n of tmp) if (n) { try { n.remove(); } catch (e) {} }
  }
  await probeIconOutline();
}

// outlineStroke(선→면 굽기) 지원 여부 → 단일 마스터 모드 결정. 미지원이면 크기별 마스터로 폴백.
async function probeIconOutline() {
  if (CAP["ov.icon"] === false) { CAP.iconOutline = false; return; }   // 스왑 자체가 안 되면 마스터도 없다
  let f = null, o = null;
  try {
    let sample = null;
    for (const k in ICONS) { sample = ICONS[k]; break; }
    if (!sample) { CAP.iconOutline = false; return; }   // 아이콘 없는 디자인 — 모드 무의미
    f = figma.createNodeFromSvg(sample);
    const vs = [];
    (function g(n) { if (n.type === "VECTOR") vs.push(n); for (const c of n.children || []) g(c); })(f);
    let ok = false;
    if (vs.length && typeof vs[0].outlineStroke === "function") {
      o = vs[0].outlineStroke();
      ok = !!o;
    }
    CAP.iconOutline = ok;
    DBG.push("아이콘 외곽선화 프로브: " + (ok ? "지원 → 아이콘당 단일 마스터(24px)" : "미지원 → 크기별 마스터로 폴백"));
  } catch (e) {
    CAP.iconOutline = false;
    DBG.push("아이콘 외곽선화 프로브: 예외(" + (e && e.message) + ") → 크기별 마스터로 폴백");
  } finally {
    if (o) { try { o.remove(); } catch (e) {} }
    if (f) { try { f.remove(); } catch (e) {} }
  }
}

// 아이콘 슬롯 인스턴스의 마스터를 교체한다. 실패·불일치는 전부 되돌리고 집계 — 시각 회귀 0.
function swapIcon(node, slot, iconName) {
  if (CAP["ov.icon"] === false) { stat("ov.icon", "skip"); return false; }
  if (!node || node.type !== "INSTANCE" || typeof node.swapComponent !== "function") {
    stat("ov.icon", "skip", (node && node.name || "?") + " — 슬롯이 인스턴스가 아님");
    return false;
  }
  const comp = ICON_COMP[iconKey(slot.library, iconName, slot.width, slot.height)];
  if (!comp) { stat("ov.icon", "skip", iconName + " — 마스터 없음(SVG 미수신)"); return false; }
  let before = null;
  try { before = node.mainComponent; } catch (e) {}
  if (before && before.id === comp.id) { stat("ov.icon", "ok"); return true; }   // 오버라이드가 기본값과 동일 — no-op
  try { node.swapComponent(comp); }
  catch (e) { stat("ov.icon", "error", (node.name || "?") + ": " + (e && e.message)); return false; }
  let got = null;
  try { got = node.mainComponent; } catch (e) {}
  if (!got || got.id !== comp.id) {
    if (before) { try { node.swapComponent(before); } catch (e) {} }
    const s = stat("ov.icon", "revert", iconName);
    if (s.revert >= 3 && s.ok === 0) { CAP["ov.icon"] = false; DBG.push("아이콘 스왑 중단 — 되돌림 3회, 성공 0"); }
    return false;
  }
  // 단일 마스터(24px)로 스왑되면 크기가 마스터 기준으로 갈 수 있어 슬롯 크기를 재확정 (크기별 모드에선 no-op)
  try { node.resize(slot.width, slot.height); } catch (e) {}
  stat("ov.icon", "ok");
  return true;
}

// ---- 패스(SVG geometry) 빌드 ----
function buildPath(spec) {
  const vb = spec.viewBox || [0, 0, spec.width || 24, spec.height || 24];
  const w = spec.width || vb[2], h = spec.height || vb[3];
  let fillAttr = "none";
  if (spec.fill !== undefined) {
    const fc = typeof spec.fill === "string" ? spec.fill : (spec.fill && spec.fill.color);
    if (fc) { const c = resolveColorRGBA(fc); if (c.a > 0) fillAttr = rgbaToHex(c); }
  }
  let strokeAttr = "";
  if (spec.stroke !== undefined) {
    const sc = typeof spec.stroke === "string" ? spec.stroke : (spec.stroke && spec.stroke.color);
    if (sc) {
      const c = resolveColorRGBA(sc);
      strokeAttr = ' stroke="' + rgbaToHex(c) + '" stroke-width="' + (spec.strokeWidth || 1) + '"';
      if (spec.strokeLinecap) strokeAttr += ' stroke-linecap="' + spec.strokeLinecap + '"';
      if (spec.strokeLinejoin) strokeAttr += ' stroke-linejoin="' + spec.strokeLinejoin + '"';
    }
  }
  const rule = spec.fillRule ? ' fill-rule="' + spec.fillRule + '"' : "";
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
    '" viewBox="' + vb[0] + " " + vb[1] + " " + vb[2] + " " + vb[3] + '"><path d="' +
    (spec.geometry || "") + '" fill="' + fillAttr + '"' + rule + strokeAttr + "/></svg>";
  return figma.createNodeFromSvg(svg);
}

// ---- 그룹 빌드 (Pencil group=레이아웃 없음, 자식 x/y 배치) ----
function buildGroup(spec) {
  const f = figma.createFrame();
  f.layoutMode = "NONE";
  f.fills = [];
  f.clipsContent = false;
  setEffects(f, spec.effect);
  let maxX = 1, maxY = 1;
  for (const child of spec.children || []) {
    try {
      const cn = buildNode(child);
      if (!cn) continue;
      f.appendChild(cn);
      if (typeof child.width === "number" || typeof child.height === "number") {
        try { cn.resize(Math.max(1, child.width || cn.width), Math.max(1, child.height || cn.height)); } catch (e) {}
      }
      cn.x = child.x || 0; cn.y = child.y || 0;
      maxX = Math.max(maxX, (child.x || 0) + (cn.width || 0));
      maxY = Math.max(maxY, (child.y || 0) + (cn.height || 0));
    } catch (e) {
      DBG.push("그룹 자식 실패 [" + (child.name || child.id) + "]: " + (e && e.message ? e.message : e));
    }
  }
  try { f.resize(maxX, maxY); } catch (e) {}
  return f;
}

// ---- 텍스트 빌드 ----
function buildText(spec) {
  const t = figma.createText();
  const fnt = textFontOf(spec);
  try { t.fontName = fnt; } catch (e) { DBG.push("폰트 적용 실패 [" + (spec.name || spec.id) + " " + JSON.stringify(fnt) + "]: " + e.message); }
  try { t.characters = spec.content == null ? "" : String(resolveStr(spec.content)); }
  catch (e) { DBG.push("텍스트 입력 실패 [" + (spec.name || spec.id) + " font=" + JSON.stringify(fnt) + "]: " + e.message); }
  const fsz = resolveNum(spec.fontSize);
  if (typeof fsz === "number") t.fontSize = fsz;
  const ls = resolveNum(spec.letterSpacing);
  if (typeof ls === "number") t.letterSpacing = { value: ls, unit: "PIXELS" };
  const lh = resolveNum(spec.lineHeight);
  if (typeof lh === "number") t.lineHeight = { value: lh * 100, unit: "PERCENT" };
  if (spec.textAlign) t.textAlignHorizontal = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" }[spec.textAlign] || "LEFT";
  if (spec.textAlignVertical) t.textAlignVertical = { top: "TOP", middle: "CENTER", bottom: "BOTTOM" }[spec.textAlignVertical] || "TOP";
  const g = spec.textGrowth || "auto";
  if (g === "auto") t.textAutoResize = "WIDTH_AND_HEIGHT";
  else if (g === "fixed-width") t.textAutoResize = "HEIGHT";
  else t.textAutoResize = "NONE";
  if (spec.fill) t.fills = makePaints(spec.fill) || []; else t.fills = [];
  bindTypography(t, spec, fnt);   // ★ 리터럴이 전부 확정된 뒤에만
  return t;
}

// 리터럴이 완성된 뒤에만 호출한다. 모든 실패는 언바인딩 → 리터럴 유지 → 시각 회귀 0.
function bindTypography(t, spec, fnt) {
  if (!OPT.bindTokens) return;
  // 프리셋(Text Style)이 5축을 통째로 소유하면 개별 바인딩은 하지 않는다 —
  // 스타일이 붙은 노드에 같은 필드를 또 바인딩하면 Figma 가 스타일을 detach 시킨다.
  // 실제 적용은 빌드가 다 끝난 뒤 비동기로 한다(setTextStyleIdAsync). 여기선 줄만 세운다.
  if (queueTextStyle(t, spec, fnt)) return;
  bindTypographyFields(t, spec, fnt);
}

// 노드별 개별 바인딩(프리셋 없이 쓰던 종전 경로). 스타일 적용이 실패한 노드를 되돌릴 때도 쓴다.
function bindTypographyFields(t, spec, fnt) {
  if (typeof resolveNum(spec.fontSize) === "number")
    bindField(t, "fontSize", spec.fontSize, "FLOAT", t.fontSize);
  const lsv = resolveNum(spec.letterSpacing);
  if (typeof lsv === "number") {
    // 단위까지 함께 확인한다 (Figma 는 변수를 걸면 단위를 PIXELS 로 강제 — Pencil 도 px 라 일치)
    bindField(t, "letterSpacing", spec.letterSpacing, "FLOAT", lsKey(t), lsKey, (n) => { n.letterSpacing = { value: lsv, unit: "PIXELS" }; });
  }
  // lineHeight: Pencil 은 배수(1.5), Figma 는 바인딩 시 PIXELS 강제 → 1.5px 이 된다. 원리적으로 불가하므로 집계만.
  if (typeof spec.lineHeight === "string" && spec.lineHeight[0] === "$") stat("lineHeight", "skip");
  bindFontFamily(t, spec.fontFamily, fnt);
  bindFontWeight(t, spec.fontWeight, fnt);
}

// fontFamily 는 **토큰 값과 실제 해석된 패밀리가 같을 때만** 건다.
// resolveFont 는 Outfit 이 없으면 조용히 Inter 로 대체하는데, 그 상태에서 "$font-body"(="Outfit")를 걸면
// 텍스트 수백 개가 한꺼번에 missing font 가 된다.
function bindFontFamily(node, ref, fnt) {
  if (typeof ref !== "string" || ref[0] !== "$") return;
  const raw = VAR_STR[ref.slice(1)];
  if (raw == null || String(raw) !== fnt.family) {
    stat("fontFamily", "skip", "미설치 폴백: " + raw + " → " + fnt.family);
    return;
  }
  // 리드백은 fontName **전체**로 한다. 패밀리만 보면, 바인딩이 패밀리는 맞추고 스타일을 바꿔버리는 경우를
  // 통과시켜 굵기·이탤릭이 조용히 어긋난다 (Figma 는 새 패밀리에 현재 스타일이 없으면 다른 걸 고른다).
  bindField(node, "fontFamily", ref, "STRING", fontKey(fnt), fontKeyOf, (n) => { n.fontName = fnt; });
}

// fontWeight 는 Pencil string("600") → Figma FLOAT(600). fontName 은 이미 리터럴로 정확하므로
// Figma 가 이 필드를 무시해도 시각은 그대로다. 리드백은 style 이 **의도와 달라지지 않았음**을 확인한다.
function bindFontWeight(node, ref, fnt) {
  if (typeof ref !== "string" || ref[0] !== "$") return;
  // 이탤릭은 숫자 굵기 변수로 표현할 수 없다 — Figma 가 weight 로 스타일을 다시 고르면 이탤릭이 날아간다
  if (/italic/i.test(fnt.style)) { stat("fontWeight", "skip", "이탤릭은 숫자 굵기로 표현 불가: " + fnt.style); return; }
  bindField(node, "fontWeight", ref, "FLOAT", fontKey(fnt), fontKeyOf, (n) => { n.fontName = fnt; });
}

function fontKey(f) { return f ? f.family + "||" + f.style : null; }
function fontKeyOf(n) { return n.fontName && n.fontName !== figma.mixed ? fontKey(n.fontName) : null; }
function lsKey(n) { return n.letterSpacing ? n.letterSpacing.unit + ":" + n.letterSpacing.value : null; }
// AUTO 는 value 가 없다 → "AUTO:" 로 정규화 (미지정 행간끼리도 비교가 되게)
function lhKey(n) { return n.lineHeight ? n.lineHeight.unit + ":" + (n.lineHeight.value === undefined ? "" : n.lineHeight.value) : null; }

// ---- 프레임 빌드 ----
function buildFrame(spec) {
  const f = figma.createFrame();
  f.layoutMode = spec.layout === "vertical" ? "VERTICAL" : spec.layout === "none" ? "NONE" : "HORIZONTAL";
  if (f.layoutMode !== "NONE") {
    // 가드 필수: resolveNum 이 미해석 "$spacing-md" 를 그대로 돌려주면 truthy 라 문자열이 대입되고,
    // 예외 → 부모의 catch → 프레임과 subtree 가 통째로 사라진다 (setPadding 은 이미 가드가 있었다)
    const gap = resolveNum(spec.gap);
    f.itemSpacing = typeof gap === "number" ? gap : 0;
    bindField(f, "itemSpacing", spec.gap, "FLOAT", f.itemSpacing);
    setPadding(f, spec.padding);
    f.primaryAxisAlignItems = ALIGN_PRIMARY[spec.justifyContent || "start"] || "MIN";
    f.counterAxisAlignItems = ALIGN_CROSS[spec.alignItems || "start"] || "MIN";
  }
  // 배경 / 테두리
  if (spec.fill !== undefined) setFills(f, spec); else f.fills = [];
  setStroke(f, spec);
  setCorner(f, spec.cornerRadius);
  setEffects(f, spec.effect);
  if (spec.clip != null) f.clipsContent = !!spec.clip;
  // 자식
  const childLayout = spec.layout === "vertical" ? "vertical" : spec.layout === "none" ? "none" : "horizontal";
  for (const child of spec.children || []) {
    try {
      const cn = buildNode(child);
      if (!cn) continue;
      f.appendChild(cn);
      const absolute = child.layoutPosition === "absolute";
      if (childLayout === "none") {
        // 절대 배치 부모: x/y 로 위치
        applySizing(cn, child, "none");
        cn.x = child.x || 0; cn.y = child.y || 0;
      } else if (absolute) {
        // auto-layout 안의 절대 배치 자식
        try { cn.layoutPositioning = "ABSOLUTE"; } catch (e) {}
        applySizing(cn, child, childLayout);
        cn.x = child.x || 0; cn.y = child.y || 0;
      } else {
        applySizing(cn, child, childLayout);
      }
    } catch (e) {
      DBG.push("자식 빌드 실패 [" + (child.name || child.id) + " / " + child.type + "]: " + (e && e.message ? e.message : e));
    }
  }
  return f;
}

// ---- 인스턴스(ref) 빌드 ----
function nodeAtPath(root, path) {
  let n = root;
  for (const i of path) { if (!n || !("children" in n)) return null; n = n.children[i]; }
  return n;
}
function isIconNode(node, pid) {
  // ① spec 유래 — 컴포넌트 spec 에서 수집한 아이콘 슬롯 (Figma 런타임 의미론에 의존하지 않는 1순위)
  if (pid && ICON_SLOTS[pid]) return true;
  // ② pluginData 태그 (인스턴스 상속 여부가 API 에 보증되지 않아 보조 신호)
  try { if (node.getPluginData("pcIcon") === "1") return true; } catch (e) {}
  // ③ 아이콘 마스터의 인스턴스인가
  try { if (node.type === "INSTANCE" && node.mainComponent && ICON_COMP_IDS.has(node.mainComponent.id)) return true; } catch (e) {}
  return false;
}
function applyOverride(node, ov, pid) {
  if (!node) return;
  if (ov.content !== undefined && node.type === "TEXT") node.characters = String(resolveStr(ov.content));
  // 아이콘 교체 — 색보다 먼저 (스왑이 서브레이어 색을 보존한다고 신뢰할 수 없으므로 뒤에서 다시 칠한다)
  const slot = pid ? ICON_SLOTS[pid] : null;
  let swapped = false;
  if (slot && ov.icon !== undefined) {
    swapped = swapIcon(node, slot, ov.icon);
    if (swapped) {
      const w = typeof ov.width === "number" ? ov.width : slot.width;
      const h = typeof ov.height === "number" ? ov.height : slot.height;
      if (w !== slot.width || h !== slot.height) { try { node.resize(w, h); stat("ov.width", "ok"); } catch (e) {} }
    }
  }
  // 색: 오버라이드 fill 우선, 없으면 (스왑했을 때만) 슬롯의 원래 fill 로 복원.
  // slot.fill 은 spec 원본("$primary" 등)이라 makeSolidPaint 를 거치며 색 변수 바인딩도 함께 복원된다.
  const fillSrc = ov.fill !== undefined ? ov.fill : (swapped && slot && slot.fill != null ? slot.fill : undefined);
  if (fillSrc !== undefined) {
    if (isImageFill(fillSrc)) { const p = makeImagePaint(fillSrc); if (p && "fills" in node) node.fills = [p]; }
    else if (isIconNode(node, pid)) recolor(node, fillSrc);   // 아이콘: 벡터 재색
    else if ("fills" in node) node.fills = makePaints(fillSrc) || [];  // 프레임/텍스트/도형: 배경 fill 직접
  }
  if (ov.enabled === false) node.visible = false;
  if (node.type === "TEXT") applyTypoOverride(node, ov);
  // 아직 적용 못 하는 키는 조용히 버리지 말고 집계한다.
  // (x/y 는 Pencil 이 계산된 절대좌표를 그대로 echo 한 것이라 auto-layout 마스터에서 재현되므로 세지 않는다)
  for (const k of UNAPPLIED_OV_KEYS) {
    if (ov[k] === undefined) continue;
    if (swapped && (k === "width" || k === "height")) continue;   // 스왑 경로에서 처리됨 (크기 같으면 no-op)
    stat("ov." + k, "skip");
  }
}

const UNAPPLIED_OV_KEYS = ["width", "height", "textGrowth", "cornerRadius",
  "stroke", "strokeWidth", "strokeAlignment", "strokeLinecap", "strokeLinejoin", "textAlign", "textAlignVertical"];

// STYLE_CANDIDATES 의 역인덱스 — 오버라이드가 weight 를 안 주면 현재 스타일에서 되찾는다
let STYLE_TO_WEIGHT = null;
function styleToWeight(style) {
  if (!STYLE_TO_WEIGHT) {
    STYLE_TO_WEIGHT = {};
    for (const w in STYLE_CANDIDATES) {
      if (w === "normal" || w === "bold") continue;   // 별칭이 숫자 키를 덮지 않게
      for (const s of STYLE_CANDIDATES[w]) {
        STYLE_TO_WEIGHT[s.toLowerCase()] = w;
        STYLE_TO_WEIGHT[(s + " Italic").toLowerCase()] = w;
        STYLE_TO_WEIGHT[(s + "Italic").toLowerCase()] = w;
      }
    }
    STYLE_TO_WEIGHT["italic"] = "400";
  }
  return STYLE_TO_WEIGHT[String(style || "").toLowerCase()] || "400";
}

// 인스턴스 오버라이드의 타이포 적용. 오버라이드는 **부분 정보**라 fontName 을 현재 값과 병합해야 한다.
// applyOverride → buildRef → buildNode → buildFrame 이 전부 동기 함수라 loadFontAsync 를 부를 수 없으므로,
// loadFonts 가 미리 로드해 둔 조합(LOADED)만 적용하고 아니면 현행 유지한다 → 회귀 0.
// 리터럴만 대입하면 컴포넌트에서 상속된 바인딩이 끊기므로 여기서도 "리터럴 + 바인딩" 쌍으로 처리한다.
function applyTypoOverride(node, ov) {
  const fsz = resolveNum(ov.fontSize);
  if (typeof fsz === "number") {
    try { node.fontSize = fsz; bindField(node, "fontSize", ov.fontSize, "FLOAT", node.fontSize); }
    catch (e) { stat("ov.fontSize", "error", e && e.message); }
  }
  const lsp = resolveNum(ov.letterSpacing);
  if (typeof lsp === "number") {
    try {
      node.letterSpacing = { value: lsp, unit: "PIXELS" };
      bindField(node, "letterSpacing", ov.letterSpacing, "FLOAT", lsKey(node), lsKey, (n) => { n.letterSpacing = { value: lsp, unit: "PIXELS" }; });
    } catch (e) { stat("ov.letterSpacing", "error", e && e.message); }
  }
  const lh = resolveNum(ov.lineHeight);
  if (typeof lh === "number") { try { node.lineHeight = { value: lh * 100, unit: "PERCENT" }; } catch (e) {} }

  if (ov.fontFamily === undefined && ov.fontWeight === undefined && ov.fontStyle === undefined) return;
  const cur = node.fontName && node.fontName !== figma.mixed ? node.fontName : null;
  if (!cur) { stat("ov.fontName", "skip", "fontName 이 mixed"); return; }
  const fam = resolveStr(ov.fontFamily) || cur.family;
  const weight = ov.fontWeight !== undefined ? resolveStr(ov.fontWeight) : styleToWeight(cur.style);
  const ital = ov.fontStyle !== undefined ? (resolveStr(ov.fontStyle) === "italic") : /italic/i.test(cur.style);
  const next = resolveFont(fam, weight, ital);
  if (!LOADED.has(next.family + "||" + next.style)) {
    stat("ov.fontName", "skip", "미프리로드 " + next.family + " " + next.style);
    return;
  }
  try { node.fontName = next; } catch (e) { stat("ov.fontName", "error", e && e.message); return; }
  stat("ov.fontName", "ok");
  if (ov.fontWeight !== undefined) bindFontWeight(node, ov.fontWeight, next);
  if (ov.fontFamily !== undefined) bindFontFamily(node, ov.fontFamily, next);
}
function parentLayoutOf(parent) {
  if (!parent || !("layoutMode" in parent)) return null;
  return parent.layoutMode === "VERTICAL" ? "vertical" : parent.layoutMode === "NONE" ? "none" : "horizontal";
}
// descendant 교체(replacement): target 노드를 새 subtree 로 대체
function replaceNode(target, repSpec) {
  if (!target || !target.parent) return;
  const parent = target.parent;
  const idx = parent.children.indexOf(target);
  const newNode = buildNode(repSpec);
  if (!newNode) return;
  try { parent.insertChild(idx, newNode); } catch (e) { DBG.push("교체 삽입 실패: " + (e && e.message)); return; }
  const pl = parentLayoutOf(parent);
  applySizing(newNode, repSpec, pl);
  if (pl === "none") { newNode.x = repSpec.x || 0; newNode.y = repSpec.y || 0; }
  try { target.remove(); } catch (e) {}
}
function buildRef(spec) {
  const comp = COMP_MAP[spec.ref];
  if (!comp) { const e = figma.createFrame(); e.name = "missing:" + spec.ref; return e; }
  const inst = comp.createInstance();
  const paths = COMP_PATHS[spec.ref] || {};
  const descendants = spec.descendants || {};
  // 교체(override 에 type 존재)가 있으면 인스턴스를 detach 해야 구조 변경 가능
  const hasReplacement = Object.keys(descendants).some((pid) => {
    const ov = descendants[pid];
    return ov && typeof ov === "object" && ov.type;
  });
  let node = inst;
  if (hasReplacement) {
    try { node = inst.detachInstance(); } catch (e) { DBG.push("detach 실패: " + (e && e.message)); node = inst; }
  }
  // ref 객체에 직접 쓴 속성 = 컴포넌트 루트 오버라이드 (예: 탈퇴 버튼 fill:"#DC2626")
  if (spec.fill !== undefined) { setFills(node, spec); ROOT_FILL_OVR++; }
  if (spec.stroke !== undefined) setStroke(node, spec);
  if (spec.cornerRadius !== undefined) setCorner(node, spec.cornerRadius);
  if (spec.effect !== undefined) setEffects(node, spec.effect);
  for (const pid in descendants) {
    const ov = descendants[pid];
    const path = paths[pid];
    if (!path) continue;
    const target = nodeAtPath(node, path);
    if (ov && typeof ov === "object" && ov.type) replaceNode(target, ov);
    else applyOverride(target, ov, pid);
  }
  return node;
}

// ---- 노드 디스패치 ----
const SKIP_TYPES = { note: 1, prompt: 1, context: 1, connection: 1, script: 1 };

function buildNode(spec) {
  if (SKIP_TYPES[spec.type]) {
    DBG.push("디자인 전용 노드 건너뜀 [" + (spec.name || spec.id) + " / " + spec.type + "]");
    return null;
  }
  let node;
  switch (spec.type) {
    case "frame": node = buildFrame(spec); break;
    case "group": node = buildGroup(spec); break;
    case "text": node = buildText(spec); break;
    case "icon": node = buildIcon(spec); break;
    case "ref": node = buildRef(spec); break;
    case "path": node = buildPath(spec); break;
    case "rectangle":
      node = figma.createRectangle();
      setFills(node, spec); setStroke(node, spec); setCorner(node, spec.cornerRadius); setEffects(node, spec.effect);
      break;
    case "line":
      // Pencil line(divider) = stroke 색을 채운 얇은 사각형으로 매핑 (fill_container 와도 호환)
      node = figma.createRectangle();
      node.fills = makePaints(spec.stroke) || [];
      node.strokes = [];
      // 두께가 strokeWidth 로만 정의되고 치수가 비면 보정
      if (spec.width == null && typeof spec.strokeWidth === "number") node.resize(node.width, spec.strokeWidth);
      break;
    case "ellipse":
      node = figma.createEllipse();
      setFills(node, spec); setStroke(node, spec); setEffects(node, spec.effect);
      if (spec.innerRadius || spec.startAngle != null || (spec.sweepAngle != null && spec.sweepAngle !== 360)) {
        const sweep = spec.sweepAngle == null ? 360 : spec.sweepAngle;
        const start = (spec.startAngle || 0) * Math.PI / 180;
        try {
          node.arcData = {
            startingAngle: -start,
            endingAngle: sweep === 360 ? -start + 2 * Math.PI : -(((spec.startAngle || 0) + sweep) * Math.PI / 180),
            innerRadius: spec.innerRadius || 0,
          };
        } catch (e) {}
      }
      break;
    case "polygon":
      node = figma.createPolygon();
      if (spec.polygonCount && spec.polygonCount >= 3) { try { node.pointCount = spec.polygonCount; } catch (e) {} }
      setFills(node, spec); setStroke(node, spec);
      setCorner(node, spec.cornerRadius);   // 직접 대입은 $ref 와 배열을 놓친다
      setEffects(node, spec.effect);
      break;
    default:
      DBG.push("미지원 타입 [" + (spec.name || spec.id) + " / " + spec.type + "] → 빈 프레임");
      node = figma.createFrame(); node.name = "unsupported:" + spec.type; node.fills = [];
  }
  if (node) applyCommon(node, spec);
  return node;
}

// ---- 컴포넌트 자식 인덱스 경로 계산 ----
function computePaths(spec, path, out) {
  out[spec.id] = path;
  const ch = spec.children || [];
  ch.forEach((c, i) => computePaths(c, path.concat(i), out));
}

// ---- 폰트 수집 & 로드 ----
// 프리로드 집합과 렌더(buildText)의 fontName 은 반드시 같은 인자로 resolveFont 를 불러야 한다.
// ($변수 해석 포함 — 안 맞으면 렌더 시 t.fontName 할당이 조용히 실패해 폰트가 폴백됨)
function textFontOf(spec) {
  return resolveFont(
    resolveStr(spec.fontFamily) || "Inter",
    resolveStr(spec.fontWeight),
    resolveStr(spec.fontStyle) === "italic"
  );
}
function collectFonts(spec, set, fams, weights) {
  if (!spec || typeof spec !== "object") return;
  // text 노드 + descendants 오버라이드 객체(type 없음)도 폰트 속성을 가질 수 있다
  if (spec.type === "text" || spec.fontFamily !== undefined || spec.fontWeight !== undefined) {
    const r = textFontOf(spec);
    set.add(r.family + "||" + r.style);
    if (fams) { const f = resolveStr(spec.fontFamily); if (f) fams.add(String(f)); }
    if (weights) { const w = resolveStr(spec.fontWeight); if (w != null) weights.add(String(w)); }
  }
  for (const c of spec.children || []) collectFonts(c, set, fams, weights);
  const d = spec.descendants;  // 교체 subtree/오버라이드 안의 텍스트도 프리로드 대상
  if (d) for (const k in d) if (d[k] && typeof d[k] === "object") collectFonts(d[k], set, fams, weights);
}
async function loadFonts(allSpecs) {
  await buildFontIndex(); // 설치된 폰트 목록 먼저 확보 (resolveFont 가 이걸 참조)
  const set = new Set();
  set.add(ANY_FONT.family + "||" + ANY_FONT.style);
  const fams = new Set([ANY_FONT.family, "Inter"]);
  const weights = new Set(["400"]);
  for (const s of allSpecs) collectFonts(s, set, fams, weights);
  // 교차곱 폐쇄: descendants 오버라이드는 대개 fontWeight 만 갖는데, textFontOf 는 fontFamily 가 없으면
  // 무조건 "Inter" 로 계산한다 → 정작 필요한 (원래 패밀리 × 새 굵기) 조합이 프리로드에서 빠진다.
  // 등장한 패밀리 × 등장한 굵기를 전부 미리 로드해 그 구멍을 막는다. loadFontAsync 는 멱등·저비용(≈15회).
  for (const f of fams) for (const w of weights) {
    const r = resolveFont(f, w, false);
    set.add(r.family + "||" + r.style);
  }
  for (const key of set) {
    const i = key.indexOf("||");
    const family = key.slice(0, i), style = key.slice(i + 2);
    try { await figma.loadFontAsync({ family, style }); LOADED.add(key); } catch (e) {}
  }
}

// ---- 변수 생성 (테마 모드 + 숫자/문자열 변수). selectedTheme = 기본 모드로 쓸 테마 ----
async function createVariables(varData, selectedTheme, collectionName) {
  VAR_HEX = {}; VAR_NUM = {}; VAR_STR = {}; VARS = {}; VAR_OBJ = {};
  if (!varData) return;
  const collName = collectionName || "Pencil Tokens";
  // 포맷 판별: 전체형식 {themes, variables} vs 평탄형식 {name:"#hex"}
  let themes = null, vars = varData;
  if (varData.variables) { themes = varData.themes; vars = varData.variables; }

  // 같은 이름의 컬렉션 재사용 (없으면 생성) — 중복 그룹 방지
  let collection = null;
  try {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    collection = cols.find((c) => c.name === collName) || null;
  } catch (e) {}
  const reusedCollection = !!collection;   // 기존 컬렉션을 덮어쓰는지 = 모드 실패 시 경고 문구가 달라진다
  if (!collection) {
    try { collection = figma.variables.createVariableCollection(collName); }
    catch (e) { return; }
  }

  // 테마축(예: mode:[light,dark]) → Figma 모드. 선택한 테마를 맨 앞(=기본 모드)으로.
  let modeNames = [];
  const axisName = themes ? Object.keys(themes)[0] : null;
  if (axisName) modeNames = (themes[axisName] || []).slice();
  if (selectedTheme && modeNames.indexOf(selectedTheme) > 0) {
    modeNames = [selectedTheme].concat(modeNames.filter((m) => m !== selectedTheme));
  }
  // 기존 모드 재사용 + 부족분만 추가
  const existingModes = {};
  for (const m of collection.modes) existingModes[m.name] = m.modeId;
  const modeIds = {};
  if (modeNames.length) {
    if (collection.modes.length <= 1) {
      // 단일 모드(신규/무료): 기본 모드를 선택 테마로 (값 덮어쓰기)
      try { collection.renameMode(collection.defaultModeId, modeNames[0]); } catch (e) {}
      modeIds[modeNames[0]] = collection.defaultModeId;
      for (let i = 1; i < modeNames.length; i++) {
        try { modeIds[modeNames[i]] = collection.addMode(modeNames[i]); }
        catch (e) {
          // 조용히 넘기면 안 된다: 기존 컬렉션이면 남아 있던 다른 테마 값이 이번 테마로 **덮어써진** 상태다.
          DBG.push("모드 추가 실패(" + modeNames[i] + ") — Figma 플랜이 컬렉션당 모드 1개로 제한."
            + (reusedCollection
              ? " ⚠ 기존 컬렉션 '" + collName + "' 의 모드가 '" + modeNames[0] + "' 로 바뀌고 값이 전부 덮어써졌습니다"
                + " (이전 테마 값은 사라짐). 두 테마를 다 남기려면 컬렉션 이름을 테마별로 다르게 주세요."
              : " '" + modeNames[0] + "' 값만 저장됩니다. 다른 테마가 필요하면 컬렉션 이름을 다르게 해서 한 번 더 임포트하세요."));
        }
      }
    } else {
      // 기존 다중 모드: 이름으로 매핑(재사용), 없는 것만 추가
      for (const mn of modeNames) {
        if (existingModes[mn]) modeIds[mn] = existingModes[mn];
        else { try { modeIds[mn] = collection.addMode(mn); } catch (e) {} }
      }
    }
  }

  // 기존 변수 재사용 (같은 이름이면 값만 갱신)
  const existingVars = {};
  try {
    const all = await figma.variables.getLocalVariablesAsync();
    for (const v of all) { if (v.variableCollectionId === collection.id) existingVars[v.name] = v; }
  } catch (e) {}

  for (const name in vars) {
    const def = vars[name];
    const type = (def && typeof def === "object" && def.type) || "color";
    const rawValue = (def && typeof def === "object" && "value" in def) ? def.value : def;
    try {
      if (type === "color") {
        let v = existingVars[name];
        // 같은 이름의 다른 타입 변수가 이미 있으면 createVariable 이 이름 중복으로 예외를 던져 무음 실패한다 → 명시적으로 알린다
        if (v && v.resolvedType !== "COLOR") {
          DBG.push("기존 변수 타입 불일치 " + name + " (" + v.resolvedType + " ≠ COLOR)"
                 + " — Figma 에서 그 변수를 지우고 재실행하세요. 이번 실행은 리터럴로 진행");
          continue;
        }
        if (!v) v = figma.variables.createVariable(name, collection, "COLOR");
        if (Array.isArray(rawValue)) {
          let lightVal = null;
          for (const entry of rawValue) {
            const mk = axisName && entry.theme ? entry.theme[axisName] : null;
            // 첫 모드(light)는 항상 default 모드. 그 외 모드는 생성됐을 때만.
            const mid = mk ? modeIds[mk] : collection.defaultModeId;
            if (!mid) continue;  // 생성 실패한 모드(플랜 제한 등) → 건너뜀 → light 값 보존
            const c = hexToRGBA(entry.value);
            v.setValueForMode(mid, { r: c.r, g: c.g, b: c.b, a: c.a });
            if (lightVal == null || mk === modeNames[0]) lightVal = entry.value;
          }
          VAR_HEX[name] = lightVal;
        } else {
          const c = hexToRGBA(rawValue);
          const rgba = { r: c.r, g: c.g, b: c.b, a: c.a };
          if (modeNames.length) { for (const mn of modeNames) if (modeIds[mn]) v.setValueForMode(modeIds[mn], rgba); }
          else v.setValueForMode(collection.defaultModeId, rgba);
          VAR_HEX[name] = rawValue;
        }
        VARS[name] = v;
      } else if (type === "number" || type === "string") {
        let val = rawValue;
        if (Array.isArray(rawValue)) {
          // 테마 배열이면 선택 테마(modeNames[0]) 값 우선 — color 경로와 같은 기준
          const pick = rawValue.find((e) => axisName && e && e.theme && e.theme[axisName] === modeNames[0]) || rawValue[0];
          val = pick && pick.value;
        }
        // ★ VAR_NUM/VAR_STR 은 resolveNum/resolveStr/textFontOf 가 쓰는 리터럴 해석 경로다.
        //   바인딩과 무관하게 항상 채운다 — 지우면 폰트가 전부 폴백되고 수치가 미해석 문자열로 샌다.
        (type === "number" ? VAR_NUM : VAR_STR)[name] = val;
        if (!OPT.bindTokens) continue;   // OFF → 변수도 만들지 않는다 (패널엔 있는데 아무것도 안 걸린 반쪽 상태 방지)

        // Figma 측 타입 결정. fontweight-* 만 string("600") → FLOAT(600) 으로 변환한다 (이름 규약 + 값이 숫자일 때만).
        const numeric = (type === "number") || (WEIGHT_RE.test(name) && /^-?\d+(\.\d+)?$/.test(String(val)));
        const ftype = numeric ? "FLOAT" : "STRING";
        const cast = (x) => (numeric ? Number(x) : String(x == null ? "" : x));
        if (numeric && !isFinite(cast(val))) { DBG.push("숫자 변환 실패 " + name + "=" + val); continue; }

        let v = existingVars[name];
        if (v && v.resolvedType !== ftype) {
          DBG.push("기존 변수 타입 불일치 " + name + " (" + v.resolvedType + " ≠ " + ftype + ")"
                 + " — Figma 에서 그 변수를 지우고 재실행하세요. 이번 실행은 리터럴로 진행");
          continue;
        }
        if (!v) v = figma.variables.createVariable(name, collection, ftype);
        if (Array.isArray(rawValue)) {
          for (const entry of rawValue) {
            const mk = axisName && entry.theme ? entry.theme[axisName] : null;
            const mid = mk ? modeIds[mk] : collection.defaultModeId;
            if (!mid) continue;   // 생성 실패한 모드(플랜 제한 등) → 건너뜀
            v.setValueForMode(mid, cast(entry.value));
          }
        } else if (modeNames.length) {
          for (const mn of modeNames) if (modeIds[mn]) v.setValueForMode(modeIds[mn], cast(val));
        } else {
          v.setValueForMode(collection.defaultModeId, cast(val));
        }
        if (LINEHEIGHT_RE.test(name)) {
          try {
            v.description = "배수(multiplier) 값. Figma 는 lineHeight 에 변수를 걸면 단위를 PIXELS 로 강제하므로,"
              + " 바인딩하면 " + cast(val) + "px 이 됩니다 — 바인딩 금지. 값 참고용.";
          } catch (e) {}
        }
        VAR_OBJ[name] = v;
      }
    } catch (e) { DBG.push("변수 생성 실패 " + name + ": " + (e && e.message)); }
  }
}

// 숫자/문자열 변수 참조 해석
function resolveNum(v) {
  if (typeof v === "string" && v[0] === "$") { const r = VAR_NUM[v.slice(1)]; return r == null ? v : r; }
  return v;
}
function resolveStr(v) {
  if (typeof v === "string" && v[0] === "$") { const r = VAR_STR[v.slice(1)]; return r == null ? v : r; }
  return v;
}

// ---- 토큰 바인딩 (Figma Variable) ----
// 설계 원칙: 리터럴을 먼저 정확히 대입한 **뒤에만** 바인딩을 덧붙이고, 직후 같은 속성을 다시 읽어
// 의도값과 다르면 즉시 언바인딩 + 리터럴 복구한다. 문서와 실동작이 어긋나도 시각 회귀가 0이 된다.
let BIND_STAT = {};   // field -> {ok, revert, error, skip, samples[]}
let CAP = {};         // field -> false 면 이후 시도를 건너뜀 (프로브 / 서킷 브레이커가 설정)

function stat(field, kind, sample) {
  const s = BIND_STAT[field] || (BIND_STAT[field] = { ok: 0, revert: 0, error: 0, skip: 0, samples: [] });
  s[kind]++;
  if (sample && s.samples.length < 3) s.samples.push(sample);   // 690건 실패가 690줄이 되는 걸 막는다
  return s;
}

function varObjFor(ref, wantType) {
  if (typeof ref !== "string" || ref[0] !== "$") return null;
  const v = VAR_OBJ[ref.slice(1)];
  if (!v) return null;
  if (wantType && v.resolvedType !== wantType) return null;
  return v;
}

/**
 * node 의 field 에 변수를 덧바인딩한다. 실패·불일치는 전부 되돌린다.
 * @param ref     "$토큰명" (리터럴이면 아무것도 안 함)
 * @param expect  바인딩 직전에 대입해 둔 리터럴 값 = 리드백 비교 기준
 * @param readFn  노드에서 비교값을 꺼내는 함수 (생략 시 node[field])
 * @param restoreFn 되돌릴 때 리터럴을 복구하는 함수. readFn 을 주면 **반드시 같이** 줘야 한다 —
 *                  fontFamily/fontWeight 는 실제 저장소가 node.fontName 이라 node[field] 대입으로 복구되지 않는다.
 */
// @param statField 집계·차단 키를 field 와 다르게 쓸 때 (TextStyle 은 "style:fontSize" 처럼 분리해
//                  노드 바인딩 통계와 섞이지 않게 한다. 지원 여부도 노드와 별개로 판정되므로 CAP 도 이 키로 본다)
function bindField(node, field, ref, wantType, expect, readFn, restoreFn, statField) {
  const SF = statField || field;
  if (!OPT.bindTokens) return false;
  if (typeof ref !== "string" || ref[0] !== "$") return false;   // 리터럴 = 바인딩 대상 아님
  if (CAP[SF] === false) { stat(SF, "skip"); return false; }
  const v = varObjFor(ref, wantType);
  if (!v) { stat(SF, "skip", ref + " — 변수 없음/타입 불일치"); return false; }
  if (!node || typeof node.setBoundVariable !== "function") { stat(SF, "skip", "setBoundVariable 미지원 노드"); return false; }
  try {
    node.setBoundVariable(field, v);
  } catch (e) {
    stat(SF, "error", (node.name || "?") + ": " + (e && e.message));
    return false;
  }
  try {
    const got = readFn ? readFn(node) : node[field];
    if (got !== expect) {
      try { node.setBoundVariable(field, null); } catch (e2) {}
      // 값까지 틀어졌을 수 있으니 리터럴을 되돌린다 (언바인딩만으로는 복구되지 않는다)
      try { if (restoreFn) restoreFn(node); else node[field] = expect; } catch (e3) {}
      const s = stat(SF, "revert", (node.name || "?") + ": " + JSON.stringify(got) + " ≠ " + JSON.stringify(expect));
      // 서킷 브레이커는 "이 필드가 근본적으로 안 먹는다"일 때만 — 성공 이력이 있으면 개별 예외일 뿐이므로 계속 시도한다
      if (s.revert >= 3 && s.ok === 0) { CAP[SF] = false; DBG.push("바인딩 중단: " + SF + " — 되돌림 3회, 성공 0"); }
      return false;
    }
  } catch (e) {
    try { node.setBoundVariable(field, null); } catch (e2) {}
    try { if (restoreFn) restoreFn(node); else node[field] = expect; } catch (e3) {}
    stat(SF, "error", "리드백 실패: " + (e && e.message));
    return false;
  }
  stat(SF, "ok");
  return true;
}

// 프로브용: 이름 패턴 + 타입이 맞는 첫 변수와 그 원시 값
function probeVar(re, wantType) {
  for (const name in VAR_OBJ) {
    if (!re.test(name)) continue;
    const v = VAR_OBJ[name];
    if (wantType && v.resolvedType !== wantType) continue;
    const raw = VAR_NUM[name] !== undefined ? VAR_NUM[name] : VAR_STR[name];
    return { v: v, name: name, value: v.resolvedType === "FLOAT" ? Number(raw) : String(raw) };
  }
  return null;
}

// 필드 지원 여부는 파일 단위로 불변이다 → 임시 노드로 **한 번만** 측정하고 즉시 제거한다.
// 판정: 예외를 던지거나 값을 "리터럴도 토큰값도 아닌 것"으로 만들면 그 필드를 차단(CAP=false).
// 값이 안 바뀌는 무반응은 차단하지 않는다 — 리터럴을 먼저 정확히 대입하므로 시각적으로 무해하고,
// 바인딩은 남아서 Dev Mode·변수 패널에 토큰이 보인다.
async function probeCapabilities() {
  if (!OPT.bindTokens) return;
  const note = [];
  const judge = (field, before, after, want) => {
    if (after === want) { note.push(field + "=존중"); return; }
    if (after === before) { note.push(field + "=무시(리터럴 유지)"); return; }
    CAP[field] = false;
    note.push(field + "=차단(" + JSON.stringify(before) + "→" + JSON.stringify(after) + ")");
  };
  let t = null, r = null;
  try {
    t = figma.createText();
    t.fontName = ANY_FONT;
    t.characters = "Ag";

    const fs = probeVar(/^fontsize[-.]/i, "FLOAT");
    if (fs) {
      const before = fs.value === 11 ? 12 : 11;
      t.fontSize = before;
      try { t.setBoundVariable("fontSize", fs.v); judge("fontSize", before, t.fontSize, fs.value); }
      catch (e) { CAP.fontSize = false; note.push("fontSize=예외(" + (e && e.message) + ")"); }
      try { t.setBoundVariable("fontSize", null); } catch (e) {}
      t.fontSize = before;
    }

    // fontWeight: Regular 노드에 다른 굵기 변수를 걸어 fontName.style 이 바뀌는지 본다.
    let fw = null;
    for (const name in VAR_OBJ) {
      if (!WEIGHT_RE.test(name) || VAR_OBJ[name].resolvedType !== "FLOAT") continue;
      const raw = Number(VAR_NUM[name] !== undefined ? VAR_NUM[name] : VAR_STR[name]);
      if (raw && raw !== 400) { fw = { v: VAR_OBJ[name], value: raw }; break; }
    }
    if (fw) {
      const base = resolveFont(ANY_FONT.family, "400", false);
      const want = resolveFont(ANY_FONT.family, String(fw.value), false);
      if (want.family === base.family && want.style !== base.style) {
        try { await figma.loadFontAsync(want); } catch (e) {}
        t.fontName = base;
        try {
          t.setBoundVariable("fontWeight", fw.v);
          const got = t.fontName && t.fontName !== figma.mixed ? t.fontName.style : null;
          judge("fontWeight", base.style, got, want.style);
        } catch (e) { CAP.fontWeight = false; note.push("fontWeight=예외(" + (e && e.message) + ")"); }
        try { t.setBoundVariable("fontWeight", null); } catch (e) {}
        try { t.fontName = base; } catch (e) {}
      } else note.push("fontWeight=측정불가(대조 스타일 없음)");
    }

    const ls = probeVar(/^tracking[-.]/i, "FLOAT");
    if (ls) {
      const before = ls.value === 0 ? 1 : 0;
      t.letterSpacing = { value: before, unit: "PIXELS" };
      try {
        t.setBoundVariable("letterSpacing", ls.v);
        judge("letterSpacing", before, t.letterSpacing && t.letterSpacing.value, ls.value);
      } catch (e) { CAP.letterSpacing = false; note.push("letterSpacing=예외(" + (e && e.message) + ")"); }
      try { t.setBoundVariable("letterSpacing", null); } catch (e) {}
    }

    // lineHeight 는 프로덕션에서 바인딩하지 않는다(배수↔PIXELS 불일치). 실제 단위만 기록해 둔다.
    const lh = probeVar(LINEHEIGHT_RE, "FLOAT");
    if (lh) {
      t.lineHeight = { value: 150, unit: "PERCENT" };
      try {
        t.setBoundVariable("lineHeight", lh.v);
        note.push("lineHeight=바인딩 시 " + JSON.stringify(t.lineHeight) + " (그래서 영구 제외)");
      } catch (e) { note.push("lineHeight=예외(" + (e && e.message) + ")"); }
      try { t.setBoundVariable("lineHeight", null); } catch (e) {}
    }

    const cr = probeVar(/^radius[-.]/i, "FLOAT");
    if (cr) {
      r = figma.createRectangle();
      const before = cr.value === 3 ? 5 : 3;
      r.cornerRadius = before;
      try { r.setBoundVariable("cornerRadius", cr.v); judge("cornerRadius", before, r.cornerRadius, cr.value); }
      catch (e) { CAP.cornerRadius = false; note.push("cornerRadius=예외(" + (e && e.message) + ")"); }
      try { r.setBoundVariable("cornerRadius", null); } catch (e) {}
    }
  } catch (e) {
    DBG.push("capability 프로브 실패(보수적으로 계속 진행): " + (e && e.message));
  } finally {
    if (t) { try { t.remove(); } catch (e) {} }
    if (r) { try { r.remove(); } catch (e) {} }
  }
  if (note.length) DBG.push("바인딩 프로브: " + note.join(" · "));
}

// ---- 타이포 프리셋 → Figma Text Style ----
// 왜: Pencil·Figma 모두 변수 타입이 4종(bool/color/number/string)뿐이라 "프리셋"(크기·굵기·행간·자간 세트)을
// 변수로는 표현할 수 없다. Figma 에서 프리셋의 제자리는 **Text Style** 이고, TextStyle 은 setBoundVariable 로
// 필드별 변수 바인딩까지 받는다 → 프리셋과 토큰을 동시에 만족시킬 수 있는 유일한 경로.
// 덤: lineHeight 는 노드에 변수를 걸면 단위가 PIXELS 로 강제돼 배수(1.5)가 1.5px 이 되지만,
// Text Style 에는 **PERCENT 리터럴**로 담기므로 지금까지 유일하게 복구 불가였던 손실이 여기서 해소된다.
let TEXT_STYLES = {};      // 프리셋 이름 -> TextStyle
let STYLE_BY_AXES = {};    // 5축 키 -> 프리셋 이름
let TS_ALIASES = {};       // 별칭 -> 프리셋 (Figma 스타일은 만들지 않는다 — 값이 같아 스타일만 늘어난다)
let TS_QUEUE = [];         // 빌드 중 모아 둔 적용 대상 {node, spec, fnt, name} — 빌드 후 비동기로 처리

// 5축 신원. 노드는 "$토큰", 프리셋 정의는 "토큰" 이라 노드 쪽 $ 를 떼고 맞춘다
// (make-typography-styles.py / verify.py TYPO_AXES 와 같은 계약 — 조합은 유일함이 보장돼 있다)
const TS_AXES = ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight"];
function axesKeyOfSpec(spec) {
  const p = [];
  for (const a of TS_AXES) {
    const v = spec[a];
    p.push(typeof v === "string" && v[0] === "$" ? v.slice(1) : (v === undefined ? "" : String(v)));
  }
  return p.join("|");
}
function axesKeyOfPreset(def) {
  const p = [];
  for (const a of TS_AXES) p.push(def[a] === undefined ? "" : String(def[a]));
  return p.join("|");
}

// 프리셋 정의를 Pencil 노드 스펙 모양("$토큰")으로 되돌린다 — textFontOf/resolveNum 을 그대로 재사용하려고
function specOfPreset(def) {
  const s = {};
  for (const a of TS_AXES) if (def[a] !== undefined) s[a] = "$" + def[a];
  return s;
}

// 스타일에서만 가능한 것과 불가능한 것을 임시 스타일 1개로 한 번만 측정한다 (probeCapabilities 와 같은 철학).
// 특히 lineHeight: 노드에서는 바인딩이 PIXELS 로 강제돼 배수가 깨지지만, 스타일에서도 그런지는
// 공식 문서에 없다 → 실측해서 되면 걸고, 안 되면 CAP 으로 막아 프로덕션에서 되돌림이 안 나게 한다.
async function probeTextStyle() {
  const note = [];
  let st = null, probeText = null;
  try {
    st = figma.createTextStyle();
    st.name = "__pencil_probe__";
    st.fontName = ANY_FONT;
    // 적용 프로브 — 실제로 노드에 붙는지 한 번만 본다. 안 되면 700번 헛시도 대신 즉시 포기한다.
    // (동기 setter 는 실측상 반영되지 않았다 → setTextStyleIdAsync 가 있으면 그쪽을 쓴다)
    try {
      probeText = figma.createText();
      probeText.fontName = ANY_FONT;
      probeText.characters = "Ag";
      st.fontSize = probeText.fontSize;
      st.letterSpacing = probeText.letterSpacing;
      st.lineHeight = probeText.lineHeight;
      if (typeof probeText.setTextStyleIdAsync === "function") await probeText.setTextStyleIdAsync(st.id);
      else probeText.textStyleId = st.id;
      if (probeText.textStyleId !== st.id) {
        CAP["style"] = false;
        note.push("적용=안 붙음(" + JSON.stringify(probeText.textStyleId) + ") → 노드별 개별 바인딩으로 진행");
      } else note.push("적용=가능" + (typeof probeText.setTextStyleIdAsync === "function" ? "(async)" : "(sync)"));
    } catch (e) { CAP["style"] = false; note.push("적용=예외(" + (e && e.message) + ")"); }

    const lh = probeVar(LINEHEIGHT_RE, "FLOAT");
    if (lh && typeof st.setBoundVariable === "function") {
      st.lineHeight = { value: 150, unit: "PERCENT" };
      try {
        st.setBoundVariable("lineHeight", lh.v);
        const got = st.lineHeight;
        const kept = got && got.unit === "PERCENT" && got.value === 150;
        if (!kept) { CAP["style:lineHeight"] = false; note.push("lineHeight=바인딩 시 " + JSON.stringify(got) + " → 리터럴 PERCENT 유지"); }
        else note.push("lineHeight=바인딩 가능(PERCENT 유지)");
      } catch (e) { CAP["style:lineHeight"] = false; note.push("lineHeight=예외(" + (e && e.message) + ")"); }
    } else if (lh) {
      CAP["style:lineHeight"] = false; note.push("lineHeight=setBoundVariable 미지원");
    }
  } catch (e) {
    CAP["style"] = false;
    DBG.push("Text Style 프로브 실패 — 프리셋 없이 진행: " + (e && e.message));
    cleanupProbe(st, probeText);
    return false;
  }
  cleanupProbe(st, probeText);
  if (note.length) DBG.push("Text Style 프로브: " + note.join(" · "));
  return true;
}

function cleanupProbe(st, txt) {
  if (txt) { try { txt.remove(); } catch (e) {} }
  if (st) { try { st.remove(); } catch (e) {} }
}

async function createTextStyles(tsData) {
  TEXT_STYLES = {}; STYLE_BY_AXES = {}; TS_ALIASES = {}; TS_QUEUE = [];
  if (!OPT.bindTokens || !tsData || !tsData.styles) return;
  TS_ALIASES = tsData.aliases || {};

  // 이름으로 재사용 (재임포트마다 스타일이 불어나는 걸 막는다 — 컬렉션 재사용과 같은 방침)
  let existing = {};
  try {
    const list = await figma.getLocalTextStylesAsync();
    for (const s of list) existing[s.name] = s;
  } catch (e) { DBG.push("기존 Text Style 조회 실패: " + (e && e.message)); }

  if (typeof figma.createTextStyle !== "function") {
    DBG.push("Text Style 미지원 환경 — 프리셋 없이 노드별 바인딩으로 진행");
    CAP["style"] = false;
    return;
  }
  if (!(await probeTextStyle())) return;   // 생성·적용이 안 되면 CAP.style=false 로 두고 전체를 건너뛴다

  let made = 0;
  for (const name in tsData.styles) {
    const def = tsData.styles[name];
    const spec = specOfPreset(def);
    // Figma 는 "/" 를 폴더로 취급한다 → 패널에서 heading/body/caption/system 으로 묶인다
    const styleName = (def.group ? def.group + "/" : "") + name;
    let st = existing[styleName];
    try {
      if (!st) { st = figma.createTextStyle(); st.name = styleName; }
    } catch (e) { DBG.push("Text Style 생성 실패 " + styleName + ": " + (e && e.message)); CAP["style"] = false; return; }

    // 1) 리터럴 먼저 — 바인딩이 전부 실패해도 스타일 자체는 정확하다 (노드 바인딩과 같은 안전 순서)
    const fnt = textFontOf(spec);
    try { st.fontName = fnt; } catch (e) { DBG.push("스타일 폰트 실패 " + styleName + ": " + (e && e.message)); }
    const fsz = resolveNum(spec.fontSize);
    if (typeof fsz === "number") { try { st.fontSize = fsz; } catch (e) {} }
    const ls = resolveNum(spec.letterSpacing);
    try { st.letterSpacing = typeof ls === "number" ? { value: ls, unit: "PIXELS" } : { value: 0, unit: "PIXELS" }; } catch (e) {}
    const lh = resolveNum(spec.lineHeight);
    // ★ 배수 → PERCENT. 미지정은 AUTO(폰트 기본) — 실측상 행간은 멀티라인 노드에만 붙으므로
    //   행간 없는 프리셋에 값을 넣으면 단일라인 텍스트가 벌어진다(시각 회귀).
    try { st.lineHeight = typeof lh === "number" ? { value: lh * 100, unit: "PERCENT" } : { unit: "AUTO" }; } catch (e) {}

    // 2) 그 다음 바인딩. 실패는 bindField 가 전부 되돌린다 → 최악이어도 리터럴 스타일로 남는다
    if (typeof st.setBoundVariable === "function") {
      if (typeof fsz === "number") bindField(st, "fontSize", spec.fontSize, "FLOAT", st.fontSize, null, null, "style:fontSize");
      if (typeof ls === "number") {
        bindField(st, "letterSpacing", spec.letterSpacing, "FLOAT", lsKey(st), lsKey,
                  (n) => { n.letterSpacing = { value: ls, unit: "PIXELS" }; }, "style:letterSpacing");
      }
      if (typeof lh === "number") {
        // 노드에서는 불가능했던 바인딩. 되면 이득, 안 되면 PERCENT 리터럴이 그대로 남는다 — 어느 쪽이든 손해가 없다
        bindField(st, "lineHeight", spec.lineHeight, "FLOAT", lhKey(st), lhKey,
                  (n) => { n.lineHeight = { value: lh * 100, unit: "PERCENT" }; }, "style:lineHeight");
      }
      // fontFamily 는 토큰 값과 실제 해석된 패밀리가 같을 때만 (미설치 폰트를 걸면 스타일 전체가 missing font)
      const rawFam = typeof spec.fontFamily === "string" && spec.fontFamily[0] === "$" ? VAR_STR[spec.fontFamily.slice(1)] : null;
      if (rawFam != null && String(rawFam) === fnt.family) {
        bindField(st, "fontFamily", spec.fontFamily, "STRING", fontKey(fnt), fontKeyOf,
                  (n) => { n.fontName = fnt; }, "style:fontFamily");
      } else if (rawFam != null) {
        stat("style:fontFamily", "skip", "미설치 폴백: " + rawFam + " → " + fnt.family);
      }
      if (!/italic/i.test(fnt.style)) {
        bindField(st, "fontWeight", spec.fontWeight, "FLOAT", fontKey(fnt), fontKeyOf,
                  (n) => { n.fontName = fnt; }, "style:fontWeight");
      }
    }

    TEXT_STYLES[name] = st;
    STYLE_BY_AXES[axesKeyOfPreset(def)] = name;
    made++;
  }
  DBG.push("Text Style " + made + "개 준비 (재사용 " + Object.keys(existing).length + " 중 매칭분 포함)"
    + (Object.keys(TS_ALIASES).length ? " · 별칭 " + Object.keys(TS_ALIASES).length + "개는 스타일을 만들지 않음" : ""));
}

// 스타일 적용은 **빌드가 다 끝난 뒤** 비동기로 한다. buildText 는 동기라 여기선 줄만 세운다.
// (실측: 동기 setter `node.textStyleId = id` 는 실제 Figma 에서 반영되지 않아 전량 되돌림이 났다.
//  Figma 가 스타일 적용을 setTextStyleIdAsync 로 옮겼기 때문으로 보인다.)
function queueTextStyle(t, spec, fnt) {
  if (!OPT.bindTokens || CAP["style"] === false) return false;
  const name = STYLE_BY_AXES[axesKeyOfSpec(spec)];
  if (!name || !TEXT_STYLES[name]) return false;
  TS_QUEUE.push({ node: t, spec: spec, fnt: fnt, name: name });
  return true;
}

// 스타일이 붙은 뒤에도 노드의 타이포 값이 그대로인가 = 시각 회귀 0 인가.
// 어긋난 항목을 문자열로 돌려준다(진단용) — 없으면 null.
function textStyleMismatch(t, st, before) {
  const bad = [];
  if (t.textStyleId !== st.id) bad.push("textStyleId " + JSON.stringify(t.textStyleId) + "≠" + JSON.stringify(st.id));
  if (fontKeyOf(t) !== before.f) bad.push("font " + before.f + "→" + fontKeyOf(t));
  if (t.fontSize !== before.s) bad.push("size " + before.s + "→" + t.fontSize);
  if (lsKey(t) !== before.l) bad.push("ls " + before.l + "→" + lsKey(t));
  if (lhKey(t) !== before.h) bad.push("lh " + before.h + "→" + lhKey(t));
  return bad.length ? bad.join(" · ") : null;
}

// 줄 세워 둔 노드에 스타일을 입힌다. 실패한 노드는 **그 자리에서 개별 바인딩으로 되돌린다** —
// 스타일이 안 붙어도 토큰이 유실되면 안 되기 때문(프리셋 도입 전과 완전히 같은 결과가 된다).
async function applyQueuedTextStyles() {
  if (!TS_QUEUE.length) return;
  const useAsync = typeof figma.createText === "function"
    && TS_QUEUE[0].node && typeof TS_QUEUE[0].node.setTextStyleIdAsync === "function";
  let fellBack = 0;
  for (const q of TS_QUEUE) {
    const st = TEXT_STYLES[q.name];
    if (!st || CAP["style"] === false) { bindTypographyFields(q.node, q.spec, q.fnt); fellBack++; continue; }
    const before = { f: fontKeyOf(q.node), s: q.node.fontSize, l: lsKey(q.node), h: lhKey(q.node) };
    let err = null;
    try {
      if (useAsync) await q.node.setTextStyleIdAsync(st.id);
      else q.node.textStyleId = st.id;
    } catch (e) { err = (e && e.message) || String(e); }
    if (!err) {
      try { err = textStyleMismatch(q.node, st, before); } catch (e) { err = "리드백 실패: " + (e && e.message); }
    }
    if (err) {
      try { if (useAsync) await q.node.setTextStyleIdAsync(""); else q.node.textStyleId = ""; } catch (e) {}
      const s = stat("textStyle", "revert", (q.node.name || "?") + " → " + q.name + ": " + err);
      bindTypographyFields(q.node, q.spec, q.fnt);   // 토큰은 살린다
      fellBack++;
      if (s.revert >= 3 && s.ok === 0) {
        CAP["style"] = false;
        DBG.push("Text Style 적용 중단 — 되돌림 3회, 성공 0 (나머지는 노드별 개별 바인딩)");
      }
    } else stat("textStyle", "ok");
  }
  DBG.push("Text Style 적용: " + (BIND_STAT.textStyle ? BIND_STAT.textStyle.ok : 0) + "/" + TS_QUEUE.length
    + (fellBack ? " · 개별 바인딩 폴백 " + fellBack : "") + (useAsync ? "" : " (동기 setter — setTextStyleIdAsync 없음)"));
  TS_QUEUE = [];
}

// ---- 이미지 준비 ----
function prepareImages(imagesObj) {
  for (const url in imagesObj) {
    try {
      const b64 = imagesObj[url].split(",")[1];
      const bytes = figma.base64Decode(b64);
      const img = figma.createImage(bytes);
      IMAGE_HASHES[url] = img.hash;
    } catch (e) {}
  }
}

// ---- ref(인스턴스) 수집 ----
function collectRefs(spec, out) {
  if (!spec || typeof spec !== "object") return;
  if (spec.type === "ref" && spec.ref) out.add(spec.ref);
  for (const c of spec.children || []) collectRefs(c, out);
}

// 페이지 전환 (비동기 API 우선, 실패 시 동기 폴백)
async function switchToPage(page) {
  if (!page || figma.currentPage === page) return;
  try { await figma.setCurrentPageAsync(page); }
  catch (e) { try { figma.currentPage = page; } catch (e2) {} }
}

// ---- 컴포넌트 1개 생성 (대상 페이지에서 직접 빌드 → 이동 없음) ----
async function buildOneComponent(cspec, targetPage) {
  if (COMP_MAP[cspec.id]) return;
  // 컴포넌트화 후 다른 페이지로 옮기면 auto-layout 텍스트 측정이 깨질 수 있으므로
  // 처음부터 대상 페이지로 전환해 거기서 빌드한다.
  if (targetPage) await switchToPage(targetPage);
  const frame = buildFrame(cspec);
  applyCommon(frame, cspec);
  frame.x = cspec.x || 0; frame.y = cspec.y || 0;
  applySizing(frame, cspec, null);
  const comp = figma.createComponentFromNode(frame);
  COMP_MAP[cspec.id] = comp;
  COMP_SPEC[cspec.id] = cspec;
  const paths = {}; computePaths(cspec, [], paths); COMP_PATHS[cspec.id] = paths;
}

// 선택된 화면이 (전이적으로) 쓰는 컴포넌트만, 의존성 순서대로 생성
async function buildNeededComponents(selectedScreens, allComponents, resolvePage) {
  const compById = {};
  for (const c of allComponents) compById[c.id] = c;
  const building = new Set();
  async function ensure(c) {
    if (!c || COMP_MAP[c.id] || building.has(c.id)) return;
    building.add(c.id);
    const refs = new Set(); collectRefs(c, refs);
    for (const rid of refs) { if (compById[rid]) await ensure(compById[rid]); }
    await buildOneComponent(c, resolvePage ? resolvePage(c.id) : null);
    building.delete(c.id);
  }
  const seed = new Set();
  for (const s of selectedScreens) collectRefs(s, seed);
  for (const rid of seed) { if (compById[rid]) await ensure(compById[rid]); }
}

// ---- 페이지 찾기/생성 (이름으로 재사용) ----
function getOrCreatePage(name) {
  if (!name) return null;
  const pages = figma.root.children;
  for (const p of pages) if (p.name === name) return p;
  const p = figma.createPage();
  p.name = name;
  return p;
}

// ---- 메인 임포트 ----
async function importDesign(data, icons, selected, pageMap, compPageMap, theme, collectionName, opts) {
  resetState();   // 세션 내 재실행 안전 (특히 COMP_MAP 잔존 방지)
  OPT = Object.assign({ bindTokens: true, iconSwap: true }, opts || {});   // opts 를 안 보내는 구 ui.html 은 전부 ON
  ICONS = icons || {};
  const allScreens = data.screens || [];
  const allComponents = data.components || [];
  pageMap = pageMap || {};
  compPageMap = compPageMap || {};
  // 선택된 화면 (selected = 인덱스 배열; 없으면 전체)
  // selected 가 배열이면(빈 배열 포함) 그대로 사용. 미지정(undefined)일 때만 전체.
  const indices = Array.isArray(selected) ? selected : allScreens.map((_, i) => i);
  const screens = indices.map((i) => allScreens[i]).filter(Boolean);

  // 순서 중요: createVariables 가 VAR_NUM/VAR_STR 을 채워야 loadFonts 의 $변수(fontFamily 등) 해석이 된다.
  // (createVariables 진입부에서 VAR_* 를 리셋하므로 loadFonts 뒤로 옮기면 안 됨)
  figma.ui.postMessage({ type: "progress", text: "변수/이미지 준비 중..." });
  await createVariables(data.variables || {}, theme, collectionName);
  prepareImages(data.images || {});
  figma.ui.postMessage({ type: "progress", text: "폰트 로딩 중..." });
  await loadFonts([].concat(allComponents, screens));
  await probeCapabilities();   // 필드별 바인딩 지원 여부를 1회만 측정 (변수·폰트가 준비된 뒤)
  await createTextStyles(data.typographyStyles);   // 타이포 프리셋 → Text Style (변수·폰트 준비 후)
  await probeIconSwap();       // 중첩 인스턴스 swapComponent 지원 여부 — 실패 시 아이콘 마스터를 아예 만들지 않는다

  // 0) 화면 페이지 준비 (이름→PageNode)
  const pageOf = {};        // 화면 인덱스 -> PageNode
  let firstScreenPage = null;
  for (const i of indices) {
    const nm = pageMap[i];
    const pg = nm ? getOrCreatePage(nm) : figma.currentPage;
    pageOf[i] = pg || figma.currentPage;
    if (!firstScreenPage) firstScreenPage = pageOf[i];
  }
  if (!firstScreenPage) firstScreenPage = figma.currentPage;

  const offsets = {};       // pageId -> 다음 x (컴포넌트·화면 공유: 같은 페이지면 가로로 나란히)
  const usedPages = {};     // 페이지 집계용

  // 0.5) 아이콘 슬롯 수집(항상 — isIconNode 판별에도 쓰임) + 아이콘 마스터 전량 생성(스왑 지원 시에만)
  collectIconSlots(allComponents, screens);   // 선택된 화면 기준 (buildNeededComponents 와 같은 원칙)
  if (CAP["ov.icon"] !== false) {
    figma.ui.postMessage({ type: "progress", text: "아이콘 컴포넌트 생성 중..." });
    await buildIconComponents(allComponents, screens, offsets);
  }
  await switchToPage(firstScreenPage);

  // 1) 선택된 화면이 쓰는 컴포넌트만, 각자 지정된 페이지에서 직접 생성 (이동 없음)
  figma.ui.postMessage({ type: "progress", text: "컴포넌트 생성 중..." });
  const resolveCompPage = (id) => (compPageMap[id] ? getOrCreatePage(compPageMap[id]) : firstScreenPage);
  await buildNeededComponents(screens, allComponents, resolveCompPage);
  // 컴포넌트 위치 정렬 (이미 각자 페이지에 있음)
  for (const id in COMP_MAP) {
    const c = COMP_MAP[id];
    const pg = (c.parent && c.parent.type === "PAGE") ? c.parent : firstScreenPage;
    const ox = offsets[pg.id] || 0;
    c.x = ox; c.y = 0;
    offsets[pg.id] = ox + c.width + 60;
    usedPages[pg.name] = 1;
  }

  // 2) 선택된 화면 생성 (대상 페이지에서 직접 빌드, 페이지별 가로 배치)
  figma.ui.postMessage({ type: "progress", text: "화면 " + screens.length + "개 생성 중..." });
  const placed = [];
  for (const i of indices) {
    const sspec = allScreens[i];
    if (!sspec) continue;
    const pg = pageOf[i];
    await switchToPage(pg);
    const frame = buildFrame(sspec);
    applyCommon(frame, sspec);
    applySizing(frame, sspec, null);
    const ox = offsets[pg.id] || 0;
    frame.x = ox; frame.y = 0;
    offsets[pg.id] = ox + frame.width + 80;
    usedPages[pg.name] = 1;
    placed.push(frame);
  }

  // 3) 프리셋 스타일 적용 — 트리가 다 만들어진 뒤에 한다.
  //    buildText 가 동기라 빌드 중에는 async API(setTextStyleIdAsync)를 못 쓰기 때문.
  if (TS_QUEUE.length) figma.ui.postMessage({ type: "progress", text: "타이포 프리셋 적용 중..." });
  await applyQueuedTextStyles();

  // 포커스: 첫 화면 페이지로 전환 후 줌
  await switchToPage(firstScreenPage);
  try {
    const onPage = placed.filter((n) => n.parent === firstScreenPage);
    if (onPage.length) figma.viewport.scrollAndZoomIntoView(onPage);
  } catch (e) {}

  figma.ui.postMessage({ type: "debug", text: "ref 루트 fill 오버라이드 적용: " + ROOT_FILL_OVR + "곳 (0이면 옛 코드 — 플러그인 재실행 필요)" });
  figma.ui.postMessage({ type: "debug", text: bindSummary() });
  if (DBG.length) figma.ui.postMessage({ type: "debug", text: "=== 빌드 경고 ===\n" + DBG.join("\n") });

  figma.notify("임포트 완료 ✓ 화면 " + placed.length + " / 컴포넌트 " + Object.keys(COMP_MAP).length + " / 페이지 " + Object.keys(usedPages).length);
  figma.ui.postMessage({ type: "done" });
}

// 필드별 바인딩 집계. 690건이 실패해도 690줄이 아니라 한 줄 + 샘플 3개로 보고한다.
function bindSummary() {
  const fields = Object.keys(BIND_STAT).sort();
  if (!fields.length) return "=== 토큰 바인딩 === 시도 없음 (bindTokens=" + OPT.bindTokens + ")";
  const rows = fields.map((f) => {
    const s = BIND_STAT[f];
    let line = "  " + f + ": 성공 " + s.ok + " / 되돌림 " + s.revert + " / 예외 " + s.error + " / 건너뜀 " + s.skip;
    for (const ex of s.samples) line += "\n      예) " + ex;
    return line;
  });
  const blocked = Object.keys(CAP).filter((k) => CAP[k] === false);
  return "=== 토큰 바인딩 요약 (bindTokens=" + OPT.bindTokens
    + (blocked.length ? ", 차단된 필드: " + blocked.join(",") : "") + ") ===\n" + rows.join("\n");
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "import") {
    try { await importDesign(msg.data, msg.icons, msg.selected, msg.pageMap, msg.compPageMap, msg.theme, msg.collectionName, msg.opts); }
    catch (e) {
      console.error(e);
      figma.notify("에러: " + (e && e.message ? e.message : e), { error: true });
      figma.ui.postMessage({ type: "error", text: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === "cancel") {
    figma.closePlugin();
  }
};
