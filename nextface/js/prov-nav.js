/* prov-nav.js — 4画面共通の画面遷移リンク解決ヘルパー（v0.5+）
 *
 * パンくず flow-steps を <a class="step" data-step="1|2|3|4"> 化した上で、
 * ① 仮登録 / ② OCRレビュー / ③ 22項目最終確認 / ④ 正式投入 への遷移先を解決する。
 *
 * id 解決ルール（??auto）:
 *   - URLパラの ?id=... を最優先
 *   - 無ければ ProvStore.list() から fallback で最初の1件を選ぶ
 *     ② レビュー  : PROVISIONAL_DRAFT > OCR_REVIEWING > ACTIVE
 *     ③ データ投入: OCR_REVIEWING > ACTIVE > PROVISIONAL_DRAFT
 *
 * ④ 正式投入は ACTIVE 行の data-entry を閲覧モードで開く（無ければダッシュボードに戻る）
 */
(function () {
  "use strict";

  function currentId() {
    const qs = new URLSearchParams(location.search);
    return qs.get("id") || sessionStorage.getItem("currentProvId") || null;
  }

  function pickByStatus(order) {
    if (!window.ProvStore) return null;
    const all = ProvStore.list();
    for (const st of order) {
      const hit = all.find((x) => x.status === st);
      if (hit) return hit.id;
    }
    return all[0]?.id || null;
  }

  function resolveStep(step) {
    const id = currentId();
    switch (step) {
      case "1":
        return "/provisional-entry.html";
      case "2": {
        const target =
          id ||
          pickByStatus(["PROVISIONAL_DRAFT", "OCR_REVIEWING", "ACTIVE"]);
        return target
          ? `/provisional-review.html?id=${encodeURIComponent(target)}`
          : "/provisional-dashboard.html";
      }
      case "3": {
        const target =
          id || pickByStatus(["OCR_REVIEWING", "ACTIVE", "PROVISIONAL_DRAFT"]);
        return target
          ? `/provisional-data-entry.html?id=${encodeURIComponent(target)}`
          : "/provisional-dashboard.html";
      }
      case "4": {
        // ④ は ACTIVE 行があれば閲覧モードで開く、無ければダッシュボード
        const target = pickByStatus(["ACTIVE"]);
        return target
          ? `/provisional-data-entry.html?id=${encodeURIComponent(target)}`
          : "/provisional-dashboard.html";
      }
      default:
        return "/provisional-dashboard.html";
    }
  }

  async function init() {
    if (window.ProvStore?.ensureSeed) {
      try { await ProvStore.ensureSeed(); } catch (_) {}
    }
    document.querySelectorAll(".flow-steps a.step[data-step]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const step = a.dataset.step;
        const href = resolveStep(step);
        location.href = href;
      });
      // 視覚的なhrefも一応セット（クリック時は上書き）
      a.setAttribute("href", "#");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 外部公開（テスト用）
  window.ProvNav = { resolveStep, currentId };
})();
