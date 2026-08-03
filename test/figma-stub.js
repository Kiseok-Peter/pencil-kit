// Figma Plugin API 스텁 — code.js 를 Figma 없이 실행하기 위한 최소 구현.
// 목적은 렌더 재현이 아니라 **code.js 가 노드에 무엇을 썼는지 기록**하는 것.
// setBoundVariable 의 동작은 BEHAVIORS 로 갈아끼워, 문서와 실동작이 어긋나는 경우까지 검증한다.

const MIXED = Symbol("figma.mixed");

// ---- 시드 고정 PRNG (hostile 프로필 재현성) ----
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ---- 폰트 목록 ----
const FULL_FONTS = [];
for (const family of ["Inter", "Outfit"]) {
  for (const style of ["Regular", "Medium", "SemiBold", "Bold", "Italic"]) FULL_FONTS.push({ family, style });
}
const INTER_ONLY = FULL_FONTS.filter((f) => f.family === "Inter");

const WEIGHT_STYLE = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

// ---- 노드 타입별로 실제 존재하는 키 (code.js 가 `"x" in node` 로 분기하므로 중요) ----
const BOX = ["width", "height", "x", "y", "visible", "opacity", "rotation"];
const PAINTABLE = ["fills", "strokes", "strokeAlign", "strokeWeight", "strokeCap", "strokeJoin", "effects"];
const CORNERS = ["cornerRadius", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];
const SIDE_STROKES = ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"];
const AUTOLAYOUT = ["layoutMode", "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom",
  "paddingLeft", "primaryAxisAlignItems", "counterAxisAlignItems", "clipsContent", "layoutWrap"];
const SIZING = ["layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning"];
const TEXTUAL = ["characters", "fontName", "fontSize", "fontWeight", "letterSpacing", "lineHeight",
  "textAlignHorizontal", "textAlignVertical", "textAutoResize", "paragraphSpacing", "paragraphIndent"];

const SHAPE_KEYS = {
  FRAME: [].concat(BOX, PAINTABLE, CORNERS, SIDE_STROKES, AUTOLAYOUT, SIZING),
  COMPONENT: [].concat(BOX, PAINTABLE, CORNERS, SIDE_STROKES, AUTOLAYOUT, SIZING),
  INSTANCE: [].concat(BOX, PAINTABLE, CORNERS, SIDE_STROKES, AUTOLAYOUT, SIZING),
  TEXT: [].concat(BOX, PAINTABLE, SIZING, TEXTUAL),
  RECTANGLE: [].concat(BOX, PAINTABLE, CORNERS, SIDE_STROKES, SIZING),
  ELLIPSE: [].concat(BOX, PAINTABLE, SIZING, ["arcData"]),
  POLYGON: [].concat(BOX, PAINTABLE, SIZING, ["pointCount", "cornerRadius"]),
  VECTOR: [].concat(BOX, PAINTABLE, SIZING),
  PAGE: ["name"],
};
const HAS_CHILDREN = { FRAME: 1, COMPONENT: 1, INSTANCE: 1, PAGE: 1, VECTOR: 1 };

const DEFAULTS = {
  width: 100, height: 100, x: 0, y: 0, visible: true, opacity: 1, rotation: 0,
  fills: [], strokes: [], effects: [], strokeAlign: "INSIDE", strokeWeight: 1,
  strokeCap: "NONE", strokeJoin: "MITER",
  cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0,
  strokeTopWeight: 0, strokeRightWeight: 0, strokeBottomWeight: 0, strokeLeftWeight: 0,
  layoutMode: "NONE", itemSpacing: 0, counterAxisSpacing: 0, layoutWrap: "NO_WRAP",
  paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
  primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", clipsContent: true,
  layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutPositioning: "AUTO",
  characters: "", fontSize: 12, fontWeight: 400,
  // 실제 Figma(실측): 새 TextNode 의 기본 자간은 **PERCENT 0**, 기본 행간은 AUTO 다.
  // 자간을 PIXELS 로 두면 "자간 없는 프리셋을 붙였을 때 단위가 바뀐다"를 못 잡는다 —
  // 실제로 이 차이 때문에 스타일 적용이 전량 되돌려졌는데 스텁은 통과시켰다.
  letterSpacing: { value: 0, unit: "PERCENT" }, lineHeight: { unit: "AUTO" },
  textAlignHorizontal: "LEFT", textAlignVertical: "TOP", textAutoResize: "NONE",
  paragraphSpacing: 0, paragraphIndent: 0,
  arcData: { startingAngle: 0, endingAngle: 0, innerRadius: 0 }, pointCount: 3,
};

