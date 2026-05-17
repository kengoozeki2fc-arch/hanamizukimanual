/* prov-nav.js — v0.6 ハブ&スポーク構成
 *
 * v0.5 までは パンくず4ステップ（仮登録→OCRレビュー→22項目→正式投入）のリンク解決を担当していたが、
 * v0.6 ではパンくずDOM自体を全画面から廃止したため、本ファイルは
 * 「ダッシュボードに戻る」「メニューに戻る」等の単純戻りリンクのみ補助する。
 *
 * 実体としては各画面の <div class="prov-nav"> 内の <a class="prov-nav-btn"> リンクは
 * HTML の href 属性で完結している。本ファイルは将来 sessionStorage の currentProvId を
 * 戻りリンクに渡す等の拡張用フックを置いておく。
 */
(function () {
  "use strict";

  function currentId() {
    const qs = new URLSearchParams(location.search);
    return qs.get("id") || sessionStorage.getItem("currentProvId") || null;
  }

  async function init() {
    if (window.ProvStore?.ensureSeed) {
      try { await ProvStore.ensureSeed(); } catch (_) {}
    }
    // 旧パンくずDOM（v0.5 以前の遺物）が残っていた場合のフェイルセーフ：非表示にする
    document.querySelectorAll(".flow-steps").forEach(el => { el.style.display = "none"; });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // 外部公開（テスト用）
  window.ProvNav = { currentId };
})();
