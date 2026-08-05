#!/usr/bin/env node
// code.js 의 토큰 바인딩을 Figma 없이 검증한다.
//
//   node test/verify-bindings.js [--data <export폴더>]
//   (--data 생략 시 env PENCIL_DATA, 그것도 없으면 합성 스펙 검사만 수행)
//
// 핵심 게이트는 **쌍둥이 차분(V2)**: 같은 데이터를 bindTokens=false/true 로 각각 임포트해
// boundVariables 만 제외한 노드 트리를 심층 비교한다. 차분이 0이면 "시각 회귀 없음"이 기계적으로 증명된다.
// Figma 의 실동작이 문서와 어긋나는 경우까지 보려고 동작 모델 5종에서 반복한다.

const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { execFileSync } = require("child_process");
const { createFigmaStub, FULL_FONTS, INTER_ONLY } = require("./figma-stub");

const KIT = path.resolve(__dirname, "..");
const CODE_PATH = path.join(KIT, "code.js");
const SRC = fs.readFileSync(CODE_PATH, "utf8");

// ---- 데이터 폴더 (--data 규약: 다른 스크립트와 동일) ----
function dataDir() {
  const i = process.argv.indexOf("--data");
  const p = i >= 0 ? process.argv[i + 1] : process.env.PENCIL_DATA;
  if (!p) {
    const guess = path.join(KIT, "..", "초코로드", "export");
    return fs.existsSync(path.join(guess, "design-data.json")) ? guess : null;
  }
  return path.resolve(p);
}

// ---- code.js 를 vm 컨텍스트에 격리 로드 ----
// code.js 는 모듈이 아니고 최상단에서 figma.showUI 를 부르므로 require 할 수 없다.
// const/let 은 전역 객체에 붙지 않으므로 에필로그로 명시적으로 꺼낸다(같은 스크립트 스코프라 접근 가능).
function loadCode(figma) {
  const ctx = { figma: figma, __html__: "<html></html>", console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, __out: {} };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC + "\n;__out.api = { importDesign, createVariables, bindSummary,"
    + " state: () => ({ VARS, VAR_OBJ, VAR_HEX, VAR_NUM, VAR_STR, DBG, BIND_STAT, CAP, OPT, COMP_MAP, LOADED, ICON_COMP, ICON_SLOTS }) };",
    ctx, { filename: "code.js" });
  return ctx.__out.api;
}

// ---- 트리 직렬화 (boundVariables·id·parent 제외 = "눈에 보이는 것"만) ----
// _main 은 마스터 컴포넌트 객체 참조라 직렬화하면 재귀 폭발 — 아이콘 정체는 _icon 으로 이미 실려 있다
// textStyleId 는 boundVariables 와 같은 부류 — 어떤 스타일을 참조하는지일 뿐 렌더링되는 값이 아니다.
// 스타일이 실제로 값을 바꿨다면 fontName/fontSize/letterSpacing/lineHeight 비교에서 잡힌다.
const SKIP_KEYS = { parent: 1, boundVariables: 1, textStyleId: 1, id: 1, children: 1, _main: 1, _plugin: 1 };
function norm(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : String(v);
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(norm);
  const o = {};
  for (const k of Object.keys(v).sort()) if (k !== "boundVariables") o[k] = norm(v[k]);
  return o;
}
function serialize(n) {
  const o = {};
  for (const k of Object.keys(n).sort()) {
    if (SKIP_KEYS[k] || typeof n[k] === "function") continue;
    o[k] = norm(n[k]);
  }
  o["#"] = (n.children || []).map(serialize);
  return o;
}
function diff(a, b, p, out) {
  if (out.length >= 8) return out;
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) return out;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) {
    out.push(p + ": " + trunc(ja) + "  ≠  " + trunc(jb));
    return out;
  }
  const keys = new Set([].concat(Object.keys(a), Object.keys(b)));
  for (const k of keys) {
    if (out.length >= 8) break;
    diff(a[k], b[k], p + "/" + k, out);
  }
  return out;
}
const trunc = (s) => (s == null ? String(s) : s.length > 90 ? s.slice(0, 90) + "…" : s);

// ---- 기대값은 하드코딩하지 않고 데이터에서 센다 (code.js 가 실제로 방문하는 범위: 컴포넌트 + 화면) ----
// 화면이 실제로 참조하는 컴포넌트 id 집합 (플러그인의 "필요한 컴포넌트만 생성"과 같은 기준).
// 컴포넌트는 최상위 엔트리로 한 번, DS 카탈로그 화면 안에 물리적으로 또 한 번 담긴다.
// 참조되는 컴포넌트는 두 번 다 만들어지지만, **아무도 안 쓰는 컴포넌트는 카탈로그 사본만** 만들어진다.
// 분모를 그대로 두면 그 차이만큼 커버리지 방정식이 어긋난다 (Textarea 변형 신설 때 실측).
function referencedComponents(data) {
  const byId = {};
  for (const c of data.components || []) if (c.id) byId[c.id] = c;
  const need = new Set(), stack = [];
  const seed = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "ref" && n.ref) stack.push(n.ref);
    for (const k of n.children || []) seed(k);
    const d = n.descendants;
    if (d) for (const kk in d) seed(d[kk]);
  };
  (data.screens || []).forEach(seed);
  while (stack.length) {
    const id = stack.pop();
    if (need.has(id) || !byId[id]) continue;
    need.add(id);
    seed(byId[id]);
  }
  return need;
}

function countRefs(data, key) {
  const c = {};
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    const v = n[key];
    if (typeof v === "string" && v[0] === "$") c[v] = (c[v] || 0) + 1;
    for (const k of n.children || []) walk(k);
    const d = n.descendants;
    if (d) for (const kk in d) walk(d[kk]);
  };
  const used = referencedComponents(data);
  (data.components || []).forEach((c2) => { if (!c2.id || used.has(c2.id)) walk(c2); });
  (data.screens || []).forEach(walk);
  return c;
}
const sum = (o) => Object.keys(o).reduce((a, k) => a + o[k], 0);
// 토큰 값 조회 (variables.json 의 두 형식 모두)
function tokenValue(variables, name) {
  const defs = (variables && variables.variables) || variables || {};
  const d = defs[name];
  let v = d && typeof d === "object" && "value" in d ? d.value : d;
  if (Array.isArray(v)) v = v[0] && v[0].value;
  return v;
}