function createFigmaStub(opts) {
  opts = opts || {};
  const behavior = opts.behavior || "honest";
  const swapMode = opts.swap || "ok";              // 인스턴스 스왑 모델: ok | throw | noop | lossy
  const outlineMode = opts.outline || "ok";        // outlineStroke 모델: ok | fail(null 반환 → 크기별 폴백)
  const textStyleMode = opts.textStyle || "ok";    // Text Style 모델: ok | unsupported(createTextStyle 예외) | detach(적용해도 안 붙음)
  const inheritPluginData = opts.pluginData !== "notInherited";
  const fonts = opts.fonts || FULL_FONTS;
  const rng = makeRng(opts.seed == null ? 12345 : opts.seed);
  const installed = new Set(fonts.map((f) => f.family + "||" + f.style));
  const varStore = {};          // id -> {id, name, resolvedType, valuesByMode, description}
  const collections = [];       // 이름으로 재사용되는지 확인하려면 실제 Figma 처럼 보관해야 한다
  const textStyles = [];        // Text Style 도 이름으로 재사용되는지 봐야 하므로 문서 자원처럼 보관
  let seq = 0;
  let imgSeq = 0;               // 이미지 해시는 별도 카운터 — 변수/노드 개수에 흔들리면 안 된다
  const nextId = (p) => p + ":" + ++seq;

  // ---- 변수 바인딩 동작 모델 ----
  // 반환값: 없음. 예외를 던지거나 노드 속성을 바꾼다.
  function applyBinding(node, field, v) {
    const modeId = Object.keys(v.valuesByMode)[0];
    const val = v.valuesByMode[modeId];

    if (behavior === "hostile" && rng() < 0.33) {
      // 무작위 오염: bindField 의 리드백·복구가 모든 경우 리터럴을 되살리는지 본다
      if (field === "fontFamily" || field === "fontWeight") node.fontName = { family: "Inter", style: "Italic" };
      else if (field === "letterSpacing") node.letterSpacing = { value: -99, unit: "PERCENT" };
      else if (field === "lineHeight") node.lineHeight = { value: -99, unit: "PIXELS" };
      else node[field] = -999;
      return;
    }
    if (behavior === "outfitMissing" && field === "fontFamily" && !hasFamily(String(val))) {
      throw new Error("Cannot bind fontFamily: font '" + val + "' is not available");
    }
    if (behavior === "weightNoop" && field === "fontWeight") return;   // 기록만, 캔버스 무반응
    if (behavior === "lineheightCoerce" && field === "lineHeight") {
      node.lineHeight = { value: Number(val), unit: "PIXELS" };        // 문서가 말하는 단위 강제
      return;
    }

    if (field === "fontFamily") {
      const cur = node.fontName === MIXED ? { family: "Inter", style: "Regular" } : node.fontName;
      node.fontName = { family: String(val), style: cur.style };
    } else if (field === "fontWeight") {
      const cur = node.fontName === MIXED ? { family: "Inter", style: "Regular" } : node.fontName;
      node.fontName = { family: cur.family, style: styleForWeight(Number(val), cur.family) };
    } else if (field === "letterSpacing") {
      node.letterSpacing = { value: Number(val), unit: "PIXELS" };     // Figma 는 변수 바인딩 시 PIXELS 강제
    } else if (field === "lineHeight") {
      node.lineHeight = { value: Number(val), unit: "PIXELS" };
    } else if (field in node) {
      node[field] = v.resolvedType === "FLOAT" ? Number(val) : val;
    }
  }
  function hasFamily(f) { for (const k of installed) if (k.slice(0, k.indexOf("||")) === f) return true; return false; }
  function styleForWeight(w, family) {
    const s = WEIGHT_STYLE[w] || "Regular";
    return installed.has(family + "||" + s) ? s : "Regular";
  }

  // ---- 노드 ----
  function makeNode(type, name) {
    const n = { type: type, name: name || "", id: nextId(type), parent: null, boundVariables: {}, _plugin: {} };
    for (const k of SHAPE_KEYS[type] || BOX) n[k] = clone(DEFAULTS[k]);
    // Figma 의 cornerRadius 는 네 모서리를 한꺼번에 쓰는 의사 속성이다 (직접 대입/변수 바인딩 모두 동일)
    if ("cornerRadius" in n && "topLeftRadius" in n) {
      let cr = 0;
      Object.defineProperty(n, "cornerRadius", {
        enumerable: true, configurable: true,
        get() { return cr; },
        set(v) { cr = v; n.topLeftRadius = n.topRightRadius = n.bottomRightRadius = n.bottomLeftRadius = v; },
      });
    }
    if (type === "TEXT") {
      n.fontName = { family: "Inter", style: "Regular" };
      // 스타일을 붙이면 Figma 는 스타일의 타이포 속성을 노드에 반영한다. 값이 같으면 시각 변화가 없고,
      // 다르면 노드가 스타일 값으로 바뀐다 → 플러그인의 리드백이 이 차이를 잡아내야 한다.
      let tsid = "";
      const applyStyle = (v) => {
        if (!v) { tsid = ""; return; }
        const st = textStyles.find((s) => s.id === v);
        if (!st) throw new Error("No text style with id " + v);
        if (textStyleMode === "detach") { tsid = ""; return; }   // 붙였다고 보고되지 않는 환경
        tsid = v;
        n.fontName = clone(st.fontName);
        n.fontSize = st.fontSize;
        n.letterSpacing = clone(st.letterSpacing);
        n.lineHeight = clone(st.lineHeight);
      };
      Object.defineProperty(n, "textStyleId", {
        enumerable: true, configurable: true,
        get() { return tsid; },
        // ★ 실측(Figma 데스크톱): 동기 setter 는 반영되지 않는다 — 전량 되돌림이 났다.
        //   그래서 기본 모델을 "동기는 안 먹음"으로 둔다. 코드가 setTextStyleIdAsync 를 쓰는지
        //   스텁이 강제로 확인하게 되고, 동기 setter 로 되돌아가면 테스트가 깨진다.
        // noAsync = async API 가 없던 옛 환경 → 그때는 동기 setter 가 유일한 수단이었으므로 동작한다.
        set(v) { if (!v) { tsid = ""; return; } if (textStyleMode === "syncWorks" || textStyleMode === "noAsync") applyStyle(v); },
      });
      // 현행 API. 이게 없는 환경(textStyle:"noAsync")이면 코드가 동기 setter 로 폴백해야 한다.
      if (textStyleMode !== "noAsync") n.setTextStyleIdAsync = async (v) => { applyStyle(v); };
    }
    if (type === "VECTOR") {
      n.constraints = { horizontal: "MIN", vertical: "MIN" };
      n.outlineStroke = () => {
        if (outlineMode === "fail") return null;
        const o = makeNode("VECTOR", n.name);
        o.fills = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
        o.strokes = [];
        return o;   // 실제 API 처럼 트리에 붙이지 않고 반환 (호출자가 insert)
      };
    }
    if (HAS_CHILDREN[type]) n.children = [];
    if (type === "PAGE") n.name = name || "Page";

    n.appendChild = (c) => { detach(c); c.parent = n; n.children.push(c); };
    n.insertChild = (i, c) => { detach(c); c.parent = n; n.children.splice(i, 0, c); };
    n.remove = () => detach(n);
    n.resize = (w, h) => { n.width = w; n.height = h; };
    n.rescale = (f) => { n.width *= f; n.height *= f; };
    n.setPluginData = (k, v) => { n._plugin[k] = String(v); };
    n.getPluginData = (k) => n._plugin[k] || "";
    n.setBoundVariable = (field, v) => {
      if (v === null || v === undefined) { delete n.boundVariables[field]; return; }
      if (!v || !v.id || !varStore[v.id]) throw new Error("Expected a Variable object");
      // 텍스트 필드는 실제 API 에서도 별칭 **배열**로 기록된다
      const alias = { type: "VARIABLE_ALIAS", id: v.id };
      n.boundVariables[field] = TEXTUAL.indexOf(field) >= 0 || field === "fontFamily" ? [alias] : alias;
      applyBinding(n, field, varStore[v.id]);
    };
    if (type === "COMPONENT") n.createInstance = () => { const i = cloneNode(n, "INSTANCE"); i._main = n; page().appendChild(i); return i; };
    if (type === "INSTANCE") {
      n._main = null;
      Object.defineProperty(n, "mainComponent", { enumerable: false, configurable: true, get() { return n._main; } });
      n.swapComponent = (comp) => {
        if (!comp || comp.type !== "COMPONENT") throw new Error("Expected a ComponentNode");
        if (swapMode === "throw") throw new Error("Cannot swap component of a nested instance");
        if (swapMode === "noop") return;                    // 기록도 반영도 없음 (리드백이 잡아야 함)
        n._main = comp;
        // 실제 Figma 처럼 자식·크기를 새 마스터 기준으로 재구성
        n.children = [];
        for (const c of comp.children || []) { const k = cloneNode(c); k.parent = n; n.children.push(k); }
        n.width = comp.width; n.height = comp.height;
        if (comp._icon) n._icon = comp._icon;
        if (swapMode === "lossy") {
          // 스왑이 서브레이어 색 오버라이드를 보존하지 못하는 모델 — 재색칠 필요성을 증명
          const black = { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 };
          const wipe = (m) => {
            if (m.type === "VECTOR") {
              if (m.strokes && m.strokes.length) m.strokes = [black];
              if (m.fills && m.fills.length) m.fills = [black];   // 외곽선화된(면) 아이콘도 오염
            }
            (m.children || []).forEach(wipe);
          };
          n.children.forEach(wipe);
        }
      };
    }
    if (type === "INSTANCE") n.detachInstance = () => {
      const f = cloneNode(n, "FRAME");
      const p = n.parent;
      if (p) { const i = p.children.indexOf(n); p.children.splice(i, 1, f); f.parent = p; }
      return f;
    };
    return n;
  }
  function detach(c) {
    if (c.parent && c.parent.children) {
      const i = c.parent.children.indexOf(c);
      if (i >= 0) c.parent.children.splice(i, 1);
    }
    c.parent = null;
  }
  // 인스턴스는 마스터의 속성 + boundVariables 를 그대로 미러링한다 (Figma 의 상속 모델)
  function cloneNode(src, asType) {
    const n = makeNode(asType || src.type, src.name);
    for (const k of SHAPE_KEYS[src.type] || []) if (k in src) n[k] = clone(src[k]);
    n.boundVariables = clone(src.boundVariables);
    if (src.textStyleId) n.textStyleId = src.textStyleId;    // 인스턴스는 마스터의 Text Style 도 물려받는다
    if (inheritPluginData) n._plugin = clone(src._plugin);   // notInherited 축: 코드가 pluginData 에 의존하지 않음을 증명
    if (src._icon) n._icon = src._icon;
    if (src._main) n._main = src._main;   // 컴포넌트 마스터 안의 아이콘 인스턴스가 미러링될 때 링크 유지 (중첩 스왑의 전제)
    if (src.children) for (const c of src.children) n.appendChild(cloneNode(c));
    return n;
  }
  function clone(v) {
    if (v === MIXED || v == null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(clone);
    const o = {};
    for (const k in v) o[k] = clone(v[k]);
    return o;
  }

  const root = makeNode("PAGE", "__root__");
  root.type = "DOCUMENT";
  root.children = [];
  const firstPage = makeNode("PAGE", "Page 1");
  root.children.push(firstPage); firstPage.parent = root;
  let current = firstPage;
  const page = () => current;

  const posted = [];
  const notices = [];

  const figma = {
    mixed: MIXED,
    root: root,
    get currentPage() { return current; },
    set currentPage(p) { current = p; },
    viewport: { scrollAndZoomIntoView() {} },
    showUI() {},
    ui: { postMessage: (m) => posted.push(m), onmessage: null },
    notify: (t) => { notices.push(t); },
    closePlugin() {},
    async setCurrentPageAsync(p) { current = p; },
    // 실제 Figma 처럼 새 노드는 currentPage 에 붙는다 (importDesign 이 frame.parent 로 페이지를 판별한다)
    createFrame: () => { const n = makeNode("FRAME", "Frame"); page().appendChild(n); return n; },
    createText: () => { const n = makeNode("TEXT", "Text"); page().appendChild(n); return n; },
    // ---- Text Style ----
    // 스타일은 노드가 아니라 문서 자원이다: 페이지에 붙지 않고, setBoundVariable 은 노드와 같은 모델을 쓴다
    // (스타일에서의 강제 단위 동작이 노드와 다르다는 근거가 없으므로 같은 applyBinding 을 태운다 —
    //  플러그인은 어느 쪽이든 리드백+되돌림으로 방어하므로 이 모델이 더 보수적이다).
    createTextStyle: () => {
      if (textStyleMode === "unsupported") throw new Error("createTextStyle is not available");
      const s = {
        type: "TEXT", id: nextId("S"), name: "", boundVariables: {},
        fontName: { family: "Inter", style: "Regular" }, fontSize: 16,
        letterSpacing: { value: 0, unit: "PERCENT" }, lineHeight: { unit: "AUTO" },   // 노드 기본과 같게
        remove() { const i = textStyles.indexOf(s); if (i >= 0) textStyles.splice(i, 1); },
      };
      s.setBoundVariable = (field, v) => {
        if (v === null || v === undefined) { delete s.boundVariables[field]; return; }
        if (!v || !v.id || !varStore[v.id]) throw new Error("Expected a Variable object");
        const alias = { type: "VARIABLE_ALIAS", id: v.id };
        s.boundVariables[field] = TEXTUAL.indexOf(field) >= 0 || field === "fontFamily" ? [alias] : alias;
        applyBinding(s, field, varStore[v.id]);
      };
      textStyles.push(s);
      return s;
    },
    getLocalTextStylesAsync: async () => textStyles.slice(),
    getLocalTextStyles: () => textStyles.slice(),
    createRectangle: () => { const n = makeNode("RECTANGLE", "Rectangle"); page().appendChild(n); return n; },
    createEllipse: () => { const n = makeNode("ELLIPSE", "Ellipse"); page().appendChild(n); return n; },
    createPolygon: () => { const n = makeNode("POLYGON", "Polygon"); page().appendChild(n); return n; },
    createPage: () => { const p = makeNode("PAGE", "Page"); root.children.push(p); p.parent = root; return p; },
    listAvailableFontsAsync: async () => fonts.map((f) => ({ fontName: { family: f.family, style: f.style } })),
    loadFontAsync: async (fn) => {
      if (!installed.has(fn.family + "||" + fn.style)) throw new Error("font not found: " + fn.family + " " + fn.style);
    },
    base64Decode: () => new Uint8Array([1, 2, 3]),
    createImage: () => ({ hash: "img" + ++imgSeq }),
    createNodeFromSvg: (svg) => {
      const f = makeNode("FRAME", "svg");
      f.width = 24; f.height = 24;
      const v = makeNode("VECTOR", "vector");
      v.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }];
      f.appendChild(v);
      f._svgLen = String(svg).length;   // 두 실행이 같은 SVG 를 만들었는지 확인용
      const m = /data-icon="([^"]+)"/.exec(String(svg));
      if (m) f._icon = m[1];            // 합성 SVG 의 아이콘명 → 트리 비교로 "어느 자리에 어떤 아이콘" 단언 가능
      page().appendChild(f);
      return f;
    },
    createComponentFromNode: (node) => {
      const c = makeNode("COMPONENT", node.name);
      for (const k of SHAPE_KEYS.FRAME) if (k in node) c[k] = clone(node[k]);
      c.boundVariables = clone(node.boundVariables);
      c._plugin = clone(node._plugin);
      if (node._icon) c._icon = node._icon;
      if (node._svgLen) c._svgLen = node._svgLen;
      const p = node.parent, idx = p ? p.children.indexOf(node) : -1;
      const kids = (node.children || []).slice();
      for (const k of kids) c.appendChild(k);
      if (p && idx >= 0) { p.children.splice(idx, 1, c); c.parent = p; } else page().appendChild(c);
      return c;
    },
    variables: {
      createVariableCollection: (name) => {
        const c = {
          id: nextId("coll"), name: name, modes: [{ modeId: "m0", name: "Mode 1" }], defaultModeId: "m0",
          renameMode(id, nm) { for (const m of this.modes) if (m.modeId === id) m.name = nm; },
          addMode(nm) { const id = "m" + this.modes.length; this.modes.push({ modeId: id, name: nm }); return id; },
        };
        collections.push(c);
        return c;
      },
      createVariable: (name, collection, resolvedType) => {
        for (const id in varStore) {
          if (varStore[id].name === name && varStore[id].variableCollectionId === collection.id) {
            throw new Error("Variable name already in use: " + name);
          }
        }
        const v = {
          id: nextId("var"), name: name, resolvedType: resolvedType,
          variableCollectionId: collection.id, valuesByMode: {}, description: "",
          setValueForMode(mid, val) { this.valuesByMode[mid] = val; },
        };
        varStore[v.id] = v;
        return v;
      },
      getLocalVariablesAsync: async () => Object.keys(varStore).map((k) => varStore[k]),
      getLocalVariableCollectionsAsync: async () => collections.slice(),
      setBoundVariableForPaint: (paint, field, v) => {
        const p = clone(paint);
        p.boundVariables = { [field]: { type: "VARIABLE_ALIAS", id: v.id } };
        return p;
      },
    },
  };

  return { figma, varStore, posted, notices, MIXED, firstPage };
}

module.exports = { createFigmaStub, FULL_FONTS, INTER_ONLY, MIXED };
