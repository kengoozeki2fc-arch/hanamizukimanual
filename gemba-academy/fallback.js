// 画像が未撮影の場合、プレースホルダに自動置換
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.screenshot img').forEach(function (img) {
    img.addEventListener('error', function () {
      var placeholder = document.createElement('div');
      placeholder.className = 'placeholder-box';
      placeholder.innerHTML = '<span class="placeholder-label">画面イメージ（撮影予定）</span>'
        + '<span class="placeholder-desc">' + (img.alt || '') + '</span>';
      var parent = img.parentNode;
      var caption = parent.querySelector('.caption');
      parent.insertBefore(placeholder, img);
      img.style.display = 'none';
      if (caption) caption.style.display = 'none';
    });
    // 既にエラー状態の画像も処理（キャッシュ対策）
    if (img.complete && img.naturalWidth === 0) {
      img.dispatchEvent(new Event('error'));
    }
  });
});