// ---- 합성 SVG (아이콘 경로 실행에 필수 — 없으면 343개 전부 "SVG 없음" 폴백을 타 아무것도 검증 못 한다) ----
// data-icon 속성으로 아이콘명을 심어 두면 스텁이 _icon 으로 파싱해 트리 비교로 정체를 단언할 수 있다.
function synthIcons(designData) {
  const map = {};
  for (const it of designData.icons || []) {
    const lib = it.library || "lucide";
    map[lib + "/" + it.icon] = '<svg data-icon="' + it.icon + '" viewBox="0 0 24 24"><path d="M0 0"/></svg>';
  }
  return map;
}

// ---- 한 번 임포트하고 페이지 트리를 돌려준다 ----
// extra: {icons(합성 SVG 맵 오버라이드), swap(스텁 스왑 모델), pluginData, iconSwap(false=아이콘 인스턴스화 끔)}
async function runImport(designData, behavior, fonts, bindTokens, seed, extra) {
  extra = extra || {};
  const stub = createFigmaStub({ behavior: behavior, fonts: fonts, seed: seed, swap: extra.swap, outline: extra.outline, pluginData: extra.pluginData, textStyle: extra.textStyle });
  const api = loadCode(stub.figma);
  const icons = extra.icons !== undefined ? extra.icons : synthIcons(designData);
  const opts = { bindTokens: bindTokens };
  if (extra.iconSwap !== undefined) opts.iconSwap = extra.iconSwap;
  await api.importDesign(designData, icons, undefined, {}, {}, "light", "Pencil Tokens", opts);
  return { stub: stub, api: api, state: api.state(), tree: stub.figma.root.children.map(serialize) };
}

// ---- 아이콘 검증 유틸 ----
// 기대값은 전부 design-data.json 에서 계산한다 (하드코딩 금지 규약)
function iconOverrideStats(designData) {
  const comps = {};
  for (const c of designData.components || []) comps[c.id] = c;
  const slots = {};   // pid -> {icon, w, h, lib}
  const walkIcons = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "icon" && n.icon && typeof n.width === "number") slots[n.id] = { icon: n.icon, w: n.width, h: n.height, lib: n.library || "lucide" };
    for (const c of n.children || []) walkIcons(c);
  };
  for (const c of designData.components || []) walkIcons(c);
  let total = 0, changed = 0;
  const perSlot = {};
  const walkRefs = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "ref") {
      const ds = n.descendants || {};
      for (const pid in ds) {
        const ov = ds[pid];
        if (ov && typeof ov === "object" && !ov.type && ov.icon && slots[pid]) {
          total++;
          if (ov.icon !== slots[pid].icon) changed++;
          (perSlot[pid] = perSlot[pid] || new Set()).add(ov.icon);
        }
      }
    }
    for (const c of n.children || []) walkRefs(c);
    const d = n.descendants;
    if (d) for (const k in d) if (d[k] && typeof d[k] === "object") walkRefs(d[k]);
  };
  for (const s of designData.screens || []) walkRefs(s);
  for (const c of designData.components || []) walkRefs(c);
  const need = new Set();
  for (const pid in perSlot) {
    const s = slots[pid];
    need.add(s.lib + "/" + s.icon + "@" + s.w + "x" + s.h);
    for (const i of perSlot[pid]) need.add(s.lib + "/" + i + "@" + s.w + "x" + s.h);
  }
  return { total: total, changed: changed, masters: need.size, slots: slots, perSlot: perSlot };
}

// 기대 마스터 키 집합 — code.js 의 buildIconComponents 수집 로직을 데이터에서 그대로 재현
// single=true(기본): 아이콘당 1개(외곽선화 단일 마스터) / false: 크기별 폴백
function expectedMasterKeys(designData, iconsMap, single) {
  if (single === undefined) single = true;
  const has = (lib, n) => iconsMap[lib + "/" + n] !== undefined || iconsMap[n] !== undefined;
  const keys = new Set();
  const add = (lib, n, w, h) => { if (has(lib, n)) keys.add(single ? lib + "/" + n : lib + "/" + n + "@" + w + "x" + h); };
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "icon" && n.icon && typeof n.width === "number" && typeof n.height === "number")
      add(n.library || "lucide", n.icon, n.width, n.height);
    for (const c of n.children || []) walk(c);
    const d = n.descendants;
    if (d) for (const k in d) if (d[k] && typeof d[k] === "object") walk(d[k]);
  };
  for (const c of designData.components || []) walk(c);
  for (const s of designData.screens || []) walk(s);
  const st = iconOverrideStats(designData);
  for (const pid in st.perSlot) {
    const s = st.slots[pid];
    if (!has(s.lib, s.icon)) continue;   // 슬롯 기본 SVG 없으면 슬롯 포기 → 후보 마스터도 없음
    for (const cand of st.perSlot[pid]) add(s.lib, cand, s.w, s.h);
  }
  return keys;
}

// 화면별 기대 아이콘 멀티셋 — ref 를 재귀 전개하고 오버라이드·교체를 반영
function expectedScreenIcons(designData) {
  const comps = {};
  for (const c of designData.components || []) comps[c.id] = c;
  const expand = (spec, push) => {
    if (!spec || typeof spec !== "object") return;
    if (spec.type === "icon") { if (spec.icon) push(spec.icon); return; }
    if (spec.type === "ref" && spec.ref && comps[spec.ref]) {
      const ds = spec.descendants || {};
      const walkComp = (n) => {
        if (!n || typeof n !== "object") return;
        const ov = ds[n.id];
        if (ov && typeof ov === "object" && ov.type) { expand(ov, push); return; }   // 교체 subtree
        if (n.type === "icon") { const nm = ov && typeof ov === "object" && ov.icon ? ov.icon : n.icon; if (nm) push(nm); return; }
        if (n.type === "ref") { expand(n, push); return; }   // 중첩 ref (자기 descendants 로)
        for (const c of n.children || []) walkComp(c);
      };
      for (const c of comps[spec.ref].children || []) walkComp(c);
      return;
    }
    for (const c of spec.children || []) expand(c, push);
  };
  const out = {};
  for (const s of designData.screens || []) { const arr = []; expand(s, (i) => arr.push(i)); out[s.name] = arr.sort(); }
  return out;
}

