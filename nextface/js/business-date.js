// JST 05:00 境界の業務日ユーティリティ（ブラウザ用）
// window.businessDate.today() -> "YYYY-MM-DD"
(function () {
  const JST_DAY_BOUNDARY_HOUR = 5;
  const SHIFT_HOURS = 9 - JST_DAY_BOUNDARY_HOUR; // 4

  function fromDate(at) {
    const d = at instanceof Date ? at : (at == null ? new Date() : new Date(at));
    const shifted = new Date(d.getTime() + SHIFT_HOURS * 3600000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const day = String(shifted.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function shiftDays(yyyymmdd, delta) {
    const [y, m, d] = yyyymmdd.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  }

  function nextBusinessDay(at) {
    let s = shiftDays(fromDate(at), 1);
    while (true) {
      const [y, m, d] = s.split("-").map(Number);
      const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (w !== 0 && w !== 6) return s;
      s = shiftDays(s, 1);
    }
  }

  window.businessDate = {
    BOUNDARY_HOUR: JST_DAY_BOUNDARY_HOUR,
    today: () => fromDate(new Date()),
    of: fromDate,
    shift: shiftDays,
    nextBusinessDay,
  };
})();
