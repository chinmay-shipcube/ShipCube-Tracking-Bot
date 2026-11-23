// ShipCube Tracking Bot - runs inside the Track123 page before it loads.
// Track123 asks its own server for the results (query-track-nos, then polling-waybill
// every few seconds until every number is done). This file reads those replies and hands
// each tracking number's status to the bot - much more reliable than reading the screen.
(() => {
  if (window.__sctrkHook) return;
  window.__sctrkHook = true;
  const seen = {};          // trackingNo -> latest record (so the bot can ask for everything again)
  const errors = [];
  const isTrackApi = (u) => /\/track\/(query-track-nos|polling-waybill|[a-z-]*track[a-z-]*)/i.test(String(u || "")) && /\/api\//i.test(String(u || ""));

  function latestDetail(list) {
    if (!Array.isArray(list) || !list.length) return null;
    let best = list[0];
    list.forEach((d) => { if (String(d.eventTime || "") > String(best.eventTime || "")) best = d; });
    return best;
  }
  function slim(w) {
    const d = latestDetail(w.localDetails);
    const sub = d && d.transitSubStatus;
    return {
      trackingNo: String(w.trackingNo || "").trim(),
      transitStatus: String(w.transitStatus || ""),
      querying: w.querying === true,
      main: (sub && sub.mainStatus && sub.mainStatus.pageName) || "",
      sub: (sub && sub.pageName) || "",
      deliveryTime: w.deliveryTime || "",
      lastTime: w.lastTrackingTime || (d && d.eventTime) || "",
      lastDesc: w.lastTrackingDetailDesc || w.latestTrackingDesc || (d && (d.eventDetail || d.desc)) || "",
      carrier: w.localProviderEnName || w.localProviderName || "",
      at: Date.now(),
    };
  }
  function handle(url, text) {
    if (!isTrackApi(url) || !text) return;
    let j;
    try { j = typeof text === "string" ? JSON.parse(text) : text; } catch { return; }
    if (!j) return;
    if (j.code && j.code !== "00000") {
      const e = { code: j.code, msg: j.msg || "", url: String(url), at: Date.now() };
      errors.push(e);
      window.postMessage({ __sctrk: "err", err: e }, "*");
      return;
    }
    const d = j.data;
    if (!d || typeof d !== "object") return;
    const lists = [].concat(d.landWaybillLists || [], d.aviationWaybillLists || []);
    if (!lists.length) return;
    const items = lists.map(slim).filter((x) => x.trackingNo);
    items.forEach((x) => { seen[x.trackingNo.toUpperCase()] = x; });
    window.postMessage({ __sctrk: "data", items }, "*");
  }

  // XMLHttpRequest (Track123 uses axios)
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__sctrkUrl = u; return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (isTrackApi(this.__sctrkUrl)) {
      this.addEventListener("load", () => {
        try {
          const t = this.responseType === "" || this.responseType === "text" ? this.responseText : this.response;
          handle(this.responseURL || this.__sctrkUrl, t);
        } catch {}
      });
    }
    return XS.apply(this, arguments);
  };
  // fetch (in case the site switches)
  const F = window.fetch;
  if (F) {
    window.fetch = function (input) {
      const p = F.apply(this, arguments);
      try {
        const u = typeof input === "string" ? input : input && input.url;
        if (isTrackApi(u)) p.then((r) => r.clone().text().then((t) => handle(u, t))).catch(() => {});
      } catch {}
      return p;
    };
  }
  // Track123's toolbar buttons build a text with EVERY number's status + latest event:
  //   "Copy to Excel" (icon-copy_excel): one line per number, tab separated:
  //       TRACKING  origin  destination  2026-10-21 23:00:13  Loaded on Vehicle  Failed  25Day(s)
  //   "copy all" (icon-system_copy): blocks of AWB/Carriers/Status lines (older backup)
  // The bot clicks the button and reads that text - the user's clipboard is left alone.
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || (e.data.__sctrk !== "copyall" && e.data.__sctrk !== "copyxls")) return;
    const xls = e.data.__sctrk === "copyxls", icon = xls ? "icon-copy_excel" : "icon-system_copy";
    // this is one of the bot's own tabs: hide Track123's "Copied" pop-up note so it doesn't flash every time
    if (!document.getElementById("sctrk-nocopied")) { const st = document.createElement("style"); st.id = "sctrk-nocopied"; st.textContent = ".el-message{display:none!important}"; (document.head || document.documentElement).appendChild(st); }
    const btn = [...document.querySelectorAll(`i.${icon}, [class*='${icon}']`)].find((el) => !el.closest(".result-list-item-container") && !el.closest("#sctrk-bot"));
    if (!btn || !navigator.clipboard) { window.postMessage({ __sctrk: "copy", text: null, xls }, "*"); return; }
    const orig = navigator.clipboard.writeText;
    let done = false;
    const finish = (text) => { if (done) return; done = true; try { navigator.clipboard.writeText = orig; } catch {} window.postMessage({ __sctrk: "copy", text, xls }, "*"); };
    try { navigator.clipboard.writeText = function (t) { finish(String(t)); return Promise.resolve(); }; } catch { finish(null); return; }
    try { btn.click(); } catch { finish(null); }
    setTimeout(() => finish(null), 1500);
  });

  // the bot's panel loads a little later - it asks for everything seen so far
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__sctrk !== "replay") return;
    window.postMessage({ __sctrk: "data", items: Object.values(seen), replay: true }, "*");
    errors.forEach((err) => window.postMessage({ __sctrk: "err", err, replay: true }, "*"));
  });
})();
