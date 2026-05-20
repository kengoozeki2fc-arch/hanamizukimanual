// URLの ?onsiteId=X を読んで、.nav 内に現場名バッジを表示する共通JS
(function () {
  const qs = new URLSearchParams(location.search);
  const onsiteId = qs.get("onsiteId");
  if (!onsiteId) return;
  fetch("/api/onsites")
    .then((r) => r.json())
    .then((j) => {
      const o = (j.onsites || []).find((x) => String(x.id) === String(onsiteId));
      if (!o) return;
      const nav = document.querySelector(".nav");
      if (!nav) return;
      const badge = document.createElement("span");
      badge.className = "nav-onsite-badge";
      badge.style.cssText =
        "background:rgba(255,255,255,0.25); color:#fff; padding:4px 10px; border-radius:12px; font-size:12px; font-weight:600; margin-right:6px;";
      badge.textContent = `🏗 ${o.name}`;
      const h3 = nav.querySelector("h3");
      if (h3) h3.insertAdjacentElement("afterend", badge);
      else nav.appendChild(badge);
    })
    .catch(() => {});
})();
