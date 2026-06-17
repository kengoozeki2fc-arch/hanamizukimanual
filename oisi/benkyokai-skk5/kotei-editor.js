/* =====================================================================
 * kotei-editor.js — 演習用 工程表メモ欄（バニラJS版）
 * 大石 1級建築施工管技 二次検定 勉強会 skk5 問3 に組込む軽量工程表エディタ。
 * kotei-app (src/app/sheets/[id]/EditorClient.tsx + calendar.ts + holidays.ts)
 * のロジックをサーバ/認証/共有/公開抜きでバニラ移植したもの。
 *
 * 残した機能：段(行)×日付グリッド／marker(○)配置／marker間ドラッグでline(横バー)結線／
 *            色(黒赤青)／段数±／undo・redo／休日設定(土日＋日本の祝日＋カスタム)。
 * 新規追加：localStorage自動保存・復元／JSON保存・読込／PNG保存／クリア。
 *
 * 使い方： コンテナ要素 #kotei-editor-root を置き、末尾でこのJSを読み込むだけ。
 * ===================================================================== */
(function () {
  "use strict";

  /* ---------- 定数（kotei踏襲） ---------- */
  var ROW_LABEL_WIDTH = 120;
  var DAY_COL_WIDTH = 28;
  var ROW_HEIGHT = 26;
  var HEADER_HEIGHT = 36;
  var MARKER_RADIUS = 8;
  var HISTORY_LIMIT = 50;
  var STORAGE_KEY = "kotei-skk5-q3";

  var COLOR_HEX = { black: "#1A1A1A", red: "#D32F2F", blue: "#1976D2" };

  /* ---------- 祝日（holidays.ts 由来・2025〜2027） ---------- */
  var JP_HOLIDAYS = [
    [2025, 1, 1, "元日"], [2025, 1, 13, "成人の日"], [2025, 2, 11, "建国記念の日"],
    [2025, 2, 23, "天皇誕生日"], [2025, 2, 24, "休日"], [2025, 3, 20, "春分の日"],
    [2025, 4, 29, "昭和の日"], [2025, 5, 3, "憲法記念日"], [2025, 5, 4, "みどりの日"],
    [2025, 5, 5, "こどもの日"], [2025, 5, 6, "休日"], [2025, 7, 21, "海の日"],
    [2025, 8, 11, "山の日"], [2025, 9, 15, "敬老の日"], [2025, 9, 23, "秋分の日"],
    [2025, 10, 13, "スポーツの日"], [2025, 11, 3, "文化の日"], [2025, 11, 23, "勤労感謝の日"],
    [2025, 11, 24, "休日"],
    [2026, 1, 1, "元日"], [2026, 1, 12, "成人の日"], [2026, 2, 11, "建国記念の日"],
    [2026, 2, 23, "天皇誕生日"], [2026, 3, 20, "春分の日"], [2026, 4, 29, "昭和の日"],
    [2026, 5, 3, "憲法記念日"], [2026, 5, 4, "みどりの日"], [2026, 5, 5, "こどもの日"],
    [2026, 5, 6, "休日"], [2026, 7, 20, "海の日"], [2026, 8, 11, "山の日"],
    [2026, 9, 21, "敬老の日"], [2026, 9, 22, "休日"], [2026, 9, 23, "秋分の日"],
    [2026, 10, 12, "スポーツの日"], [2026, 11, 3, "文化の日"], [2026, 11, 23, "勤労感謝の日"],
    [2027, 1, 1, "元日"], [2027, 1, 11, "成人の日"], [2027, 2, 11, "建国記念の日"],
    [2027, 2, 23, "天皇誕生日"], [2027, 3, 21, "春分の日"], [2027, 3, 22, "休日"],
    [2027, 4, 29, "昭和の日"], [2027, 5, 3, "憲法記念日"], [2027, 5, 4, "みどりの日"],
    [2027, 5, 5, "こどもの日"], [2027, 7, 19, "海の日"], [2027, 8, 11, "山の日"],
    [2027, 9, 20, "敬老の日"], [2027, 9, 23, "秋分の日"], [2027, 10, 11, "スポーツの日"],
    [2027, 11, 3, "文化の日"], [2027, 11, 23, "勤労感謝の日"]
  ];
  var HOLIDAY_INDEX = {};
  JP_HOLIDAYS.forEach(function (h) { HOLIDAY_INDEX[h[0] + "-" + h[1] + "-" + h[2]] = h[3]; });

  function getJpHolidayLabel(y, m, d) { return HOLIDAY_INDEX[y + "-" + m + "-" + d] || null; }
  function isJpHoliday(y, m, d) { return Object.prototype.hasOwnProperty.call(HOLIDAY_INDEX, y + "-" + m + "-" + d); }

  /* ---------- calendar.ts 由来 ---------- */
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
  function dayOfWeek(y, m, d) { return new Date(y, m - 1, d).getDay(); }
  function dayLabel(dow) { return ["日", "月", "火", "水", "木", "金", "土"][dow] || ""; }
  function isWeekend(dow, sat, sun) {
    if (sun && dow === 0) return true;
    if (sat && dow === 6) return true;
    return false;
  }
  function classifyDay(y, m, d, opts) {
    var dow = dayOfWeek(y, m, d);
    var dateStr = y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    var custom = (opts.customHolidays || []).filter(function (c) { return c.date === dateStr; })[0];
    if (custom) return { isHoliday: true, label: custom.label || "休日", source: "custom" };
    if (opts.jpHoliday && isJpHoliday(y, m, d)) return { isHoliday: true, label: getJpHolidayLabel(y, m, d), source: "jp" };
    if (isWeekend(dow, opts.satHoliday, opts.sunHoliday)) return { isHoliday: true, label: null, source: "weekend" };
    return { isHoliday: false, label: null, source: null };
  }

  /* ---------- ユーティリティ ---------- */
  function uid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  /* ---------- 線パス（EditorClient.tsx 移植） ---------- */
  function linePath(x1, y1, x2, y2) {
    var dy = y2 - y1;
    if (Math.abs(dy) < 1) return "M " + x1 + " " + y1 + " L " + x2 + " " + y2;
    var dx = x2 - x1, absDx = Math.abs(dx);
    var sw = Math.min(2 * DAY_COL_WIDTH, absDx);
    var dir = dx >= 0 ? 1 : -1;
    var midX = (x1 + x2) / 2;
    var leftX = midX - (sw / 2) * dir, rightX = midX + (sw / 2) * dir;
    return "M " + x1 + " " + y1 + " L " + leftX + " " + y1 + " C " + midX + " " + y1 + " " + midX + " " + y2 + " " + rightX + " " + y2 + " L " + x2 + " " + y2;
  }
  function lineMidpoint(x1, y1, x2, y2) {
    if (Math.abs(y2 - y1) < 1) return { x: (x1 + x2) / 2, y: y1 - 8 };
    return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  function ghostPath(x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    if (Math.abs(dy) < 1) {
      var cx = (x1 + x2) / 2;
      var cy = y1 + Math.min(20, Math.max(8, Math.abs(dx) * 0.08));
      return "M " + x1 + " " + y1 + " Q " + cx + " " + cy + " " + x2 + " " + y2;
    }
    var offsetX = Math.max(20, Math.abs(dx) * 0.4);
    return "M " + x1 + " " + y1 + " C " + (x1 + offsetX) + " " + y1 + " " + (x2 - offsetX) + " " + y2 + " " + x2 + " " + y2;
  }

  /* ---------- 状態・履歴 ---------- */
  function defaultState() {
    var rowCount = 10;
    var rows = [];
    for (var i = 0; i < rowCount; i++) rows.push({ index: i, label: "" });
    return {
      rowCount: rowCount,
      rows: rows,
      markers: [],
      lines: [],
      settings: {
        year: 2026, month: 6,
        satHoliday: true, sunHoliday: true, jpHoliday: true,
        customHolidays: []
      }
    };
  }

  function normalizeState(s) {
    var d = defaultState();
    if (!s || typeof s !== "object") return d;
    var out = clone(d);
    if (typeof s.rowCount === "number") out.rowCount = Math.max(5, Math.min(30, s.rowCount));
    out.rows = [];
    var labelMap = {};
    var srcRows = Array.isArray(s.rows) ? s.rows : [];
    srcRows.forEach(function (r) { if (r && typeof r.index === "number") labelMap[r.index] = r.label || ""; });
    for (var i = 0; i < out.rowCount; i++) out.rows.push({ index: i, label: labelMap[i] || "" });
    var srcMarkers = Array.isArray(s.markers) ? s.markers : [];
    out.markers = srcMarkers.filter(function (m) { return m && m.id && typeof m.rowIndex === "number" && typeof m.day === "number"; })
      .map(function (m) { return { id: m.id, rowIndex: m.rowIndex, day: m.day, color: COLOR_HEX[m.color] ? m.color : "black" }; });
    var srcLines = Array.isArray(s.lines) ? s.lines : [];
    out.lines = srcLines.filter(function (l) { return l && l.id && l.fromMarkerId && l.toMarkerId; })
      .map(function (l) { return { id: l.id, fromMarkerId: l.fromMarkerId, toMarkerId: l.toMarkerId, label: l.label || "", color: COLOR_HEX[l.color] ? l.color : "black" }; });
    if (s.settings && typeof s.settings === "object") {
      var st = s.settings;
      if (typeof st.year === "number") out.settings.year = st.year;
      if (typeof st.month === "number") out.settings.month = st.month;
      out.settings.satHoliday = st.satHoliday !== false;
      out.settings.sunHoliday = st.sunHoliday !== false;
      out.settings.jpHoliday = st.jpHoliday !== false;
      var srcCust = Array.isArray(st.customHolidays) ? st.customHolidays : [];
      out.settings.customHolidays = srcCust.filter(function (c) { return c && c.date; });
    }
    return out;
  }

  /* ============ メインコントローラ ============ */
  /* ---------- タッチ判定（スマホ＝2タップ結線） ---------- */
  var IS_TOUCH = (typeof window !== "undefined") && (
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    ("ontouchstart" in window) ||
    (navigator && navigator.maxTouchPoints > 0)
  );

  function KoteiEditor(root) {
    this.root = root;
    this.color = "black";
    this.dragSourceId = null;
    this.pointer = null;
    this.isTouch = IS_TOUCH;
    this.selectedMarkerId = null; // タッチ2タップ結線の選択中○
    this.history = { past: [], present: defaultState(), future: [] };
    // localStorage 復元
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.history.present = normalizeState(JSON.parse(raw));
    } catch (e) { /* 破損時は既定 */ }
    this.buildDom();
    this.render();
  }

  KoteiEditor.prototype.state = function () { return this.history.present; };

  KoteiEditor.prototype.commit = function (next, resetHistory) {
    if (next === this.history.present) return;
    if (resetHistory) {
      this.history = { past: [], present: next, future: [] };
    } else {
      var past = this.history.past.concat([this.history.present]).slice(-HISTORY_LIMIT);
      this.history = { past: past, present: next, future: [] };
    }
    this.persist();
    this.render();
  };

  KoteiEditor.prototype.undo = function () {
    if (this.history.past.length === 0) return;
    var prev = this.history.past[this.history.past.length - 1];
    this.history = {
      past: this.history.past.slice(0, -1),
      present: prev,
      future: [this.history.present].concat(this.history.future)
    };
    this.persist();
    this.render();
  };

  KoteiEditor.prototype.redo = function () {
    if (this.history.future.length === 0) return;
    var nx = this.history.future[0];
    this.history = {
      past: this.history.past.concat([this.history.present]).slice(-HISTORY_LIMIT),
      present: nx,
      future: this.history.future.slice(1)
    };
    this.persist();
    this.render();
  };

  KoteiEditor.prototype.persist = function () {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history.present)); } catch (e) { /* quota等は無視 */ }
  };

  /* ---------- 状態変更ヘルパ ---------- */
  KoteiEditor.prototype.changeRowCount = function (delta) {
    var s = this.state();
    var next = Math.max(5, Math.min(30, s.rowCount + delta));
    if (next === s.rowCount) return;
    var ns = clone(s);
    if (next < s.rowCount) {
      var dropped = {};
      for (var i = next; i < s.rowCount; i++) dropped[i] = true;
      var keptMarkers = ns.markers.filter(function (m) { return !dropped[m.rowIndex]; });
      var droppedIds = {};
      ns.markers.forEach(function (m) { if (dropped[m.rowIndex]) droppedIds[m.id] = true; });
      ns.markers = keptMarkers;
      ns.lines = ns.lines.filter(function (l) { return !droppedIds[l.fromMarkerId] && !droppedIds[l.toMarkerId]; });
      ns.rows = ns.rows.filter(function (r) { return r.index < next; });
      ns.rowCount = next;
    } else {
      for (var j = s.rowCount; j < next; j++) ns.rows.push({ index: j, label: "" });
      ns.rowCount = next;
    }
    this.commit(ns);
  };

  KoteiEditor.prototype.setRowLabel = function (rowIndex, label) {
    var ns = clone(this.state());
    ns.rows = ns.rows.map(function (r) { return r.index === rowIndex ? { index: r.index, label: label } : r; });
    this.commit(ns);
  };

  KoteiEditor.prototype.toggleMarker = function (rowIndex, day) {
    var s = this.state();
    var existing = s.markers.filter(function (m) { return m.rowIndex === rowIndex && m.day === day; })[0];
    var ns = clone(s);
    if (existing) {
      ns.markers = ns.markers.filter(function (m) { return m.id !== existing.id; });
      ns.lines = ns.lines.filter(function (l) { return l.fromMarkerId !== existing.id && l.toMarkerId !== existing.id; });
    } else {
      ns.markers.push({ id: uid(), rowIndex: rowIndex, day: day, color: this.color });
    }
    this.commit(ns);
  };

  KoteiEditor.prototype.removeMarker = function (id) {
    var ns = clone(this.state());
    ns.markers = ns.markers.filter(function (m) { return m.id !== id; });
    ns.lines = ns.lines.filter(function (l) { return l.fromMarkerId !== id && l.toMarkerId !== id; });
    this.commit(ns);
  };

  KoteiEditor.prototype.setMarkerColor = function (id, color) {
    var ns = clone(this.state());
    ns.markers = ns.markers.map(function (m) { return m.id === id ? { id: m.id, rowIndex: m.rowIndex, day: m.day, color: color } : m; });
    this.commit(ns);
  };

  KoteiEditor.prototype.addLine = function (fromId, toId) {
    var s = this.state();
    var dup = s.lines.filter(function (l) {
      return (l.fromMarkerId === fromId && l.toMarkerId === toId) || (l.fromMarkerId === toId && l.toMarkerId === fromId);
    })[0];
    if (dup) return;
    var ns = clone(s);
    ns.lines.push({ id: uid(), fromMarkerId: fromId, toMarkerId: toId, label: "", color: this.color });
    this.commit(ns);
  };

  KoteiEditor.prototype.removeLine = function (id) {
    var ns = clone(this.state());
    ns.lines = ns.lines.filter(function (l) { return l.id !== id; });
    this.commit(ns);
  };

  KoteiEditor.prototype.setLineLabel = function (id, label) {
    var ns = clone(this.state());
    ns.lines = ns.lines.map(function (l) { return l.id === id ? { id: l.id, fromMarkerId: l.fromMarkerId, toMarkerId: l.toMarkerId, label: label, color: l.color } : l; });
    this.commit(ns);
  };

  KoteiEditor.prototype.setLineColor = function (id, color) {
    var ns = clone(this.state());
    ns.lines = ns.lines.map(function (l) { return l.id === id ? { id: l.id, fromMarkerId: l.fromMarkerId, toMarkerId: l.toMarkerId, label: l.label, color: color } : l; });
    this.commit(ns);
  };

  KoteiEditor.prototype.setSettingFlag = function (key, value) {
    var ns = clone(this.state());
    ns.settings[key] = value;
    this.commit(ns);
  };

  KoteiEditor.prototype.setYearMonth = function (year, month) {
    var ns = clone(this.state());
    ns.settings.year = year;
    ns.settings.month = month;
    this.commit(ns);
  };

  KoteiEditor.prototype.addCustomHoliday = function (date, label) {
    var ns = clone(this.state());
    var list = ns.settings.customHolidays || [];
    if (list.some(function (c) { return c.date === date; })) {
      list = list.map(function (c) { return c.date === date ? { date: date, label: label } : c; });
    } else {
      list = list.concat([{ date: date, label: label }]).sort(function (a, b) { return a.date.localeCompare(b.date); });
    }
    ns.settings.customHolidays = list;
    this.commit(ns);
  };

  KoteiEditor.prototype.removeCustomHoliday = function (date) {
    var ns = clone(this.state());
    ns.settings.customHolidays = (ns.settings.customHolidays || []).filter(function (c) { return c.date !== date; });
    this.commit(ns);
  };

  KoteiEditor.prototype.clearAll = function () {
    if (!window.confirm("工程表メモを白紙に戻します。よろしいですか？（元に戻すには戻すボタンを使ってください）")) return;
    this.commit(defaultState());
  };

  /* ---------- 幾何 ---------- */
  KoteiEditor.prototype.days = function () {
    var s = this.state().settings;
    return daysInMonth(s.year, s.month);
  };
  KoteiEditor.prototype.markerXY = function (id) {
    var m = this.state().markers.filter(function (mk) { return mk.id === id; })[0];
    if (!m) return null;
    return {
      x: ROW_LABEL_WIDTH + (m.day - 1) * DAY_COL_WIDTH + DAY_COL_WIDTH / 2,
      y: HEADER_HEIGHT + m.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
    };
  };

  /* ============ DOM 構築 ============ */
  KoteiEditor.prototype.buildDom = function () {
    var self = this;
    this.root.innerHTML = "";
    this.root.className = "kotei-editor";

    // 注意書き（スマホ非推奨）
    var note = document.createElement("div");
    note.className = "kotei-note";
    note.innerHTML =
      "📝 工程表メモ欄の使い方：<strong>PC＝</strong>○をドラッグして別の○でドロップすると線が引けます。" +
      "<strong>スマホ／タブレット＝</strong>○を1回タップ（青く選択）→もう一方の○をタップすると線が引けます（同じ○をもう一度タップで選択解除）。" +
      "線を消すときは線をタップ（PCは右クリックで色変更・削除）。" +
      "複雑な図はPC（マウス操作）の方が快適ですが、スマホでも作図・接続できます。";
    this.root.appendChild(note);

    // ツールバー
    var bar = document.createElement("div");
    bar.className = "kotei-toolbar";
    this.root.appendChild(bar);
    this.toolbar = bar;

    this.btnUndo = this.mkBtn("↶ 戻す", function () { self.undo(); });
    this.btnRedo = this.mkBtn("↷ 進む", function () { self.redo(); });
    bar.appendChild(this.btnUndo);
    bar.appendChild(this.btnRedo);

    bar.appendChild(this.mkLabel("段数"));
    this.btnRowMinus = this.mkBtn("−", function () { self.changeRowCount(-1); });
    this.rowCountSpan = document.createElement("span");
    this.rowCountSpan.className = "kotei-rowcount";
    this.btnRowPlus = this.mkBtn("＋", function () { self.changeRowCount(1); });
    bar.appendChild(this.btnRowMinus);
    bar.appendChild(this.rowCountSpan);
    bar.appendChild(this.btnRowPlus);

    bar.appendChild(this.mkLabel("色"));
    this.colorBtns = {};
    ["black", "red", "blue"].forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "kotei-color";
      b.style.backgroundColor = COLOR_HEX[c];
      b.title = c;
      b.addEventListener("click", function () { self.color = c; self.renderToolbar(); });
      self.colorBtns[c] = b;
      bar.appendChild(b);
    });

    var gear = this.mkBtn("⚙ 休日設定", function () { self.openSettings(); });
    bar.appendChild(gear);

    // 年月ピッカー
    bar.appendChild(this.mkLabel("対象月"));
    this.ymInput = document.createElement("input");
    this.ymInput.type = "month";
    this.ymInput.className = "kotei-ym";
    this.ymInput.addEventListener("change", function () {
      var v = self.ymInput.value; // YYYY-MM
      var mt = /^(\d{4})-(\d{2})$/.exec(v);
      if (mt) self.setYearMonth(Number(mt[1]), Number(mt[2]));
    });
    bar.appendChild(this.ymInput);

    // 保存系（右寄せ）
    var spacer = document.createElement("span");
    spacer.className = "kotei-spacer";
    bar.appendChild(spacer);

    bar.appendChild(this.mkBtn("💾 JSON保存", function () { self.exportJson(); }));
    var loadBtn = this.mkBtn("📂 JSON読込", function () { self.fileInput.click(); });
    bar.appendChild(loadBtn);
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = "application/json,.json";
    this.fileInput.style.display = "none";
    this.fileInput.addEventListener("change", function (e) { self.importJson(e); });
    bar.appendChild(this.fileInput);
    bar.appendChild(this.mkBtn("🖼 PNG保存", function () { self.exportPng(); }));
    var clr = this.mkBtn("🗑 クリア", function () { self.clearAll(); });
    clr.className += " kotei-btn-danger";
    bar.appendChild(clr);

    // スクロール領域
    this.scrollWrap = document.createElement("div");
    this.scrollWrap.className = "kotei-scroll";
    this.root.appendChild(this.scrollWrap);

    this.inner = document.createElement("div");
    this.inner.className = "kotei-inner";
    this.scrollWrap.appendChild(this.inner);

    this.svg = svgEl("svg", { xmlns: SVGNS });
    this.svg.style.display = "block";
    this.svg.style.userSelect = "none";
    this.inner.appendChild(this.svg);

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "kotei-labels";
    this.inner.appendChild(this.labelLayer);

    // SVGポインタ
    this.svg.addEventListener("mousemove", function (e) { self.onSvgMove(e); });
    this.svg.addEventListener("mouseup", function () { self.onSvgUp(); });
    this.svg.addEventListener("mouseleave", function () { self.onSvgUp(); });

    // フッタ
    this.footer = document.createElement("div");
    this.footer.className = "kotei-footer";
    this.root.appendChild(this.footer);

    // キーボード undo/redo
    this.keyHandler = function (e) {
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      var meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); self.undo(); }
      else if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); self.redo(); }
    };
    // root にフォーカスがある時だけ拾う（ページ全体を奪わない）
    this.scrollWrap.setAttribute("tabindex", "0");
    this.scrollWrap.addEventListener("keydown", this.keyHandler);

    // コンテキストメニュー外クリック閉じ
    document.addEventListener("click", function () { self.closeContextMenu(); });
  };

  KoteiEditor.prototype.mkBtn = function (text, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "kotei-btn";
    b.textContent = text;
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
    return b;
  };
  KoteiEditor.prototype.mkLabel = function (text) {
    var s = document.createElement("span");
    s.className = "kotei-toollabel";
    s.textContent = text;
    return s;
  };

  /* ============ 描画 ============ */
  KoteiEditor.prototype.render = function () {
    this.renderToolbar();
    this.renderGrid();
    this.renderFooter();
  };

  KoteiEditor.prototype.renderToolbar = function () {
    var s = this.state();
    this.btnUndo.disabled = this.history.past.length === 0;
    this.btnRedo.disabled = this.history.future.length === 0;
    this.btnRowMinus.disabled = s.rowCount <= 5;
    this.btnRowPlus.disabled = s.rowCount >= 30;
    this.rowCountSpan.textContent = s.rowCount;
    var self = this;
    ["black", "red", "blue"].forEach(function (c) {
      self.colorBtns[c].classList.toggle("kotei-color-active", self.color === c);
    });
    this.ymInput.value = s.settings.year + "-" + String(s.settings.month).padStart(2, "0");
  };

  KoteiEditor.prototype.renderFooter = function () {
    var s = this.state();
    var ops = this.isTouch
      ? "セルタップで○配置 / ○をタップ→別の○をタップで線接続 / 線タップ=削除 / 同じ○を再タップで選択解除"
      : "セルクリックで○配置 / ○をドラッグ→別の○でドロップして線接続（クリック選択でも可）/ 線クリック=ラベル / 右クリック=色変更・削除 / Ctrl+Z で戻す";
    var sel = this.selectedMarkerId ? '<span class="kotei-count" style="color:#1976D2">○を選択中…もう一方の○をタップ</span>' : "";
    this.footer.innerHTML = ops + sel +
      '<span class="kotei-count">○ ' + s.markers.length + " 個 / 線 " + s.lines.length + " 本</span>";
  };

  KoteiEditor.prototype.renderGrid = function () {
    var self = this;
    var s = this.state();
    var settings = s.settings;
    var days = this.days();
    var rowCount = s.rowCount;
    var gridWidth = ROW_LABEL_WIDTH + days * DAY_COL_WIDTH;
    var gridHeight = HEADER_HEIGHT + rowCount * ROW_HEIGHT;

    this.inner.style.width = gridWidth + "px";
    this.svg.setAttribute("width", gridWidth);
    this.svg.setAttribute("height", gridHeight);
    this.svg.setAttribute("viewBox", "0 0 " + gridWidth + " " + gridHeight);
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    // 日付情報
    var dayInfos = [];
    for (var di = 0; di < days; di++) {
      var day = di + 1;
      dayInfos.push({
        day: day,
        dow: dayOfWeek(settings.year, settings.month, day),
        info: classifyDay(settings.year, settings.month, day, settings)
      });
    }

    // 背景
    this.svg.appendChild(svgEl("rect", { x: 0, y: 0, width: gridWidth, height: HEADER_HEIGHT, fill: "#F0F4F8" }));
    this.svg.appendChild(svgEl("rect", { x: 0, y: HEADER_HEIGHT, width: ROW_LABEL_WIDTH, height: rowCount * ROW_HEIGHT, fill: "#F8FAFC" }));

    // 休日列
    dayInfos.forEach(function (d, i) {
      if (!d.info.isHoliday) return;
      var x = ROW_LABEL_WIDTH + i * DAY_COL_WIDTH;
      var fill = (d.info.source === "jp" || d.info.source === "custom") ? "#FEE2E2" : (d.dow === 0 ? "#FEF1F2" : "#F1F5FE");
      self.svg.appendChild(svgEl("rect", { x: x, y: 0, width: DAY_COL_WIDTH, height: gridHeight, fill: fill }));
    });

    // グリッド線
    for (var r = 0; r <= rowCount; r++) {
      this.svg.appendChild(svgEl("line", { x1: 0, x2: gridWidth, y1: HEADER_HEIGHT + r * ROW_HEIGHT, y2: HEADER_HEIGHT + r * ROW_HEIGHT, stroke: "#E2E8F0", "stroke-width": 1 }));
    }
    for (var v = 0; v <= days; v++) {
      this.svg.appendChild(svgEl("line", { x1: ROW_LABEL_WIDTH + v * DAY_COL_WIDTH, x2: ROW_LABEL_WIDTH + v * DAY_COL_WIDTH, y1: 0, y2: gridHeight, stroke: "#E2E8F0", "stroke-width": 1 }));
    }
    this.svg.appendChild(svgEl("line", { x1: ROW_LABEL_WIDTH, x2: ROW_LABEL_WIDTH, y1: 0, y2: gridHeight, stroke: "#94A3B8", "stroke-width": 1.5 }));
    this.svg.appendChild(svgEl("line", { x1: 0, x2: gridWidth, y1: HEADER_HEIGHT, y2: HEADER_HEIGHT, stroke: "#94A3B8", "stroke-width": 1.5 }));

    // 日付ヘッダ
    dayInfos.forEach(function (d, i) {
      var x = ROW_LABEL_WIDTH + i * DAY_COL_WIDTH + DAY_COL_WIDTH / 2;
      var isJpC = d.info.source === "jp" || d.info.source === "custom";
      var dowFill = isJpC ? "#B91C1C" : (d.dow === 0 ? "#B91C1C" : (d.dow === 6 ? "#1D4ED8" : "#475569"));
      var numFill = isJpC ? "#B91C1C" : "#1E293B";
      var t1 = svgEl("text", { x: x, y: 14, "text-anchor": "middle", "font-size": 11, fill: numFill, "font-weight": 600 });
      t1.textContent = d.day;
      self.svg.appendChild(t1);
      var t2 = svgEl("text", { x: x, y: 28, "text-anchor": "middle", "font-size": 10, fill: dowFill });
      t2.textContent = dayLabel(d.dow);
      if (d.info.label) { var ti = svgEl("title"); ti.textContent = d.info.label; t2.appendChild(ti); }
      self.svg.appendChild(t2);
    });

    // セルクリック領域
    for (var ri = 0; ri < rowCount; ri++) {
      for (var dj = 0; dj < days; dj++) {
        (function (ri, day) {
          var cell = svgEl("rect", {
            x: ROW_LABEL_WIDTH + (day - 1) * DAY_COL_WIDTH, y: HEADER_HEIGHT + ri * ROW_HEIGHT,
            width: DAY_COL_WIDTH, height: ROW_HEIGHT, fill: "transparent"
          });
          cell.style.cursor = self.dragSourceId ? "default" : "pointer";
          cell.addEventListener("click", function () {
            if (self.dragSourceId) return;
            // タッチで○選択中に空き場所をタップ＝選択解除（マーカー設置はしない）
            if (self.isTouch && self.selectedMarkerId !== null) { self.clearSelection(); return; }
            self.toggleMarker(ri, day);
          });
          self.svg.appendChild(cell);
        })(ri, dj + 1);
      }
    }

    // 線
    s.lines.forEach(function (l) {
      var f = self.markerXY(l.fromMarkerId), t = self.markerXY(l.toMarkerId);
      if (!f || !t) return;
      var d = linePath(f.x, f.y, t.x, t.y);
      var mid = lineMidpoint(f.x, f.y, t.x, t.y);
      var hit = svgEl("path", { d: d, stroke: "transparent", "stroke-width": self.isTouch ? 20 : 14, fill: "none" });
      hit.style.cursor = "pointer";
      hit.addEventListener("click", function (e) {
        e.stopPropagation();
        if (self.isTouch) { self.removeLine(l.id); }
        else { self.editLineLabel(l.id); }
      });
      hit.addEventListener("contextmenu", function (e) { self.openContextMenu("line", l.id, e); });
      self.svg.appendChild(hit);
      var path = svgEl("path", { d: d, stroke: COLOR_HEX[l.color], "stroke-width": 2.2, fill: "none" });
      path.style.pointerEvents = "none";
      self.svg.appendChild(path);
      if (l.label) {
        var rect = svgEl("rect", { x: mid.x - l.label.length * 4 - 4, y: mid.y - 14, width: l.label.length * 8 + 8, height: 14, fill: "white", stroke: COLOR_HEX[l.color], "stroke-opacity": 0.3 });
        rect.style.pointerEvents = "none";
        self.svg.appendChild(rect);
        var txt = svgEl("text", { x: mid.x, y: mid.y - 3, "text-anchor": "middle", "font-size": 10, fill: COLOR_HEX[l.color], "font-weight": 600 });
        txt.style.pointerEvents = "none";
        txt.textContent = l.label;
        self.svg.appendChild(txt);
      }
    });

    // ドラッグゴースト
    if (this.dragSourceId && this.pointer) {
      var src = this.markerXY(this.dragSourceId);
      if (src) {
        var g = svgEl("path", { d: ghostPath(src.x, src.y, this.pointer.x, this.pointer.y), stroke: COLOR_HEX[this.color], "stroke-width": 2, "stroke-dasharray": "4 3", fill: "none" });
        g.style.pointerEvents = "none";
        this.svg.appendChild(g);
      }
    }

    // マーカー
    s.markers.filter(function (m) { return m.rowIndex < rowCount && m.day >= 1 && m.day <= days; }).forEach(function (m) {
      var xy = self.markerXY(m.id);
      if (!xy) return;
      var isDragging = self.dragSourceId === m.id;
      var isSelected = self.selectedMarkerId === m.id;
      // タッチ2タップ結線：選択中○に目立つリングを描く
      if (isSelected) {
        var ring = svgEl("circle", {
          cx: xy.x, cy: xy.y, r: MARKER_RADIUS + 5,
          fill: "rgba(25,118,210,0.12)", stroke: "#1976D2", "stroke-width": 2.5
        });
        ring.style.pointerEvents = "none";
        self.svg.appendChild(ring);
      }
      var c = svgEl("circle", {
        cx: xy.x, cy: xy.y, r: (isDragging || isSelected) ? MARKER_RADIUS + 1.5 : MARKER_RADIUS,
        fill: "#fff", stroke: isSelected ? "#1976D2" : COLOR_HEX[m.color], "stroke-width": (isDragging || isSelected) ? 3 : 2.5
      });
      c.style.cursor = self.dragSourceId ? "crosshair" : "pointer";
      c.addEventListener("mouseenter", function () { if (!isSelected) { c.setAttribute("r", MARKER_RADIUS + 1.5); c.setAttribute("stroke-width", 3); } });
      c.addEventListener("mouseleave", function () { if (self.dragSourceId !== m.id && !isSelected) { c.setAttribute("r", MARKER_RADIUS); c.setAttribute("stroke-width", 2.5); } });
      if (!self.isTouch) {
        // PC：従来のドラッグ結線を維持
        c.addEventListener("mousedown", function (e) { self.onMarkerDown(m.id, e); });
        c.addEventListener("mouseup", function (e) { self.onMarkerUp(m.id, e); });
      }
      c.addEventListener("click", function (e) { self.onMarkerClick(m.id, e); });
      c.addEventListener("contextmenu", function (e) { self.openContextMenu("marker", m.id, e); });
      self.svg.appendChild(c);
    });

    // 段ラベル
    this.labelLayer.style.top = HEADER_HEIGHT + "px";
    this.labelLayer.style.width = ROW_LABEL_WIDTH + "px";
    this.labelLayer.innerHTML = "";
    var _self = this;
    for (var li = 0; li < rowCount; li++) {
      (function (idx) {
        var row = s.rows.filter(function (rr) { return rr.index === idx; })[0];
        var wrap = document.createElement("div");
        wrap.className = "kotei-label-cell";
        wrap.style.height = ROW_HEIGHT + "px";
        var inp = document.createElement("input");
        inp.type = "text";
        inp.value = (row && row.label) || "";
        inp.placeholder = "段" + (idx + 1);
        inp.className = "kotei-label-input";
        inp.addEventListener("change", function () { _self.setRowLabel(idx, inp.value); });
        wrap.appendChild(inp);
        _self.labelLayer.appendChild(wrap);
      })(li);
    }
  };

  /* ---------- ポインタ操作 ---------- */
  KoteiEditor.prototype.onSvgMove = function (e) {
    if (!this.dragSourceId) return;
    var pt = this.svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    var ctm = this.svg.getScreenCTM();
    if (!ctm) return;
    var cur = pt.matrixTransform(ctm.inverse());
    this.pointer = { x: cur.x, y: cur.y };
    this.renderGrid();
  };
  KoteiEditor.prototype.onSvgUp = function () {
    if (this.dragSourceId) { this.dragSourceId = null; this.pointer = null; this.renderGrid(); }
  };
  KoteiEditor.prototype.onMarkerDown = function (id, e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.dragSourceId = id;
    this.pointer = this.markerXY(id);
    this._dragMoved = false;
    this.renderGrid();
  };
  KoteiEditor.prototype.onMarkerUp = function (id, e) {
    e.stopPropagation();
    if (this.dragSourceId && this.dragSourceId !== id) {
      this.addLine(this.dragSourceId, id);
      this.dragSourceId = null; this.pointer = null;
    } else if (this.dragSourceId === id) {
      this.dragSourceId = null; this.pointer = null;
      this.renderGrid();
    }
  };
  KoteiEditor.prototype.onMarkerClick = function (id, e) {
    e.stopPropagation();
    if (this.isTouch) {
      // タッチ＝2タップ結線
      if (this.selectedMarkerId === null) {
        // 1つ目を選択
        this.selectedMarkerId = id;
        this.render();
      } else if (this.selectedMarkerId === id) {
        // 同じ○を再タップ＝選択解除
        this.selectedMarkerId = null;
        this.render();
      } else {
        // 2つ目＝結線して選択解除
        var fromId = this.selectedMarkerId;
        this.selectedMarkerId = null;
        this.addLine(fromId, id); // addLine内でcommit→render
        this.render(); // selectedMarkerIdクリアの反映（addLineが重複等でcommitしない場合の保険）
      }
      return;
    }
    // PC：ドラッグで線を引いた直後はremoveしない。dragSourceIdが既にnullなら純粋クリック=削除
    if (!this.dragSourceId) this.removeMarker(id);
  };

  // 別の場所（空セル・SVG背景）タップで選択解除
  KoteiEditor.prototype.clearSelection = function () {
    if (this.selectedMarkerId !== null) {
      this.selectedMarkerId = null;
      this.render();
    }
  };
  KoteiEditor.prototype.editLineLabel = function (id) {
    var line = this.state().lines.filter(function (l) { return l.id === id; })[0];
    var next = window.prompt("線のラベルを入力", (line && line.label) || "");
    if (next !== null) this.setLineLabel(id, next);
  };

  /* ---------- コンテキストメニュー ---------- */
  KoteiEditor.prototype.openContextMenu = function (kind, id, e) {
    e.preventDefault();
    e.stopPropagation();
    this.closeContextMenu();
    var self = this;
    var menu = document.createElement("div");
    menu.className = "kotei-ctxmenu";
    menu.style.left = e.clientX + "px";
    menu.style.top = e.clientY + "px";
    menu.addEventListener("click", function (ev) { ev.stopPropagation(); });

    var head = document.createElement("div");
    head.className = "kotei-ctx-head";
    head.textContent = kind === "line" ? "線の操作" : "○の操作";
    menu.appendChild(head);

    var colorRow = document.createElement("div");
    colorRow.className = "kotei-ctx-colors";
    var lbl = document.createElement("span");
    lbl.textContent = "色:";
    colorRow.appendChild(lbl);
    ["black", "red", "blue"].forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "kotei-ctx-color";
      b.style.backgroundColor = COLOR_HEX[c];
      b.addEventListener("click", function () {
        if (kind === "line") self.setLineColor(id, c); else self.setMarkerColor(id, c);
        self.closeContextMenu();
      });
      colorRow.appendChild(b);
    });
    menu.appendChild(colorRow);

    if (kind === "line") {
      var labelBtn = document.createElement("button");
      labelBtn.type = "button";
      labelBtn.className = "kotei-ctx-item";
      labelBtn.textContent = "ラベル編集…";
      labelBtn.addEventListener("click", function () { self.closeContextMenu(); self.editLineLabel(id); });
      menu.appendChild(labelBtn);
    }

    var del = document.createElement("button");
    del.type = "button";
    del.className = "kotei-ctx-item kotei-ctx-del";
    del.textContent = "削除";
    del.addEventListener("click", function () {
      if (kind === "line") self.removeLine(id); else self.removeMarker(id);
      self.closeContextMenu();
    });
    menu.appendChild(del);

    document.body.appendChild(menu);
    this.contextMenu = menu;
  };
  KoteiEditor.prototype.closeContextMenu = function () {
    if (this.contextMenu && this.contextMenu.parentNode) this.contextMenu.parentNode.removeChild(this.contextMenu);
    this.contextMenu = null;
  };

  /* ---------- 休日設定モーダル ---------- */
  KoteiEditor.prototype.openSettings = function () {
    var self = this;
    var s = this.state().settings;
    var overlay = document.createElement("div");
    overlay.className = "kotei-modal-overlay";
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });

    var box = document.createElement("div");
    box.className = "kotei-modal";
    overlay.appendChild(box);

    box.innerHTML =
      '<header class="kotei-modal-head"><h3>休日設定</h3><button type="button" class="kotei-modal-close" aria-label="閉じる">✕</button></header>' +
      '<section class="kotei-modal-body">' +
      '<label class="kotei-chk"><input type="checkbox" data-key="satHoliday">土曜日を休日扱いにする</label>' +
      '<label class="kotei-chk"><input type="checkbox" data-key="sunHoliday">日曜日を休日扱いにする</label>' +
      '<label class="kotei-chk"><input type="checkbox" data-key="jpHoliday">日本の祝日を休日扱いにする</label>' +
      '<div class="kotei-custom-title">カスタム休日</div>' +
      '<ul class="kotei-custom-list"></ul>' +
      '<div class="kotei-custom-add"><input type="date" class="kotei-cd-date"><input type="text" class="kotei-cd-label" placeholder="ラベル（任意）"><button type="button" class="kotei-cd-add kotei-btn">追加</button></div>' +
      '</section>' +
      '<footer class="kotei-modal-foot"><button type="button" class="kotei-btn kotei-modal-ok">閉じる</button></footer>';

    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    box.querySelector(".kotei-modal-close").addEventListener("click", close);
    box.querySelector(".kotei-modal-ok").addEventListener("click", close);

    ["satHoliday", "sunHoliday", "jpHoliday"].forEach(function (key) {
      var cb = box.querySelector('input[data-key="' + key + '"]');
      cb.checked = !!s[key];
      cb.addEventListener("change", function () { self.setSettingFlag(key, cb.checked); });
    });

    function renderCustom() {
      var ul = box.querySelector(".kotei-custom-list");
      var list = self.state().settings.customHolidays || [];
      ul.innerHTML = "";
      if (list.length === 0) {
        var li = document.createElement("li");
        li.className = "kotei-custom-empty";
        li.textContent = "未登録";
        ul.appendChild(li);
        return;
      }
      list.forEach(function (c) {
        var li = document.createElement("li");
        li.className = "kotei-custom-item";
        var d = document.createElement("span"); d.className = "kotei-cd-show-date"; d.textContent = c.date;
        var lb = document.createElement("span"); lb.className = "kotei-cd-show-label"; lb.textContent = c.label || "(休日)";
        var rm = document.createElement("button"); rm.type = "button"; rm.className = "kotei-cd-rm"; rm.textContent = "削除";
        rm.addEventListener("click", function () { self.removeCustomHoliday(c.date); renderCustom(); });
        li.appendChild(d); li.appendChild(lb); li.appendChild(rm);
        ul.appendChild(li);
      });
    }
    renderCustom();

    box.querySelector(".kotei-cd-add").addEventListener("click", function () {
      var dt = box.querySelector(".kotei-cd-date").value;
      var lb = box.querySelector(".kotei-cd-label").value;
      if (!dt) return;
      self.addCustomHoliday(dt, lb);
      box.querySelector(".kotei-cd-date").value = "";
      box.querySelector(".kotei-cd-label").value = "";
      renderCustom();
    });

    document.body.appendChild(overlay);
  };

  /* ---------- JSON 入出力 ---------- */
  KoteiEditor.prototype.exportJson = function () {
    var data = JSON.stringify(this.state(), null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "kotei-skk5-q3-" + this.tsStamp() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };
  KoteiEditor.prototype.importJson = function (e) {
    var self = this;
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        self.commit(normalizeState(parsed), true); // 履歴リセット
      } catch (err) {
        window.alert("JSONの読込に失敗しました：" + err.message);
      }
      self.fileInput.value = "";
    };
    reader.readAsText(file);
  };

  /* ---------- PNG 出力（外部ライブラリ無し） ---------- */
  KoteiEditor.prototype.exportPng = function () {
    var self = this;
    var s = this.state();
    var days = this.days();
    var gridWidth = ROW_LABEL_WIDTH + days * DAY_COL_WIDTH;
    var gridHeight = HEADER_HEIGHT + s.rowCount * ROW_HEIGHT;

    // SVGクローン＋段ラベルをSVG textとして焼き込む（HTML input はSVGに乗らないため）
    var cloneSvg = this.svg.cloneNode(true);
    cloneSvg.setAttribute("xmlns", SVGNS);
    cloneSvg.setAttribute("width", gridWidth);
    cloneSvg.setAttribute("height", gridHeight);
    // 背景白を最下層に
    var bg = svgEl("rect", { x: 0, y: 0, width: gridWidth, height: gridHeight, fill: "#ffffff" });
    cloneSvg.insertBefore(bg, cloneSvg.firstChild);
    // 段ラベル焼き込み
    s.rows.forEach(function (row) {
      if (row.index >= s.rowCount) return;
      var label = row.label || ("段" + (row.index + 1));
      var t = svgEl("text", {
        x: 6, y: HEADER_HEIGHT + row.index * ROW_HEIGHT + ROW_HEIGHT / 2 + 4,
        "font-size": 11, fill: row.label ? "#1E293B" : "#94A3B8",
        "font-family": "sans-serif"
      });
      t.textContent = label;
      cloneSvg.appendChild(t);
    });

    var svgData = new XMLSerializer().serializeToString(cloneSvg);
    var svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    var url = URL.createObjectURL(svgBlob);
    var img = new Image();
    img.onload = function () {
      var scale = 2; // 高解像度
      var canvas = document.createElement("canvas");
      canvas.width = gridWidth * scale;
      canvas.height = gridHeight * scale;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      var a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = "kotei-skk5-q3-" + self.tsStamp() + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      window.alert("PNG出力に失敗しました。お手数ですが画面のスクリーンショットをご利用ください。");
    };
    img.src = url;
  };

  KoteiEditor.prototype.tsStamp = function () {
    var d = new Date();
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  };

  /* ---------- 初期化 ---------- */
  // テスト/外部からの再利用のため公開（本番動作には影響なし）
  if (typeof window !== "undefined") window.KoteiEditor = KoteiEditor;

  function init() {
    var root = document.getElementById("kotei-editor-root");
    if (!root) return;
    new KoteiEditor(root);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
