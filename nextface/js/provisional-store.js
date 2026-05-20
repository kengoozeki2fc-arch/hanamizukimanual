/* 顔認証初期登録フロー v0.5 共通ストア
   sessionStorage で 4画面間のデータ受け渡しを行う。
   将来 ProvisionalRegistration テーブルへの差し替えを意識し、
   provisional-mocks.json と同じスキーマで読み書きする。
   v0.5 追加：
     - ログインUser／所属現場マスタを sessionStorage から取得（監督氏名手入力を廃止）
     - URL ?multi=1 で複数現場兼任ユーザーに切替可能（検証用） */
(function () {
  const LS_KEY = "nagaken_provisional_v04";
  const SS_LOGIN_USER  = "nagaken_login_user";   // { userId, displayName, email }
  const SS_USER_SITES  = "nagaken_user_sites";   // [{ onsiteId, name, clientId, clientName }]
  const SS_SITES_ALL   = "nagaken_sites_all";    // 全現場マスタキャッシュ

  // 起動時：sessionStorage が空ならモックJSONをロード
  async function ensureSeed() {
    const raw = sessionStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
    try {
      const res = await fetch("/data/provisional-mocks.json");
      const json = await res.json();
      sessionStorage.setItem(LS_KEY, JSON.stringify(json.items || []));
      return json.items || [];
    } catch (e) {
      console.warn("provisional-mocks.json 読み込み失敗。空配列で起動", e);
      sessionStorage.setItem(LS_KEY, "[]");
      return [];
    }
  }

  // ====== v0.5: ログインUser／現場マスタ ======
  // /data/sites-mock.json をロード（キャッシュ可）
  async function loadSitesMock() {
    const cached = sessionStorage.getItem(SS_SITES_ALL);
    if (cached) return JSON.parse(cached);
    try {
      const res = await fetch("/data/sites-mock.json");
      const j = await res.json();
      sessionStorage.setItem(SS_SITES_ALL, JSON.stringify(j));
      return j;
    } catch (e) {
      console.warn("sites-mock.json 読み込み失敗。デフォルト値で起動", e);
      return { sites: [], users: [] };
    }
  }

  // 起動時に呼び：ログインUserと所属現場を sessionStorage に積む。
  // - sessionStorage.nagaken_login_user が既にあればそれを尊重（手動上書き運用可）
  // - URL `?multi=1` で起動された場合は test-foreman-multi（3現場）を採用
  // - それ以外は test-foreman-yamada（1現場固定）を採用
  async function ensureLoginContext() {
    const data = await loadSitesMock();
    const qs   = new URLSearchParams(location.search);
    const multi = qs.get("multi") === "1";

    let user = null;
    const rawUser = sessionStorage.getItem(SS_LOGIN_USER);
    if (rawUser) {
      try { user = JSON.parse(rawUser); } catch { user = null; }
    }
    if (!user) {
      const target = multi ? "test-foreman-multi" : "test-foreman-yamada";
      const u = (data.users || []).find(x => x.userId === target)
             || (data.users || [])[0]
             || { userId: "test-foreman", displayName: "監督A（test-foreman）", email: "", siteIds: [] };
      user = { userId: u.userId, displayName: u.displayName, email: u.email || "" };
      sessionStorage.setItem(SS_LOGIN_USER, JSON.stringify(user));
    }

    // ユーザーの所属現場を解決（master が users 内 siteIds でも、上書き sessionStorage でも可）
    let userSites = [];
    const rawSites = sessionStorage.getItem(SS_USER_SITES);
    if (rawSites) {
      try { userSites = JSON.parse(rawSites); } catch { userSites = []; }
    }
    if (!userSites.length) {
      const u = (data.users || []).find(x => x.userId === user.userId);
      const siteIds = u?.siteIds || [];
      userSites = (data.sites || []).filter(s => siteIds.includes(s.onsiteId));
      // fallback：所属が解決できなければ全件
      if (!userSites.length) userSites = (data.sites || []).slice(0, 1);
      sessionStorage.setItem(SS_USER_SITES, JSON.stringify(userSites));
    }
    return { user, sites: userSites };
  }

  function getLoginUser() {
    const raw = sessionStorage.getItem(SS_LOGIN_USER);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  function getUserSites() {
    const raw = sessionStorage.getItem(SS_USER_SITES);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  function list() {
    const raw = sessionStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  }

  function save(items) {
    sessionStorage.setItem(LS_KEY, JSON.stringify(items));
  }

  function getById(id) {
    return list().find((x) => x.id === id) || null;
  }

  function upsert(item) {
    const items = list();
    const idx = items.findIndex((x) => x.id === item.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...item, updatedAt: new Date().toISOString() };
    else items.unshift({ ...item, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    save(items);
    return item;
  }

  function setStatus(id, status) {
    const items = list();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    items[idx].status = status;
    items[idx].updatedAt = new Date().toISOString();
    save(items);
    return items[idx];
  }

  // モックOCR：仮登録ドラフトから OCR_REVIEWING へ昇格させる時に呼ぶ
  // 実運用では Azure Functions の Gemini Flash 呼び出しに置換
  async function runMockOcr(id) {
    const items = list();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    try {
      const res = await fetch("/data/ocr-mocks.json");
      const j = await res.json();
      // デフォルトOCR結果テンプレートを流し込み（電話番号と顔写真は本人入力のため上書きしない）
      items[idx].ocrResult = j.defaultResult;
      items[idx].status = "OCR_REVIEWING";
      items[idx].updatedAt = new Date().toISOString();
      save(items);
      return items[idx];
    } catch (e) {
      console.warn("ocr-mocks.json 読み込み失敗", e);
      return null;
    }
  }

  // 実OCR呼出（GAS Web App）
  //   mode: 'v1' (現行スキーマ縛り版) | 'v2' (2段化版) | 'compare' (V1/V2比較)
  //   feedback_gemini_ocr_paper_form_lessons の学び検証用
  //   CORS: Content-Type=text/plain で simple request 化（preflight回避）
  const NAGAKEN_GAS_OCR_URL = "https://script.google.com/macros/s/AKfycbwgVHVYmlzYvsjnSLhDmn9Kh8nq5RGBrsgyy3KtGhyFHsyQUBnV7CRecgdPI6fB1RM/exec";

  async function runRealOcr(id, mode) {
    const items = list();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const draft = items[idx];
    const s = draft.shots || {};
    const paperDataUrl = s.paper && s.paper.thumb ? s.paper.thumb : null;
    if (!paperDataUrl) {
      console.warn("runRealOcr: paper shot 不在");
      return null;
    }
    const payload = {
      provId: id,
      mode: mode || 'v1',
      shots: {
        paper: paperDataUrl,
        licence: s.licence && s.licence.thumb ? s.licence.thumb : null,
        qualifications: (s.certs || []).map((c) => c && c.thumb).filter(Boolean),
        face: s.face && s.face.thumb ? s.face.thumb : null,
      },
    };
    try {
      const res = await fetch(NAGAKEN_GAS_OCR_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!j.ok) {
        console.error("GAS OCR error:", j);
        items[idx].ocrError = j.error || "unknown";
        items[idx].updatedAt = new Date().toISOString();
        save(items);
        return items[idx];
      }
      // mode別の結果格納
      //   v1: paperResult = { fields, confidence }
      //   v2: paperResult = { fields, _rawTranscription, _version }
      //   compare: paperResult = { v1, v2, diff, summary, totalElapsedMs }
      items[idx].ocrResult = j.results;
      items[idx].ocrMode = j.mode || mode;
      items[idx].ocrElapsedMs = j.elapsedMs;
      items[idx].status = "OCR_REVIEWING";
      items[idx].updatedAt = new Date().toISOString();
      save(items);
      return items[idx];
    } catch (e) {
      console.error("runRealOcr fetch failed", e);
      items[idx].ocrError = String(e && e.message || e);
      items[idx].updatedAt = new Date().toISOString();
      save(items);
      return items[idx];
    }
  }

  // Azure DI + OpenAI 経路OCR呼出（SWA Functions /api/ocr-di）
  //   GAS版 runRealOcr と payload/レスポンス同一構造（fields lowerCamel）
  //   ocrEngine フィールドで判別可能
  async function runAzureOcr(id, mode) {
    const items = list();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const draft = items[idx];
    const s = draft.shots || {};
    const paperDataUrl = s.paper && s.paper.thumb ? s.paper.thumb : null;
    if (!paperDataUrl) {
      console.warn("runAzureOcr: paper shot 不在");
      return null;
    }
    const payload = {
      provId: id,
      mode: mode || 'v1',
      shots: {
        paper: paperDataUrl,
        licence: s.licence && s.licence.thumb ? s.licence.thumb : null,
        qualifications: (s.certs || []).map((c) => c && c.thumb).filter(Boolean),
        face: s.face && s.face.thumb ? s.face.thumb : null,
      },
    };
    try {
      // manual.kensetsu-total.support/nextface/ など別オリジンから叩く前提で絶対URL固定
      // Content-Type: text/plain;charset=utf-8 で simple request 化＝CORS preflight 回避（GASと同じパターン）
      const res = await fetch("https://gray-moss-06a59c500.2.azurestaticapps.net/api/ocr-di", {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!j.ok) {
        console.error("Azure OCR error:", j);
        items[idx].ocrError = j.error || "unknown";
        items[idx].ocrEngine = "azure-di+openai";
        items[idx].updatedAt = new Date().toISOString();
        save(items);
        return items[idx];
      }
      items[idx].ocrResult = j.results;
      items[idx].ocrMode = j.mode || mode;
      items[idx].ocrEngine = j.engine || "azure-di+openai";
      items[idx].ocrElapsedMs = j.elapsedMs;
      items[idx].status = "OCR_REVIEWING";
      items[idx].updatedAt = new Date().toISOString();
      save(items);
      return items[idx];
    } catch (e) {
      console.error("runAzureOcr fetch failed", e);
      items[idx].ocrError = String(e && e.message || e);
      items[idx].ocrEngine = "azure-di+openai";
      items[idx].updatedAt = new Date().toISOString();
      save(items);
      return items[idx];
    }
  }

  function newDraftId() {
    return "prov-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  // 3段ステータス表示用ラベル
  const STATUS_LABEL = {
    PROVISIONAL_DRAFT: "仮登録（OCR待ち）",
    OCR_REVIEWING: "レビュー待ち",
    ACTIVE: "正式登録済み",
  };
  const STATUS_CLASS = {
    PROVISIONAL_DRAFT: "status-draft",
    OCR_REVIEWING: "status-review",
    ACTIVE: "status-active",
  };

  function statusBadge(status) {
    const label = STATUS_LABEL[status] || status;
    const cls = STATUS_CLASS[status] || "";
    return `<span class="status-badge ${cls}">${label}</span>`;
  }

  // 信頼度バッジ
  const CONF_LABEL = { high: "高", mid: "中", low: "低", fail: "OCR失敗", manual: "手入力" };
  function confBadge(level) {
    const lv = level || "manual";
    return `<span class="confidence-badge conf-${lv}">${CONF_LABEL[lv] || lv}</span>`;
  }

  // 日時フォーマット（JST業務日 5時起算は dashboard.html 既存 business-date.js に従う）
  function fmtDateTime(iso) {
    if (!iso) return "-";
    const d = new Date(iso);
    return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  window.ProvStore = {
    ensureSeed, list, save, getById, upsert, setStatus,
    runMockOcr, runRealOcr, runAzureOcr, newDraftId, statusBadge, confBadge, fmtDateTime,
    STATUS_LABEL,
    // v0.5: ログインUser／現場マスタ
    ensureLoginContext, getLoginUser, getUserSites,
  };
})();
