// ShipCube Tracking Bot - panel (Google Sheet + Track123) and worker (Track123 tabs)
//   Start reads the whole row range once. Then 1-4 Track123 tabs work AT THE SAME TIME: each one takes
//   the next free 100 numbers from the background's queue, waits until Track123 shows a status for every
//   one, hands the results back and immediately takes the next 100. The background pastes the results
//   into the sheet in big blocks while the tabs keep tracking - nobody waits for anybody.
(() => {
  if (window.top !== window || document.getElementById("sctrk-bot")) return;
  // "side" = Chrome's side panel (click the bot icon) · "track" = a Track123 tab (works in the background, shows a small badge)
  const SITE = window.SCTRK_SIDE ? "side" : /track123\.com$/i.test(location.hostname) ? "track" : /(^|\.)usps\.com$/i.test(location.hostname) ? "usps" : "sheet";
  const WORKS = SITE === "track" || SITE === "usps";    // a tab that tracks numbers (Track123 or usps.com)
  // side panel: the tab open next to it (so "This sheet" works when a Google Sheet is open)
  let sideTab = { url: "", title: "" };
  const here = () => {
    if (SITE !== "side") return { href: location.href, pathname: location.pathname, hash: location.hash, search: location.search, title: document.title };
    try { const u = new URL(sideTab.url || "about:blank"); return { href: u.href, pathname: u.pathname, hash: u.hash, search: u.search, title: sideTab.title || "" }; }
    catch { return { href: "", pathname: "", hash: "", search: "", title: "" }; }
  };
  const onSheet = () => SITE === "sheet" || (SITE === "side" && /^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(sideTab.url || ""));
  const VERSION = chrome.runtime.getManifest().version;
  const CFG_KEY = "sctrk_cfg", UI_KEY = "sctrk_ui", LOG_KEY = "sctrk_log", JOB_KEY = "sctrk_job";
  const VALID_TN = /^[A-Za-z0-9-]{5,50}$/;
  // a status is only used if it is a real status word - never "Day(s)", a number, "Tracking..." or an empty label
  const okStatus = (st) => {
    st = String(st || "").replace(/\s+/g, " ").replace(/^[^A-Za-z]+/, "").replace(/[^A-Za-z)]+$/, "").trim();
    if (!st || st.length > 40 || !/[A-Za-z]{3}/.test(st)) return "";
    if (/day\(s\)|^\d|^(tracking|querying|searching|loading|pending)\b|\.\.\.|…/i.test(st)) return "";
    return st;
  };
  const WAIT_S = 90;    // longest wait for Track123 per batch (security-check time not counted); then the rest is retried at the end
  const DEFAULT_URL = "https://script.google.com/macros/s/AKfycbyG0dzcVvyhZ0dTgKEVz7jS5oCX213Zxnhe9yOgQeQDq2gScNFUodwDVCS6RBAFq1Om/exec";   // shared ShipCube sheet script - used when no link is saved
  const DEFAULTS = {
    url: DEFAULT_URL, token: "shipcube", tab: "",
    colTracking: "", colStatus: "", colT123: "", colDelivered: "", colLast: "", colChecked: "",
    style: "track123", deliveredText: "Delivered", notDeliveredText: "not delivered",
    sheets: [{ name: "Sheet 1", link: "", url: "" }, { name: "Sheet 2", link: "", url: "" }], sheetSel: "page",
    skip: "Delivered, Expired", lightPages: true, savedAt: 0,
    mode: "auto", tabs: 2, from: "", to: "", reverse: false, onlyNF: false, onlyBlank: false, onlyBNF: false,
    useCarrier: true, ownWindow: true, carrierFirst: false, uspsSite: true, uspsTabs: 1, uspsBudget: 3000, uspsPace: "slow", gentle: true, skipFresh: false, freshHours: 12,
    // only the exceptions - every other carrier name is matched to Track123's own carrier list automatically
    carrierMap: "dhl ecommerce = dhlglobalmail\ndhl express = dhl\ndhl = dhlglobalmail\nother = auto",
    // Carrier guess from the tracking-number prefix (used when the Carrier column is empty / missing). "prefix = Track123 code" per line.
    prefixMap: "TBA = Amazon Shipping + Amazon MCF",
    theme: "auto",
    // "USPS only" runs: which numbers belong on usps.com. carrier = number prefixes (comma separated, 1-8 = digits 1 to 8)
    uspsFilter: "usps = 9\nusps modem = 9\nendicia = 9\nshippo usps = 9\namazon shipping api v2 = TBA\ndhl ecommerce = 1-8\nuniuni = U\nups = 1Z",
    db: false, dbUrl: "", dbApiKey: "", dbEmail: "",
  };
  const STATUS = {
    DELIVERED: "Delivered", IN_TRANSIT: "In transit", INFO_RECEIVED: "Info received", WAITING_DELIVERY: "Out for delivery",
    DELIVERY_FAILED: "Failed attempt", ABNORMAL: "Exception", EXCEPTION: "Exception", EXPIRED: "Expired",
    NO_RECORD: "Not found", NOT_FOUND: "Not found",
    BOOKED: "Booked", RECEIVED: "Received", ARRIVED: "Arrived", NOTIFIED: "Notified",
  };
  // worker tabs wait with the background's clock: Chrome slows (or nearly stops) timers in tabs you're not looking at
  const sleep = (ms) => new Promise((r) => {
    if (!(/track123\.com$/i.test(location.hostname) || /(^|\.)usps\.com$/i.test(location.hostname)) || window.SCTRK_SIDE) { setTimeout(r, ms); return; }
    let done = false; const fin = () => { if (!done) { done = true; r(); } };
    try { chrome.runtime.sendMessage({ type: "sleep", ms }, () => { void chrome.runtime.lastError; fin(); }); } catch { setTimeout(fin, ms); }
    setTimeout(fin, ms + 4000);      // safety net
  });
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const titleCase = (s) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const now = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

  // ---------------- storage ----------------
  const store = {
    async get(k, def) { try { const v = (await chrome.storage.local.get(k))[k]; return v === undefined ? def : v; } catch { return def; } },
    async set(k, v) { try { await chrome.storage.local.set({ [k]: v }); } catch {} },
  };
  let cfg = Object.assign({}, DEFAULTS), job = {}, myTab = null, WORKER = null;
  const saveCfg = () => { cfg.savedAt = Date.now(); cfg.cfgV = 4; return store.set(CFG_KEY, cfg); };
  const bg = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || {}); }); } catch { res({}); } });

  // ---------------- sheet (Apps Script web app) ----------------
  function sheet(action, extra, tgt) {
    const t = tgt || target();
    const url = String(t.url || cfg.url || "").trim();
    if (!url) return Promise.resolve({ ok: false, error: "Google Sheet not set up - open ⚙ Settings > Google Sheet" });
    const body = JSON.stringify(Object.assign({
      token: cfg.token, action, tab: cfg.tab || "", sheetId: t.sheetId || "", gid: t.gid || "",
      cols: { tracking: cfg.colTracking, status: cfg.colStatus, t123: cfg.colT123, delivered: cfg.colDelivered, lastUpdate: cfg.colLast, checked: cfg.colChecked },
    }, extra || {}));
    return new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: "sheet", url, body }, (r) => {
          const err = chrome.runtime.lastError;
          res(r || { ok: false, error: err ? err.message : "no reply" });
        });
      } catch (e) { res({ ok: false, error: "The extension was updated - refresh this page (" + e.message + ")" }); }
    });
  }

  // which Google Sheet + tab the bot works on: the one open in this browser tab (sheet page),
  // or the one the run was started on (Track123 page)
  function pageSheet() {
    const h = here();
    const id = (h.pathname.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/) || [])[1] || "";
    const gid = ((h.hash + "&" + h.search).match(/gid=(\d+)/) || [])[1] || "";
    const name = h.title.replace(/\s+-\s+Google\s+\S+\s*$/i, "").trim();
    return { sheetId: id, gid, sheetName: name };
  }
  // a sheet link -> its id + tab (gid)
  function parseLink(link) {
    const s = String(link || "").trim();
    const id = (s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/) || [])[1] || (/^[A-Za-z0-9_-]{25,}$/.test(s) ? s : "");
    const gid = (s.match(/[#&?]gid=(\d+)/) || [])[1] || "";
    return { sheetId: id, gid };
  }
  const savedSheets = () => (cfg.sheets || []).map((x, i) => Object.assign({ i }, x, parseLink(x.link))).filter((x) => x.sheetId);
  // the sheet chosen in the panel's "Sheet" box: "page" = the Google Sheet open in this tab, or a saved sheet (0, 1, ...)
  function chosenSheet() {
    const sel = cfg.sheetSel;
    const list = savedSheets();
    if (sel !== "page" && sel !== undefined && sel !== null && sel !== "") {
      const e = list.find((x) => String(x.i) === String(sel));
      if (e) return { sheetId: e.sheetId, gid: e.gid, sheetName: e.name || "Sheet " + (e.i + 1), url: (e.url || "").trim() };
    }
    if (onSheet()) { const p = pageSheet(); return { sheetId: p.sheetId, gid: p.gid, sheetName: p.sheetName, url: "", page: true }; }
    if (list.length) { const e = list[0]; return { sheetId: e.sheetId, gid: e.gid, sheetName: e.name, url: (e.url || "").trim() }; }
    return { sheetId: cfg.lastSheetId || "", gid: cfg.lastGid || "", sheetName: cfg.lastSheetName || "the sheet the script is in", url: "" };
  }
  function target() { return chosenSheet(); }
  function looksExcel() {
    if (!onSheet()) return false;
    if (/[?&]rtpof=true/.test(here().search)) return true;
    if (/\.xlsx?\s*(-\s*Google|$)/i.test(here().title)) return true;
    if (SITE === "side") return false;
    return [...document.querySelectorAll('[class*="badge" i]')].some((e) => /^\s*\.?xlsx?\s*$/i.test(e.textContent || ""));
  }

  // ---------------- Track123 results (from hook.js + result cards) ----------------
  const results = new Map();     // TRACKING NO (upper) -> record from Track123's replies
  const apiErrors = [];
  const copied = new Map();      // TRACKING NO -> { status, date } from Track123's "copy all" text
  // "AWB：X\nCarriers：…\nStatus：Delivered · 5Day(s)\nCountry：…\n2026-10-17 09:02:00 DELIVERED …\n====="
  function parseCopy(text) {
    String(text || "").split(/\n=+\s*\n?/).forEach((blk) => {
      const tn = (blk.match(/AWB[^A-Za-z0-9\n]*([A-Za-z0-9-]{5,50})\s*$/m) || [])[1];
      const line = (blk.match(/Status[^\n]*/) || [""])[0];
      const st = okStatus(line.replace(/^Status\s*[：:]?/, "").split("·")[0]);   // the words BEFORE "·", e.g. "In transit"
      if (!tn || !st) return;
      const date = (blk.match(/^\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/m) || [])[1] || "";
      copied.set(tn.toUpperCase(), { status: st, date });
    });
  }
  // "Copy to Excel": one line per number, tab separated - number, origin, destination, date, latest event, STATUS, days
  //   "YT26…661\tUnknown\tUnknown\t2026-09-29 18:21:52\tArrived at GOFO Regional Hub\tIn transit\t25Day(s)"
  //   "ZZ12…\tUnknown\tUnknown\t\t\tNot found\t"      (then "=====" and "Powered by www.track123.com", ignored)
  function parseXls(text) {
    let n = 0;
    String(text || "").split(/\r?\n/).forEach((line) => {
      const c = line.split("\t");
      if (c.length < 6) return;
      const tn = c[0].replace(/\s+/g, "").toUpperCase(), st = okStatus(String(c[5] || "").split("·")[0]);
      if (!/^[A-Z0-9-]{5,50}$/.test(tn) || !st) return;
      copied.set(tn, { status: st, date: (String(c[3] || "").match(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?/) || [""])[0], event: String(c[4] || "").trim() });
      n++;
    });
    return n;
  }
  let copyWait = null, xlsOk = true;     // xlsOk: the "Copy to Excel" button worked last time (else the bot uses "copy all")
  function askCopy(kind) {
    return new Promise((res) => {
      copyWait = res; window.postMessage({ __sctrk: kind }, "*");
      setTimeout(() => { if (copyWait === res) { copyWait = null; res(0); } }, 2500);
    });
  }
  async function copyAll() {      // ask hook.js to press Track123's "Copy to Excel" (or "copy all") and hand over the text
    if (xlsOk) { const n = await askCopy("copyxls"); if (n) return true; xlsOk = false; }
    const ok = await askCopy("copyall");
    if (!ok) xlsOk = true;        // neither worked this time (page still loading?) - try Excel again next time
    return !!ok;
  }
  if (SITE === "track") {
    window.addEventListener("message", (e) => {
      if (e.source !== window || !e.data) return;
      if (e.data.__sctrk === "copy") {
        let n = 0;
        if (e.data.text) n = e.data.xls ? parseXls(e.data.text) : (parseCopy(e.data.text), 1);
        if (copyWait) { const r = copyWait; copyWait = null; r(n); }
        return;
      }
      if (e.data.__sctrk === "data") (e.data.items || []).forEach((x) => {
        const k = String(x.trackingNo || "").toUpperCase(); if (!k) return;
        const old = results.get(k);
        if (!old || old.querying || x.querying === false) results.set(k, x);
      });
      if (e.data.__sctrk === "err" && e.data.err) apiErrors.push(e.data.err);
    });
    window.postMessage({ __sctrk: "replay" }, "*");
  }
  function apiStatus(rec) {
    if (!rec || rec.querying) return "";
    const s = String(rec.transitStatus || "").toUpperCase();
    if (!s || s === "INIT") return okStatus(rec.main);
    return STATUS[s] || okStatus(rec.main) || okStatus(titleCase(s));
  }
  // what Track123 shows on each result card ("Delivered", "Expired", "Not found", "Tracking..." while loading)
  function screenStatuses() {
    const out = new Map();
    document.querySelectorAll(".result-list-item-container").forEach((card) => {
      const tnEl = card.querySelector(".tracking-no-text"), stEl = card.querySelector(".status-text");
      if (!tnEl || !stEl) return;
      const tn = tnEl.textContent.replace(/\s+/g, "").toUpperCase();
      const st = String(stEl.textContent || "").split("·")[0].replace(/\s+/g, " ").trim();   // "In transit · 2Day(s)" -> "In transit"
      const good = okStatus(st);
      if (tn && good) out.set(tn, good);
    });
    return out;
  }
  // the date Track123 shows on each card (latest event), e.g. "2026-10-16 20:02:18"
  function screenDates() {
    const out = new Map();
    document.querySelectorAll(".result-list-item-container").forEach((card) => {
      const tnEl = card.querySelector(".tracking-no-text");
      if (!tnEl) return;
      const head = card.querySelector(".result-list-item-header") || card;
      const txt = head.innerText || "";
      const m = txt.match(/\b(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\b/)       // 2026-10-16 20:02:18
        || txt.match(/\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}(?:,? \d{1,2}:\d{2}(?::\d{2})?)?)\b/)   // 16/10/2026 20:02
        || txt.match(/\b([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}(?:,? \d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?)?)/); // Oct 16, 2026
      if (m) out.set(tnEl.textContent.replace(/\s+/g, "").toUpperCase(), m[1]);
    });
    return out;
  }
  // A security check the user really has to solve. Track123 keeps an old (already passed, invisible)
  // captcha box in the page, so: it must be on screen, not see-through, and not say "success".
  function shownForReal(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.1) return false;
    }
    return true;
  }
  function captchaShown() {
    const cands = document.querySelectorAll('#tCaptchaDyContent, [id^="tcaptcha"], iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="recaptcha" i], iframe[title*="challenge" i]');
    for (const el of cands) {
      if (/验证成功|success/i.test(el.innerText || "")) continue;   // already passed
      if (shownForReal(el)) return true;
    }
    return false;
  }

  // ---------------- shared log (the background writes it - same lines on the sheet and every tab) ----------------
  let logLines = [];
  function paintLog() {
    if (!logEl) return;
    logEl.innerHTML = logLines.map((l) => `<div class="${l.c || ""}">${esc(l.t)}  ${esc(l.m).replace(/\b(rows?) (\d+(?:[–-]\d+)?)/gi, (_m, a, b) => `${a} <a data-goto="${parseInt(b, 10)}" title="Show this row in the sheet">${b}</a>`)}</div>`).join("");
    logEl.scrollTop = logEl.scrollHeight;
  }
  function log(m, c) { return bg({ type: "log", m: (WORKS && WORKER ? `[${SITE === "usps" ? "USPS tab" : "Tab"} ${WORKER}] ` : "") + m, c }); }

  // ---------------- panel ----------------
  let panel, logEl;
  const $ = (sel) => panel.querySelector(sel);
  // Track123 tabs: no big panel any more (it lives in Chrome's side panel) - just a small badge while the tab works
  function buildChip() {
    panel = document.createElement("div");
    panel.id = "sctrk-bot";
    panel.innerHTML = `<style>
      #sctrk-bot .cd{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;max-width:360px;
        background:#011842;color:#fff;font:600 12.5px "Segoe UI",system-ui,sans-serif;padding:7px 12px 7px 8px;border-radius:999px;
        box-shadow:0 8px 22px rgba(1,24,66,.3);border:2px solid #FCBE08;line-height:1.3}
      #sctrk-bot .cd img{width:22px;height:22px;border-radius:6px;flex:none}
      #sctrk-bot .uw{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:380px;font:600 12.5px "Segoe UI",system-ui,sans-serif}
      #sctrk-bot .uw button{display:flex;align-items:center;gap:8px;background:#FCBE08;color:#011842;border:2px solid #011842;border-radius:999px;padding:7px 14px 7px 8px;font:700 13px "Segoe UI",system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 22px rgba(1,24,66,.3)}
      #sctrk-bot .uw button:disabled{opacity:.6;cursor:default}
      #sctrk-bot .uw button img{width:22px;height:22px;border-radius:6px}
      #sctrk-bot .uw .msg{background:#fff;color:#0F172A;border:1px solid #E2E8F0;border-radius:10px;padding:7px 10px;box-shadow:0 6px 18px rgba(1,24,66,.18);font-weight:500;line-height:1.35;white-space:pre-wrap}
      </style><div class="uw" data-a="uw" style="display:none"><div class="msg" data-a="uwmsg" style="display:none"></div>
      <button data-a="uwbtn" title="Writes the status of every tracking number on this usps.com page into the matching rows of your Google Sheet"><img alt="" src="${chrome.runtime.getURL("icon48.png")}"><span data-a="uwt">Write to sheet</span></button></div>
      <div class="cd" data-a="cd" style="display:none" title="ShipCube Tracking Bot - click the bot icon in Chrome's toolbar to open the panel">
      <img alt="" src="${chrome.runtime.getURL("icon48.png")}"><span data-a="cdt"></span></div>`;
    (document.body || document.documentElement).appendChild(panel);
  }
  function buildPanel() {
    panel = document.createElement("div");
    panel.id = "sctrk-bot";
    panel.innerHTML = `
      <style>
        #sctrk-bot{--navy:#011842;--navy2:#0A2A5E;--gold:#FCBE08;--gold2:#E5AB00;--ink:#0F172A;--mute:#64748B;--line:#E2E8F0;--soft:#F4F6FA;
          position:fixed;right:18px;bottom:18px;z-index:2147483647;width:340px;
          font:13px "Segoe UI",system-ui,sans-serif;background:#fff;color:var(--ink);border-radius:14px;
          box-shadow:0 12px 32px rgba(1,24,66,.28);border:1px solid var(--line);overflow:hidden;text-align:left;line-height:1.35;letter-spacing:normal}
        #sctrk-bot *{box-sizing:border-box}
        #sctrk-bot a[data-wtab]{color:inherit;text-decoration:underline dotted;cursor:pointer}#sctrk-bot a[data-wtab]:hover{color:var(--navy);text-decoration:underline}
        #sctrk-bot a[data-goto]{color:inherit;text-decoration:underline dotted;cursor:pointer}
        #sctrk-bot a[data-goto]:hover{color:var(--navy);text-decoration:underline}
        #sctrk-bot .hd{display:flex;align-items:center;gap:10px;padding:8px 14px 8px 12px;background:var(--navy);color:#fff;font-weight:700;letter-spacing:.2px;cursor:default}
        #sctrk-bot .hd img{width:30px;height:30px;border-radius:7px}
        #sctrk-bot .hd .ttl{display:flex;flex-direction:column;line-height:1.15}
        #sctrk-bot .hd .ttl small{font-weight:400;color:var(--gold);font-size:11px}
        #sctrk-bot .hd .gear{margin-left:auto;cursor:pointer;color:var(--gold);font-weight:600;white-space:nowrap}
        #sctrk-bot .hd .x{margin-left:10px;cursor:pointer;opacity:.8;flex:none;padding:0 4px;font-size:15px;line-height:1}
        #sctrk-bot .steps{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;background:var(--navy2)}
        #sctrk-bot .st{font-size:11px;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.12);color:#CBD5E1}
        #sctrk-bot .st.done{background:var(--gold);color:var(--navy);font-weight:700}
        #sctrk-bot .st.wait{background:rgba(252,190,8,.18);color:var(--gold)}
        #sctrk-bot .st.bad{background:#FEE2E2;color:#B91C1C}
        #sctrk-bot .bd{padding:10px 12px;max-height:calc(100vh - 150px);overflow:auto}
        #sctrk-bot .log{max-height:150px;min-height:60px;overflow:auto;font:12px Consolas,monospace;background:var(--soft);border-radius:8px;padding:8px;margin:8px 0;white-space:pre-wrap;border:1px solid var(--line)}
        #sctrk-bot .ok{color:#047857}#sctrk-bot .warn{color:#B45309}#sctrk-bot .bad{color:#DC2626}#sctrk-bot .muted{color:var(--mute)}
        #sctrk-bot button{font:600 12.5px "Segoe UI",sans-serif;border-radius:8px;padding:6px 11px;cursor:pointer;border:1px solid var(--line);background:#fff;color:var(--navy);line-height:1.2}
        #sctrk-bot button:hover{border-color:var(--navy)}
        #sctrk-bot button.p{background:var(--gold);color:var(--navy);border-color:var(--gold)}
        #sctrk-bot button.p:hover{background:var(--gold2)}
        #sctrk-bot button:disabled{opacity:.5;cursor:default}
        #sctrk-bot .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
        #sctrk-bot label{display:flex;gap:6px;align-items:center;cursor:pointer;margin:0;font-weight:400}
        #sctrk-bot input[type=checkbox]{accent-color:var(--navy);margin:0}
        #sctrk-bot input:not([type=checkbox]),#sctrk-bot select{font:12px "Segoe UI",sans-serif;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);height:auto}
        #sctrk-bot.min .bd,#sctrk-bot.min .steps{display:none}
        #sctrk-bot .seg{display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
        #sctrk-bot .seg button{border:0;border-radius:0;padding:6px 14px;background:#fff}
        #sctrk-bot .seg button.on{background:var(--navy);color:#fff}
        #sctrk-bot .lbl{font-size:11px;color:var(--mute);font-weight:600;text-transform:uppercase;letter-spacing:.4px}
        #sctrk-bot .range input{width:70px;text-align:center;font-weight:600}
        #sctrk-bot .dir{font-size:12px;color:var(--navy2);font-weight:600}
        #sctrk-bot button.rev.on{background:#16A34A;color:#fff;border-color:#16A34A}
        #sctrk-bot button.rev.on:hover{background:#15803D}
        #sctrk-bot .file{font-size:11.5px;color:var(--mute);margin-top:6px}
        #sctrk-bot .file b{color:var(--navy)}
        #sctrk-bot .probs{border:1px solid #F59E0B;background:#FFFBEB;border-radius:8px;padding:8px;margin-top:8px;font-size:12px;color:#78350F}
        #sctrk-bot .probs .pl{max-height:170px;overflow:auto;margin-top:6px;font:11.5px Consolas,monospace;white-space:pre;background:#fff;border:1px solid #FDE68A;border-radius:6px;padding:6px;color:#0F172A}
        #sctrk-bot .probs button{padding:2px 8px;font-size:12px}
        #sctrk-bot .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:8px}
        #sctrk-bot .stats div{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:5px 4px;text-align:center}
        #sctrk-bot .stats b{display:block;font-size:15px;color:var(--navy)}
        #sctrk-bot .stats span{font-size:10.5px;color:var(--mute)}
        #sctrk-bot .stats .d b{color:#047857}#sctrk-bot .stats .n b{color:#B45309}#sctrk-bot .stats .f b{color:#DC2626}
        #sctrk-bot .cur{margin-top:8px;font-size:12px;color:var(--mute)}
        #sctrk-bot .cur b{color:var(--navy)}
        #sctrk-bot .alert{margin-top:8px;background:#FEF3C7;border:1px solid #FCD34D;color:#92400E;border-radius:8px;padding:6px 8px;font-size:12px;font-weight:600}
        #sctrk-bot .alert button{margin-top:4px;padding:3px 9px}
        #sctrk-bot .cd{display:flex;align-items:center;gap:8px;justify-content:space-between;background:var(--gold);color:var(--navy);font-weight:700;border-radius:8px;padding:6px 8px;margin-top:8px}
        #sctrk-bot .cd button{background:var(--navy);color:#fff;border-color:var(--navy);padding:3px 9px}
        #sctrk-bot .foot{font-size:11px;color:var(--mute);text-align:center}
        #sctrk-bot .sett{position:fixed;bottom:18px;width:420px;max-height:calc(100vh - 36px);overflow:auto;border:1px solid var(--line);border-radius:12px;padding:12px;
          box-shadow:0 12px 32px rgba(1,24,66,.28);background:#fff;z-index:2147483647}
        #sctrk-bot .sett .tabs button{padding:4px 9px;font-size:12px}
        #sctrk-bot .sett .f{margin-top:8px}
        #sctrk-bot .sett .f > div:first-child{font-weight:600;margin-bottom:3px;color:var(--navy)}
        #sctrk-bot .sett .f input:not([type=checkbox]),#sctrk-bot .sett .f select{width:100%}
        #sctrk-bot .sett .hint{font-size:11px;color:var(--mute);margin-top:3px}
        #sctrk-bot .sett .grid2{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px}
        #sctrk-bot.side{position:relative;right:auto;bottom:auto;width:auto;min-height:100vh;border:0;border-radius:0;box-shadow:none}
        #sctrk-bot.side .bd{max-height:none;overflow:visible}
        #sctrk-bot.side .log{max-height:260px}
        #sctrk-bot.side [data-a="min"]{display:none}
        #sctrk-bot.side .sett{position:fixed;top:0;left:0;right:0!important;bottom:0!important;width:auto!important;max-height:none;min-height:0;overflow:auto;box-sizing:border-box;border-radius:0;box-shadow:none;border:0}
        #sctrk-bot .sett .card{border:1px solid var(--line);border-left:3px solid var(--gold);border-radius:8px;padding:8px;margin-top:8px;background:var(--soft)}
        #sctrk-bot .hd .thm{margin-left:10px;cursor:pointer;color:var(--gold);font-size:15px;line-height:1}
        /* ---- dark mode ---- */
        #sctrk-bot.dark{--ink:#E5E9F2;--mute:#94A3B8;--line:#2B3A55;--soft:#15213A;background:#0D1729;color:var(--ink);color-scheme:dark;box-shadow:0 12px 32px rgba(0,0,0,.6)}
        #sctrk-bot.dark .hd{background:#06102A}#sctrk-bot.dark .steps{background:#0A1A3D}
        #sctrk-bot.dark button{background:#15213A;color:#DCE6FA;border-color:var(--line)}
        #sctrk-bot.dark button:hover{border-color:var(--gold)}
        #sctrk-bot.dark button.p{background:var(--gold);color:var(--navy);border-color:var(--gold)}
        #sctrk-bot.dark button.p:hover{background:var(--gold2)}
        #sctrk-bot.dark button.rev.on{background:#16A34A;color:#fff;border-color:#16A34A}
        #sctrk-bot.dark .cd button{background:var(--navy);color:#fff;border-color:var(--navy)}
        #sctrk-bot.dark input:not([type=checkbox]),#sctrk-bot.dark select,#sctrk-bot.dark textarea{background:#0F1B30;color:var(--ink);border:1px solid var(--line)}
        #sctrk-bot.dark .seg button{background:#15213A}#sctrk-bot.dark .seg button.on{background:var(--gold);color:var(--navy)}
        #sctrk-bot.dark .stats b,#sctrk-bot.dark .cur b,#sctrk-bot.dark .file b,#sctrk-bot.dark .sett .f > div:first-child,#sctrk-bot.dark .dir{color:#DCE6FA}
        #sctrk-bot.dark a[data-goto]:hover,#sctrk-bot.dark a[data-wtab]:hover{color:var(--gold)}
        #sctrk-bot.dark .ok,#sctrk-bot.dark .stats .d b{color:#34D399}
        #sctrk-bot.dark .warn,#sctrk-bot.dark .stats .n b{color:#FBBF24}
        #sctrk-bot.dark .bad,#sctrk-bot.dark .stats .f b{color:#F87171}
        #sctrk-bot.dark .st.bad{background:#4C1414;color:#FCA5A5}
        #sctrk-bot.dark .sett{background:#0D1729;border-color:var(--line)}
        #sctrk-bot.dark .sett .card{background:#15213A}
        #sctrk-bot.dark .probs{background:#2A2110;border-color:#B45309;color:#FCD34D}
        #sctrk-bot.dark .probs .pl{background:#0F1B30;color:var(--ink);border-color:#78350F}
        #sctrk-bot.dark .alert{background:#3A2A08;border-color:#B45309;color:#FCD34D}
        #sctrk-bot.dark code{background:#15213A;color:#FDE68A;border-radius:4px;padding:0 3px}
      </style>
      <div class="hd"><img alt="" src="${chrome.runtime.getURL("icon48.png")}"><div class="ttl">ShipCube Tracking Bot<small>v${VERSION} · ${SITE === "side" ? "Track123 → Google Sheet" : SITE === "sheet" ? "Sheet → Track123" : WORKER ? "Track123 tab " + WORKER : "Track123 → Sheet"}</small></div>
        <span class="gear" data-a="settings" title="Settings">⚙ Settings</span><span class="thm" data-a="theme" title="Theme">◐</span><span class="x" data-a="min" title="minimize">▁</span></div>
      <div class="steps"><span class="st" data-step="pick">1 · Read sheet</span><span class="st" data-step="track">2 · Tabs tracking</span><span class="st" data-step="write">3 · Writing to sheet</span><span class="st" data-step="done">4 · Done</span></div>
      <div class="bd">
        <div class="row" style="justify-content:space-between">
          <label title="How many Track123 tabs work at the same time. More tabs = faster, but Track123 shows its security check more often." style="font-size:12px">Track123 speed
            <select data-a="tabsel" style="font-weight:600"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="6">6×</option><option value="8">8×</option><option value="10">10×</option></select></label>
        </div>
        <div class="muted" data-a="modehint" style="font-size:11.5px;margin-top:4px"></div>
        <div class="row" style="margin-top:8px;gap:6px"><span class="lbl" style="margin:0">Sheet</span><select data-a="sheetsel" style="flex:1;min-width:0" title="Which Google Sheet the bot works on. Add your sheets in ⚙ Settings > Google Sheet."></select></div>
        <div class="file" data-a="file"></div>
        <div class="lbl" style="margin-top:10px">Sheet rows to check <span style="text-transform:none;font-weight:400">(row numbers on the left of the sheet, not Sr.no)</span></div>
        <div class="row range" style="margin-top:4px">
          From <input data-a="from" inputmode="numeric" title="Sheet row to start at. Empty = the first row (or the last row when Reverse is on).">
          to <input data-a="to" inputmode="numeric" title="Sheet row to finish at. Empty or 0 = keep going until there are no orders left.">
          <button data-a="rev" class="rev" title="Reverse: work from the bottom up. Green = on.">⇅ Reverse</button>
          ${SITE === "sheet" ? `<button data-a="usesel" title="Select rows in the sheet (e.g. click row 369, Shift+click row 869), then click this">Use selected rows</button>` : ""}
        </div>
        <div class="dir" data-a="dir" style="margin-top:4px"></div>
        <div class="row" style="margin-top:8px;gap:6px"><span class="lbl" style="margin:0">Check</span>
          <div class="seg" title="All rows, or a 'Not found run': only rows whose Status says Not found, tracked again with the carrier from the Carrier column">
            <button data-what="all">All rows</button><button data-what="blank" title="Only rows whose Status cell is empty - fills the gaps">Only blank</button><button data-what="nf">Only “Not found”</button><button data-what="bnf" title="Rows whose Status is empty OR says Not found - both in one run">Blank + Not found</button></div></div>
        <div class="row" style="margin-top:8px;gap:6px"><span class="lbl" style="margin:0">Sites</span>
          <div class="seg" title="Both = one run does Track123 and usps.com together. To run two at once (e.g. in a second Chrome profile or on another PC), give one run 'Track123 only' and the other 'USPS only' - they never touch the same rows.">
            <button data-site="">Both</button><button data-site="track">Track123 only</button><button data-site="usps">USPS only</button></div></div>
        <div class="hint" style="margin-top:6px">Finished rows (<span data-a="skiplist">Delivered, Expired</span>) are skipped automatically.</div>
        <label style="margin-top:3px;font-size:12px" title="The bot's Track123 / USPS tabs open in a separate Chrome window, so you can keep working in yours (other sheets, your own Track123 tabs). Minimise it if you like - just don't close it while the bot runs."><input type="checkbox" data-a="ownwin"> Bot tabs in their own window (keep working in yours)</label>
        <label style="margin-top:3px;font-size:12px" title="Off (fast): every number is auto-detected in row order; the ones Track123 can't find are checked again with the carrier from your Carrier column at the end. On: the sheet is done carrier by carrier, each with its carrier chosen (slower)."><input type="checkbox" data-a="cfirst"> Several carriers: choose the carrier first (slower)</label>
        <label style="margin-top:3px;font-size:12px" data-a="uspsrow" title="USPS rows (Carrier USPS, shippo__usps, usps_modern, endicia). Track123 first: they are tracked on Track123 with the others; only the ones Track123 can't find (no status / Not found) go to usps.com, 35 per page - fewer usps.com pages, so usps.com blocks far less. The number of USPS tabs comes from “usps.com speed” below.">USPS rows: <select data-a="umode" style="padding:1px 4px;font-size:12px"><option value="t123first">Track123 first, rest on usps.com</option><option value="site">usps.com only</option><option value="t123">Track123 only</option></select><select data-a="utabs" style="display:none"><option value="1">1 tab</option><option value="2">2 tabs</option><option value="3">3 tabs</option><option value="4">4 tabs</option><option value="5">5 tabs</option><option value="6">6 tabs</option></select></label>
        <label style="margin-top:3px;font-size:12px" data-a="ubudrow" title="usps.com lookups per day on this PC. When it is reached, usps.com stops for the day and those USPS rows stay empty for an “Only blank” run tomorrow. 0 = no limit.">usps.com limit: <input data-a="ubudget" type="number" min="0" step="500" style="width:70px;padding:1px 4px;font-size:12px"> lookups per day (0 = no limit)</label>
        <label style="margin-top:3px;font-size:12px" data-a="upacerow" title="How long each USPS tab waits between two usps.com pages. Slower = usps.com blocks far less, so long runs finish. If usps.com still shows its blank page, the bot rests 2, 10, 20, then 30 min and carries on by itself.">usps.com speed: <select data-a="upace" style="padding:1px 4px;font-size:12px"><option value="normal">Fast · 4 tabs · 15-45 s between pages (blocks sooner)</option><option value="slow">Balanced · 2 tabs · 1-2 min between pages (recommended)</option><option value="steady">Careful · 1 tab · 2.5-5 min between pages (all-day runs)</option></select></label>
        <label style="margin-top:3px;font-size:12px" title="A short random pause (3-10 s) after each batch, and the bot slows down by itself when Track123 shows a security check"><input type="checkbox" data-a="gentle"> Gentle pace (random pauses + auto slow-down)</label>
        <div class="row" style="margin-top:10px">
          <button class="p" data-a="start">▶ Start</button><button data-a="pause" title="Pause: the tabs finish the batch they are on (it is written), then wait. ▶ Resume carries on.">⏸ Pause</button><button data-a="stop">■ Stop</button>
          <button data-a="restart" title="Forget the unfinished run and start again from the From row">↺ From the start</button>
        </div>
        <div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)">
          <button data-a="uwbtn" title="Numbers you tracked on usps.com yourself (up to 35 per page): reads every open usps.com tab and writes each number's status, latest event and date into the rows of the chosen sheet that have that number">✍ Write usps.com results to sheet</button>
          <div class="hint" data-a="uwout" style="font-size:12px;margin-top:4px">Track the leftover numbers on usps.com yourself, then press this.</div>
        </div>
        <div data-a="alert" class="alert" style="display:none"></div>
        <div data-a="cd" class="cd" style="display:none"><span data-a="cdt"></span></div>
        <div class="cur" data-a="cur"></div>
        <div class="stats">
          <div><b data-a="sDone">0</b><span>checked</span></div>
          <div class="d"><b data-a="sDel">0</b><span>delivered</span></div>
          <div class="n"><b data-a="sNot">0</b><span>not deliv.</span></div>
          <div class="f"><b data-a="sNF">0</b><span>not found</span></div>
        </div>
        <div class="probs" data-a="probs" style="display:none"></div>
        <div class="log"></div>
        <div class="foot">${SITE !== "track" ? "Start here - the Track123 tabs work in the background and the statuses appear in this sheet." : "Each tab takes the next free 100, tracks them and hands them in - all tabs at the same time."}</div>
      </div>`;
    if (SITE === "side") panel.classList.add("side");
    (document.body || document.documentElement).appendChild(panel);
    logEl = $(".log");
    $('[data-a="min"]').onclick = async () => { panel.classList.toggle("min"); const ui = await store.get(UI_KEY, {}); ui["min_" + SITE] = panel.classList.contains("min"); store.set(UI_KEY, ui); };
    $('[data-a="settings"]').onclick = openSettings;
    $('[data-a="theme"]').onclick = async () => {        // Auto (follows Windows / Chrome) → Dark → Light → Auto
      cfg.theme = ({ auto: "dark", dark: "light", light: "auto" })[cfg.theme || "auto"] || "auto";
      applyTheme(); await saveCfg();
    };
    try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme); } catch {}
    applyTheme();
    $('[data-a="tabsel"]').onchange = async (e) => {
      cfg.tabs = +e.target.value || 2; await saveCfg();
      if (job.running) await bg({ type: "setTabs", tabs: cfg.tabs });     // during a run: tabs are added / closed straight away
      render();
    };
    panel.querySelectorAll("[data-site]").forEach((b) => b.onclick = async () => { cfg.sites = b.dataset.site; if (cfg.sites === "usps") cfg.uspsSite = true; await saveCfg(); await bg({ type: "resetRun" }); render(); });
    panel.querySelectorAll("[data-what]").forEach((b) => b.onclick = async () => { cfg.onlyNF = b.dataset.what === "nf"; cfg.onlyBlank = b.dataset.what === "blank"; cfg.onlyBNF = b.dataset.what === "bnf"; await saveCfg(); await bg({ type: "resetRun" }); render(); });
    const rangeChanged = async () => {
      cfg.from = cleanRow($('[data-a="from"]').value); cfg.to = cleanRow($('[data-a="to"]').value);
      if (cfg.from && cfg.to) cfg.reverse = +cfg.from > +cfg.to;     // 100 → 1 is reverse by itself
      else cfg.reverse = false;            // a box was emptied: back to top → bottom (⇅ Reverse turns it on again)
      await saveCfg(); await bg({ type: "resetRun" }); render();
    };
    $('[data-a="from"]').onchange = rangeChanged; $('[data-a="to"]').onchange = rangeChanged;
    $('[data-a="rev"]').onclick = async () => {
      const fi = $('[data-a="from"]'), ti = $('[data-a="to"]');
      if (cleanRow(fi.value) && cleanRow(ti.value)) { const f = fi.value; fi.value = ti.value; ti.value = f; await rangeChanged(); }
      else { cfg.reverse = !cfg.reverse; await saveCfg(); await bg({ type: "resetRun" }); render(); }
      log(`Reverse ${isReverse() ? "ON" : "OFF"}: ${describeRange()}`);
    };
    const us = $('[data-a="usesel"]');
    if (us) us.onclick = async () => {
      const rows = selectedRows();
      if (!rows) { log("Select the rows in the sheet first (click row 369, Shift+click row 869), then click “Use selected rows”.", "warn"); return; }
      const rv = !!cfg.reverse;
      $('[data-a="from"]').value = rv ? rows[1] : rows[0]; $('[data-a="to"]').value = rv ? rows[0] : rows[1];
      await rangeChanged();
      log(`Range set from your selection: ${describeRange()}`);
    };
    $('[data-a="sheetsel"]').onchange = async (e) => {
      cfg.sheetSel = e.target.value; await saveCfg(); await bg({ type: "resetRun" }); render();
      log(`Sheet: ${chosenSheet().sheetName || "this sheet"}`);
    };
    $('[data-a="umode"]').onchange = async (e) => { cfg.uspsMode = e.target.value; cfg.uspsSite = e.target.value !== "t123"; await saveCfg(); await bg({ type: "resetRun" }); };
    $('[data-a="utabs"]').onchange = async (e) => { cfg.uspsTabs = +e.target.value || 1; await saveCfg(); };
    $('[data-a="upace"]').onchange = async (e) => { cfg.uspsPace = e.target.value; await saveCfg(); render(); };
    $('[data-a="ubudget"]').onchange = async (e) => { const v = Math.max(0, Math.round(+e.target.value || 0)); cfg.uspsBudget = v; e.target.value = String(v); await saveCfg(); };
    $('[data-a="cfirst"]').onchange = async (e) => { cfg.carrierFirst = e.target.checked; await saveCfg(); await bg({ type: "resetRun" }); };
    $('[data-a="ownwin"]').onchange = async (e) => { cfg.ownWindow = e.target.checked; await saveCfg(); };
    $('[data-a="gentle"]').onchange = async (e) => { cfg.gentle = e.target.checked; await saveCfg(); };
    // "USPS tab 2" / "Tab 3" in the tab lines: open that tab. On mouse DOWN - the lines are redrawn every second,
    // so a normal click (down + up on the same element) was often lost.
    panel.addEventListener("mousedown", (e) => {
      const wt = e.button === 0 && e.target.closest && e.target.closest("a[data-wtab]");
      if (!wt) return;
      e.preventDefault();
      const w = +wt.dataset.wtab;
      bg({ type: "showWorker", w }).then((r) => { if (r && r.gone) log(`Tab ${w} is already closed.`); else if (r && r.error) log("Couldn't open tab " + w + ": " + r.error, "warn"); });
    });
    panel.addEventListener("click", (e) => {            // a row number in the tab lines or the log: show that row in the sheet
      const a = e.target.closest && e.target.closest("a[data-goto]");
      if (!a || !+a.dataset.goto) return;
      e.preventDefault();
      const t = target();
      bg({ type: "gotoRow", row: +a.dataset.goto, sheetId: job.sheetId || t.sheetId || "", gid: job.gid || t.gid || "" });
    });
    $('[data-a="start"]').onclick = start;
    $('[data-a="uwbtn"]').onclick = async () => {
      const o = $('[data-a="uwout"]'), b = $('[data-a="uwbtn"]');
      b.disabled = true; o.textContent = "Reading your usps.com tab(s)…";
      const g = await bg({ type: "uspsGrab" });
      const items = (g && g.items) || [];
      if (!items.length) {
        b.disabled = false;
        o.innerHTML = `<span class="bad">${g && g.tabs ? `No results found on your ${g.tabs} usps.com tab${g.tabs > 1 ? "s" : ""} - wait until the statuses show, or refresh the usps.com tab once (needed right after the bot is updated).` : "No tools.usps.com tab found - track your numbers on tools.usps.com first (in this Chrome), then press this again."}</span>`;
        return;
      }
      const t = target();
      o.textContent = `Writing ${items.length} number${items.length > 1 ? "s" : ""} to “${t.sheetName || "the sheet"}”…`;
      const r = await sheet("update", { items });
      b.disabled = false;
      if (!r.ok) { o.innerHTML = `<span class="bad">Couldn't write: ${esc(r.error || "no reply")}</span>`; return; }
      const miss = r.missing || [], counts = {};
      items.forEach((x) => { counts[x.st] = (counts[x.st] || 0) + 1; });
      const summ = Object.entries(counts).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
      o.innerHTML = `<span class="ok">✓ ${items.length - miss.length} written to “${esc(t.sheetName || "the sheet")}”</span> · ${esc(summ)}`
        + (miss.length ? `<br><span class="warn">${miss.length} not in the sheet: ${esc(miss.slice(0, 8).join(", "))}${miss.length > 8 ? " …" : ""}</span>` : "");
      log(`usps.com results written by hand: ${items.length - miss.length} number(s) from ${g.pages} usps.com tab(s) - ${summ}${miss.length ? ` · ${miss.length} not in the sheet` : ""}`, "ok");
    };
    $('[data-a="stop"]').onclick = () => bg({ type: "stopRun", why: "Stopped by you" });
    $('[data-a="pause"]').onclick = () => bg({ type: "pause" });
    $('[data-a="restart"]').onclick = async () => {
      if (job.running) { log("Stop the bot first.", "warn"); return; }
      await bg({ type: "resetRun" }); render();
      log(`Reset - next Start: ${describeRange()}.`);
    };
  }
  const cleanRow = (v) => { const n = parseInt(String(v).replace(/\D/g, ""), 10); return n > 0 ? String(n) : ""; };
  // Google Sheets: the Name box shows the selection, e.g. "G369:G869", "369:869", "A369"
  function selectedRows() {
    const nb = document.querySelector("#t-name-box, input.waffle-name-box, input[aria-label='Name Box' i], input[aria-label*='name box' i]");
    const v = nb ? String(nb.value || "") : "";
    const m = v.match(/^[A-Z]*(\d+)(?::[A-Z]*(\d+))?$/i);
    if (!m) return null;
    const a = +m[1], b = +(m[2] || m[1]);
    return [Math.min(a, b), Math.max(a, b)];
  }
  const isReverse = () => (cfg.from && cfg.to ? +cfg.from > +cfg.to : !!cfg.reverse);
  function describeRange() {
    const rev = isReverse();
    const fs = cfg.from ? `row ${cfg.from}` : rev ? "last row" : "first row";
    const ts = cfg.to ? `row ${cfg.to}` : rev ? "the top (no orders left)" : "the end (no orders left)";
    return `${fs} → ${ts}  (${rev ? "REVERSE: bottom to top ↑" : "top to bottom ↓"})`;
  }
  function setStep(k, v) { const el = panel && panel.querySelector(`[data-step="${k}"]`); if (el) el.className = "st" + (v ? " " + v : ""); }
  // dark mode: cfg.theme = "auto" (follows Windows / Chrome), "dark" or "light"
  function applyTheme() {
    if (!panel) return;
    const t = cfg.theme || "auto";
    let dark = t === "dark";
    if (t === "auto") { try { dark = matchMedia("(prefers-color-scheme: dark)").matches; } catch {} }
    panel.classList.toggle("dark", dark);
    const b = $('[data-a="theme"]');
    if (b) { b.textContent = t === "auto" ? "◐" : dark ? "☾" : "☀"; b.title = `Theme: ${t === "auto" ? "Auto (follows Windows)" : dark ? "Dark" : "Light"} - click to change`; }
    if (SITE === "side") { document.documentElement.style.background = dark ? "#0D1729" : "#fff"; if (document.body) document.body.style.background = dark ? "#0D1729" : "#fff"; }
  }
  function render() {
    applyTheme();
    if (!panel || WORKS) return;
    const run = !!job.running;
    const done = (job.totals && job.totals.checked) || 0;
    const tabs = cfg.tabs || 2;
    { const ts = $('[data-a="tabsel"]'); if (document.activeElement !== ts) ts.value = String([1, 2, 4, 6, 8, 10].includes(tabs) ? tabs : 2); ts.disabled = run && cfg.sites === "usps"; }
    panel.querySelectorAll("[data-site]").forEach((b) => { b.classList.toggle("on", b.dataset.site === (cfg.sites || "")); b.disabled = run || (cfg.useCarrier === false && b.dataset.site === "track"); });
    panel.querySelectorAll("[data-what]").forEach((b) => { b.classList.toggle("on", b.dataset.what === (cfg.onlyBNF ? "bnf" : cfg.onlyNF ? "nf" : cfg.onlyBlank ? "blank" : "all")); b.disabled = run; });
    const rate = job.startedAt && done ? Math.round(done / Math.max(1, ((run ? Date.now() : job.finishedAt || Date.now()) - job.startedAt) / 60000)) : 0;
    $('[data-a="modehint"]').textContent = `${tabs} Track123 tab${tabs > 1 ? "s" : ""} at the same time${tabs > 4 ? " - watch the speed and security checks" : tabs > 2 ? " - Track123 may show its security check more often" : ""}`;
    const fi = $('[data-a="from"]'), ti = $('[data-a="to"]');
    if (document.activeElement !== fi) fi.value = cfg.from || "";
    if (document.activeElement !== ti) ti.value = cfg.to || "";
    const rev = isReverse();
    fi.placeholder = rev ? "last row" : "first row"; ti.placeholder = "end";
    $('[data-a="rev"]').classList.toggle("on", rev);
    $('[data-a="dir"]').textContent = describeRange();
    $('[data-a="skiplist"]').textContent = String(cfg.skip || "Delivered"); 
    $('[data-a="ownwin"]').checked = cfg.ownWindow !== false; $('[data-a="ownwin"]').disabled = run;
$('[data-a="gentle"]').checked = cfg.gentle !== false; $('[data-a="cfirst"]').checked = !!cfg.carrierFirst;
    $('[data-a="umode"]').value = uspsMode(); $('[data-a="utabs"]').value = String(cfg.uspsTabs || 1);
    $('[data-a="upace"]').value = cfg.uspsPace || "slow"; $('[data-a="upace"]').disabled = run || uspsMode() === "t123";
    $('[data-a="upacerow"]').style.display = cfg.sites === "track" || uspsMode() === "t123" ? "none" : "";
    if (document.activeElement !== $('[data-a="ubudget"]')) $('[data-a="ubudget"]').value = String(cfg.uspsBudget === undefined ? 3000 : cfg.uspsBudget);
    $('[data-a="ubudget"]').disabled = run || uspsMode() === "t123";
    $('[data-a="umode"]').disabled = run || cfg.sites === "usps" || cfg.useCarrier === false;   // USPS only: always usps.com only
    $('[data-a="utabs"]').disabled = run || uspsMode() === "t123";
    $('[data-a="uspsrow"]').style.display = cfg.sites === "track" ? "none" : "";
    $('[data-a="ubudrow"]').style.display = cfg.sites === "track" || uspsMode() === "t123" ? "none" : "";
    $('[data-a="cfirst"]').closest("label").style.display = cfg.sites === "usps" ? "none" : "";   // USPS only: no carrier choice        // Track123 only: no USPS option
    $('[data-a="cfirst"]').disabled = run || cfg.useCarrier === false;
    $('[data-a="gentle"]').disabled = run;
    fi.disabled = ti.disabled = $('[data-a="rev"]').disabled = run;
    if ($('[data-a="usesel"]')) $('[data-a="usesel"]').disabled = run;
    const ss = $('[data-a="sheetsel"]');
    if (ss && document.activeElement !== ss) {
      const opts = [];
      if (onSheet()) opts.push([`page`, `This sheet: ${pageSheet().sheetName || "open tab"}`]);
      savedSheets().forEach((x) => opts.push([String(x.i), x.name || "Sheet " + (x.i + 1)]));
      if (!opts.length) opts.push(["page", cfg.lastSheetName ? `Last used: ${cfg.lastSheetName}` : "Add your sheets in ⚙ Settings"]);
      ss.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
      const want = String(cfg.sheetSel ?? "page");
      ss.value = opts.some((o) => o[0] === want) ? want : opts[0][0];
      ss.disabled = run;
    }
    const fl = $('[data-a="file"]');
    if (fl) {
      const c = chosenSheet();
      const p = onSheet() ? pageSheet() : null;
      if (run) fl.innerHTML = `Working on: <b>${esc(job.sheetName || "sheet")}</b>${p && job.sheetId && job.sheetId !== p.sheetId ? " (another sheet - open it to watch the statuses)" : ""}`;
      else if (c.page && looksExcel()) fl.innerHTML = `<span class="bad">This is an Excel file - File &gt; Save as Google Sheets first, then run the bot on the copy.</span>`;
      else fl.innerHTML = c.page ? `The tab you have open in this sheet` : c.sheetId ? `${p && c.sheetId === p.sheetId ? "This sheet" : "Writes into that sheet"}${c.gid ? "" : " (first tab)"}` : `<span class="warn">No sheet chosen - add it in ⚙ Settings > Google Sheet</span>`;
    }
    const startB = $('[data-a="start"]');
    startB.disabled = run && !job.paused;
    startB.textContent = run && job.paused ? (job.pausedBy === "user" ? "▶ Resume" : "▶ Next 100") : !run && job.canResume ? "▶ Continue" : "▶ Start";
    startB.classList.toggle("p", true);
    const pauseB = $('[data-a="pause"]');
    pauseB.disabled = !run || job.paused;
    pauseB.style.display = "";
    // status
    const total = job.total || 0;
    let cur;
    if (run) {
      const ws = Object.entries(job.wstate || {}).map(([w, s]) => `<a data-wtab="${+w}" title="Open this tab">${s.site === "usps" ? "USPS tab" : "Tab"} ${w}</a>: ${s.state === "tracking" ? `rows <a data-goto="${parseInt(s.rows, 10) || ""}" title="Show this row in the sheet"><b>${esc(s.rows)}</b></a> (${s.n})${s.code ? " · " + esc(s.code) : ""}` : esc(s.state || "")}`);
      cur = `<b>${done}</b> of <b>${total}</b> checked${rate ? ` · <b>${rate}</b>/min` : ""} · <b>${job.left || 0}</b> waiting · ${job.writing || job.pending ? `<b>${job.pending}</b> being written` : "sheet up to date"}${job.round > 1 ? ` · retry round ${job.round}` : ""}${job.active && job.active < job.tabs && Object.values(job.wstate || {}).some((x) => x.site !== "usps") ? ` · <b style="color:var(--gold)">slowed down: ${job.active} of ${job.tabs} tabs</b>` : ""}${job.coolUntil > Date.now() ? ` · break ${Math.ceil((job.coolUntil - Date.now()) / 1000)} s` : ""}${job.ustop ? ` · <b style="color:var(--gold)">usps.com stopped (${job.ustop === "budget" ? "daily limit reached" : "blocked"}) - USPS rows left for “Only blank”</b>` : job.ucap && job.utabs && job.ucap < job.utabs ? ` · <b style="color:var(--gold)">USPS slowed down: up to ${job.ucap} of ${job.utabs} tabs</b>` : ""}${job.ubudget && Object.values(job.wstate || {}).some((x) => x.site === "usps") ? ` · usps.com today ${job.uday || 0}/${job.ubudget}` : ""}${job.ucool > Date.now() ? ` · USPS break ${Math.ceil((job.ucool - Date.now()) / 1000)} s` : ""}<br>${ws.join("<br>")}`;
      if (job.paused && job.pausedBy === "user") cur = `<b>⏸ Paused</b>${job.inflight ? ` - ${job.inflight} tab${job.inflight > 1 ? "s are" : " is"} finishing the batch they're on` : ""}. Click <b>▶ Resume</b> to carry on.<br>` + cur;
      else if (job.paused) cur = `Batch done. Click <b>▶ Next 100</b> for the next batch.<br>` + cur;
    } else if (job.canResume) cur = `${esc(job.note || "Stopped")} · <b>${job.left}</b> numbers not done yet${job.rangeText ? ` of the last run (<b>${esc(job.rangeText)}</b>)` : ""} - <b>▶ Continue</b> goes on with that run, <b>↺ From the start</b> starts over.`;
    else cur = job.note ? `${esc(job.note)}${total ? ` · ${done} of ${total} checked${rate ? ` · ${rate}/min` : ""}${job.gaveUp ? ` · ${job.gaveUp} without a status` : ""}` : ""}` : `Ready · ${cfg.onlyBNF ? "only empty + “Not found” rows · " : cfg.onlyNF ? "only “Not found” rows · " : cfg.onlyBlank ? "only rows with an empty Status · " : ""}${describeRange()}`;
    $('[data-a="cur"]').innerHTML = cur;
    setStep("pick", total ? "done" : run ? "wait" : "");
    setStep("track", run && Object.values(job.wstate || {}).some((s) => s.state === "tracking") ? "wait" : done ? "done" : "");
    setStep("write", job.writing || job.pending ? "wait" : job.written ? "done" : "");
    setStep("done", !run && job.note && /finished|nothing/i.test(job.note) ? "done" : "");
    const al = $('[data-a="alert"]');
    if (run && job.alert) { al.style.display = ""; al.innerHTML = esc(job.alert) + (/security/i.test(job.alert) ? `<br><button data-a="showtab">Show the Track123 tab</button>` : ""); const b = al.querySelector('[data-a="showtab"]'); if (b) b.onclick = () => bg({ type: "focusTab" }); }
    else al.style.display = "none";
    const t = job.totals || {};
    $('[data-a="sDone"]').textContent = done;
    $('[data-a="sDel"]').textContent = t.delivered || 0;
    $('[data-a="sNot"]').textContent = t.notDelivered || 0;
    $('[data-a="sNF"]').textContent = t.notFound || 0;
  }

  // ---------------- problem shipments of the last run (Exception / Failed attempt / Expired / no movement 7+ days) ----------------
  function paintProbs(p) {
    const el = panel && $('[data-a="probs"]');
    if (!el) return;
    const list = (p && p.list) || [];
    if (!list.length || (p.hiddenAt && p.hiddenAt >= p.at)) { el.style.display = "none"; return; }
    el.style.display = "";
    const rows = list.slice().sort((a, b) => a.row - b.row);
    el.innerHTML = `<div style="display:flex;gap:6px;align-items:center"><b>⚠ ${rows.length} problem shipment${rows.length > 1 ? "s" : ""}</b><span style="opacity:.8">· last run${p.sheet ? " · " + esc(p.sheet) : ""}</span>
        <span style="margin-left:auto"></span><button data-p="copy">Copy list</button><button data-p="x" title="Hide">✕</button></div>
      <div class="pl">${rows.slice(0, 300).map((x) => esc(`Row ${x.row} · ${x.tn} · ${x.why}${x.date && !/days/.test(x.why) ? " · " + x.date : ""}`)).join("\n")}${rows.length > 300 ? "\n… (Copy list has all " + rows.length + ")" : ""}</div>
      <div style="margin-top:4px;opacity:.8">Copy list → paste into any sheet (columns: Row, Tracking, Status, Last event, Problem).</div>`;
    el.querySelector('[data-p="copy"]').onclick = async (e) => {
      const txt = ["Row\tTracking\tStatus\tLast event\tProblem"].concat(rows.map((x) => [x.row, x.tn, x.st, x.date, x.why].join("\t"))).join("\n");
      let ok = false; try { await navigator.clipboard.writeText(txt); ok = true; } catch {}
      if (!ok) { try { const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); ta.remove(); } catch {} }
      e.target.textContent = ok ? "✓ Copied" : "Copy failed"; setTimeout(() => (e.target.textContent = "Copy list"), 1500);
    };
    el.querySelector('[data-p="x"]').onclick = () => store.set("sctrk_problems", Object.assign({}, p, { hiddenAt: Date.now() }));
  }

  // ---------------- start (sheet page or Track123 page) ----------------
  async function start() {
    if (job.running && job.paused) { await bg({ type: "resume" }); return; }
    if (job.running) return;
    if (!cfg.url && !savedSheets().some((x) => x.url)) { log("Set up the Google Sheet first: ⚙ Settings > Google Sheet.", "bad"); openSettings("sheet"); return; }
    cfg.from = cleanRow($('[data-a="from"]').value); cfg.to = cleanRow($('[data-a="to"]').value);
    if (cfg.from && cfg.to) cfg.reverse = +cfg.from > +cfg.to;
    const c = chosenSheet();
    if (c.page && looksExcel()) { log("This is an Excel (.xlsx) file - the bot can't write into it. Use File > Save as Google Sheets and start the bot on the new Google Sheet.", "bad"); return; }
    cfg.lastSheetId = c.sheetId; cfg.lastGid = c.gid; cfg.lastSheetName = c.sheetName; await saveCfg();
    const url = String(c.url || cfg.url || "").trim();
    const req = { url, base: { token: cfg.token, tab: cfg.tab || "", sheetId: c.sheetId || "", gid: c.gid || "",
      cols: { tracking: cfg.colTracking, status: cfg.colStatus, t123: cfg.colT123, delivered: cfg.colDelivered, lastUpdate: cfg.colLast, checked: cfg.colChecked } } };
    const skip = String(cfg.skip || "Delivered, Expired").split(",").map((s) => s.trim()).filter(Boolean);
    $('[data-a="start"]').disabled = true;
    const carrierRules = cfg.useCarrier === false ? [] : String(cfg.carrierMap || "").split(/\n/).map((l) => l.split("=")).filter((p) => p.length === 2)
      .map(([a, c]) => [a.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim(), c.trim()]).filter(([a, c]) => a && c);
    const prefixRules = String(cfg.prefixMap || "").split(/\n/).map((l) => l.split("=")).filter((p) => p.length === 2)
      .map(([a, c]) => [a.trim().toUpperCase(), c.trim()]).filter(([a, c]) => a && c);
    const couriers = cfg.useCarrier === false || job.canResume || cfg.sites === "usps" ? [] : await courierList();
    const only = cfg.onlyNF && !cfg.onlyBNF ? ["not found"] : [];
    const msg = { type: "startRun", uspsFilter: cfg.uspsFilter, resume: !!job.canResume, req, deliveredText: cfg.style === "simple" ? cfg.deliveredText || "Delivered" : "Delivered", mode: "auto", tabs: cfg.tabs, carrierRules, prefixRules, db: !!cfg.db, only, onlyNF: !cfg.onlyBNF && !!cfg.onlyNF, onlyBlank: !cfg.onlyBNF && !cfg.onlyNF && !!cfg.onlyBlank, onlyBNF: !!cfg.onlyBNF,
      useCarrier: cfg.useCarrier !== false, carrierFirst: !!cfg.carrierFirst, uspsSite: cfg.sites === "usps" || (cfg.useCarrier !== false && uspsMode() !== "t123"), uspsMode: uspsMode(), uspsTabs: ({ normal: 4, slow: 2, steady: 1 })[cfg.uspsPace || "slow"] || 2, uspsBudget: cfg.uspsBudget === undefined ? 3000 : cfg.uspsBudget, uspsPace: cfg.uspsPace || "slow", sites: cfg.useCarrier === false && cfg.sites !== "usps" ? "" : cfg.sites || "", couriers, gentle: cfg.gentle !== false, light: true, ownWindow: cfg.ownWindow !== false, fresh: 0, now: now(),
      from: cfg.from, to: cfg.to, dir: isReverse() ? -1 : 1, skip, sheetName: c.sheetName, sheetId: c.sheetId, rangeText: describeRange(),
      selfTab: SITE === "track" ? myTab : null };
    // scheduled runs repeat the settings of the last ▶ Start (sheet, rows, speed, sites, USPS…)
    if (!job.canResume) await store.set("sctrk_lastStart", Object.assign({}, msg, { resume: false, selfTab: null, savedAt: Date.now() }));
    const r = await bg(msg);
    if (!r.ok && r.error) log("Couldn't start: " + r.error, "bad");
    render();
  }

  // how USPS rows are tracked: Track123 first (the rest on usps.com) - usps.com only - Track123 only
  const uspsMode = () => cfg.sites === "usps" ? "site" : cfg.uspsMode || (cfg.uspsSite === false ? "t123" : "t123first");
  // Track123's own list of carriers (code + name), kept for 3 days - "Uni_Uni" in the sheet -> uniuni
  async function courierList() {
    const K = "sctrk_couriers", c = await store.get(K, null);
    if (c && c.list && c.list.length > 100 && Date.now() - c.at < 3 * 864e5) return c.list;
    try {
      const r = await fetch("https://www.track123.com/tk/api/v2/anonymous/track/list-all-courier", { credentials: "include" }).then((x) => x.json());
      const d = r && r.data;
      const arr = Array.isArray(d) ? d : (d && (d.list || d.records || Object.values(d).find(Array.isArray))) || [];
      const list = arr.filter((x) => x && x.code).map((x) => [String(x.code), String(x.nameEN || x.name || ""), +x.type || 0]);
      if (list.length > 100) { await store.set(K, { at: Date.now(), list }); return list; }
    } catch {}
    return (c && c.list) || [];
  }

  // ---------------- worker (Track123 tabs) ----------------
  // how much text the SITE's page shows - the bot's own chip ("needs a break…") is not counted
  // usps.com's bot-check / half-loaded pages can have no <body> at all - never read .innerText of nothing
  const bodyText = () => { const el = document.body || document.documentElement; return (el && el.innerText) || ""; };
  const pageTextLen = () => Math.max(0, bodyText().trim().length - ((panel && panel.innerText) || "").trim().length);
  const pageBlank = () => pageTextLen() < 40;
  let engineOn = false, navigating = false, lateSent = false, okSent = false, harvestNow = false;   // harvestNow: ■ Stop - hand in what this page has right now
  const brkJit = Math.round(Math.random() * 6000);
  function setCd(text) { if (!panel) return; const el = $('[data-a="cd"]'); el.style.display = ""; $('[data-a="cdt"]').textContent = text; }
  function hideCd() { if (panel) $('[data-a="cd"]').style.display = "none"; }
  function pageTns() {
    try {
      const v = new URL(location.href).searchParams.get("trackNos") || "";
      return v.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    } catch { return []; }
  }
  async function engine() {
    if (!WORKS || engineOn || navigating) return;
    engineOn = true;
    try {
      while (true) {
        const b = await bg({ type: "take" });
        if (!b || b.stop || (!b.items && !b.wait)) { hideCd(); break; }
        if (b.wait) {
          if (SITE === "usps" && !lateSent) {          // e.g. you reloaded a blank usps.com page yourself: hand in what it shows
            const late = uspsWrites(uspsCards()).out;
            if (late.length) { lateSent = true; const r = await bg({ type: "uspsLate", items: late }); if (r && r.n) setCd(`Picked up ${r.n} result${r.n > 1 ? "s" : ""} from this page ✓`); }
          }
          let k = {}; try { k = JSON.parse(sessionStorage.getItem("sctrk_brk") || "{}"); } catch {}
          if (k.u !== location.href) k = { u: location.href, n: 0 };
          if (SITE === "usps" && !job.paused && performance.now() > 8000 + brkJit + Math.min(25000, k.n * 1500) && !uspsCards().size
              && pageBlank()) {
            if (k.n < 60) {                      // keeps reloading (every ~10-30 s) until the page loads; then the break ends and its results are picked up
              k.n++; sessionStorage.setItem("sctrk_brk", JSON.stringify(k));
              if (k.n % 5 === 1) log(`usps.com page is blank - reloading it until it answers (try ${k.n}).`);
              navigating = true; location.reload(); return;
            }
          }
          if (SITE === "usps" && b.why === "cool" && !okSent && performance.now() > 3000 && pageTextLen() >= 200) {
            okSent = true; if (!/access denied/i.test(document.title)) bg({ type: "uspsOk", at: Date.now() - performance.now() });
          }
          const sec = b.until ? Math.max(1, Math.ceil((b.until - Date.now()) / 1000)) : 0;
          setCd(job.paused ? (job.pausedBy === "user" ? "⏸ Paused - click ▶ Resume" : "Waiting for ▶ Next 100…")
            : b.why === "cool" ? `${SITE === "usps" ? "usps.com" : "Track123"} needs a break - carrying on in ${sec >= 3600 ? Math.floor(sec / 3600) + " h " + Math.ceil((sec % 3600) / 60) + " min" : sec >= 90 ? Math.ceil(sec / 60) + " min" : sec + " s"}`
            : b.why === "slow" ? "Resting this tab - the bot slowed down (speeds up again by itself)"
            : b.why === "rest" ? `Short pause · next batch in ${sec} s`
            : "Waiting for the other tabs to finish…");
          await sleep(b.until ? Math.min(1500, Math.max(300, b.until - Date.now())) : 1500); continue;
        }
        const here = pageTns();
        // usps.com forwards to /tracking/<all the numbers joined together>
        const same = SITE === "usps" ? (/\/tracking\//.test(location.pathname)
            && decodeURIComponent(location.pathname + location.search).replace(/[^A-Za-z0-9]/g, "").toUpperCase().includes(b.tns.join("").toUpperCase()))
            || (() => { const k = uspsCards(); return b.tns.some((t) => k.has(t)); })()      // the results are already on screen
          : here.length === b.tns.length && b.tns.every((t) => here.includes(t));
        if (!same) {                                           // open this batch on Track123 - the page reloads and the bot carries on
          const opens = +(sessionStorage.getItem("sctrk_opens") || 0);
          if (b.again && opens >= 3) { sessionStorage.removeItem("sctrk_opens"); await giveBack(b, "Couldn't open this batch on Track123"); continue; }
          sessionStorage.setItem("sctrk_opens", String(b.again ? opens + 1 : 1));
          if (SITE === "usps") sessionStorage.setItem("sctrk_usps", b.tns.join(","));
          navigating = true;        // this page is going away - don't start another engine on it
          setTimeout(() => { navigating = false; maybeWork(true); }, 25000);   // the site didn't load it: try again
          location.href = b.url;
          return;
        }
        sessionStorage.removeItem("sctrk_opens");
        const ok = SITE === "usps" ? await trackUsps(b) : await track(b);
        if (!ok || navigating) break;          // stopped, or the page is reloading
        // results are handed in - the loop takes the next 100 straight away
      }
    } finally { engineOn = false; }
  }
  async function giveBack(b, why) {   // a batch that can't be done now: everything goes to the retry list
    log(`${why} - its ${b.items.length} numbers are retried at the end.`, "warn");
    await bg({ type: "result", writes: [], counts: {}, unresolved: b.items.map((it) => Object.assign({}, it, SITE === "usps" ? { blank: (it.blank || 0) + 1 } : { tries: (it.tries || 0) + 1 })) });
  }
  // wait until EVERY number of the batch has its status (or the time limit), then hand the results in
  // 420 + ZIP + USPS number (420891359261290…): Track123 sometimes answers for the number WITHOUT the "420 + ZIP"
  // part (9261290…), so the bot didn't recognise it and the row was left blank. Both forms count as the same number.
  const tnKey = (t) => { t = String(t || "").replace(/\s+/g, "").toUpperCase(); const m = t.match(/^420\d{5}(?:\d{4})?(9[1-5]\d{18,26})$/); return m ? m[1] : t; };
  function getT(map, tn) {
    if (!map) return undefined;
    tn = String(tn || "").toUpperCase();
    if (map.has(tn)) return map.get(tn);
    const k = tnKey(tn);
    for (const [x, v] of map) if (tnKey(x) === k) return v;
    return undefined;
  }
  async function track(b) {
    bg({ type: "state", state: "tracking" });
    const t0 = Date.now(), limit = WAIT_S * 1000;
    let paused = 0, clickedTrack = false, captchaSince = 0, alerted = false, sawCaptcha = false, last = -1, lastCopy = 0, lastHb = 0, lastChange = Date.now();
    const known = (t, screen) => apiStatus(getT(results, t)) || getT(screen, t) !== undefined || getT(copied, t) !== undefined;
    while (true) {
      await sleep(400);
      if (!job.running) { hideCd(); return false; }
      if (Date.now() - lastHb > 10000) { lastHb = Date.now(); bg({ type: "hb" }); }
      if (harvestNow) break;          // ■ Stop: write the statuses this page already shows, the rest go back to the queue
      let screen = screenStatuses();
      // Track123's own "Copy to Excel" text has every number at once - read it every ~2 s while numbers are missing
      if (Date.now() - t0 > 1500 && Date.now() - lastCopy > 2000 && b.tns.some((t) => !known(t, screen))) {
        lastCopy = Date.now(); await copyAll(); screen = screenStatuses();
      }
      const have = b.tns.filter((t) => known(t, screen)).length;
      if (have !== last) { last = have; lastChange = Date.now(); setCd(`Rows ${rowsOf(b)} · statuses ${have}/${b.tns.length}`); }
      if (have === b.tns.length) break;
      if (captchaShown()) {
        paused += 400;
        if (!captchaSince) captchaSince = Date.now();
        if (!alerted && Date.now() - captchaSince > 2500) {
          alerted = true; sawCaptcha = true;
          log("Track123 is showing a security check - please solve it in this tab. The bot waits.", "warn");
          bg({ type: "alert", text: `Track123 tab ${WORKER} needs a security check - solve it there, the bot waits.` });
          bg({ type: "focusTab" });
        }
        continue;
      }
      if (alerted) { alerted = false; bg({ type: "alert", text: "" }); log("Security check done ✓"); }
      captchaSince = 0;
      if (!have && !clickedTrack && Date.now() - t0 - paused > 20000) {      // nothing at all after 20 s: press Track
        const btn = [...document.querySelectorAll("button, a, div[role=button], [class*=track-btn]")].find((x) => !x.closest("#sctrk-bot") && /^\s*track\s*→?\s*$/i.test(x.textContent || "") && x.offsetParent);
        if (btn) { btn.click(); clickedTrack = true; }
      }
      // the numbers still missing: is Track123 still asking the carrier for them (Amazon TBA… often takes 1-2 min)?
      const missing = b.tns.filter((t) => !known(t, screen));
      const asking = missing.filter((t) => { const r = getT(results, t); return r && r.querying; }).length;
      // while Track123 is still asking: wait up to 3 min for the batch (it fills them in by itself) - otherwise 90 s
      if (Date.now() - t0 - paused > (asking ? Math.max(limit, 180000) : limit)) break;
      // most are done and the last few haven't moved for 35 s AND Track123 isn't asking for them any more: hand these in
      if (have >= b.tns.length * 0.8 && Date.now() - lastChange > (asking ? 90000 : 35000)) break;
    }
    await copyAll();     // one last full read (statuses + dates of every number)
    hideCd();
    // build the results
    const screen = screenStatuses(), dates = screenDates();
    const writes = [], counts = {}, unresolved = [];
    let noStatus = 0;     // numbers Track123 showed nothing for (not the "Not found → try auto-detect" ones)
    const rowsByTn = new Map();
    b.items.forEach((it) => { const k = it.tn.toUpperCase(); if (!rowsByTn.has(k)) rowsByTn.set(k, []); rowsByTn.get(k).push(it); });
    for (const tn of b.tns) {
      const rec = getT(results, tn), cp = getT(copied, tn);
      const det = okStatus(getT(screen, tn)) || okStatus(cp && cp.status) || okStatus(apiStatus(rec));     // what Track123 shows first
      // usps.com said only "Awaiting Item" / a shipping partner has it: Track123 (auto-detect) gave a second opinion.
      // Keep whichever is further along (e.g. Track123 "Delivered" via Amazon beats usps.com "Info received").
      const xc = rowsByTn.get(tn)[0].xcheck;
      if (xc && !(det && RANK(det) > RANK(xc.st))) {
        counts[xc.st] = (counts[xc.st] || 0) + 1;
        rowsByTn.get(tn).forEach((it) => writes.push(Object.assign({}, it.xcheck || xc, { row: it.row, tn: it.tn, checked: now() })));
        continue;
      }
      // a USPS row Track123 couldn't do (no status / Not found): it goes on to usps.com
      if (rowsByTn.get(tn)[0].usps && (!det || /^not found$/i.test(det))) {
        if (!det) noStatus++;
        rowsByTn.get(tn).forEach((it) => unresolved.push({ row: it.row, tn: it.tn, code: "", site: "usps", viaT123: true, tries: 0 }));
        continue;
      }
      if (!det) { noStatus++; rowsByTn.get(tn).forEach((it) => unresolved.push({ row: it.row, tn: it.tn, code: it.code || "", cc: it.cc, ccTried: it.ccTried, autoTried: it.autoTried, tries: (it.tries || 0) + 1 })); continue; }
      // auto-detect said "Not found" and the sheet names a carrier: check it again with that carrier (at the end of the run)
      if (!b.code && /^not found$/i.test(det) && rowsByTn.get(tn)[0].cc && !rowsByTn.get(tn)[0].ccTried) {
        rowsByTn.get(tn).forEach((it) => unresolved.push({ row: it.row, tn: it.tn, code: it.cc, cc: it.cc, ccTried: true, autoTried: true, tries: it.tries || 0 }));
        continue;
      }
      // carrier chosen from the sheet but Track123 says "Not found": the sheet's carrier may be wrong - try auto-detect once
      if (b.code && /^not found$/i.test(det) && !rowsByTn.get(tn)[0].autoTried) {
        rowsByTn.get(tn).forEach((it) => unresolved.push({ row: it.row, tn: it.tn, code: "", autoTried: true, tries: it.tries || 0 }));
        continue;
      }
      counts[det] = (counts[det] || 0) + 1;
      const isDel = /^delivered$/i.test(det);
      const status = cfg.style === "simple" ? (isDel ? cfg.deliveredText || "Delivered" : cfg.notDeliveredText || "not delivered") : det;
      const lastEv = rec && (rec.lastDesc || rec.lastTime) ? `${rec.lastDesc || ""}${rec.lastTime ? " (" + rec.lastTime + ")" : ""}`.trim()
        : cp && (cp.event || cp.date) ? `${cp.event || ""}${cp.date ? " (" + cp.date + ")" : ""}`.trim() : "";
      rowsByTn.get(tn).forEach((it) => writes.push({
        row: it.row, tn: it.tn, status, t123: det, st: det, del: isDel,
        delivered: isDel && rec ? rec.deliveryTime || rec.lastTime || "" : "",
        last: lastEv, checked: now(),
        // every order gets a date: the one Track123 shows, else its latest event / delivery time, else the day it was checked
        date: getT(dates, tn) || (cp && cp.date) || (rec && (rec.lastTime || rec.deliveryTime)) || now(),
      }));
    }
    if (noStatus) {          // say WHY a number got no status (so a pattern can be fixed)
      const why = [];
      for (const tn of b.tns) {
        if (why.length >= 4) break;
        const rec = getT(results, tn), cp = getT(copied, tn);
        if (okStatus(getT(screen, tn)) || okStatus(cp && cp.status) || okStatus(apiStatus(rec))) continue;
        const card = [...document.querySelectorAll(".result-list-item-container")].find((k) => ((k.querySelector(".tracking-no-text") || {}).textContent || "").replace(/\s+/g, "").toUpperCase() === tn);
        const shown = card ? ((card.querySelector(".status-text") || {}).textContent || "").replace(/\s+/g, " ").trim() : "";
        const r = !rec ? "no reply from Track123" : rec.querying ? "Track123 still asking the carrier" : `Track123 status “${rec.transitStatus || ""}${rec.main ? " / " + rec.main : ""}”`;
        why.push(`${tn}: ${r}${card ? `, page shows “${shown || "nothing"}”` : ", not on the page"}`);
      }
      if (why.length) log(`No status for: ${why.join(" · ")}`, "warn");
    }
    if (!writes.length && apiErrors.length) log(`Track123 said: ${apiErrors[apiErrors.length - 1].msg || apiErrors[apiErrors.length - 1].code}`, "bad");
    const summ = Object.entries(counts).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
    log(`Rows ${rowsOf(b)}${b.code ? ` (${b.code})` : ""}: ${summ || "no statuses"}${unresolved.length ? ` · ${unresolved.length} without a status yet (retried at the end)` : ""}`, unresolved.length ? "warn" : "");
    // tell the dispatcher if Track123 pushed back, so it can slow down by itself
    const empty = b.tns.length >= 10 && noStatus > b.tns.length * 0.5;
    // Track123 rate-limit note ("The operation is too frequent and has been restricted") - the bot pauses and lowers tabs
    const frequent = apiErrors.some((e) => /too frequent|has been restricted|frequency|rate.*limit/i.test(String(e.msg || "") + " " + String(e.code || "")));
    await bg({ type: "result", writes, counts, unresolved, signal: { captcha: sawCaptcha, empty, frequent } });
    return true;
  }
  // how far along a status is (for "keep the better one")
  const RANK = (st) => { const t = String(st || "").toLowerCase();
    return /^delivered/.test(t) ? 5 : /out for delivery|available for pickup|failed attempt|exception|alert|return/.test(t) ? 4
      : /in transit|transit|expired/.test(t) ? 3 : /info received|pending|label/.test(t) ? 2 : /not found/.test(t) ? 0 : 1; };
  // ---------------- usps.com: up to 35 numbers on one page ----------------
  const USPS = [   // usps.com's words -> the same statuses Track123 uses
    [/^delivered/i, "Delivered"], [/out for delivery/i, "Out for delivery"], [/available for pickup|ready for pickup/i, "Available for pickup"],
    [/attempt|notice left|missed/i, "Failed attempt"], [/alert|return to sender|returned|undeliverable|exception|refused/i, "Exception"],
    [/awaiting item|label created|pre-shipment|pre shipment/i, "Info received"], [/on the way|in transit|preparing for delivery|accepted|arrived|departed|moving/i, "In transit"],
  ];
  const uspsDate = (t) => {      // "October 20, 2026 8:39 PM" -> "2026-10-20 20:39"
    const m = String(t || "").match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})\s*([ap]m))?/i);
    if (!m) return "";
    const mon = "january february march april may june july august september october november december".split(" ").indexOf(m[1].toLowerCase()) + 1;
    if (!mon) return "";
    const p = (n) => String(n).padStart(2, "0");
    let h = m[4] ? +m[4] % 12 + (/pm/i.test(m[6]) ? 12 : 0) : null;
    return `${m[3]}-${p(mon)}-${p(+m[2])}` + (h === null ? "" : ` ${p(h)}:${m[5]}`);
  };
  function uspsCards() {
    const out = new Map();
    document.querySelectorAll(".product_summary").forEach((ps) => {
      const c = ps.parentElement || ps, q = (sel) => ((c.querySelector(sel) || {}).innerText || "").replace(/\s+/g, " ").trim();
      const tn = q(".tracking-number").replace(/\s+/g, "").toUpperCase();
      if (!tn) return;
      const head = q(".tb-status"), detail = q(".tb-status-detail"), date = q(".tb-date"), all = (c.innerText || "").replace(/\s+/g, " ");
      let st = "";
      if (/tracking (is )?not available|status not available|label created, not yet in system/i.test(all) && !head) st = "Not found";
      else { const hit = USPS.find(([re]) => re.test(head) || (!head && re.test(detail))); st = hit ? hit[1] : head ? head : ""; }
      out.set(tn, { status: st, head, detail, date: uspsDate(date) });
    });
    return out;
  }
  async function trackUsps(b) {
    bg({ type: "state", state: "tracking" });
    const t0 = Date.now();
    let cards = new Map(), last = -1, lastChange = Date.now(), alerted = false, denied = false;
    let lastHb = 0;
    while (true) {
      await sleep(500);
      if (!job.running) { hideCd(); return false; }
      if (Date.now() - lastHb > 10000) { lastHb = Date.now(); bg({ type: "hb" }); }
      if (harvestNow) break;          // ■ Stop: write the statuses this page already shows, the rest go back to the queue
      cards = uspsCards();
      const have = b.tns.filter((t) => cards.has(t) && cards.get(t).status).length;
      if (have !== last) { last = have; lastChange = Date.now(); setCd(`USPS · rows ${rowsOf(b)} · statuses ${have}/${b.tns.length}`); }
      if (have === b.tns.length) break;
      // "Access Denied": usps.com has blocked this PC's connection for now - reloading only makes the block last longer
      if (!cards.size && (/access denied/i.test(document.title) || /access denied[\s\S]{0,300}edgesuite/i.test(bodyText()))) { denied = true; break; }
      // blank page (usps.com's bot check or a page that never finished): the tab does not wait - it reloads again and again
      // (a little longer between tries each time) until the page answers. After 30 tries the batch goes back and the bot rests.
      if (!cards.size && Date.now() - t0 > 10000 && pageBlank()) {
        const key = b.tns.join(",");
        const pv = (sessionStorage.getItem("sctrk_ureload") || "").split("|"), nRe = pv[0] === key ? +pv[1] || 0 : 0;
        if (nRe < 30) {
          sessionStorage.setItem("sctrk_ureload", key + "|" + (nRe + 1));
          const wait = Math.min(40000, 2000 + nRe * 1500) + Math.round(Math.random() * 3000);
          setCd(`USPS · rows ${rowsOf(b)} · page is blank - reloading in ${Math.round(wait / 1000)} s (try ${nRe + 1}/30)…`);
          await sleep(wait);
          if (!job.running) { hideCd(); return false; }
          if (nRe % 5 === 0) log(`Rows ${rowsOf(b)}: usps.com page is blank - reloading until it answers (try ${nRe + 1}/30).`);
          navigating = true; location.reload();
          return false;
        }
        break;
      }
      // the page loaded but the numbers were never searched (usps.com showed its empty form / dropped the numbers): open the batch link again
      if (!cards.size && Date.now() - t0 > 20000 && !pageBlank()) {
        const key = b.tns.join(","), pv = (sessionStorage.getItem("sctrk_unav") || "").split("|"), n = pv[0] === key ? +pv[1] || 0 : 0;
        if (n < 3) {
          sessionStorage.setItem("sctrk_unav", key + "|" + (n + 1));
          log(`Rows ${rowsOf(b)}: usps.com did not search these numbers - opening them again (${n + 1}/3).`, "warn");
          navigating = true; location.href = b.url;
          return false;
        }
      }
      if (!cards.size && Date.now() - t0 > 30000) break;
      if (Date.now() - t0 > 60000) break;
      if (have && Date.now() - lastChange > 6000) break;
    }
    hideCd();
    const writes = [], counts = {}, unresolved = [];
    let noStatus = 0, xcN = 0;
    const rowsByTn = new Map();
    b.items.forEach((it) => { const k = it.tn.toUpperCase(); if (!rowsByTn.has(k)) rowsByTn.set(k, []); rowsByTn.get(k).push(it); });
    for (const tn of b.tns) {
      const c = cards.get(tn);
      // blank page: usps.com didn't show the numbers at all - not the number's fault, so it doesn't use up a try
      if (!cards.size) { noStatus++; rowsByTn.get(tn).forEach((it) => unresolved.push(Object.assign({}, it, { blank: (it.blank || 0) + 1 }))); continue; }
      if (!c || !c.status) { noStatus++; rowsByTn.get(tn).forEach((it) => unresolved.push(Object.assign({}, it, { tries: (it.tries || 0) + 1 }))); continue; }
      const det = c.status;
      counts[det] = (counts[det] || 0) + 1;
      const isDel = /^delivered$/i.test(det);
      const status = cfg.style === "simple" ? (isDel ? cfg.deliveredText || "Delivered" : cfg.notDeliveredText || "not delivered") : det;
      // "USPS Awaiting Item" / "Shipping Partner: AMAZON": USPS only has a label - the parcel may be moving with a partner.
      // These get a second opinion on Track123 (auto-detect) when Track123 tabs are part of the run; the better status wins.
      const pre = !!b.xc && (/^info received$/i.test(det) || /shipping partner/i.test(c.detail + " " + c.head));
      rowsByTn.get(tn).forEach((it) => {
        const w = {
          row: it.row, tn: it.tn, status, st: det, del: isDel, t123: [c.head, c.detail].filter(Boolean).join(" · "),
          delivered: isDel ? c.date : "", last: [c.detail, c.date].filter(Boolean).join(" (") + (c.detail && c.date ? ")" : ""),
          checked: now(), date: c.date || now(),
        };
        if (pre && !isDel && !it.xcheck) { xcN++; unresolved.push({ row: it.row, tn: it.tn, code: "", autoTried: true, ccTried: true, tries: 0, xcheck: w }); }
        else writes.push(w);
      });
      if (pre && !isDel) { counts[det]--; if (!counts[det]) delete counts[det]; }
    }
    const summ = Object.entries(counts).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
    log(cards.size ? `Rows ${rowsOf(b)} (usps.com): ${summ || "no statuses"}${unresolved.length > xcN ? ` · ${unresolved.length - xcN} without a status yet (retried at the end)` : ""}`
      : denied ? `Rows ${rowsOf(b)}: usps.com answered “Access Denied” - these ${b.tns.length} are tried again after the wait.`
      : `Rows ${rowsOf(b)}: usps.com kept the page blank - these ${b.tns.length} are tracked again later (not skipped).`, unresolved.length > xcN ? "warn" : "");
    if (xcN) log(`${xcN} USPS row(s) show only “Awaiting Item” / a shipping partner on usps.com - Track123 gives a second opinion (the status further along is written).`);
    await bg({ type: "result", writes, counts, unresolved, signal: { captcha: false, denied, blank: !cards.size, empty: b.tns.length >= 5 && noStatus > b.tns.length * 0.5 } });
    sessionStorage.removeItem("sctrk_usps"); sessionStorage.removeItem("sctrk_ureload"); sessionStorage.removeItem("sctrk_unav");
    return true;
  }
  const rowsOf = (b) => { const r = b.items.map((x) => x.row); return `${Math.min(...r)}–${Math.max(...r)}`; };

  // ---------------- usps.com "Write to sheet" button (numbers you tracked on usps.com yourself) ----------------
  // Paste up to 35 numbers on usps.com yourself, press the button: every number's status, latest event and
  // date go into the rows of the chosen Google Sheet that have that tracking number (found anywhere in the sheet).
  function uspsWrites(cards) {
    const out = [], counts = {};
    cards.forEach((c, tn) => {
      if (!c.status) return;
      const isDel = /^delivered$/i.test(c.status);
      counts[c.status] = (counts[c.status] || 0) + 1;
      out.push({
        row: 0, tn, st: c.status, del: isDel,
        status: cfg.style === "simple" ? (isDel ? cfg.deliveredText || "Delivered" : cfg.notDeliveredText || "not delivered") : c.status,
        t123: [c.head, c.detail].filter(Boolean).join(" · "),
        delivered: isDel ? c.date : "", last: [c.detail, c.date].filter(Boolean).join(" (") + (c.detail && c.date ? ")" : ""),
        checked: now(), date: c.date || now(),
      });
    });
    return { out, counts };
  }
  function uspsButton() {
    if (SITE !== "usps" || !panel) return;
    const box = $('[data-a="uw"]'), btn = $('[data-a="uwbtn"]'), txt = $('[data-a="uwt"]'), msg = $('[data-a="uwmsg"]');
    if (!box) return;
    let busy = false;
    const say = (t, cls) => { msg.style.display = t ? "" : "none"; msg.innerHTML = t; msg.style.borderColor = cls === "bad" ? "#FCA5A5" : cls === "ok" ? "#86EFAC" : "#E2E8F0"; };
    const refresh = () => {
      if (busy) return;
      if (WORKER) { box.style.display = "none"; return; }          // the bot's own usps.com tabs: no button
      const cards = uspsCards(), n = [...cards.values()].filter((c) => c.status).length;
      // always shown on usps.com tracking pages (so you can see the bot is there), active once results are read
      box.style.display = cards.size || /\/tracking|trackconfirm/i.test(location.pathname) ? "" : "none";
      txt.textContent = n ? `Write ${n} result${n > 1 ? "s" : ""} to sheet` : cards.size ? "Waiting for results…" : "No results read on this page";
      btn.disabled = !n;
    };
    btn.onclick = async () => {
      const cards = uspsCards(), { out, counts } = uspsWrites(cards);
      if (!out.length) return;
      const t = target();
      busy = true; btn.disabled = true; txt.textContent = `Writing ${out.length}…`; say("");
      const r = await sheet("update", { items: out });
      busy = false;
      if (r.ok) {
        const miss = r.missing || [], wrote = out.length - miss.length;
        const summ = Object.entries(counts).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
        say(`<b>✓ ${wrote} written</b> to “${esc(t.sheetName || "the sheet")}”${r.written > wrote ? ` (${r.written} rows - some numbers are on more than one row)` : ""}<br>${esc(summ)}`
          + (miss.length ? `<br><span style="color:#B45309">${miss.length} not in the sheet: ${esc(miss.slice(0, 8).join(", "))}${miss.length > 8 ? "…" : ""}</span>` : ""), "ok");
        log(`usps.com page written by hand to the sheet: ${wrote} number(s) - ${summ}${miss.length ? ` · ${miss.length} not found in the sheet` : ""}`, "ok");
      } else {
        say(`<b>Couldn't write:</b> ${esc(r.error || "no reply")}`, "bad");
      }
      refresh();
    };
    refresh();
    setInterval(refresh, 1500);
  }

  // ---------------- settings ----------------
  function openSettings(tabWanted) {
    let ov = panel.querySelector(".sett");
    if (ov && typeof tabWanted !== "string") { ov.remove(); return; }
    if (ov) ov.remove();
    ov = document.createElement("div");
    ov.className = "sett";
    panel.appendChild(ov);
    const place = () => {
      const r = panel.getBoundingClientRect(), room = r.left - 24;
      ov.style.width = Math.max(300, Math.min(420, room)) + "px";
      ov.style.right = (room >= 300 ? window.innerWidth - r.left + 12 : 12) + "px";
    };
    if (SITE !== "side") { place(); window.addEventListener("resize", place); }
    let tab = typeof tabWanted === "string" ? tabWanted : "sheet";
    const f = (label, html, hint) => `<div class="f"><div>${label}</div>${html}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
    const inp = (k, ph, extra) => `<input data-k="${k}" value="${esc(cfg[k])}" placeholder="${esc(ph || "")}" ${extra || ""}>`;
    function draw() {
      let h = `<div class="row tabs" style="margin-bottom:4px">${[["sheet", "Google Sheet"], ["cols", "Columns & status"], ["sched", "Schedule"], ["db", "Database"], ["team", "Team"]]
        .map(([k, t]) => `<button data-t="${k}" class="${tab === k ? "p" : ""}">${t}</button>`).join("")}<span style="margin-left:auto;cursor:pointer;font-size:15px" data-x>✕</span></div>`;
      if (tab === "sheet") {
        h += f("Web app link", inp("url", "https://script.google.com/macros/s/…/exec"), "From the sheet: Extensions > Apps Script > Deploy (see GOOGLE SHEET SETUP.txt).")
          + f("Password", inp("token", "shipcube"), "Same as TOKEN at the top of the script.")
          + `<div class="card"><b>Your sheets</b> - pick one in the panel's <b>Sheet</b> box to switch.
              <div class="hint">Sheet link = the address of the Google Sheet (open the tab you want, copy the link). Own web app link only if that sheet has its own script - otherwise leave it empty.</div>
              ${(cfg.sheets || []).map((x, i) => `<div style="border-top:1px solid var(--line);margin-top:8px;padding-top:6px">
                <div class="row"><input data-sh="${i}" data-f="name" value="${esc(x.name)}" placeholder="Name" style="flex:1;font-weight:600"><span style="cursor:pointer;color:var(--mute)" data-shdel="${i}" title="Remove">✕</span></div>
                <input data-sh="${i}" data-f="link" value="${esc(x.link)}" placeholder="Sheet link: https://docs.google.com/spreadsheets/d/…/edit#gid=0" style="width:100%;margin-top:4px">
                <input data-sh="${i}" data-f="url" value="${esc(x.url)}" placeholder="own web app link (optional)" style="width:100%;margin-top:4px">
                <div class="row" style="margin-top:4px"><button data-shtest="${i}" style="padding:3px 9px;font-size:12px">Test</button><span class="hint" data-shout="${i}"></span></div></div>`).join("")}
              <div class="row" style="margin-top:8px"><button data-s="addsheet" style="padding:3px 9px;font-size:12px">+ Add sheet</button>${onSheet() ? `<button data-s="addthis" style="padding:3px 9px;font-size:12px">+ Add this sheet</button>` : ""}</div></div>`
          + f("Tab name", inp("tab", "empty = first tab"), "Only for a sheet link without #gid=… (the tab is otherwise taken from the link / the open tab).")
          + `<div class="row" style="margin-top:10px"><button class="p" data-s="save">Save</button><button data-s="test">Test connection</button></div><div data-s="out" class="hint" style="font-size:12px"></div>`;
      } else if (tab === "cols") {
        h += `<div class="hint" style="font-size:12px">Columns are found by their heading (<b>Tracking Number</b>, <b>Status</b>). Type a letter only if you want to force a column.</div>
          <div class="grid2">${f("Tracking number column", inp("colTracking", "auto (F)", 'maxlength="3"'))}${f("Status column", inp("colStatus", "auto (G)", 'maxlength="3"'))}</div>
          ${f("What to write in Status", `<select data-k="style"><option value="track123">Exact Track123 status (Delivered, In transit, Info received, Out for delivery, Expired, Not found…)</option><option value="simple">Only two words: Delivered / not delivered</option></select>`)}
          <div class="grid2" data-simple>${f("Text when delivered", inp("deliveredText", "Delivered"))}${f("Text when not delivered", inp("notDeliveredText", "not delivered"))}</div>
          ${f("“Skip finished rows” = Status is", inp("skip", "Delivered, Expired"), "Rows with these statuses are not tracked again when the tick box is on. Comma separated.")}
          <div class="card"><label style="font-weight:600"><input type="checkbox" data-k2="useCarrier"> Choose the carrier from the sheet's <b>Carrier</b> column</label>
            <div class="hint">The bot reads the Carrier (or Shipper / Courier) column and picks that carrier on Track123 instead of auto-detect - no more "Not found" from a wrong guess.
            <b>Automatic:</b> any carrier name is matched to Track123's own list of ~2,400 carriers (Uni_Uni, UNIUNI, uni uni → UniUni · OnTrac · Veho · GOFO …). New carriers work without adding anything.
            <div style="margin-top:6px"><b>Built in</b> (always on, no need to type them): ${[["uni_uni", "UniUni"], ["gofo", "GOFO"], ["amazon_shipping_api_v2 / any amazon…", "Amazon Shipping + Amazon MCF"], ["dhl_ecommerce", "DHL eCommerce US"], ["ups", "UPS"], ["fedex", "FedEx"]].map(([a, b]) => `<code>${a}</code> → ${b}`).join(" · ")}</div>
            <div style="margin-top:6px">Lines below are only for <b>exceptions</b> (they win): <b>word in your Carrier column = Track123 code</b>, "auto" = let Track123 detect. If a chosen carrier says Not found, the bot tries auto-detect once.</div></div>
            <textarea data-k="carrierMap" style="width:100%;height:120px;font:11.5px Consolas,monospace;margin-top:4px">${esc(cfg.carrierMap)}</textarea>
            <div class="hint">Codes: DHL eCommerce US = dhlglobalmail · DHL Express = dhl · USPS = usps · UPS = ups · FedEx = fedex · UniUni = uniuni · GOFO = gofo-express. The log names any carrier it couldn't recognise.</div></div>
          <div class="card"><b>Carrier from tracking-number prefix</b>
            <div class="hint">Used when the <b>Carrier</b> column is empty or missing. One line per prefix: <b>PREFIX = carrier</b> (Track123's carrier name as shown on its site, or its code). The prefix is matched at the START of the tracking number, case does not matter. The log will say "prefix: TBA → amazon…" when it kicks in.</div>
            <textarea data-k="prefixMap" style="width:100%;height:70px;font:11.5px Consolas,monospace;margin-top:4px">${esc(cfg.prefixMap)}</textarea>
            <div class="hint">Nothing here is fixed - delete or change any line. Suggested: <code>TBA = Amazon Shipping + Amazon MCF</code>. Add more as you find them (e.g. <code>1Z = ups</code>, <code>92 = usps</code>). "auto" = let Track123 detect.</div></div>
          <div class="card"><b>USPS only: which numbers go to usps.com</b>
            <div class="hint">In a <b>USPS only</b> run the bot skips numbers that belong to another carrier (Amazon TBA…, UPS, UniUni, DHL) - they are never searched on usps.com and stay as they are in the sheet. One line per carrier: <b>carrier = number prefixes</b> (comma separated; <code>1-8</code> means digits 1 to 8). Only numbers that start with a USPS prefix (9) <b>and</b> whose Carrier is empty or one of usps, usps modem, endicia, shippo usps go to usps.com - nothing else, in any run. Edit or add lines any time.</div>
            <textarea data-k="uspsFilter" style="width:100%;height:130px;font:11.5px Consolas,monospace;margin-top:4px">${esc(cfg.uspsFilter)}</textarea></div>
          <div class="card"><b>Optional extra columns</b> - add the heading to the sheet and the bot fills it (or type a letter):
            <div class="grid2">${f("Track123 Status", inp("colT123", "heading", 'maxlength="3"'))}${f("Delivered Date", inp("colDelivered", "heading", 'maxlength="3"'))}${f("Last Update", inp("colLast", "heading", 'maxlength="3"'))}${f("Checked On", inp("colChecked", "heading", 'maxlength="3"'))}</div></div>
          <div class="row" style="margin-top:10px"><button class="p" data-s="save">Save</button><button data-s="test">Check columns</button></div><div data-s="out" class="hint" style="font-size:12px"></div>`;
      } else if (tab === "sched") {
        const sc = cfg.schedule || {};
        h += `<div class="hint" style="font-size:12px;margin-top:6px">The bot starts a run by itself at this time, with the <b>same settings as your last ▶ Start</b> (sheet, rows, speed, sites, USPS…). Press ▶ Start once by hand after changing settings so the schedule uses them.<br>Chrome must be open and the PC awake (the side panel can be closed). You get a notification when it's done.</div>
          <label style="display:flex;gap:6px;margin-top:10px;font-weight:600"><input type="checkbox" data-sc="on" ${sc.on ? "checked" : ""}> Run automatically</label>
          <div class="grid2">${f("Time", `<input type="time" data-sc="time" value="${esc(sc.time || "08:30")}">`)}${f("Days", `<select data-sc="days"><option value="daily">Every day</option><option value="weekdays">Mon - Fri</option><option value="monsat">Mon - Sat</option></select>`)}</div>
          <div class="row" style="margin-top:10px"><button class="p" data-s="schedsave">Save schedule</button></div><div data-s="schedout" class="hint" style="font-size:12px"></div>`;
      } else if (tab === "db") {
        h += `<div class="hint" style="font-size:12px">Save every run's rows to your <b>Firebase</b> database. The sheet keeps working either way; if the database can't be reached, the sheet is still updated and the bot retries on the next run.</div>
          <label style="display:flex;gap:6px;margin-top:10px;font-weight:600"><input type="checkbox" data-k2="db"> Save to database too</label>
          ${f("Cloud Functions base link", inp("dbUrl", "https://us-central1-<project>.cloudfunctions.net"), "The part BEFORE /sync. See firebase/DEPLOY.txt in the bot folder.")}
          ${f("Firebase Web API key", inp("dbApiKey", "AIzaSy…"), "From Firebase Console > Project settings > Web app > apiKey. Not a secret.")}
          ${f("Your @shipcube.com email", inp("dbEmail", "you@shipcube.com"))}
          ${f("Password (used once, not stored)", `<input type="password" data-dbp placeholder="(sign in)" autocomplete="current-password" style="width:100%">`)}
          <div class="row" style="margin-top:10px"><button class="p" data-s="dbsignin">Sign in</button><button data-s="dbtest">Test connection</button><button data-s="dbout">Sign out</button></div>
          <div data-s="dbstatus" class="hint" style="font-size:12px;margin-top:6px"></div>`;
            } else {
        h += `<div style="margin-top:6px">Set the bot up once for every PC:</div>
          <div class="hint" style="font-size:12px">1. Fill in Google Sheet + Columns here.<br>2. Click the button → <b>team-settings.json</b> downloads.<br>3. Put it in the bot folder (replace the old one), copy the folder to the other PCs and load / reload it in chrome://extensions.</div>
          <div class="row" style="margin-top:10px"><button class="p" data-s="team">Download team settings</button></div>`;
      }
      ov.innerHTML = h;
      ov.querySelectorAll("[data-t]").forEach((b) => b.onclick = () => { collect(); tab = b.dataset.t; draw(); });
      ov.querySelector("[data-x]").onclick = () => ov.remove();
      ov.querySelectorAll("[data-k2]").forEach((el) => { el.checked = cfg[el.dataset.k2] !== false; });
      const sel = ov.querySelector('[data-k="style"]');
      if (sel) { sel.value = cfg.style; const tog = () => { const s = ov.querySelector("[data-simple]"); if (s) s.style.display = sel.value === "simple" ? "" : "none"; }; sel.onchange = tog; tog(); }
      const out = ov.querySelector('[data-s="out"]');
      const sv = ov.querySelector('[data-s="save"]');
      if (sv) sv.onclick = async () => {
        collect(); await saveCfg(); render();
        if (fixedLinks.length) { draw(); ov.querySelector('[data-s="out"]').innerHTML = `<span class="bad">You pasted the web app link (script.google.com…) into a “Sheet link” box - I moved it. A Sheet link is the address of the Google Sheet itself: docs.google.com/spreadsheets/d/…</span>`; return; }
        out.innerHTML = `<span class="ok">Saved ✓</span>`;
      };
      const ts = ov.querySelector('[data-s="test"]');
      if (ts) ts.onclick = async () => {
        collect(); await saveCfg(); out.textContent = "Testing…";
        const r = await sheet("ping");
        if (!r.ok) { out.innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
        const c = r.columns || {};
        const miss = ["tracking", "status"].filter((k) => !c[k]);
        out.innerHTML = `<span class="${miss.length ? "bad" : "ok"}">Connected to “${esc(r.file || "")}” › tab “${esc(r.sheet)}” ${miss.length ? "- missing: " + miss.join(", ") : "✓"}</span><br>
          Headings on sheet row ${r.headerRow}, orders on sheet rows ${r.firstRow} → ${r.lastRow}<br>${Object.entries(c).map(([k, v]) => `${esc(k)}: <b>${esc(v)}</b>`).join("<br>")}`;
      };
      const addS = ov.querySelector('[data-s="addsheet"]');
      if (addS) addS.onclick = () => { collect(); cfg.sheets = (cfg.sheets || []).concat([{ name: "Sheet " + ((cfg.sheets || []).length + 1), link: "", url: "" }]); draw(); };
      const addT = ov.querySelector('[data-s="addthis"]');
      if (addT) addT.onclick = () => { collect(); const p = pageSheet(); cfg.sheets = (cfg.sheets || []).concat([{ name: p.sheetName || "This sheet", link: here().href.split("?")[0], url: "" }]); draw(); };
      ov.querySelectorAll("[data-shdel]").forEach((b) => b.onclick = () => { collect(); cfg.sheets.splice(+b.dataset.shdel, 1); if (String(cfg.sheetSel) === b.dataset.shdel) cfg.sheetSel = "page"; draw(); });
      ov.querySelectorAll("[data-shtest]").forEach((b) => b.onclick = async () => {
        collect(); await saveCfg(); render();
        const i = +b.dataset.shtest, x = cfg.sheets[i], o = ov.querySelector(`[data-shout="${i}"]`), pl = parseLink(x.link);
        if (!pl.sheetId) { draw(); const o2 = ov.querySelector(`[data-shout="${i}"]`); if (o2) o2.innerHTML = `<span class="bad">Paste the Google Sheet's own link here (docs.google.com/spreadsheets/d/…), not the web app link</span>`; return; }
        o.textContent = "Testing…";
        const r = await sheet("ping", {}, { sheetId: pl.sheetId, gid: pl.gid, url: x.url });
        o.innerHTML = r.ok ? `<span class="${r.columns && r.columns.tracking && r.columns.status ? "ok" : "bad"}">“${esc(r.file || "")}” › ${esc(r.sheet)} · rows ${r.firstRow} → ${r.lastRow} · ${esc(Object.values(r.columns || {}).join(", "))}</span>` : `<span class="bad">${esc(r.error)}</span>`;
      });
      const dsel = ov.querySelector('[data-sc="days"]');
      if (dsel) dsel.value = (cfg.schedule && cfg.schedule.days) || "daily";
      const ss = ov.querySelector('[data-s="schedsave"]');
      if (ss) {
        const so = ov.querySelector('[data-s="schedout"]');
        const show = async (next) => {
          const last = await store.get("sctrk_lastStart", null);
          so.innerHTML = (next ? `<span class="ok">Next run: ${new Date(next).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>` : "Schedule is off.")
            + (cfg.schedule && cfg.schedule.on ? (last ? `<br>Uses the settings of your Start on ${new Date(last.savedAt).toLocaleString()} - ${esc(last.sheetName || "sheet")} · ${esc(last.rangeText || "")}` : `<br><span class="bad">Press ▶ Start once by hand - the schedule repeats that Start's settings.</span>`) : "");
        };
        ss.onclick = async () => {
          cfg.schedule = { on: ov.querySelector('[data-sc="on"]').checked, time: ov.querySelector('[data-sc="time"]').value || "08:30", days: dsel.value };
          await saveCfg();
          const r = await bg({ type: "schedule", sched: cfg.schedule });
          show(r && r.next);
        };
        store.get("sctrk_schedNext", 0).then((n) => show(cfg.schedule && cfg.schedule.on ? n : 0));
      }
      const tm = ov.querySelector('[data-s="team"]');
      if (tm) tm.onclick = () => {
        const blob = new Blob([JSON.stringify(Object.assign({}, cfg, { savedAt: Date.now() }), null, 2)], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "team-settings.json"; document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      };

      const dbStat = ov.querySelector('[data-s="dbstatus"]');
      const dbShow = async () => { if (!dbStat) return; const r = await bg({ type: "dbStatus" }); dbStat.innerHTML = r && r.signedIn ? `<span class="ok">Signed in as ${esc(r.email)} ✓</span>${r.synced ? ` · ${r.synced} rows synced this run` : ""}${r.alert ? `<br><span class="bad">${esc(r.alert)}</span>` : ""}` : `<span class="warn">Not signed in</span>`; };
      const dbIn = ov.querySelector('[data-s="dbsignin"]');
      if (dbIn) dbIn.onclick = async () => {
        collect(); await saveCfg();
        const pw = ov.querySelector("[data-dbp]"); const r = await bg({ type: "dbSignIn", email: cfg.dbEmail, password: (pw && pw.value) || "", url: cfg.dbUrl, apiKey: cfg.dbApiKey });
        if (pw) pw.value = "";
        if (dbStat) dbStat.innerHTML = r && r.ok ? `<span class="ok">Signed in as ${esc(r.email)} ✓</span>` : `<span class="bad">${esc((r && r.error) || "sign-in failed")}</span>`;
      };
      const dbTe = ov.querySelector('[data-s="dbtest"]');
      if (dbTe) dbTe.onclick = async () => { await dbShow(); };
      const dbOut = ov.querySelector('[data-s="dbout"]');
      if (dbOut) dbOut.onclick = async () => { await bg({ type: "dbSignOut" }); await dbShow(); };
      if (tab === "db") dbShow();
    }
    let fixedLinks = [];
    function collect() {
      ov.querySelectorAll("[data-sh]").forEach((el) => { const x = cfg.sheets[+el.dataset.sh]; if (x) x[el.dataset.f] = el.value.trim(); });
      fixedLinks = [];
      (cfg.sheets || []).forEach((x, i) => {
        if (/script\.google\.com\/macros/i.test(x.link || "")) {     // that's the web app link, not the sheet's link
          const w = x.link.replace(/\s+/g, ""); x.link = "";
          const main = ov.querySelector('[data-k="url"]');
          if (main && !main.value.trim()) main.value = w; else if (main && main.value.trim() !== w) x.url = w;
          fixedLinks.push(i);
        }
      });
      ov.querySelectorAll("[data-k2]").forEach((el) => { cfg[el.dataset.k2] = el.checked; });
      ov.querySelectorAll("[data-k]").forEach((el) => {
        const k = el.dataset.k; let v = el.value.trim();
        if (/^col/.test(k)) v = v.toUpperCase().replace(/[^A-Z]/g, "");
        if (k === "url") v = v.replace(/\s+/g, "");
        cfg[k] = v;
      });
    }
    draw();
  }

  // ---------------- boot ----------------
  async function boot() {
    cfg = Object.assign({}, DEFAULTS, await store.get(CFG_KEY, {}));
    delete cfg.skipDelivered; if (!String(cfg.uspsFilter || '').trim()) cfg.uspsFilter = DEFAULTS.uspsFilter;
    try {   // team settings file in the bot folder (newer than this PC's settings wins)
      const r = await fetch(chrome.runtime.getURL("team-settings.json"));
      if (r.ok) { const t = await r.json(); if (t && (t.savedAt || 0) > (cfg.savedAt || 0)) { cfg = Object.assign({}, DEFAULTS, t); await store.set(CFG_KEY, cfg); setTimeout(() => log("Team settings loaded ✓", "ok"), 300); } }
    } catch {}
    if (!String(cfg.url || "").trim()) { cfg.url = DEFAULT_URL; await store.set(CFG_KEY, cfg); }
    if (!cfg.cfgV) { cfg.style = "track123"; cfg.cfgV = 2; await store.set(CFG_KEY, cfg); }
    if ((cfg.cfgV || 0) < 4) {   // v4: Expired is final too - skip it like Delivered
      if (/^\s*delivered\s*$/i.test(String(cfg.skip || "Delivered"))) cfg.skip = "Delivered, Expired";
    }
    if ((cfg.cfgV || 0) < 3) {   // Amazon: Track123's auto-detect does it best - drop the old forced Amazon rule
      cfg.carrierMap = String(cfg.carrierMap || "").split(/\n/).filter((l) => !/^\s*amazon[^=]*=/i.test(l)).join("\n");
    }
    if ((cfg.cfgV || 0) < 4) { cfg.cfgV = 4; await store.set(CFG_KEY, cfg); }
    if (/^\s*TBA\s*=\s*amazon shipping api v2\s*$/i.test(String(cfg.prefixMap || ""))) { cfg.prefixMap = "TBA = Amazon Shipping + Amazon MCF"; await store.set(CFG_KEY, cfg); }
    if (cfg.pair && !cfg.tabsSet) { cfg.tabs = 2; cfg.tabsSet = true; await store.set(CFG_KEY, cfg); }   // the old 2× box
    job = await store.get(JOB_KEY, {});
    logLines = await store.get(LOG_KEY, []);
    const me = await bg({ type: "whoami" });
    myTab = me.tabId || null; WORKER = me.worker || null;
    if (WORKS) buildChip(); else buildPanel();
    if (SITE === "sheet" && (await store.get(UI_KEY, {}))["min_" + SITE]) panel.classList.add("min");
    if (SITE === "side") {      // follow the tab that is open next to the side panel
      const upd = async () => { try { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); sideTab = { url: (t && t.url) || "", title: (t && t.title) || "" }; } catch {} render(); };
      chrome.tabs.onActivated.addListener(upd);
      chrome.tabs.onUpdated.addListener((_id, ch, t) => { if (t.active && (ch.url || ch.title)) upd(); });
      upd();
    }
    render(); paintLog();
    if (!WORKS) store.get("sctrk_problems", null).then(paintProbs);
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.sctrk_problems && !WORKS) paintProbs(ch.sctrk_problems.newValue || null);
      if (ch[JOB_KEY]) { job = ch[JOB_KEY].newValue || {}; render(); if (job.running) maybeWork(); }
      if (ch[LOG_KEY]) { logLines = ch[LOG_KEY].newValue || []; paintLog(); }
      if (ch[CFG_KEY]) { cfg = Object.assign({}, DEFAULTS, ch[CFG_KEY].newValue || {}); if (!String(cfg.url || "").trim()) cfg.url = DEFAULT_URL; render(); }
    });
    chrome.runtime.onMessage.addListener((m, _s, reply) => {
      if (m && m.type === "ping") { if (SITE === "side") return; reply({ ok: true, site: SITE }); }
      if (m && m.type === "kick" && WORKS) { reply({ ok: true }); maybeWork(true); }
      if (m && m.type === "harvest" && WORKS) { harvestNow = true; reply({ ok: true }); }
      if (m && m.type === "uspsGrab" && SITE === "usps") { const { out } = uspsWrites(uspsCards()); reply({ items: out }); }
    });
    if (!cfg.url) log("Welcome! Open ⚙ Settings > Google Sheet to connect your sheet.", "warn");
    maybeWork(true);
  }
  async function maybeWork(ask) {
    if (!WORKS || engineOn) return;
    if (SITE === "usps" && /^\/go\//i.test(location.pathname)) return;     // usps.com is still forwarding to the results page
    if (ask || !WORKER) { const me = await bg({ type: "whoami" }); WORKER = me.worker || null; }
    if (WORKER && job.running) engine();
  }
  boot();
})();
