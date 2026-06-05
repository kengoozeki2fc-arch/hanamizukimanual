/* 本登録済み作業員ストア（＝「既存テーブル」）v0.1
 *
 * フロー図の「既存テーブル（本登録済み作業員）」を localStorage で再現するモック。
 * - 仮登録ストア（ProvStore＝新規テーブル）から本社ダッシュボードで OCR本登録（昇格）されると
 *   ここに 1件 追加される（ProvStore 側は status=REGISTERED にして仮入場者リストから外す）。
 * - 現場ダッシュボード site-dashboard.html はこのストアを参照して入退場状況を表示する。
 *
 * 将来は RegisteredWorker テーブル（本登録済み作業員）＋ OnsiteTagRelation 入退場ログへ差し替え想定。
 *
 * localStorage を使う（ProvStore は sessionStorage だが、本登録済みは
 * タブをまたいで残ってほしい本番テーブル相当なので localStorage で永続化する）。
 *
 * Worker レコード:
 *   {
 *     workerId, name, nameKana, company, occupation, phone,
 *     certs: [string],          // 保有資格名の配列（OCR結果から）
 *     bloodType, birthday,
 *     onsiteId, onsiteName,     // 本登録時に本社が割当てた所属現場
 *     provId,                   // 昇格元の仮登録ドラフトID（トレース用）
 *     registeredAt,             // 本登録（昇格）日時 ISO
 *     // 入退場（モック）：当日の入退場状況。実運用は別ログテーブル。
 *     attendance: { date: "YYYY-MM-DD", inAt: ISO|null, outAt: ISO|null } | null
 *   }
 */
(function () {
  "use strict";
  const LS_KEY = "nagaken_workers_v1";

  function list() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function save(items) {
    localStorage.setItem(LS_KEY, JSON.stringify(items));
  }
  function getById(id) {
    return list().find((x) => x.workerId === id) || null;
  }
  function listBySite(onsiteId) {
    const n = Number(onsiteId);
    return list().filter((x) => Number(x.onsiteId) === n);
  }

  function newWorkerId() {
    return "wk-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  // 仮登録ドラフト＋本社で確認したOCRフィールドから本登録レコードを作る（＝昇格）
  //   provItem : ProvStore のドラフト1件
  //   fields   : { name, nameKana, company, occupation, certs:[], bloodType, birthday }
  //   site     : { onsiteId, name } 本社が割当てた所属現場
  function promote(provItem, fields, site) {
    const items = list();
    const worker = {
      workerId: newWorkerId(),
      name: fields.name || "(氏名不明)",
      nameKana: fields.nameKana || "",
      company: fields.company || "",
      occupation: fields.occupation || "",
      phone: provItem.phone || "",
      certs: Array.isArray(fields.certs) ? fields.certs : [],
      bloodType: fields.bloodType || "",
      birthday: fields.birthday || "",
      onsiteId: site ? Number(site.onsiteId) : null,
      onsiteName: site ? site.name : "",
      provId: provItem.id,
      registeredAt: new Date().toISOString(),
      attendance: null,
    };
    items.unshift(worker);
    save(items);
    return worker;
  }

  function clearAll() {
    localStorage.removeItem(LS_KEY);
  }

  window.WorkerStore = {
    list, save, getById, listBySite, newWorkerId, promote, clearAll, LS_KEY,
  };
})();