// 빌드된 트리(직렬화)에서 화면별 실제 아이콘 수확 (_icon 마커)
function observedScreenIcons(tree, screenNames) {
  const out = {};
  const collect = (o, arr) => { if (o._icon) arr.push(o._icon); for (const c of o["#"] || []) collect(c, arr); };
  for (const page of tree) for (const child of page["#"] || []) {
    if (child.type === "FRAME" && screenNames.has(child.name)) { const arr = []; collect(child, arr); out[child.name] = arr.sort(); }
  }
  return out;
}

// V7 마스킹: 아이콘 정체·구조를 지우고(이름·크기만 남김) 마스터 페이지를 제거 → "아이콘 밖" 동일성만 비교
function maskIconTree(tree) {
  const mask = (o) => {
    if (o._icon !== undefined) return { "@iconslot": (o.name || "") + "|" + o.width + "x" + o.height };
    const r = {};
    for (const k in o) if (k !== "#") r[k] = o[k];
    r["#"] = (o["#"] || []).map(mask);
    return r;
  };
  return tree.filter((p) => p.name !== "DS - Icon Components").map(mask);
}

// 원시 스텁 트리 탐색 (직렬화는 paint 내부 boundVariables 를 지우므로 색 토큰 검사는 원시로)
function rawFind(node, pred, out) {
  if (pred(node)) out.push(node);
  for (const c of node.children || []) rawFind(c, pred, out);
  return out;
}

// ---- 검사 러너 ----
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✅ " + name); }
  else { fail++; console.log("  ❌ " + name + (detail ? "\n       " + String(detail).split("\n").join("\n       ") : "")); }
}
function section(t) { console.log("\n" + t); }

