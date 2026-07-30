// Pencil(.pen) -> Figma 변환기 (플러그인 메인 스레드)
// UI 가 design-data.json 과 lucide 아이콘 SVG 를 읽어 postMessage 로 전달하면
// 이 코드가 Figma 노드 트리를 재구성한다.

figma.showUI(__html__, { width: 440, height: 520 });

// ---- 전역 상태 ----
const VARS = {};            // 변수명 -> Figma Variable
const IMAGE_HASHES = {};    // url -> imageHash
const COMP_MAP = {};        // pencil 컴포넌트 id -> ComponentNode
const COMP_PATHS = {};      // pencil 컴포넌트 id -> { 자식 pencilId: [인덱스경로] }
const COMP_SPEC = {};       // pencil 컴포넌트 id -> 컴포넌트 spec (치수 상속용)
let ICONS = {};             // 아이콘명 -> SVG 문자열
const DBG = [];             // 진단 로그
let ROOT_FILL_OVR = 0;      // ref 루트 fill 오버라이드 적용 횟수 (코드 반영 확인용)

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
const FONT_RESOLVED = {};       // "family|weight|italic" -> {family, style} (로드 보장됨)

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
    try { node.strokeWeight = sw; } catch (e) {}
  } else if (perSide) {
    if ("strokeTopWeight" in node) {
      // 면별 두께 (예: 하단 밑줄 {bottom:2}, 상단 구분선 {top:1})
      try { node.strokeTopWeight = resolveNum(sw.top) || 0; } catch (e) {}
      try { node.strokeRightWeight = resolveNum(sw.right) || 0; } catch (e) {}
      try { node.strokeBottomWeight = resolveNum(sw.bottom) || 0; } catch (e) {}
      try { node.strokeLeftWeight = resolveNum(sw.left) || 0; } catch (e) {}
    } else {
      const vals = Object.keys(sw).map((k) => sw[k]).filter((v) => typeof v === "number");
      if (vals.length) { try { node.strokeWeight = Math.max.apply(null, vals); } catch (e) {} }
    }
  }
  if (spec.strokeLinecap && "strokeCap" in node) node.strokeCap = { butt: "NONE", round: "ROUND", square: "SQUARE" }[spec.strokeLinecap] || "NONE";
  if (spec.strokeLinejoin && "strokeJoin" in node) node.strokeJoin = { miter: "MITER", bevel: "BEVEL", round: "ROUND" }[spec.strokeLinejoin] || "MITER";
}

