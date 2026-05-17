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

  // ====== v0.6: 実Gemini OCR（GAS Web App 呼び出し） ======
  //
  // GAS デプロイ URL を埋め込み or sessionStorage / URLパラメータで上書き可能。
  // 流れ:
  //   1. ?ocrEndpoint=https://script.google.com/...exec で上書き
  //   2. sessionStorage.nagaken_ocr_endpoint があれば次回以降そっち
  //   3. 既定値（後で大関さん側で値差し替え）
  //
  // ?mock=1 が付いていれば常にモック動作（GAS呼ばず ocr-mocks.json を返す）
  //
  const OCR_ENDPOINT_DEFAULT = ""; // 大関さんが GAS デプロイ後に貼る
  const SS_OCR_ENDPOINT = "nagaken_ocr_endpoint";

  function getOcrEndpoint() {
    const qs = new URLSearchParams(location.search);
    const fromQs = qs.get("ocrEndpoint");
    if (fromQs) {
      sessionStorage.setItem(SS_OCR_ENDPOINT, fromQs);
      return fromQs;
    }
    return sessionStorage.getItem(SS_OCR_ENDPOINT) || OCR_ENDPOINT_DEFAULT;
  }
  function isMockForced() {
    const qs = new URLSearchParams(location.search);
    return qs.get("mock") === "1";
  }

  // shots を GAS が期待する形（dataURL）に変換
  function shotsToPayload(shots) {
    if (!shots) return {};
    return {
      paper:   shots.paper?.thumb   || null,
      licence: shots.licence?.thumb || null,
      qualifications: (shots.certs || []).map(c => c.thumb).filter(Boolean),
      face:    shots.face?.thumb    || null, // 参考送信のみ・OCR対象外
    };
  }

  // GAS の results を v0.5/v0.6 フォーマット {licence:{...}, paper:{...}, certs:[]}
  // に変換する。GAS は {fields:{...}} で返してくるので１段剥がす。
  function adaptGasResults(gas) {
    if (!gas) return { licence: {}, paper: {}, certs: [] };
    const out = { licence: {}, paper: {}, certs: [] };
    if (gas.licence && gas.licence.fields) out.licence = gas.licence.fields;
    if (gas.paper   && gas.paper.fields)   out.paper   = gas.paper.fields;
    if (Array.isArray(gas.qualifications)) {
      out.certs = gas.qualifications.map(q => ({
        kind: q.type || "不明",
        confidence: q.confidence || "mid",
        fields: (q.fields || {}),
      }));
    }
    return out;
  }

  async function runRealOcr(id) {
    const items = list();
    const idx = items.findIndex((x) => x.id === id);
    if (idx < 0) return { ok: false, error: "draft not found" };

    const draft = items[idx];

    // モック強制 or エンドポイント未設定なら mock fallback
    const endpoint = getOcrEndpoint();
    if (isMockForced() || !endpoint) {
      const updated = await runMockOcr(id);
      return {
        ok: true,
        item: updated,
        usedMock: true,
        endpoint: endpoint || "(未設定)",
      };
    }

    const payload = {
      provId: id,
      shots: shotsToPayload(draft.shots),
    };

    // 60秒タイムアウト
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        // GAS Web App は標準で text/plain でも application/json でも受けるが
        // CORS preflight 回避のため text/plain にしておく（GAS側は contentText を JSON.parse）
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!res.ok || !json || json.ok === false) {
        // フォールバック: モックで埋める
        const updated = await runMockOcr(id);
        return {
          ok: false,
          error: (json && json.error) || `HTTP ${res.status}`,
          fallbackToMock: true,
          item: updated,
          rawText: text.slice(0, 500),
        };
      }
      // 成功 → ストア更新
      const adapted = adaptGasResults(json.results);
      items[idx].ocrResult = adapted;
      items[idx].status = "OCR_REVIEWING";
      items[idx].ocrElapsedMs = json.elapsedMs || null;
      items[idx].ocrUsedEndpoint = endpoint;
      items[idx].updatedAt = new Date().toISOString();
      save(items);
      return { ok: true, item: items[idx], elapsedMs: json.elapsedMs, usedMock: false };
    } catch (e) {
      clearTimeout(timer);
      // ネットワークエラー等 → モックフォールバック
      const updated = await runMockOcr(id);
      return {
        ok: false,
        error: String(e && e.message || e),
        fallbackToMock: true,
        item: updated,
      };
    }
  }

  function setOcrEndpoint(url) {
    if (url) sessionStorage.setItem(SS_OCR_ENDPOINT, url);
    else sessionStorage.removeItem(SS_OCR_ENDPOINT);
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
    // v0.6: 実 OCR（Gemini 2.5 Flash via GAS）
    runRealOcr, getOcrEndpoint, setOcrEndpoint, isMockForced,
  };
})();
