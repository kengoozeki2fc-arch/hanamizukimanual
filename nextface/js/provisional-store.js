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
      const res = await fetch("/nextface/data/provisional-mocks.json");
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
      const res = await fetch("/nextface/data/sites-mock.json");
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
      const res = await fetch("/nextface/data/ocr-mocks.json");
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
    runMockOcr, newDraftId, statusBadge, confBadge, fmtDateTime,
    STATUS_LABEL,
    // v0.5: ログインUser／現場マスタ
    ensureLoginContext, getLoginUser, getUserSites,
  };
})();