// ---- 패딩 정규화 ----
function setPadding(node, p) {
  const rv = (x) => { const v = resolveNum(x); return typeof v === "number" ? v : 0; };
  let t = 0, r = 0, b = 0, l = 0;
  if (Array.isArray(p)) {
    if (p.length === 2) { t = b = rv(p[0]); r = l = rv(p[1]); }
    else if (p.length === 4) { t = rv(p[0]); r = rv(p[1]); b = rv(p[2]); l = rv(p[3]); }
  } else if (p != null) { t = r = b = l = rv(p); }
  node.paddingTop = t; node.paddingRight = r; node.paddingBottom = b; node.paddingLeft = l;
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
      const c = hexToRGBA(e.color || "#00000040");
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
function setCorner(node, cr) {
  if (cr == null) return;
  cr = resolveNum(cr);
  if (typeof cr === "number") { node.cornerRadius = cr; return; }
  if (Array.isArray(cr)) {
    node.topLeftRadius = resolveNum(cr[0]); node.topRightRadius = resolveNum(cr[1]);
    node.bottomRightRadius = resolveNum(cr[2]); node.bottomLeftRadius = resolveNum(cr[3]);
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
  if (vectors.length && node.type === "FRAME") {
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
function buildIcon(spec) {
  const key = (spec.library || "lucide") + "/" + spec.icon;
  const svg = ICONS[key] || ICONS[spec.icon];
  let node;
  if (svg) {
    node = figma.createNodeFromSvg(svg);
    // 라이브러리마다 viewBox 가 다름(lucide/feather=24, phosphor=256) → 현재 폭 기준 리스케일
    const target = spec.width || spec.height || node.width || 24;
    try { if (node.width) node.rescale(target / node.width); } catch (e) {}
  } else {
    DBG.push("아이콘 SVG 없음: " + key + " (CDN 미수신)");
    node = figma.createFrame();
    node.resize(spec.width || 16, spec.height || 16);
    node.fills = [];
  }
  node.name = spec.name || spec.icon || "icon";
  try { node.setPluginData("pcIcon", "1"); } catch (e) {}  // 아이콘 태그 (오버라이드 시 벡터 재색 구분용)
  if (spec.fill) recolor(node, spec.fill);
  return node;
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
  if (spec.fill) t.fills = [makePaint(spec.fill)]; else t.fills = [];
  return t;
}

// ---- 프레임 빌드 ----
function buildFrame(spec) {
  const f = figma.createFrame();
  f.layoutMode = spec.layout === "vertical" ? "VERTICAL" : spec.layout === "none" ? "NONE" : "HORIZONTAL";
  if (f.layoutMode !== "NONE") {
    f.itemSpacing = resolveNum(spec.gap) || 0;
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
function isIconNode(node) {
  try { return node.getPluginData("pcIcon") === "1"; } catch (e) { return false; }
}
function applyOverride(node, ov) {
  if (!node) return;
  if (ov.content !== undefined && node.type === "TEXT") node.characters = String(resolveStr(ov.content));
  if (ov.fill !== undefined) {
    if (isImageFill(ov.fill)) { const p = makeImagePaint(ov.fill); if (p && "fills" in node) node.fills = [p]; }
    else if (isIconNode(node)) recolor(node, ov.fill);      // 아이콘: 벡터 재색
    else if ("fills" in node) node.fills = makePaints(ov.fill) || [];  // 프레임/텍스트/도형: 배경 fill 직접
  }
  if (ov.enabled === false) node.visible = false;
  // 타이포 오버라이드는 아직 미적용 (부분정보 병합 문제 — Phase 3). 조용히 버리지 말고 알린다.
  if (ov.fontFamily !== undefined || ov.fontWeight !== undefined || ov.fontSize !== undefined)
    DBG.push("인스턴스 타이포 오버라이드 미적용 [" + (node.name || "?") + "] — 컴포넌트 정의에 바인딩 권장");
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
    else applyOverride(target, ov);
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
      if (typeof spec.cornerRadius === "number") node.cornerRadius = spec.cornerRadius;
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
function collectFonts(spec, set) {
  if (!spec || typeof spec !== "object") return;
  // text 노드 + descendants 오버라이드 객체(type 없음)도 폰트 속성을 가질 수 있다
  if (spec.type === "text" || spec.fontFamily !== undefined || spec.fontWeight !== undefined) {
    const r = textFontOf(spec);
    set.add(r.family + "||" + r.style);
  }
  for (const c of spec.children || []) collectFonts(c, set);
  const d = spec.descendants;  // 교체 subtree/오버라이드 안의 텍스트도 프리로드 대상
  if (d) for (const k in d) if (d[k] && typeof d[k] === "object") collectFonts(d[k], set);
}
async function loadFonts(allSpecs) {
  await buildFontIndex(); // 설치된 폰트 목록 먼저 확보 (resolveFont 가 이걸 참조)
  const set = new Set();
  set.add(ANY_FONT.family + "||" + ANY_FONT.style);
  for (const s of allSpecs) collectFonts(s, set);
  for (const key of set) {
    const [family, style] = key.split("||");
    try { await figma.loadFontAsync({ family, style }); } catch (e) {}
  }
}

// ---- 변수 생성 (테마 모드 + 숫자/문자열 변수). selectedTheme = 기본 모드로 쓸 테마 ----
async function createVariables(varData, selectedTheme, collectionName) {
  VAR_HEX = {}; VAR_NUM = {}; VAR_STR = {};
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
        catch (e) { DBG.push("모드 추가 실패(" + modeNames[i] + ") — 플랜 제한(모드 1개)일 수 있음"); }
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
        (type === "number" ? VAR_NUM : VAR_STR)[name] = val;
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
async function importDesign(data, icons, selected, pageMap, compPageMap, theme, collectionName) {
  ICONS = icons || {};
  ROOT_FILL_OVR = 0;
  const allScreens = data.screens || [];
  const allComponents = data.components || [];
  pageMap = pageMap || {};
  compPageMap = compPageMap || {};
  // 선택된 화면 (selected = 인덱스 배열; 없으면 전체)
  // selected 가 배열이면(빈 배열 포함) 그대로 사용. 미지정(undefined)일 때만 전체.
  const indices = Array.isArray(selected) ? selected : allScreens.map((_, i) => i);
  const screens = indices.map((i) => allScreens[i]).filter(Boolean);

  // 순서 중요: createVariables 가 VAR_NUM/VAR_STR 을 채워야 loadFonts 의 $변수(fontFamily 등) 해석이 된다.
  // (createVariables 는 622행에서 VAR_* 를 리셋하므로 loadFonts 뒤로 옮기면 안 됨)
  figma.ui.postMessage({ type: "progress", text: "변수/이미지 준비 중..." });
  await createVariables(data.variables || {}, theme, collectionName);
  prepareImages(data.images || {});
  figma.ui.postMessage({ type: "progress", text: "폰트 로딩 중..." });
  await loadFonts([].concat(allComponents, screens));

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

  // 포커스: 첫 화면 페이지로 전환 후 줌
  await switchToPage(firstScreenPage);
  try {
    const onPage = placed.filter((n) => n.parent === firstScreenPage);
    if (onPage.length) figma.viewport.scrollAndZoomIntoView(onPage);
  } catch (e) {}

  figma.ui.postMessage({ type: "debug", text: "ref 루트 fill 오버라이드 적용: " + ROOT_FILL_OVR + "곳 (0이면 옛 코드 — 플러그인 재실행 필요)" });
  if (DBG.length) figma.ui.postMessage({ type: "debug", text: "=== 빌드 경고 ===\n" + DBG.join("\n") });

  figma.notify("임포트 완료 ✓ 화면 " + placed.length + " / 컴포넌트 " + Object.keys(COMP_MAP).length + " / 페이지 " + Object.keys(usedPages).length);
  figma.ui.postMessage({ type: "done" });
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "import") {
    try { await importDesign(msg.data, msg.icons, msg.selected, msg.pageMap, msg.compPageMap, msg.theme, msg.collectionName); }
    catch (e) {
      console.error(e);
      figma.notify("에러: " + (e && e.message ? e.message : e), { error: true });
      figma.ui.postMessage({ type: "error", text: String(e && e.message ? e.message : e) });
    }
  } else if (msg.type === "cancel") {
    figma.closePlugin();
  }
};
