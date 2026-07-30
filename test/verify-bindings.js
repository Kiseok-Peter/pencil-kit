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
    + " state: () => ({ VARS, VAR_OBJ, VAR_HEX, VAR_NUM, VAR_STR, DBG, BIND_STAT, CAP, OPT, COMP_MAP, LOADED }) };",
    ctx, { filename: "code.js" });
  return ctx.__out.api;
}

// ---- 트리 직렬화 (boundVariables·id·parent 제외 = "눈에 보이는 것"만) ----
const SKIP_KEYS = { parent: 1, boundVariables: 1, id: 1, children: 1 };
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
  [].concat(data.components || [], data.screens || []).forEach(walk);
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

// ---- 한 번 임포트하고 페이지 트리를 돌려준다 ----
async function runImport(designData, behavior, fonts, bindTokens, seed) {
  const stub = createFigmaStub({ behavior: behavior, fonts: fonts, seed: seed });
  const api = loadCode(stub.figma);
  await api.importDesign(designData, {}, undefined, {}, {}, "light", "Pencil Tokens", { bindTokens: bindTokens });
  return { stub: stub, api: api, state: api.state(), tree: stub.figma.root.children.map(serialize) };
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
      { name: "honest         (모든 필드 존중)", behavior: "honest", fonts: FULL_FONTS },
      { name: "weightNoop     (fontWeight 캔버스 무반응)", behavior: "weightNoop", fonts: FULL_FONTS },
      { name: "lineheightCoerce (lineHeight 단위 강제)", behavior: "lineheightCoerce", fonts: FULL_FONTS },
      { name: "outfitMissing  (Outfit 미설치 + 바인딩 throw)", behavior: "outfitMissing", fonts: INTER_ONLY },
      { name: "hostile        (33% 무작위 오염)", behavior: "hostile", fonts: FULL_FONTS },
    ];
    for (const p of PROFILES) {
      section("V2 쌍둥이 차분 — " + p.name);
      const off = await runImport(designData, p.behavior, p.fonts, false, 7);
      const on = await runImport(designData, p.behavior, p.fonts, true, 7);
      const d = diff(off.tree, on.tree, "", []);
      check("bindTokens false/true 트리 동일 (시각 회귀 0)", d.length === 0, d.join("\n"));

      const bs = on.state.BIND_STAT;
      const tot = (f, k) => (bs[f] ? bs[f][k] : 0);
      const line = Object.keys(bs).sort().map((f) =>
        f + "(ok " + bs[f].ok + " rv " + bs[f].revert + " er " + bs[f].error + " sk " + bs[f].skip + ")").join(" ");
      console.log("       " + (line || "(집계 없음)"));

      if (p.behavior === "honest") {
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
        check("fontSize 전량 바인딩 " + tot("fontSize", "ok") + "/" + nFs, tot("fontSize", "ok") === nFs);
        check("fontFamily 전량 바인딩 " + tot("fontFamily", "ok") + "/" + nFam, tot("fontFamily", "ok") === nFam);
        check("fontWeight 시도 전량 처리 " + (tot("fontWeight", "ok") + tot("fontWeight", "skip")) + "/" + nFw
          + " (건너뜀 " + tot("fontWeight", "skip") + " = 이탤릭)", tot("fontWeight", "ok") + tot("fontWeight", "skip") === nFw);
        check("cornerRadius 전량 바인딩 " + tot("cornerRadius", "ok") + "/" + nCr, tot("cornerRadius", "ok") === nCr);
        check("letterSpacing 전량 바인딩 " + tot("letterSpacing", "ok") + "/" + nLs, tot("letterSpacing", "ok") === nLs);
        check("lineHeight 은 시도조차 안 함 " + tot("lineHeight", "skip") + "/" + nLh + " (배수↔PIXELS)",
          tot("lineHeight", "ok") === 0 && tot("lineHeight", "skip") === nLh);
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
        const famRefs = countRefs(designData, "fontFamily");
        let expOk = 0, expSkip = 0;
        for (const ref in famRefs) {
          const val = String(tokenValue(designData.variables, ref.slice(1)));
          if (val === "Inter") expOk += famRefs[ref]; else expSkip += famRefs[ref];
        }
        check("설치된 폰트만 바인딩 " + tot("fontFamily", "ok") + "/" + expOk, tot("fontFamily", "ok") === expOk);
        check("미설치(Outfit) 참조는 전부 건너뜀 " + tot("fontFamily", "skip") + "/" + expSkip, tot("fontFamily", "skip") === expSkip);
        // 이 프로필의 스텁은 미설치 패밀리를 바인딩하면 throw 한다 → 예외 0 = 게이트가 시도 자체를 막았다는 증거
        check("미설치 폰트 바인딩 시도 0 (예외 0 이 증거)", tot("fontFamily", "error") === 0);
      }
      if (p.behavior === "hostile") {
        const rv = Object.keys(bs).reduce((a, f) => a + bs[f].revert, 0);
        check("오염을 리드백이 잡아 되돌림 (" + rv + "건) — 그래도 트리는 동일", rv > 0);
        const blocked = Object.keys(on.state.CAP).filter((k) => on.state.CAP[k] === false);
        check("서킷 브레이커 작동 (" + (blocked.join(",") || "없음") + ")", blocked.length > 0);
      }
    }

    // ---------- V5 재실행 멱등성 ----------
    section("V5 재실행 멱등성 (resetState)");
    const stub = createFigmaStub({ behavior: "honest", fonts: FULL_FONTS });
    const api = loadCode(stub.figma);
    await api.importDesign(designData, {}, undefined, {}, {}, "light", "Pencil Tokens", { bindTokens: true });
    const c1 = Object.keys(api.state().COMP_MAP).length, d1 = api.state().DBG.length;
    const v1 = Object.keys(stub.varStore).length;
    await api.importDesign(designData, {}, undefined, {}, {}, "light", "Pencil Tokens", { bindTokens: true });
    const c2 = Object.keys(api.state().COMP_MAP).length, d2 = api.state().DBG.length;
    const v2 = Object.keys(stub.varStore).length;
    check("2회차도 컴포넌트를 새로 만든다 (" + c1 + " → " + c2 + ")", c1 > 0 && c1 === c2);
    check("DBG 가 누적되지 않는다 (" + d1 + " → " + d2 + ")", d1 === d2);
    check("변수는 컬렉션·이름으로 재사용 — 중복 생성 없음 (" + v1 + " → " + v2 + ")", v1 > 0 && v1 === v2);
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
