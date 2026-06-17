/* kotei-editor.js ロジックテスト（DOMスタブ・node実行）
 * 件2 タッチ2タップ結線の検証。`node kotei-editor.test.js` で実行。
 * 検証点：
 *  - タッチ時 onMarkerClick で 1タップ選択→2タップ結線→選択解除
 *  - 同一○再タップで選択解除（線は増えない）
 *  - addLine の重複排除
 *  - 空セル click で選択解除（マーカー増えない）
 *  - PC（isTouch=false）はクリック=削除でドラッグ非破壊
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let touchMode = false; // sandbox構築時に参照
function makeNode() {
  const node = {
    children: [],
    style: {},
    attrs: {},
    listeners: {},
    className: "",
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    disabled: false,
    type: "",
    placeholder: "",
    title: "",
    accept: "",
    innerHTML: "",
    textContent: "",
    value: "",
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    querySelector() { return makeNode(); },
    querySelectorAll() { return []; },
    get firstChild() { return this.children[0] || null; },
    createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return { x: 0, y: 0 }; } }; },
    getScreenCTM() { return { inverse() { return {}; } }; },
    cloneNode() { return makeNode(); },
  };
  return node;
}

function buildSandbox(isTouch) {
  const store = {};
  const root = makeNode();
  const documentStub = {
    readyState: "complete",
    createElement: () => makeNode(),
    createElementNS: () => makeNode(),
    getElementById: (id) => (id === "kotei-editor-root" ? root : null),
    addEventListener: () => {},
    body: makeNode(),
  };
  const win = {
    matchMedia: (q) => ({ matches: isTouch && /coarse/.test(q) }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    confirm: () => true,
    prompt: () => "",
    alert: () => {},
  };
  if (isTouch) win.ontouchstart = null; // 'ontouchstart' in window === true
  const sandbox = {
    window: win,
    document: documentStub,
    navigator: { maxTouchPoints: isTouch ? 5 : 0 },
    localStorage: win.localStorage,
    crypto: { randomUUID: () => "id-" + Math.random().toString(36).slice(2) },
    XMLSerializer: function () { this.serializeToString = () => "<svg/>"; },
    Blob: function () {},
    URL: { createObjectURL: () => "blob:", revokeObjectURL: () => {} },
    Image: function () {},
    setTimeout: () => {},
    FileReader: function () {},
    console,
  };
  sandbox.window.document = documentStub;
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, "kotei-editor.js"), "utf8");
  vm.runInContext(code, sandbox);
  return { sandbox, root };
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ok  - " + msg); }
  else { fail++; console.log("  FAIL- " + msg); }
}

/* ---- タッチモード ---- */
(function testTouch() {
  console.log("[タッチ＝2タップ結線]");
  const { sandbox } = buildSandbox(true);
  const ed = new sandbox.window.KoteiEditor(sandbox.document.getElementById("kotei-editor-root"));
  assert(ed.isTouch === true, "isTouch が true で初期化される");

  // ○を2つ配置
  ed.toggleMarker(0, 2);
  ed.toggleMarker(1, 5);
  let ms = ed.state().markers;
  assert(ms.length === 2, "○が2つ配置される");
  const a = ms[0].id, b = ms[1].id;

  // 1タップ目：選択
  ed.onMarkerClick(a, { stopPropagation() {} });
  assert(ed.selectedMarkerId === a, "1タップ目で選択中になる");
  assert(ed.state().lines.length === 0, "1タップだけでは線は引かれない");

  // 2タップ目（別の○）：結線＋選択解除
  ed.onMarkerClick(b, { stopPropagation() {} });
  assert(ed.state().lines.length === 1, "2タップ目で線が1本引かれる");
  assert(ed.selectedMarkerId === null, "結線後に選択解除される");
  const ln = ed.state().lines[0];
  assert((ln.fromMarkerId === a && ln.toMarkerId === b), "線が a→b で生成される");
  assert(ln.color === "black", "選択中の色(black)が線に反映される");

  // 重複結線：同じペアをもう一度
  ed.onMarkerClick(a, { stopPropagation() {} });
  ed.onMarkerClick(b, { stopPropagation() {} });
  assert(ed.state().lines.length === 1, "同じ2点の再結線は重複排除される");

  // 同一○再タップで選択解除
  ed.onMarkerClick(a, { stopPropagation() {} });
  assert(ed.selectedMarkerId === a, "再び1タップで選択");
  ed.onMarkerClick(a, { stopPropagation() {} });
  assert(ed.selectedMarkerId === null, "同じ○の再タップで選択解除");

  // 色変更後の結線
  ed.toggleMarker(3, 8);
  const c = ed.state().markers.filter(m => m.rowIndex === 3)[0].id;
  ed.color = "red";
  ed.onMarkerClick(a, { stopPropagation() {} });
  ed.onMarkerClick(c, { stopPropagation() {} });
  const redLine = ed.state().lines.filter(l =>
    (l.fromMarkerId === a && l.toMarkerId === c) || (l.fromMarkerId === c && l.toMarkerId === a))[0];
  assert(redLine && redLine.color === "red", "色を赤にして結線すると赤線になる");

  // 空セル相当：clearSelection で選択解除（マーカー数不変）
  ed.onMarkerClick(b, { stopPropagation() {} });
  assert(ed.selectedMarkerId === b, "選択中にしてから");
  const beforeMarkers = ed.state().markers.length;
  ed.clearSelection();
  assert(ed.selectedMarkerId === null, "clearSelection で選択解除");
  assert(ed.state().markers.length === beforeMarkers, "選択解除でマーカー数は変わらない");

  // 線タップ削除（タッチ）
  const before = ed.state().lines.length;
  ed.removeLine(ed.state().lines[0].id);
  assert(ed.state().lines.length === before - 1, "線タップ削除で線が1本減る");
})();

/* ---- PCモード（ドラッグ非破壊） ---- */
(function testPC() {
  console.log("[PC＝ドラッグ結線維持・非破壊]");
  const { sandbox } = buildSandbox(false);
  const ed = new sandbox.window.KoteiEditor(sandbox.document.getElementById("kotei-editor-root"));
  assert(ed.isTouch === false, "isTouch が false（PC）");

  ed.toggleMarker(0, 2);
  ed.toggleMarker(1, 5);
  const a = ed.state().markers[0].id, b = ed.state().markers[1].id;

  // 従来のドラッグ結線：onMarkerDown(a) → onMarkerUp(b)
  ed.onMarkerDown(a, { button: 0, stopPropagation() {} });
  assert(ed.dragSourceId === a, "ドラッグ開始でdragSourceId設定");
  ed.onMarkerUp(b, { stopPropagation() {} });
  assert(ed.state().lines.length === 1, "ドラッグ結線で線が引かれる（PC非破壊）");
  assert(ed.dragSourceId === null, "ドラッグ終了でdragSourceIdクリア");

  // PCの純粋クリック＝○削除（従来挙動）
  const beforeM = ed.state().markers.length;
  ed.onMarkerClick(a, { stopPropagation() {} });
  assert(ed.state().markers.length === beforeM - 1, "PCクリックで○削除（従来挙動維持）");
  assert(ed.selectedMarkerId === null, "PCではselectedMarkerIdは使われない");
})();

console.log("\n結果: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