// ================================================================
(async function main() {
  const DATA = dataDir();
  console.log("code.js: " + CODE_PATH);
  console.log("데이터: " + (DATA || "(없음 — 합성 스펙 검사만 수행)"));

  // ---------- V0 구문 ----------
  section("V0 구문/정합");
  try {
    execFileSync(process.execPath, ["--check", CODE_PATH], { stdio: "pipe" });
    check("node --check code.js", true);
  } catch (e) { check("node --check code.js", false, String(e.stderr || e.message)); }

  let designData = null, variablesJson = null;
  if (DATA) {
    designData = JSON.parse(fs.readFileSync(path.join(DATA, "design-data.json"), "utf8"));
    variablesJson = designData.variables;
  }

  // ---------- V1 변수 인벤토리 ----------
  if (variablesJson) {
    section("V1 변수 인벤토리 (createVariables 격리 실행)");
    const defs = variablesJson.variables || variablesJson;
    let expColor = 0, expFloat = 0, expString = 0;
    for (const name in defs) {
      const d = defs[name];
      const t = (d && typeof d === "object" && d.type) || "color";
      let val = d && typeof d === "object" && "value" in d ? d.value : d;
      if (Array.isArray(val)) val = val[0] && val[0].value;
      if (t === "color") expColor++;
      else if (t === "number") expFloat++;
      else if (/^fontweight[-.]/i.test(name) && /^-?\d+(\.\d+)?$/.test(String(val))) expFloat++;
      else expString++;
    }
    const stub = createFigmaStub({});
    const api = loadCode(stub.figma);
    await api.createVariables(variablesJson, "light", "Pencil Tokens");
    const st = api.state();
    const byType = { COLOR: 0, FLOAT: 0, STRING: 0 };
    for (const id in stub.varStore) byType[stub.varStore[id].resolvedType]++;
    check("COLOR " + byType.COLOR + " = 기대 " + expColor, byType.COLOR === expColor);
    check("FLOAT " + byType.FLOAT + " = 기대 " + expFloat, byType.FLOAT === expFloat);
    check("STRING " + byType.STRING + " = 기대 " + expString, byType.STRING === expString);

    // ★ 폰트 해석 경로: fontweight-* 는 Figma 에선 FLOAT 이지만 VAR_STR 에는 문자열로 남아 있어야 한다.
    //   (textFontOf → resolveStr → STYLE_CANDIDATES 조회. 여기가 깨지면 폰트가 전부 폴백된다)
    const wKeys = Object.keys(st.VAR_STR).filter((k) => /^fontweight[-.]/i.test(k));
    check("fontweight-* 가 VAR_STR 에 문자열로 보존 (" + wKeys.length + "개)",
      wKeys.length > 0 && wKeys.every((k) => typeof st.VAR_STR[k] === "string"),
      JSON.stringify(wKeys.map((k) => k + "=" + JSON.stringify(st.VAR_STR[k]))));
    const fwVar = Object.keys(stub.varStore).map((i) => stub.varStore[i]).filter((v) => /^fontweight[-.]/i.test(v.name));
    check("fontweight-* Figma 변수는 FLOAT + 숫자값",
      fwVar.length > 0 && fwVar.every((v) => v.resolvedType === "FLOAT" && typeof v.valuesByMode[Object.keys(v.valuesByMode)[0]] === "number"),
      fwVar.map((v) => v.name + "=" + v.resolvedType + ":" + JSON.stringify(v.valuesByMode)).join(" "));
    const lhVar = Object.keys(stub.varStore).map((i) => stub.varStore[i]).filter((v) => /^lineheight[-.]/i.test(v.name));
    check("lineheight-* 에 오용 방지 description", lhVar.length > 0 && lhVar.every((v) => /PIXELS/.test(v.description)));
    check("VAR_HEX 가 색 개수만큼 채워짐 (기존 동작 불변)", Object.keys(st.VAR_HEX).length === expColor);

    // bindTokens=false 면 변수를 아예 만들지 않는다 (반쪽 상태 방지)
    const stub2 = createFigmaStub({});
    const api2 = loadCode(stub2.figma);
    api2.state().OPT.bindTokens = false;
    await api2.importDesign({ variables: variablesJson, components: [], screens: [] }, {}, [], {}, {}, "light", "T", { bindTokens: false });
    const nonColor = Object.keys(stub2.varStore).filter((i) => stub2.varStore[i].resolvedType !== "COLOR").length;
    check("bindTokens=false 면 number/string 변수 0개 (색은 유지)", nonColor === 0, "실제 " + nonColor + "개");
  }

  // ---------- V2~V4 쌍둥이 차분 + 프로필별 동작 ----------
  if (designData) {
    const PROFILES = [
      // pure = 아무것도 적대적이지 않은 기준선. 커버리지 등식은 여기서만 성립한다
      { name: "honest         (모든 필드 존중)", behavior: "honest", fonts: FULL_FONTS, pure: true },
      { name: "weightNoop     (fontWeight 캔버스 무반응)", behavior: "weightNoop", fonts: FULL_FONTS },
      { name: "lineheightCoerce (lineHeight 단위 강제)", behavior: "lineheightCoerce", fonts: FULL_FONTS },
      { name: "outfitMissing  (Outfit 미설치 + 바인딩 throw)", behavior: "outfitMissing", fonts: INTER_ONLY },
      { name: "hostile        (33% 무작위 오염)", behavior: "hostile", fonts: FULL_FONTS },
      // 프리셋 경로가 없는/깨진 환경에서도 현행(노드별 개별 바인딩)과 완전히 같아야 한다
      { name: "tsUnsupported  (createTextStyle 예외)", behavior: "honest", fonts: FULL_FONTS, extra: { textStyle: "unsupported" } },
      { name: "tsDetach       (스타일이 노드에 안 붙음)", behavior: "honest", fonts: FULL_FONTS, extra: { textStyle: "detach" } },
      // setTextStyleIdAsync 가 없던 옛 환경 — 동기 setter 폴백 분기가 실제로 붙는지 본다
      { name: "tsNoAsync      (동기 setter 폴백)", behavior: "honest", fonts: FULL_FONTS, extra: { textStyle: "noAsync" } },
    ];
    for (const p of PROFILES) {
      section("V2 쌍둥이 차분 — " + p.name);
      const off = await runImport(designData, p.behavior, p.fonts, false, 7, p.extra);
      const on = await runImport(designData, p.behavior, p.fonts, true, 7, p.extra);
      const d = diff(off.tree, on.tree, "", []);
      check("bindTokens false/true 트리 동일 (시각 회귀 0)", d.length === 0, d.join("\n"));

      const bs = on.state.BIND_STAT;
      const tot = (f, k) => (bs[f] ? bs[f][k] : 0);
      const line = Object.keys(bs).sort().map((f) =>
        f + "(ok " + bs[f].ok + " rv " + bs[f].revert + " er " + bs[f].error + " sk " + bs[f].skip + ")").join(" ");
      console.log("       " + (line || "(집계 없음)"));

      if (p.pure) {
        const bindFields = Object.keys(bs).filter((f) => f.indexOf("ov.") !== 0);
        check("모든 바인딩 필드에서 되돌림·예외 0",
          bindFields.every((f) => bs[f].revert === 0 && bs[f].error === 0),
          bindFields.filter((f) => bs[f].revert || bs[f].error).join(","));

        // V3 커버리지 — 기대값은 design-data.json 에서 센 값 (하드코딩 금지)
        const nFs = sum(countRefs(designData, "fontSize"));
        const nFam = sum(countRefs(designData, "fontFamily"));
        const nFw = sum(countRefs(designData, "fontWeight"));
        const nCr = sum(countRefs(designData, "cornerRadius"));
        const nLh = sum(countRefs(designData, "lineHeight"));
        const nLs = sum(countRefs(designData, "letterSpacing"));
        // 타이포 5축은 이제 두 경로로 갈린다: 프리셋에 맞으면 Text Style 이 통째로 소유하고(textStyle.ok),
        // 아니면 종전처럼 노드에 개별 바인딩한다. 둘의 합이 전량이어야 한다 — 어느 노드도 누락되면 안 된다.
        const nTs = tot("textStyle", "ok");
        check("fontSize 전량 처리 = 스타일 " + nTs + " + 개별 " + tot("fontSize", "ok") + " / " + nFs,
          nTs + tot("fontSize", "ok") === nFs);
        check("fontFamily 전량 처리 = 스타일 " + nTs + " + 개별 " + tot("fontFamily", "ok") + " / " + nFam,
          nTs + tot("fontFamily", "ok") === nFam);
        check("fontWeight 전량 처리 = 스타일 " + nTs + " + 개별 " + (tot("fontWeight", "ok") + tot("fontWeight", "skip")) + " / " + nFw
          + " (건너뜀 " + tot("fontWeight", "skip") + " = 이탤릭)",
          nTs + tot("fontWeight", "ok") + tot("fontWeight", "skip") === nFw);
        check("cornerRadius 전량 바인딩 " + tot("cornerRadius", "ok") + "/" + nCr, tot("cornerRadius", "ok") === nCr);
        // letterSpacing/lineHeight 은 "설정된 노드에만" 있어서 스타일이 가져간 몫을 따로 못 센다.
        // 대신 두 경로 어디서도 되돌림·예외가 없어야 한다는 불변식으로 본다 (누락은 위 세 축이 잡는다).
        check("letterSpacing 개별 " + tot("letterSpacing", "ok") + "/" + nLs + " · 되돌림·예외 0",
          tot("letterSpacing", "revert") === 0 && tot("letterSpacing", "error") === 0);
        check("lineHeight 은 노드에 시도조차 안 함 (배수↔PIXELS) — 참조 " + nLh + "곳은 Text Style 이 PERCENT 로 담는다",
          tot("lineHeight", "ok") === 0 && tot("lineHeight", "revert") === 0 && tot("lineHeight", "error") === 0);
        // ov.* 는 "아직 적용 못 하는 오버라이드 키" 통계라 bindTokens 와 무관하게 늘 집계된다
        const offBind = Object.keys(off.state.BIND_STAT).filter((f) => f.indexOf("ov.") !== 0);
        check("bindTokens=false 실행은 바인딩 시도 0", offBind.length === 0, offBind.join(","));
      }
      if (p.behavior === "weightNoop") {
        // 무반응은 "리터럴 유지" = 우리 기대값과 같음 → ok 로 집계되고 되돌림이 없어야 한다
        check("fontWeight 무반응은 되돌림 0 (fontName 리터럴이 이미 정확)", tot("fontWeight", "revert") === 0);
      }
      if (p.behavior === "outfitMissing") {
        // Inter 만 설치된 환경. $font-system(=Inter) 만 바인딩되고 Outfit 계열은 전부 건너뛰어야 한다.
        // 프리셋이 생긴 뒤로는 노드 경로와 스타일 경로 둘 다 같은 게이트를 통과해야 하므로 나눠서 본다.
        const nTs2 = tot("textStyle", "ok");
        const nFam2 = sum(countRefs(designData, "fontFamily"));
        check("개별 경로는 프리셋이 안 가져간 몫만 처리 "
          + (tot("fontFamily", "ok") + tot("fontFamily", "skip")) + "/" + (nFam2 - nTs2),
          tot("fontFamily", "ok") + tot("fontFamily", "skip") === nFam2 - nTs2);
        // 스타일 경로: 프리셋 중 패밀리가 Inter 로 해석되는 것만 바인딩돼야 한다
        const styleDefs = (designData.typographyStyles || {}).styles || {};
        let expStyleOk = 0;
        for (const n in styleDefs) {
          if (String(tokenValue(designData.variables, styleDefs[n].fontFamily)) === "Inter") expStyleOk++;
        }
        const sOk = bs["style:fontFamily"] ? bs["style:fontFamily"].ok : 0;
        const sSkip = bs["style:fontFamily"] ? bs["style:fontFamily"].skip : 0;
        check("스타일도 설치된 폰트만 바인딩 " + sOk + "/" + expStyleOk + " (건너뜀 " + sSkip + ")",
          sOk === expStyleOk && sOk + sSkip === Object.keys(styleDefs).length);
        // 이 프로필의 스텁은 미설치 패밀리를 바인딩하면 throw 한다 → 예외 0 = 게이트가 시도 자체를 막았다는 증거
        check("미설치 폰트 바인딩 시도 0 (노드·스타일 모두 예외 0)",
          tot("fontFamily", "error") === 0 && (!bs["style:fontFamily"] || bs["style:fontFamily"].error === 0));
      }
      if (p.extra && p.extra.textStyle === "noAsync") {
        // setTextStyleIdAsync 가 없으면 동기 setter 로 폴백해야 한다 — 그래도 스타일은 붙는다
        check("동기 setter 폴백으로도 적용됨 (" + tot("textStyle", "ok") + "곳, 되돌림 " + tot("textStyle", "revert") + ")",
          tot("textStyle", "ok") > 0 && tot("textStyle", "revert") === 0);
      } else if (p.extra && p.extra.textStyle) {
        // 프리셋 경로가 없는/깨진 환경 = 프리셋 도입 전과 완전히 같아야 한다 (위 쌍둥이 차분이 이미 증명)
        const nFs2 = sum(countRefs(designData, "fontSize"));
        check("스타일이 붙은 노드 0 (" + p.extra.textStyle + ")", tot("textStyle", "ok") === 0);
        check("전 타이포가 개별 바인딩으로 폴백 " + tot("fontSize", "ok") + "/" + nFs2, tot("fontSize", "ok") === nFs2);
        // 프로브가 임시 노드 1개로 미리 판정하므로 노드 700개를 헛시도하지 않는다
        // (되돌림 0 이 정상 — 큐에 담기지도 않는다)
        check("스타일 경로 선차단 (CAP.style=false, 되돌림 " + tot("textStyle", "revert") + ")",
          on.state.CAP["style"] === false && tot("textStyle", "revert") === 0);
      }
      if (p.behavior === "hostile") {
        const rv = Object.keys(bs).reduce((a, f) => a + bs[f].revert, 0);
        check("오염을 리드백이 잡아 되돌림 (" + rv + "건) — 그래도 트리는 동일", rv > 0);
        const blocked = Object.keys(on.state.CAP).filter((k) => on.state.CAP[k] === false);
        check("서킷 브레이커 작동 (" + (blocked.join(",") || "없음") + ")", blocked.length > 0);
      }
    }

    // ---------- V6 타이포 프리셋 → Text Style ----------
    // 프리셋은 Pencil·Figma 어느 쪽에서도 "변수"로 표현할 수 없다(둘 다 타입 4종). Figma 에서의 제자리는
    // Text Style 이고, 그래야 lineHeight 를 PERCENT 로 담아 배수(1.5)를 보존할 수 있다.
    const TS = designData.typographyStyles;
    if (!TS || !TS.styles) {
      section("V6 타이포 프리셋 — typography-styles.json 없음, 건너뜀");
    } else {
      section("V6 타이포 프리셋 → Text Style");
      const r = await runImport(designData, "honest", FULL_FONTS, true, 7);
      const styles = r.stub.figma.getLocalTextStyles();
      const names = styles.map((s) => s.name).sort();
      const want = Object.keys(TS.styles).map((n) => (TS.styles[n].group ? TS.styles[n].group + "/" : "") + n).sort();

      check("프리셋 수만큼 Text Style 생성 " + styles.length + "/" + want.length, styles.length === want.length);
      check("스타일 이름 = group/preset (Figma 패널에서 폴더로 묶임)",
        JSON.stringify(names) === JSON.stringify(want),
        "\n  got:  " + names.join(" ") + "\n  want: " + want.join(" "));
      const nAlias = Object.keys(TS.aliases || {}).length;
      check("별칭 " + nAlias + "개는 스타일을 만들지 않음 (값이 같아 스타일만 늘어난다)", styles.length === want.length);

      // ★ 이번 작업의 핵심 이득: 노드에서는 원리적으로 불가능했던 배수 행간이 스타일에 살아남는가
      const byName = {};
      for (const s of styles) byName[s.name] = s;
      let lhOk = 0, lhBad = [];
      for (const n in TS.styles) {
        const def = TS.styles[n];
        const s = byName[(def.group ? def.group + "/" : "") + n];
        if (!s) continue;
        if (def.lineHeight) {
          const mult = Number(tokenValue(designData.variables, def.lineHeight));
          if (s.lineHeight && s.lineHeight.unit === "PERCENT" && s.lineHeight.value === mult * 100) lhOk++;
          else lhBad.push(n + "=" + JSON.stringify(s.lineHeight) + " (기대 PERCENT " + mult * 100 + ")");
        } else if (!s.lineHeight || s.lineHeight.unit !== "AUTO") {
          // 행간 없는 프리셋에 값이 들어가면 단일라인 텍스트가 벌어진다 → 시각 회귀
          lhBad.push(n + "=" + JSON.stringify(s.lineHeight) + " (기대 AUTO)");
        }
      }
      check("행간 프리셋 " + lhOk + "개가 PERCENT 배수로 보존 · 나머지는 AUTO", lhBad.length === 0, lhBad.join("\n  "));

      // ★ 자간이 없는 프리셋은 스타일의 자간을 **건드리지 않아야** 한다.
      //   0 을 PIXELS 로 넣으면 노드 기본값(PERCENT 0)과 단위가 달라져 스타일 적용이 전량 되돌려진다
      //   (Figma 실측으로 겪은 회귀. 값은 같고 단위만 달라서 눈에는 안 보인다)
      let lsOk = 0, lsBad = [];
      for (const n in TS.styles) {
        const def = TS.styles[n];
        const s = byName[(def.group ? def.group + "/" : "") + n];
        if (!s) continue;
        if (def.letterSpacing) {
          const pt = Number(tokenValue(designData.variables, def.letterSpacing));
          if (s.letterSpacing && s.letterSpacing.unit === "PIXELS" && s.letterSpacing.value === pt) lsOk++;
          else lsBad.push(n + "=" + JSON.stringify(s.letterSpacing) + " (기대 PIXELS " + pt + ")");
        } else if (!s.letterSpacing || s.letterSpacing.unit !== "PERCENT" || s.letterSpacing.value !== 0) {
          lsBad.push(n + "=" + JSON.stringify(s.letterSpacing) + " (자간 없는 프리셋 — 기본값을 건드리면 안 됨)");
        }
      }
      check("자간 프리셋 " + lsOk + "개만 PIXELS 로 설정 · 나머지는 노드 기본값 그대로", lsBad.length === 0, lsBad.join("\n  "));

      const sb = r.state.BIND_STAT;
      const sFields = Object.keys(sb).filter((f) => f.indexOf("style:") === 0);
      check("스타일 필드 바인딩 되돌림·예외 0 (" + sFields.map((f) => f + " ok" + sb[f].ok + " sk" + sb[f].skip).join(" ") + ")",
        sFields.every((f) => sb[f].revert === 0 && sb[f].error === 0),
        sFields.filter((f) => sb[f].revert || sb[f].error).join(","));
      check("프리셋 매칭 노드에 스타일 적용 (" + (sb.textStyle ? sb.textStyle.ok : 0) + "곳, 되돌림 " + (sb.textStyle ? sb.textStyle.revert : 0) + ")",
        !!sb.textStyle && sb.textStyle.ok > 0 && sb.textStyle.revert === 0 && sb.textStyle.error === 0);

      // 재임포트로 스타일이 불어나지 않아야 한다 (컬렉션 재사용과 같은 방침)
      const api2 = loadCode(r.stub.figma);
      await api2.importDesign(designData, synthIcons(designData), undefined, {}, {}, "light", "Pencil Tokens", { bindTokens: true });
      check("재임포트에도 스타일 중복 없음 " + r.stub.figma.getLocalTextStyles().length + "/" + want.length,
        r.stub.figma.getLocalTextStyles().length === want.length);
    }

    // ---------- V5 재실행 멱등성 ----------
    section("V5 재실행 멱등성 (resetState)");
    const stub = createFigmaStub({ behavior: "honest", fonts: FULL_FONTS });
    const api = loadCode(stub.figma);
    const svgMap = synthIcons(designData);
    await api.importDesign(designData, svgMap, undefined, {}, {}, "light", "Pencil Tokens", { bindTokens: true });
    const c1 = Object.keys(api.state().COMP_MAP).length, d1 = api.state().DBG.length;
    const v1 = Object.keys(stub.varStore).length;
    const i1 = Object.keys(api.state().ICON_COMP).length;
    await api.importDesign(designData, svgMap, undefined, {}, {}, "light", "Pencil Tokens", { bindTokens: true });
    const c2 = Object.keys(api.state().COMP_MAP).length, d2 = api.state().DBG.length;
    const v2 = Object.keys(stub.varStore).length;
    check("2회차도 컴포넌트를 새로 만든다 (" + c1 + " → " + c2 + ")", c1 > 0 && c1 === c2);
    check("DBG 가 누적되지 않는다 (" + d1 + " → " + d2 + ")", d1 === d2);
    check("변수는 컬렉션·이름으로 재사용 — 중복 생성 없음 (" + v1 + " → " + v2 + ")", v1 > 0 && v1 === v2);
    const i2 = Object.keys(api.state().ICON_COMP).length;
    check("2회차도 아이콘 마스터를 새로 만든다 (" + i1 + " → " + i2 + ", resetState 검증)", i1 > 0 && i1 === i2);
  }

  // ---------- V7~V11 아이콘 스왑 ----------
  if (designData) {
    const st = iconOverrideStats(designData);
    const screenNames = new Set((designData.screens || []).map((s) => s.name));
    section("V7 아이콘 폭발 반경 (마스킹 차분) — 실측 기대: 오버라이드 " + st.total + " · 변경 " + st.changed);

    const offIcon = await runImport(designData, "honest", FULL_FONTS, true, 7, { iconSwap: false });
    const onIcon = await runImport(designData, "honest", FULL_FONTS, true, 7, {});
    {
      const d = diff(maskIconTree(offIcon.tree), maskIconTree(onIcon.tree), "", []);
      check("아이콘 밖 트리 완전 동일 (스왑 ON/OFF)", d.length === 0, d.join("\n"));
    }

    section("V8 아이콘 정확성");
    {
      const bs = onIcon.state.BIND_STAT["ov.icon"] || { ok: 0, revert: 0, error: 0, skip: 0 };
      check("ov.icon: 성공 " + bs.ok + "/" + st.total + " · 되돌림 " + bs.revert + " · 예외 " + bs.error,
        bs.ok === st.total && bs.revert === 0 && bs.error === 0);
      const expKeys = expectedMasterKeys(designData, synthIcons(designData));
      const gotKeys = new Set(Object.keys(onIcon.state.ICON_COMP));
      const missing = [...expKeys].filter((k) => !gotKeys.has(k));
      const extraK = [...gotKeys].filter((k) => !expKeys.has(k));
      check("아이콘 마스터 전량 " + gotKeys.size + "/" + expKeys.size + "개 (전 조합)",
        missing.length === 0 && extraK.length === 0,
        (missing.length ? "누락: " + missing.slice(0, 5).join(" ") : "") + (extraK.length ? " 과잉: " + extraK.slice(0, 5).join(" ") : ""));
      const allInst = [];
      for (const pg of onIcon.tree) if (pg.name !== "DS - Icon Components")
        for (const ch of pg["#"] || []) (function cnt(o) { if (o._icon && o.type === "INSTANCE") allInst.push(o._icon); for (const c of o["#"] || []) cnt(c); })(ch);
      check("화면·컴포넌트의 아이콘이 전부 인스턴스 (" + allInst.length + "개, 낱개 벡터 0)",
        (function () {
          let frames = 0;
          for (const pg of onIcon.tree) if (pg.name !== "DS - Icon Components")
            for (const ch of pg["#"] || []) (function cnt(o) { if (o._icon && o.type === "FRAME") frames++; for (const c of o["#"] || []) cnt(c); })(ch);
          return frames === 0;
        })());

      const exp = expectedScreenIcons(designData);
      const obs = observedScreenIcons(onIcon.tree, screenNames);
      const bad = [];
      for (const name in exp) {
        const e = JSON.stringify(exp[name]), o = JSON.stringify(obs[name] || []);
        if (e !== o) bad.push(name + ": 기대 " + e.slice(0, 60) + " ≠ 실제 " + o.slice(0, 60));
      }
      check("전 화면(" + Object.keys(exp).length + "개) 아이콘 멀티셋 = 기대값 (오버라이드·교체 반영)", bad.length === 0, bad.slice(0, 5).join("\n"));

      const spot = (scr, icon) => (obs[scr] || []).indexOf(icon) >= 0;
      check("스포트: 에러 토스트 → circle-alert", spot("Status Change Error Toast", "circle-alert"));
      check("스포트: 삭제 확인 팝업 → trash-2", spot("삭제 확인 팝업", "trash-2"));
      const chips = new Set(obs["Category Bottom Sheet Frame"] || []);
      check("스포트: 카테고리 시트에 서로 다른 아이콘 " + chips.size + "종 (≥10)", chips.size >= 10);
    }

    section("V9 아이콘 폴백 안전성 (스왑 불가 환경 = 오늘과 완전 동일)");
    for (const sw of ["throw", "noop"]) {
      const alt = await runImport(designData, "honest", FULL_FONTS, true, 7, { swap: sw });
      const d = diff(offIcon.tree, alt.tree, "", []);
      check(sw + ": 트리가 스왑 OFF 와 완전 동일 (마스킹 없이)", d.length === 0, d.join("\n"));
      check(sw + ": 프로브가 차단 (CAP=false, 마스터 0개)",
        alt.state.CAP["ov.icon"] === false && Object.keys(alt.state.ICON_COMP).length === 0);
    }

    section("V10 SVG 미수신 가드");
    {
      const icons = synthIcons(designData);
      delete icons["lucide/circle-alert"];   // 후보 전용 (Toast 슬롯)
      delete icons["lucide/search"];         // 슬롯 기본 (Empty State 48px) → 슬롯 통째 포기되어야 함
      const r = await runImport(designData, "honest", FULL_FONTS, true, 7, { icons: icons });
      const keys = Object.keys(r.state.ICON_COMP);
      const hit = (k) => k === "lucide/circle-alert" || k === "lucide/search" || k.indexOf("/circle-alert@") >= 0 || k.indexOf("/search@") >= 0;
      check("SVG 없는 아이콘의 마스터 미생성", keys.every((k) => !hit(k)), keys.filter(hit).join(","));
      const bs = r.state.BIND_STAT["ov.icon"] || { ok: 0, skip: 0, error: 0, revert: 0 };
      check("영향받은 오버라이드만 건너뜀 (성공 " + bs.ok + " + 건너뜀 " + bs.skip + " = " + st.total + ", 예외 0)",
        bs.ok + bs.skip === st.total && bs.error === 0 && bs.revert === 0 && bs.skip > 0);
      const obs = observedScreenIcons(r.tree, screenNames);
      check("토스트는 기본 아이콘 유지 (빈 프레임으로 스왑하지 않음)", (obs["Status Change Error Toast"] || []).indexOf("circle-check") >= 0);
    }

    section("V11 재색칠 (스왑이 색을 날려도 복원 + 토큰 바인딩 유지)");
    {
      const r = await runImport(designData, "honest", FULL_FONTS, true, 7, { swap: "lossy" });
      // Toast 슬롯 fill = $primary → 스왑 후 재색칠이 색 변수 바인딩까지 복원해야 한다
      const toasts = [];
      for (const pg of r.stub.figma.root.children) rawFind(pg, (n) => n.type === "FRAME" && n.name === "Status Change Error Toast", toasts);
      const inst = toasts.length ? rawFind(toasts[0], (n) => n.type === "INSTANCE" && n._icon === "circle-alert", []) : [];
      const vecs = inst.length ? rawFind(inst[0], (n) => n.type === "VECTOR", []) : [];
      // 외곽선화된(면) 아이콘은 fills, live stroke 아이콘은 strokes — 어느 쪽이든 재색칠돼야 한다
      const paint = vecs.length && ((vecs[0].strokes && vecs[0].strokes[0]) || (vecs[0].fills && vecs[0].fills[0]));
      check("lossy: 스왑된 토스트 아이콘이 재색칠됨 (검정 아님)", !!paint && !(paint.color.r === 0 && paint.color.g === 0 && paint.color.b === 0),
        JSON.stringify(paint && paint.color));
      check("lossy: 재색칠에 색 변수 바인딩 존재 ($primary)", !!(paint && paint.boundVariables));

      const r2 = await runImport(designData, "honest", FULL_FONTS, true, 7, { pluginData: "notInherited" });
      const blocks = [];
      for (const pg of r2.stub.figma.root.children) {
        if (pg.name === "DS - Icon Components") continue;
        rawFind(pg, (n) => n._icon && Array.isArray(n.fills) && n.fills.length > 0, blocks);
      }
      check("pluginData 미상속이어도 아이콘에 단색 fills 없음 (색 블록 증상 0, ICON_SLOTS 판별)", blocks.length === 0,
        blocks.slice(0, 3).map((n) => n.name).join(","));
    }

    section("V13 외곽선화 미지원 폴백 (크기별 마스터)");
    {
      const r = await runImport(designData, "honest", FULL_FONTS, true, 7, { outline: "fail" });
      const exp = expectedMasterKeys(designData, synthIcons(designData), false);
      check("크기별 마스터로 폴백 (" + Object.keys(r.state.ICON_COMP).length + "/" + exp.size + ")",
        Object.keys(r.state.ICON_COMP).length === exp.size);
      const bs = r.state.BIND_STAT["ov.icon"] || { ok: 0, revert: 0, error: 0 };
      check("폴백 모드에서도 스왑 " + bs.ok + "/" + st.total, bs.ok === st.total && bs.error === 0 && bs.revert === 0);
      const exp2 = expectedScreenIcons(designData);
      const obs2 = observedScreenIcons(r.tree, screenNames);
      let bad2 = 0;
      for (const nm in exp2) if (JSON.stringify(exp2[nm]) !== JSON.stringify(obs2[nm] || [])) bad2++;
      check("폴백 모드에서도 전 화면 아이콘 일치", bad2 === 0, bad2 + "개 화면 불일치");
    }
  }

  // ---------- V6 잔여 결함 회귀 (합성 스펙) ----------
  section("V6 잔여 결함 회귀 (합성 스펙)");
  {
    const vars = {
      themes: { mode: ["light", "dark"] },
      variables: {
        primary: { type: "color", value: [{ value: "#FF0000", theme: { mode: "light" } }, { value: "#AA0000", theme: { mode: "dark" } }] },
        "radius-md": { type: "number", value: 12 },
        "spacing-md": { type: "number", value: 16 },
        "fontsize-body": { type: "number", value: 15 },
        "fontweight-bold": { type: "string", value: "700" },
        "font-body": { type: "string", value: "Inter" },
      },
    };
    const screens = [{
      id: "s1", name: "합성", type: "frame", layout: "vertical",
      gap: "$없는토큰",                                   // 미해석 → itemSpacing 에 문자열 대입 금지
      padding: { top: 8 },                                // 객체형 padding (미지원 형태)
      cornerRadius: ["$radius-md", 4, "$없는토큰", 8],     // 배열 + $ref + 미해석 혼합
      effect: [{ type: "shadow", color: "$primary", blur: 4 }],   // 그림자 색 $변수
      children: [
        { id: "t1", name: "txt", type: "text", content: "hi", fontFamily: "$font-body", fontSize: "$fontsize-body", fontWeight: "$fontweight-bold", lineHeight: 1.5, fill: "$primary" },
        { id: "r1", name: "shader", type: "rectangle", fill: { type: "shader" }, cornerRadius: "$radius-md" },
        { id: "p1", name: "poly", type: "polygon", polygonCount: 6, cornerRadius: "$radius-md" },
        { id: "l1", name: "line", type: "line", stroke: "$primary", strokeWidth: 1 },
        { id: "f2", name: "inner", type: "frame", layout: "horizontal", gap: "$spacing-md", padding: [4, "$spacing-md"], strokeWidth: { bottom: 2 }, stroke: "$primary" },
      ],
    }];
    const data = { variables: vars, components: [], screens: screens, icons: [], images: {} };
    let threw = null, res = null;
    try { res = await runImport(data, "honest", FULL_FONTS, true, 1); } catch (e) { threw = e; }
    check("합성 스펙이 예외 없이 빌드됨", !threw, threw && threw.stack);
    if (res) {
      const root = res.stub.figma.root.children[0].children.find((n) => n.name === "합성");
      check("미해석 gap 은 0 으로 (문자열 대입 금지)", root && root.itemSpacing === 0, root && JSON.stringify(root.itemSpacing));
      check("배열 cornerRadius 중 해석되는 것만 적용", root && root.topLeftRadius === 12 && root.topRightRadius === 4 && root.bottomLeftRadius === 8);
      check("미해석 cornerRadius 성분은 건드리지 않음", root && root.bottomRightRadius === 0);
      const eff = root && root.effects && root.effects[0];
      check("그림자 색 $변수 해석 (NaN 아님)", eff && Number.isFinite(eff.color.r) && eff.color.r > 0.9, JSON.stringify(eff && eff.color));
      const poly = root && root.children.find((n) => n.type === "POLYGON");
      check("polygon 의 $cornerRadius 적용", poly && poly.cornerRadius === 12, poly && poly.cornerRadius);
      const rect = root && root.children.find((n) => n.name === "shader");
      check("미지원 shader fill 은 [] (null 대입 아님)", rect && Array.isArray(rect.fills) && rect.fills.length === 0);
      const inner = root && root.children.find((n) => n.name === "inner");
      check("gap/padding 배관 작동 ($spacing-md → 16)", inner && inner.itemSpacing === 16 && inner.paddingRight === 16 && inner.paddingTop === 4);
      check("per-side strokeWeight 적용", inner && inner.strokeBottomWeight === 2);
      const txt = root && root.children.find((n) => n.type === "TEXT");
      check("lineHeight 은 PERCENT 리터럴 유지 (150%)",
        txt && txt.lineHeight.unit === "PERCENT" && txt.lineHeight.value === 150, txt && JSON.stringify(txt.lineHeight));
      check("텍스트 fill 이 색 변수로 바인딩", txt && txt.fills[0] && txt.fills[0].boundVariables);
      const bs = res.state.BIND_STAT;
      console.log("       " + Object.keys(bs).sort().map((f) =>
        f + "(ok " + bs[f].ok + " rv " + bs[f].revert + " er " + bs[f].error + " sk " + bs[f].skip + ")").join(" "));
      check("합성 스펙에서 되돌림·예외 0", Object.keys(bs).every((f) => bs[f].revert === 0 && bs[f].error === 0));
    }
  }

  console.log("\n" + (fail === 0 ? "✅ 전부 통과" : "❌ 실패 " + fail + "건") + " (통과 " + pass + " / 실패 " + fail + ")");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
