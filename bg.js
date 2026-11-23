// ShipCube Tracking Bot - background = the "dispatcher"
//
//  * At Start it reads the WHOLE row range from the sheet once (one call) into a queue.
//  * Every Track123 tab ("worker") takes the next free 100 from that queue - instantly, no sheet call,
//    no waiting for the other tabs. 1, 2, 3 or 4 tabs all really work at the same time.
//  * Results come back here and ONE writer pastes them into the sheet in big blocks, in the background,
//    while the tabs already track their next 100. The tabs never wait for Google Sheets.
//  * Numbers without a status yet are tracked again at the end (up to 3 tries).
//
// Also: talks to the Apps Script web app (only Apps Script /exec links), keeps the shared log.

const ALLOWED = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(\?.*)?$/;
const TRACK_URLS = ["https://www.track123.com/*", "https://track123.com/*"];
const TRACK_URL = "https://www.track123.com/track?trackNos=";
const JOB_KEY = "sctrk_job", Q_KEY = "sctrk_q", LOG_KEY = "sctrk_log";
const VALID_TN = /^[A-Za-z0-9-]{5,50}$/;
const MAX_BLANK = 8;      // a USPS number is put back this many times when usps.com shows a blank page
const BATCH = 100, MAX_TRIES = 3, WRITE_CHUNK = 400, MAX_TABS = 10;
// USPS rows (Carrier column = USPS / shippo__usps / endicia) are tracked on usps.com, 35 per page
const USPS_URL = "https://tools.usps.com/go/TrackConfirmAction?tLabels=", USPS_BATCH = 35, USPS_HOME = "https://tools.usps.com/tracking/";

// ---------------- state (kept in memory, saved so a sleeping service worker picks up where it was) ----------------
let S = null;
const fresh = () => ({
  running: false, paused: false, pausedBy: "", finishing: false, mode: "auto", tabs: 2,
  req: null, sheetName: "", sheetId: "", rangeText: "",
  queue: [], pos: 0, left: [], inflight: {}, buffer: [], writing: false,
  workers: {},          // tabId -> worker number (1..4)
  wstate: {},           // worker number -> { state, rows, n, at }
  total: 0, written: 0, round: 1, totals: { checked: 0, delivered: 0, notDelivered: 0, notFound: 0 },
  note: "", alert: "", startedAt: 0, finishedAt: 0, gaveUp: [],
  gentle: true, rest: {}, active: 2, cool: { until: 0, level: 0, clean: 0 },   // pacing: pauses + automatic slow-down
  uq: [], upos: 0, utabs: 1, ucool: 0, wsite: {},     // the USPS queue + which site each worker tab is on
  db: false, dbLeft: [], dbSynced: 0, dbAlert: "", dbBusy: false,   // database sync: rows still to write, rows written
  ucap: 0, ublank: 0, ustop: "", ubudget: 3000,          // USPS pacing: tab ceiling, blank pages in a row, why usps.com was stopped, daily limit
});
const canRetry = (x) => (x.tries || 0) < MAX_TRIES && (x.blank || 0) < MAX_BLANK && !(S.ustop && x.site === "usps");
const qLeft = () => Math.max(0, S.queue.length - S.pos) + (S.ustop ? 0 : Math.max(0, (S.uq || []).length - (S.upos || 0)));
const rand = (a, b) => a + Math.round(Math.random() * (b - a));

// ---------------- results: totals, "never back from Delivered", problem shipments ----------------
function addTotal(st, n) {
  n = n || 1;
  if (/^delivered$/i.test(st)) S.totals.delivered += n; else if (/^not found$/i.test(st)) S.totals.notFound += n; else S.totals.notDelivered += n;
  S.totals.checked += n;
}
const PROB_KEY = "sctrk_problems", STUCK_DAYS = 7;
const daysSince = (d) => { const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return 0; return Math.floor((Date.now() - new Date(+m[1], +m[2] - 1, +m[3]).getTime()) / 864e5); };
// a written row worth a look: Exception / Failed attempt / Expired / returned, or no movement for 7+ days
function checkProblem(w) {
  const st = String(w.st || w.status || "");
  if (!st || /^(delivered|not found)$/i.test(st)) return;
  let why = "";
  if (/exception|alert|return|undeliverable|refused/i.test(st)) why = st;
  else if (/failed attempt|attempt/i.test(st)) why = "Failed attempt";
  else if (/expired/i.test(st)) why = "Expired (no updates for a long time)";
  else { const d = daysSince(w.date); if (d >= STUCK_DAYS) why = `No movement for ${d} days`; }
  if (why && (S.problems = S.problems || []).length < 2000) S.problems.push({ row: w.row, tn: w.tn, st, date: w.date || "", why });
}
// rows that were Delivered in the sheet are never set back to an earlier status (a flaky page can't undo a delivery)
function guard(writes) {
  if (!S.runCode || !S.guardOn) return writes;
  return writes.filter((w) => {
    const c = S.runCode[w.row];
    if (!c || !c[4] || w.del) return true;
    (S.kept = S.kept || []).push(w.row);
    if ((S.problems = S.problems || []).length < 2000) S.problems.push({ row: w.row, tn: w.tn, st: String(w.st || w.status || ""), date: w.date || "", why: `Was Delivered, now shows “${w.st || w.status}” - kept Delivered` });
    return false;
  });
}

// ---------------- usps.com daily limit (counted per PC per calendar day, kept across runs) ----------------
const UB_KEY = "sctrk_ubud";
let ubud = { day: "", n: 0 };
chrome.storage.local.get(UB_KEY).then((r) => { if (r[UB_KEY]) ubud = r[UB_KEY]; }).catch(() => {});
const today = () => new Date().toLocaleDateString("en-CA");
function budgetLeft() {
  if (ubud.day !== today()) ubud = { day: today(), n: 0 };
  return S.ubudget > 0 ? Math.max(0, S.ubudget - ubud.n) : Infinity;
}
function spendBudget(k) { budgetLeft(); ubud.n += k; chrome.storage.local.set({ [UB_KEY]: ubud }).catch(() => {}); }
// the usps.com part stops for now (blocked twice in a row, or today's limit reached): Track123 carries on,
// the USPS rows not done yet stay EMPTY in the sheet - an "Only blank" run later picks them up
function parkUsps(why) {
  if (S.ustop) return;
  S.ustop = why;
  const n = Math.max(0, (S.uq || []).length - (S.upos || 0)) + S.left.filter((x) => x.site === "usps").length;
  const t123 = S.queue.length > S.pos || Object.values(S.wsite || {}).some((x) => x !== "usps") ? " (Track123 carries on)" : "";
  log(why === "denied"
    ? `usps.com answered “Access Denied” - it has blocked this PC's internet connection for now. It was still denied after waiting 1 + 2 + 3 hours, so usps.com is stopped for this run. ${n} USPS row(s) stay empty: wait a few hours (best: until tomorrow), check that tools.usps.com opens normally, then run “Only blank” on the Careful speed${t123}.`
    : why === "budget"
    ? `usps.com: today's limit of ${S.ubudget} lookups is reached - stopping usps.com for today. ${n} USPS row(s) stay empty; run “Only blank” tomorrow${t123}.`
    : `usps.com was still blocking after resting 2 + 10 + 20 + 30 min - stopping usps.com for now so it doesn't get worse. ${n} USPS row(s) stay empty; run “Only blank” later${t123}.`, "warn");
  save(true); checkFinish();
}
const RC_KEY = "sctrk_rc";     // this run's rows (for the final sweep) - kept apart, it's big and doesn't change
const ready = chrome.storage.local.get([Q_KEY, RC_KEY]).then((r) => { S = Object.assign(fresh(), r[Q_KEY] || {}); S.runCode = r[RC_KEY] || null; S.writing = false; if (S.buffer.length) flush(); });
let saveT = null;
function save(now) {
  clearTimeout(saveT);
  const go = () => {
    const { runCode, ...rest } = S; void runCode;
    chrome.storage.local.set({ [Q_KEY]: rest, [JOB_KEY]: summary() });
  };
  if (now) go(); else saveT = setTimeout(go, 150);
}
// small summary for the panels (they redraw when it changes)
function summary() {
  const inflight = Object.keys(S.inflight).length;
  return {
    running: S.running, paused: S.paused, pausedBy: S.pausedBy, finishing: S.finishing, mode: S.mode, tabs: S.tabs,
    sheetName: S.sheetName, sheetId: S.sheetId, gid: (S.req && S.req.base && S.req.base.gid) || "", rangeText: S.rangeText,
    total: S.total, left: qLeft(), uLeft: Math.max(0, (S.uq || []).length - (S.upos || 0)), retryLeft: S.left.filter(canRetry).length,
    inflight, pending: S.buffer.length, writing: S.writing, written: S.written, round: S.round,
    totals: S.totals, wstate: S.wstate, note: S.note, alert: S.alert, gaveUp: S.gaveUp.length,
    active: S.active, coolUntil: S.cool ? S.cool.until : 0, uactive: S.uactive, utabs: S.utabs, ucool: S.ucool || 0,
    ucap: S.ucap || S.utabs, ustop: S.ustop || "", uday: ubud.day === today() ? ubud.n : 0, ubudget: S.ubudget,
    canResume: !S.running && qLeft() > 0, startedAt: S.startedAt, finishedAt: S.finishedAt, at: Date.now(),
  };
}

// ---------------- shared log (only the background writes it, so no line is ever lost) ----------------
let logChain = Promise.resolve();
function log(m, c) {
  const line = { t: new Date().toTimeString().slice(0, 8), m: String(m), c: c || "" };
  logChain = logChain.then(async () => {
    const cur = (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || [];
    await chrome.storage.local.set({ [LOG_KEY]: cur.concat([line]).slice(-150) });
  }).catch(() => {});
}

// ---------------- Google Sheet (Apps Script web app) ----------------
const pageText = (t) => {
  const title = (t.match(/<title[^>]*>([^<]*)/i) || [])[1] || "";
  const body = t.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return (title + " - " + body).slice(0, 220);
};
// Google sometimes answers with a web page instead of the result (busy / hiccup / signed-in-account mix-up):
// send without cookies first, retry a few times, and say what Google's page said if it still fails.
async function callSheet(url, body) {
  if (!ALLOWED.test(url || "")) return { ok: false, error: "That isn't an Apps Script web app link (it must end with /exec)" };
  let last = "";
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, redirect: "follow", credentials: i % 2 === 0 ? "omit" : "include" });
      const t = await r.text();
      try { return JSON.parse(t); } catch {}
      last = /<html/i.test(t) ? "Google returned a web page: " + pageText(t) : "Unexpected reply: " + t.slice(0, 150);
    } catch (e) { last = "Network error: " + e.message; }
    await new Promise((res) => setTimeout(res, [800, 1500, 3000, 5000, 0][i]));
  }
  if (/authoriz|permission|access/i.test(last)) last += " - open the script, Deploy > Manage deployments > edit > New version > Deploy, allow access, and check 'Who has access: Anyone'.";
  return { ok: false, error: last };
}
// "The sheet is busy" (another write - maybe another PC or profile - has its turn): wait and try again, up to ~2 min
async function sheetCall(action, extra) {
  const body = JSON.stringify(Object.assign({}, S.req.base, { action }, extra || {}));
  let r;
  for (let i = 0; i < 8; i++) {
    r = await callSheet(S.req.url, body);
    if (r.ok || !(r.busy || /sheet is busy|lock|too many simultaneous|service invoked too many times/i.test(r.error || ""))) return r;
    if (S.running) S.alert = "The sheet is busy (someone else is writing) - the bot waits its turn, nothing is lost.";
    await new Promise((res) => setTimeout(res, [3000, 5000, 8000, 10000, 15000, 20000, 25000, 30000][i]));
  }
  return r;
}

// read the whole range at once ('list'); an older script without 'list' is read 100 at a time instead
async function readRange(o) {
  const ask = { from: o.from || "", to: o.to || "", dir: o.dir, skip: o.skip || [], only: o.only || [], onlyBlank: !!o.onlyBlank, fresh: +o.fresh || 0, now: o.now || "" };
  let r = await sheetCall("list", ask);
  if (r.ok) return r;
  if (!/unknown action/i.test(r.error || "")) return r;
  log("Your sheet script is an older version - reading the rows 100 at a time (update the script for an instant start).", "warn");
  const all = { ok: true, items: [], broken: [], invalid: [], skipped: 0 };
  let cursor = "";
  for (let i = 0; i < 1000; i++) {
    r = await sheetCall("next", Object.assign({ limit: 100, cursor }, ask));
    if (!r.ok) return r;
    all.items.push(...(r.items || [])); all.broken.push(...(r.broken || [])); all.invalid.push(...(r.invalid || [])); all.skipped += r.skipped || 0;
    Object.assign(all, { from: r.from, to: r.to, dir: r.dir });
    if (!r.items || !r.items.length || !(r.remaining > 0)) break;
    cursor = r.nextRow; ask.from = r.from; ask.to = r.to;
  }
  return all;
}

// ---------------- carriers: the sheet's Carrier column -> Track123 carrier code ('' = auto-detect) ----------------
//   1. your rules in Settings (they win - e.g. "dhl = dhlglobalmail")
//   2. otherwise Track123's own list of ~2,400 carriers: "Uni_Uni", "UNIUNI", "uni uni" -> uniuni, "OnTrac" -> ontrac …
//   3. not recognised -> auto-detect (and the log names it, so you can add a rule)
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const FILLER = /\b(inc|llc|ltd|co|corp|company|shipping|logistics|courier|delivery|deliveries|services?|group|carrier|parcel|post)\b/g;
function courierIndex(list) {
  const byCode = new Map(), byName = new Map(), names = [];
  (list || []).forEach(([code, name, type]) => {
    const pri = type === 1 ? 0 : 1;          // 1 = parcel carrier (preferred over airlines / shipping lines)
    const k1 = norm(code), k2 = norm(name);
    if (k1 && (!byCode.has(k1) || byCode.get(k1).pri > pri)) byCode.set(k1, { code, pri });
    if (k2 && (!byName.has(k2) || byName.get(k2).pri > pri)) byName.set(k2, { code, pri });
    if (k2 && type === 1) names.push([k2, code]);
  });
  return { byCode, byName, names, size: (list || []).length, codes: new Set((list || []).map((x) => x[0])) };
}
// ShipCube's main carriers, exactly as they come in the sheet (used when no rule in Settings matches)
const MAIN = { usps: "usps", shippousps: "usps", uspsmodern: "usps", endicia: "usps", stampscom: "usps", uniuni: "uniuni", gofo: "gofo-express", dhlecommerce: "dhlglobalmail", ups: "ups", fedex: "fedex" };
// Amazon: Track123 has several "Amazon shipping" carriers (India, UK, Italy …). ShipCube's are always the US one,
// "Amazon Shipping + Amazon MCF" - found by its NAME in Track123's own list, so no code is hard-coded.
function amazonCode(idx) {
  if (!idx || !idx.byName) return "";
  const h = idx.byName.get("amazonshippingamazonmcf");
  if (h) return h.code;
  for (const [k, x] of idx.byName) if (/^amazon/.test(k) && /mcf/.test(k)) return x.code;
  return "";
}
// a carrier typed by a person (Settings rule, prefix line): a Track123 code OR a carrier name -> the Track123 code
function resolveCarrier(val, idx) {
  const raw = String(val || "").trim();
  if (!raw || /^auto$/i.test(raw)) return "";
  const v = norm(raw);
  if (/^amazon/.test(v)) return amazonCode(idx);                 // any "amazon…" = Amazon Shipping + Amazon MCF ("" = auto-detect if the list isn't loaded)
  if (!idx || !idx.size) return raw;
  if (idx.codes.has(raw)) return raw;
  const h = idx.byCode.get(v) || idx.byName.get(v);
  return h ? h.code : raw;
}
function codeFor(carrier, rules, idx, tn, prefixRules) {
  const raw = String(carrier || "").trim();
  const v = norm(raw);
  // Carrier column is empty: try the tracking-number prefix (e.g. TBA… → amazon)
  if (!v && tn && prefixRules && prefixRules.length) {
    const up = String(tn).toUpperCase();
    for (const [pfx, code] of prefixRules) { if (pfx && up.startsWith(pfx)) return { code: resolveCarrier(code, idx), how: "prefix", pfx }; }
  }
  if (!v) return { code: "", how: "empty" };
  for (const [pat, code] of rules || []) { const p = norm(pat); if (p && v.includes(p)) return { code: resolveCarrier(code, idx), how: "rule" }; }
  if (Object.prototype.hasOwnProperty.call(MAIN, v)) return { code: MAIN[v], how: "main" };
  if (/^amazon/.test(v)) return { code: amazonCode(idx), how: "main" };    // amazon_shipping_api_v2, Amazon, Amazon Shipping … (never India / UK / Italy)
  if (!idx || !idx.size) return { code: "", how: "unknown" };
  const exact = (k) => k && (idx.byCode.get(k) || idx.byName.get(k));
  let hit = exact(v) || exact(norm(raw.toLowerCase().replace(/[_\-]+/g, " ").replace(FILLER, " ")));
  if (!hit && v.length >= 4) {                 // "GOFO Express" ~ "GOFO" - only if exactly one carrier fits
    const c = idx.names.filter(([k]) => k.length >= 4 && (k.startsWith(v) || v.startsWith(k)));
    const codes = [...new Set(c.map((x) => x[1]))];
    if (codes.length === 1) hit = { code: codes[0] };
  }
  return hit ? { code: hit.code, how: "list" } : { code: "", how: "unknown" };
}
// same-carrier rows go together (one Track123 page = one carrier); row order is kept inside each carrier
function byCarrier(list) {
  const groups = new Map();
  list.forEach((x) => { const k = x.code || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); });
  return [...groups.values()].flat();
}

// ---------------- the writer: pastes results into the sheet in big blocks, one call at a time ----------------
async function flush() {
  if (!S || S.writing || !S.buffer.length || !S.req) return;
  S.writing = true; save();
  const chunk = S.buffer.slice(0, WRITE_CHUNK);
  const r = await sheetCall("update", { items: chunk });
  if (r.ok) {
    S.buffer.splice(0, chunk.length);
    S.written += r.written || 0;
    if (S.alert && /sheet/i.test(S.alert)) S.alert = "";
    if (r.missing && r.missing.length) log(`${r.missing.length} number(s) were not found in the sheet any more (rows deleted?) - skipped.`, "warn");
    if (S.db) S.dbLeft = (S.dbLeft || []).concat(chunk.map((x) => x.row));
    S.writing = false; save();
    if (S.db && S.dbLeft.length) await dbFlush();
  } else {
    S.writing = false;
    S.alert = "Can't write to the sheet right now - retrying: " + r.error;
    log("Sheet: " + r.error + " - retrying in 10 s (nothing is lost).", "bad");
    save();
    await new Promise((res) => setTimeout(res, 10000));
  }
  if (S.buffer.length) return flush();
  checkFinish();
}

// ---------------- Firebase (database) ----------------
// After every sheet write the bot reads back EVERY column of those rows ('rows' action) and sends them to the
// Cloud Function "sync", which writes Firestore (shipments + history). The sheet stays the same as before.
// Settings kept in chrome.storage.local: { url, apiKey, refresh, email, idToken, exp }.  The password is never stored.
const DB_KEY = "sctrk_db";
async function dbCfg() { return ((await chrome.storage.local.get(DB_KEY))[DB_KEY]) || null; }
async function dbSaveCfg(c) { await chrome.storage.local.set({ [DB_KEY]: c }); }
async function dbLogin(email, password, url, apiKey) {
  if (!url || !apiKey) return { ok: false, error: "Enter the database link and the Firebase Web API key" };
  const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + encodeURIComponent(apiKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (j.error && j.error.message) || "Sign-in failed" };
  if (!/@shipcube\.com$/i.test(j.email || "")) return { ok: false, error: "Only @shipcube.com accounts can use the database" };
  await dbSaveCfg({ url: String(url).replace(/\/+$/, ""), apiKey, refresh: j.refreshToken, email: j.email, idToken: j.idToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000 - 60000 });
  log("Database: signed in as " + j.email + ".", "ok");
  return { ok: true, email: j.email };
}
async function dbToken(c) {
  if (c.idToken && c.exp > Date.now()) return c.idToken;
  const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(c.apiKey), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(c.refresh) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id_token) throw new Error("database sign-in expired - sign in again in the bot's Settings");
  c.idToken = j.id_token; c.refresh = j.refresh_token || c.refresh; c.exp = Date.now() + (+j.expires_in || 3600) * 1000 - 60000;
  await dbSaveCfg(c);
  return c.idToken;
}
async function dbCall(c, path, body) {
  const tok = await dbToken(c);
  const r = await fetch(c.url + "/" + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) });
  let j; try { j = await r.json(); } catch { j = { ok: false, error: "database replied " + r.status }; }
  return j;
}
// writes the rows waiting in S.dbLeft: read all columns from the sheet, then send them to the database
async function dbFlush() {
  if (!S || !S.db || !S.dbLeft || !S.dbLeft.length || S.dbBusy) return;
  S.dbBusy = true; save();
  let tries = 0;
  try {
    const c = await dbCfg();
    if (!c || !c.refresh) throw new Error("not signed in to the database");
    while (S.dbLeft.length && tries < 3) {
      const rows = [...new Set(S.dbLeft)].slice(0, 200);
      const sr = await sheetCall("rows", { rows });                       // every column of these rows, after the status write
      if (!sr.ok) throw new Error("reading the sheet rows: " + sr.error);
      const dr = await dbCall(c, "sync", { source: (S.req && S.req.base && S.req.base.tab) || "", headers: sr.headers, rows: sr.rows });
      if (!dr.ok) throw new Error("database: " + (dr.error || "write failed"));
      S.dbLeft = S.dbLeft.filter((r) => rows.indexOf(r) === -1);
      S.dbSynced = (S.dbSynced || 0) + (dr.written || rows.length);
      S.dbAlert = ""; save();
    }
  } catch (e) {
    tries++;
    S.dbAlert = "Database write paused: " + e.message + " - the sheet is already up to date; the bot retries on the next run.";
    log("Database: " + e.message, "bad");
  } finally { S.dbBusy = false; save(); }
}

// ---------------- the queue ----------------
function nextBatch(site, max) {
  if (site === "usps") {
    const items = [], seen = new Set(), cap = Math.max(1, Math.min(USPS_BATCH, max || USPS_BATCH));
    while (S.upos < S.uq.length) {
      const it = S.uq[S.upos], k = it.tn.toUpperCase();
      const own = notUsps(it.car || "", k);
      if (own) {              // only USPS numbers (9…, USPS carriers) are ever searched on usps.com - in any mode or round
        S.upos++; S.ugated = (S.ugated || 0) + 1; S.total = Math.max(0, (S.total || 0) - 1);
        if (S.ugated === 1 || S.ugated % 100 === 0) log(`Not sent to usps.com: row ${it.row} (${k.slice(0, 4)}… · ${own})${S.ugated > 1 ? ` - ${S.ugated} so far` : ""}. Left as it is in the sheet.`);
        continue;
      }
      if (!seen.has(k) && seen.size >= cap) break;
      seen.add(k); items.push(it); S.upos++;
    }
    if (!items.length) return null;
    return { items, tns: [...seen], url: USPS_URL + [...seen].join(","), code: "", site: "usps" };
  }
  const items = [], seen = new Set();
  const code = S.pos < S.queue.length ? S.queue[S.pos].code || "" : "";
  while (S.pos < S.queue.length) {
    const it = S.queue[S.pos], k = it.tn.toUpperCase();
    if ((it.code || "") !== code) break;                    // one carrier per Track123 page
    if (!seen.has(k) && seen.size >= BATCH) break;
    seen.add(k); items.push(it); S.pos++;
  }
  if (!items.length) return null;
  const url = TRACK_URL + [...seen].map(encodeURIComponent).join(",") + (code ? "&code=" + encodeURIComponent(code) : "");
  return { items, tns: [...seen], url, code };
}
// how many Track123 pages the queue still needs (a page = up to 100 numbers, one carrier per page - same rule as nextBatch)
function trackBatches() {
  let n = 0, seen = new Set(), code = null;
  for (let i = S.pos; i < S.queue.length; i++) {
    const it = S.queue[i], c = it.code || "", k = it.tn.toUpperCase();
    if (c !== code || (!seen.has(k) && seen.size >= BATCH)) { n++; code = c; seen = new Set(); }
    seen.add(k);
  }
  return n;
}
const rowsText = (items) => { const r = items.map((x) => x.row); return `${Math.min(...r)}–${Math.max(...r)}`; };

function checkFinish() {
  if (!S.running || qLeft() > 0 || Object.keys(S.inflight).length) return;
  const todo = S.left.filter(canRetry);
  if (todo.length) {                      // a retry round for the numbers that had no status yet
    S.left = S.left.filter((x) => !canRetry(x));
    S.queue = byCarrier(todo.filter((x) => x.site !== "usps")); S.pos = 0; S.round++;
    S.uq = todo.filter((x) => x.site === "usps"); S.upos = 0;
    const viaT = S.uq.filter((x) => x.viaT123).length;
    if (viaT) log(`${viaT} USPS number(s) Track123 couldn't find - checking them on usps.com.`);
    if (S.uq.length && !S.ustop) ensureUspsTabs();
    log(`Retrying ${todo.length} number(s) that had no status yet (round ${S.round})…`, "warn");
    save(true); kickAll(); return;
  }
  const xc = S.left.filter((x) => x.xcheck);
  if (xc.length) {                         // Track123 never answered for these: the usps.com status is written
    S.left = S.left.filter((x) => !x.xcheck);
    const ws = guard(xc.map((x) => x.xcheck)); ws.forEach((w) => { addTotal(w.st); checkProblem(w); }); S.buffer.push(...ws);
    save(); flush(); return;
  }
  if (S.buffer.length || S.writing) { S.finishing = true; save(); return; }   // wait for the last write
  if (S.sweeping) return;
  if (!S.swept && S.runCode && S.rng) { sweep(); return; }   // last check: anything of this run still empty in the sheet?
  if (S.ustop) {
    const parked = S.left.filter((x) => x.site === "usps").length + Math.max(0, (S.uq || []).length - (S.upos || 0));
    S.left = S.left.filter((x) => x.site !== "usps");
    if (parked) log(`${parked} USPS row(s) were left empty because usps.com was stopped (${S.ustop === "budget" ? "daily limit" : "blocked"}) - run “Only blank” on this range later.`, "warn");
  }
  S.gaveUp = S.left;
  if (S.left.length) log(`Still no status after all tries (left unchanged): sheet rows ${S.left.slice(0, 15).map((x) => x.row).join(", ")}${S.left.length > 15 ? "…" : ""}`, "warn");
  if (S.kept && S.kept.length) log(`Kept “Delivered” on ${S.kept.length} row(s) where the check now showed an earlier status: rows ${S.kept.slice(0, 15).join(", ")}${S.kept.length > 15 ? "…" : ""}`, "warn");
  const probs = S.problems || [];
  chrome.storage.local.set({ [PROB_KEY]: { at: Date.now(), sheet: S.sheetName || "", list: probs } }).catch(() => {});
  if (probs.length) log(`⚠ ${probs.length} problem shipment(s) - Exception / Failed attempt / Expired / no movement for ${STUCK_DAYS}+ days. See “Problem shipments” in the panel.`, "warn");
  const secs = Math.max(1, Math.round((Date.now() - S.startedAt) / 1000));
  if (S.scheduled) notify("Scheduled tracking run finished", `${S.totals.checked} checked · ${S.totals.delivered} delivered · ${probs.length} problem shipment(s)${S.gaveUp.length ? ` · ${S.gaveUp.length} without a status` : ""}`);
  log(`✓ Finished - ${S.totals.checked} numbers checked and written in ${secs} s (${Math.round(S.totals.checked / secs * 60)} per minute).`, "ok");
  lightPages([]);
  closeWorkers();
  S.running = false; S.finishing = false; S.note = "Finished ✓"; S.finishedAt = Date.now(); S.queue = []; S.pos = 0; S.uq = []; S.upos = 0; S.wstate = {};
  save(true);
}

// ---------------- final sweep: re-read the sheet, every row of this run that is still EMPTY is tracked once more ----------------
// (catches anything lost on the way - a page that showed the status too late, a write that didn't land ...)
async function sweep() {
  S.sweeping = true; S.swept = true; save(true);
  let r = null;
  try { r = await sheetCall("list", { from: S.rng.from, to: S.rng.to, dir: S.rng.dir, skip: [], only: [], onlyBlank: true }); } catch {}
  S.sweeping = false;
  if (!S.running) return;
  const again = [];
  if (r && r.ok && r.blankApplied) {
    (r.items || []).forEach((x) => {
      const c = S.runCode[x.row];
      if (!c || !VALID_TN.test(x.tn)) return;
      if (S.ustop && (c[2] === "usps" || c[3])) return;      // usps.com is stopped: these stay empty for a later run
      again.push(c[2] === "usps" || c[3] ? { row: x.row, tn: x.tn, code: "", site: "usps" } : { row: x.row, tn: x.tn, code: c[0] || "", cc: c[1] || "" });
    });
  }
  if (again.length) {
    S.left = S.left.filter((x) => !again.some((y) => y.row === x.row));
    S.queue = byCarrier(again.filter((x) => x.site !== "usps")); S.pos = 0;
    S.uq = again.filter((x) => x.site === "usps"); S.upos = 0; S.round++;
    if (S.uq.length && !S.ustop) ensureUspsTabs();
    log(`${again.length} row(s) of this run are still empty in the sheet - checking them once more…`, "warn");
    save(true); kickAll(); return;
  }
  checkFinish();
}

// "USPS only" runs: which numbers belong on usps.com. Lines "carrier = prefixes" (1-8 = digits 1 to 8).
const unorm = (s) => String(s || "").toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
function parseUspsFilter(txt) {
  return String(txt || "").split(/\n/).map((l) => l.split("=")).filter((p) => p.length >= 2).map((p) => {
    const name = unorm(p[0]), pre = [];
    p.slice(1).join("=").split(/[,;]/).map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((t) => {
      const m = t.match(/^(\d)-(\d)$/);
      if (m) for (let d = +m[1]; d <= +m[2]; d++) pre.push(String(d)); else pre.push(t);
    });
    return { name, usps: /usps|endicia/.test(name), pre };
  }).filter((r) => r.name && r.pre.length);
}
const UF_DEFAULT = "usps = 9\nusps modem = 9\nendicia = 9\nshippo usps = 9\namazon shipping api v2 = TBA\ndhl ecommerce = 1-8\nuniuni = U\nups = 1Z";
// usps.com gets ONLY: a number starting with a USPS prefix (9) whose Carrier is empty or a USPS carrier
// (usps, usps modem, endicia, shippo usps). Everything else -> "" is fine, otherwise why it is not sent.
const isUspsCar = (car) => /usps|endicia/.test(unorm(car));
function notUsps(car, tn, rules) {
  rules = rules && rules.length ? rules : (S.ufilter || (S.ufilter = parseUspsFilter(UF_DEFAULT)));
  car = unorm(car); tn = String(tn || "").toUpperCase();
  if (car && !isUspsCar(car)) return car;                                   // the sheet names another carrier
  const usPre = [].concat(...rules.filter((r) => r.usps).map((r) => r.pre));
  if (usPre.length && !usPre.some((p) => tn.startsWith(p))) {               // not a USPS number: say whose it is
    let best = "", len = 0;
    rules.filter((r) => !r.usps).forEach((r) => r.pre.forEach((p) => { if (tn.startsWith(p) && p.length > len) { len = p.length; best = r.name; } }));
    return best || "not a 9… number";
  }
  return "";
}

// ---------------- pacing: gentle pauses + automatic slow-down when Track123 pushes back ----------------
const COOL_S = [0, 10, 10, 10];
// usps.com pace: seconds between two usps.com pages of the same tab, and the most USPS tabs that pace allows
const UPACE = { normal: { lo: 15, hi: 45, tabs: 4, name: "Fast" }, slow: { lo: 60, hi: 120, tabs: 2, name: "Balanced" }, steady: { lo: 150, hi: 300, tabs: 1, name: "Careful" } };
const UBLOCK_MIN = [2, 10, 20, 30];      // usps.com showed its bot check: rest 2 min, then 10, 20, 30 min - stopped only after that
function setUspsPace(p) {
  S.upace = UPACE[p] ? p : "slow";
  const P = UPACE[S.upace];
  if ((S.utabs || 1) > P.tabs) { log(`usps.com pace “${P.name}”: ${P.tabs} USPS tab${P.tabs > 1 ? "s" : ""} at most (you chose ${S.utabs}).`); S.utabs = P.tabs; }
  S.uactive = Math.min(S.uactive || S.utabs, S.utabs); S.ucap = Math.min(S.ucap || S.utabs, S.utabs);
}      // break length (s) - the tabs are also halved, so a short break is enough
function pace(w, sig, tookAt) {
  if (!S.rest) S.rest = {};
  if (!S.cool) S.cool = { until: 0, level: 0, clean: 0 };
  if (S.active === undefined) S.active = S.tabs;
  if (S.gentle && S.mode !== "manual") S.rest[w] = Date.now() + 3000 + Math.round(Math.random() * 7000);   // 3-10 s, different every time
  if (S.mode === "manual") return;
  if (((S.wsite || {})[w] || "track") === "usps") {          // USPS: its own pacing, the Track123 tabs carry on
    const un = S.utabs || 1;
    if (!S.ucap) S.ucap = un;
    const P = UPACE[S.upace] || UPACE.slow;
    S.rest[w] = Date.now() + rand(P.lo * 1000, P.hi * 1000);   // time between usps.com pages (the pace you chose), different every time
    if (sig.denied) {                                          // "Access Denied": a real block. No reloads - wait it out, then try ONE page
      if (tookAt && tookAt < (S.usince || 0)) return;        // another tab's page from before the pause: already counted
      const k = (S.udenied = (S.udenied || 0) + 1), DEN_MIN = [60, 120, 180];
      if (k > DEN_MIN.length) { parkUsps("denied"); return; }  // still denied after 6 hours of waiting: stop usps.com for this run
      const mins = DEN_MIN[k - 1];
      S.ucap = 1; S.uactive = 1; S.uclean = 0; S.usince = Date.now(); S.uresume = 1; S.ucool = Date.now() + mins * 60000 + rand(0, 300000);
      S.upace = "steady";
      log(`usps.com answered “Access Denied” (it has blocked this connection for now). The bot waits ${mins} min without touching usps.com, then tries one page on the Careful speed and carries on by itself if it loads${k < DEN_MIN.length ? "" : " (last try)"}. Keep Chrome open. Nothing is lost.`, "warn");
      return;
    }
    if (sig.blank) {                                           // the page stayed blank (even after the tab reloaded it once)
      if (tookAt && tookAt < (S.usince || 0)) return;        // started before the last slow-down: already counted
      // usually the TAB is broken, not usps.com: a brand-new tab fixes it (what a manual restart did). Up to 2 fresh
      // tabs in a row, the batch goes straight back to the front of the queue - no long break.
      const f = (S.ufresh = (S.ufresh || 0) + 1);
      if (f <= 2) {
        const back = S.left.filter((x) => x.site === "usps" && canRetry(x));
        S.left = S.left.filter((x) => !back.includes(x));
        S.uq.splice(S.upos, 0, ...back);
        S.rest[w] = Date.now() + rand(8000, 20000);
        log(`USPS tab ${w}: page stayed blank even after 3 reloads - closing it and opening a fresh tab (${f}/2); its ${back.length} numbers are tried again right away.`, "warn");
        replaceWorker(w, USPS_HOME);
        return;
      }
      const k = (S.ublocks = (S.ublocks || 0) + 1);
      if (k > UBLOCK_MIN.length) { parkUsps("blocked"); return; }    // still blocked after ~1 hour of resting: stop usps.com for now
      const mins = UBLOCK_MIN[k - 1], r = mins * 60000 + rand(0, 60000);
      S.ucap = 1; S.uactive = 1; S.uclean = 0; S.usince = Date.now(); S.uresume = 1; S.ucool = Date.now() + r;
      log(`usps.com showed a blank page (its bot check) - resting usps.com ${mins} min, then 1 USPS tab carries on${k < UBLOCK_MIN.length ? "" : " (last try - if it is still blocked, usps.com stops for now and the rows stay for an “Only blank” run)"}. Nothing is lost.`, "warn");
      return;
    }
    if (sig.captcha || sig.empty) {                            // page loaded but most numbers had no status
      if (tookAt && tookAt < (S.usince || 0)) return;
      S.ucap = Math.max(1, Math.ceil(S.ucap / 2)); S.uclean = 0; S.usince = Date.now(); S.ucool = Date.now() + 30000;
      log(`usps.com gave back mostly empty results - slowing down to ${S.ucap} USPS tab${S.ucap > 1 ? "s" : ""}, 30 s rest.`, "warn");
    } else {
      S.udenied = 0; S.ublank = 0; S.ublocks = 0; S.ufresh = 0;              // a good page: fresh-tab tries and the rest ladder start again
      if (S.ucap < un && tookAt >= (S.usince || 0) && ++S.uclean >= 5) { S.uclean = 0; S.ucap++; log(`usps.com is fine again - up to ${S.ucap} of ${un} USPS tabs.`, "ok"); }
    }
    S.uactive = S.ucap;                                        // every allowed USPS tab works (each still waits its own random time between pages)
    kickAll();
    return;
  }
  if (sig.frequent) {
    // Track123's "operation is too frequent" note: a long rest and down to 1 tab
    const c = S.cool;
    if (tookAt && tookAt < (c.since || 0)) return;
    const wait = 180000 + Math.round(Math.random() * 60000);   // 3-4 min
    c.level = 3; c.clean = 0; c.until = Date.now() + wait; c.since = Date.now();
    S.active = 1;
    log(`Track123 said "too frequent, restricted" (tab ${w}) - pausing all tabs ${Math.round(wait / 1000)} s and dropping to 1 of ${S.tabs} tabs. The bot speeds back up by itself after 4 clean batches.`, "warn");
  } else if (sig.captcha || sig.empty) {
    const c = S.cool;
    if (tookAt && tookAt < (c.since || 0)) return;             // started before the last slow-down: already counted
    c.level = Math.min(3, c.level + 1); c.clean = 0;
    c.until = Date.now() + COOL_S[c.level] * 1000; c.since = Date.now();
    S.active = Math.max(1, Math.ceil(S.active / 2));
    log(`Track123 is pushing back (${sig.captcha ? "security check" : "many numbers came back empty"}) tab ${w} - slowing down: ${S.active} of ${S.tabs} tab${S.tabs > 1 ? "s" : ""}, short break of ${COOL_S[c.level]} s.`, "warn");
  } else {
    const c = S.cool;
    if ((S.active < S.tabs || c.level > 0) && tookAt >= (c.since || 0)) {   // only batches started after the slow-down count
      c.clean++;
      if (c.clean >= 4) {                       // 4 clean batches in a row: speed up one step
        c.clean = 0; c.level = Math.max(0, c.level - 1);
        if (S.active < S.tabs) { S.active++; log(`Track123 is fine again - speeding up: ${S.active} of ${S.tabs} tabs.`, "ok"); kickAll(); }
      }
    }
  }
}

// swap a worker's tab for a brand-new one (same worker number, same place in the queue)
async function replaceWorker(w, home) {
  const tid = Object.keys(S.workers || {}).find((k) => S.workers[k] === w);
  if (!tid) return;
  S.replacing = S.replacing || {}; S.replacing[tid] = true;
  try {
    const nid = await newTab(home);
    delete S.workers[tid]; S.workers[nid] = w;
    chrome.tabs.update(nid, S.ownWindow !== false ? { autoDiscardable: false, active: true } : { autoDiscardable: false }).catch(() => {});   // in the bot's own window: the fresh tab is the one shown
    chrome.tabs.remove(+tid).catch(() => {});
    save(); setTimeout(() => kick(nid), 4000);
  } catch (e) { log(`Couldn't open a fresh tab for tab ${w}: ${e.message}`, "bad"); }
}

// ---------------- watchdog: a tab that went quiet with a batch (page didn't load, site hung) is reloaded ----------------
// a worker tab that stops talking to the bot (page never loaded, site hung, tab frozen) is brought back:
//   1st: opened fresh (like typing the address again)  2nd: replaced by a brand-new tab  3rd: its rows are
//   handed back (tracked again later) and the tab is replaced again. USPS tabs are checked after 35 s, Track123 after 60 s.
const STALE = { usps: 35000, track: 60000 };
const contact = {};          // worker -> last time its tab talked to the bot (not saved - it's only for the watchdog)
const touch = (tabId) => { if (S && S.workers && tabId && S.workers[tabId]) contact[S.workers[tabId]] = Date.now(); };
let fixing = false;
async function watchdog() {
  if (!S || !S.running || S.paused || fixing) return;
  fixing = true;
  try {
    const t = Date.now();
    if (!S.fix) S.fix = {};
    for (const [tid, w] of Object.entries(S.workers || {})) {
      const site = (S.wsite || {})[w] || "track", b = S.inflight[w];
      const last = Math.max(contact[w] || 0, b ? b.seen || b.at || 0 : 0, S.startedAt || 0, S.resumedAt || 0);
      if (t - last < STALE[site]) continue;
      const name = `${site === "usps" ? "USPS tab" : "Tab"} ${w}`, home = site === "usps" ? USPS_HOME : "https://www.track123.com/track";
      const n = (S.fix[w] = (S.fix[w] || 0) + 1);
      contact[w] = t; if (b) b.seen = t;
      if (n >= 3 && b) {          // still nothing: hand the rows back so other tabs / a later round do them
        delete S.inflight[w];
        b.items.forEach((x) => {
          const y = Object.assign({}, x, site === "usps" ? { blank: (x.blank || 0) + 1 } : { tries: (x.tries || 0) + 1 });
          S.left = S.left.filter((z) => z.row !== y.row); S.left.push(y);
        });
        log(`${name} still didn't load - rows ${rowsText(b.items)} are tracked again later.`, "warn");
        S.fix[w] = 1;
      }
      if (n === 1) {
        log(`${name} didn't load${b ? ` (rows ${rowsText(b.items)})` : ""} - opening it fresh.`, "warn");
        chrome.tabs.update(+tid, { url: home }).catch(() => {});
      } else {
        log(`${name} still didn't load - replacing it with a new tab.`, "warn");
        try {
          S.replacing = S.replacing || {}; S.replacing[tid] = true;
          const nid = await newTab(home);
          delete S.workers[tid]; S.workers[nid] = w;
          chrome.tabs.update(nid, { autoDiscardable: false }).catch(() => {});
          chrome.tabs.remove(+tid).catch(() => {});
          if (site === "track" && S.light !== false) lightPages(Object.entries(S.workers).filter(([, x]) => ((S.wsite || {})[x] || "track") === "track").map(([id]) => +id));
        } catch (e) { log(`Couldn't replace ${name}: ${e.message}`, "bad"); }
      }
      save();
      checkFinish();
    }
  } finally { fixing = false; }
}
setInterval(() => { ready.then(watchdog); }, 15000);
try { chrome.alarms.create("sctrk_watch", { periodInMinutes: 0.5 }); chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sctrk_watch") ready.then(watchdog); }); } catch {}

// USPS tabs opened only when they're needed (Track123-first: for the numbers Track123 couldn't find)
let openingUsps = false;
async function ensureUspsTabs() {
  if (openingUsps || S.ustop || Object.values(S.wsite || {}).includes("usps")) return;
  openingUsps = true;
  try {
    const need = Math.max(1, Math.min(6, S.utabs || 1, Math.ceil((S.uq.length - S.upos) / USPS_BATCH) || 1));
    let next = Math.max(0, ...Object.values(S.workers || {})) + 1;
    for (let i = 0; i < need; i++) {
      const id = await newTab(USPS_HOME), w = next++;
      S.workers[id] = w; S.wsite[w] = "usps"; S.wstate[w] = { state: "starting", rows: "", n: 0, at: Date.now(), site: "usps" };
      if (i) S.rest[w] = Date.now() + 6000 * i;
      chrome.tabs.update(id, { autoDiscardable: false }).catch(() => {});
      kick(id);
    }
    S.uactive = need; save(true);
  } finally { openingUsps = false; }
}

// ---------------- job finished: close the bot's tabs (and its own window) ----------------
// close Track123 / usps.com tabs in the bot's window that are NOT current workers (strays left by an earlier run)
async function closeStrays(winId) {
  if (!winId) return;      // only ever touch the bot's own window - never a tab the person opened themselves
  try {
    const keep = new Set(Object.keys(S.workers || {}).map(Number));
    const tabs = await chrome.tabs.query({ url: TRACK_URLS.concat(["https://tools.usps.com/*"]), windowId: winId });
    const stray = tabs.filter((t) => !keep.has(t.id)).map((t) => t.id);
    if (stray.length) { await chrome.tabs.remove(stray).catch(() => {}); log(`Closed ${stray.length} leftover tracking tab${stray.length > 1 ? "s" : ""} from an earlier run.`); }
  } catch {}
}
async function closeWorkers() {
  const ids = Object.keys(S.workers || {}).map(Number);
  S.workers = {}; S.wsite = {};            // forget them first, so closing them doesn't look like "a tab was closed"
  try {
    if (S.winId) {
      const w = await chrome.windows.get(S.winId, { populate: true }).catch(() => null);
      const other = w ? w.tabs.filter((t) => !ids.includes(t.id) && !/^(about:blank|chrome:\/\/newtab)/.test(t.url || "")) : [];
      if (w && !other.length) { await chrome.windows.remove(S.winId).catch(() => {}); S.winId = null; save(); return; }
    }
    if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
  } catch {}
  save();
}

// ---------------- light pages: the Track123 tabs load without pictures / videos / fonts ----------------
// (only the bot's own Track123 tabs; security-check pictures and usps.com are never touched)
const LIGHT_RULE = 9101;
async function lightPages(tabIds) {
  try {
    const add = tabIds && tabIds.length ? [{
      id: LIGHT_RULE, priority: 1, action: { type: "block" },
      condition: { tabIds, resourceTypes: ["image", "media", "font"],
        excludedRequestDomains: ["qcloud.com", "gtimg.com", "qq.com", "tencent.com", "tencent-cloud.com", "recaptcha.net", "google.com", "gstatic.com", "hcaptcha.com", "cloudflare.com", "geetest.com"] },
    }] : [];
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [LIGHT_RULE], addRules: add });
  } catch (e) { /* older Chrome: pages just load normally */ }
}

// ---------------- tabs ----------------
const ping = (id, site) => new Promise((res) => chrome.tabs.sendMessage(id, { type: "ping" }, (r) => { void chrome.runtime.lastError; res(!!(r && r.ok && r.site === (site || "track"))); }));
const kick = (id) => new Promise((res) => chrome.tabs.sendMessage(id, { type: "kick" }, () => { void chrome.runtime.lastError; res(); }));
function kickAll() { Object.keys(S.workers).forEach((id) => kick(+id)); }
// The bot's tabs live in their OWN Chrome window, so the team can keep working in their window
// (other sheets, other Track123 / USPS tabs) without touching - or being slowed by - the bot's tabs.
async function botWindow() {
  if (S.ownWindow === false) return null;
  if (S.winId) { try { await chrome.windows.get(S.winId); return S.winId; } catch { S.winId = null; } }
  const w = await chrome.windows.create({ url: "about:blank", focused: false, state: "normal", width: 1100, height: 800 });
  S.winId = w.id; S.winBlank = w.tabs && w.tabs[0] ? w.tabs[0].id : null;
  return S.winId;
}
async function newTab(url) {
  const winId = await botWindow();
  if (winId && S.winBlank) {         // reuse the window's first (blank) tab
    const id = S.winBlank; S.winBlank = null;
    try { await chrome.tabs.update(id, { url }); return id; } catch {}
  }
  return (await chrome.tabs.create(winId ? { url, active: false, windowId: winId } : { url, active: false })).id;
}
async function openWorkers(n, selfTab) {
  const winId = await botWindow();
  // only tabs in the bot's window are reused - never a Track123/USPS tab someone is working in
  const tabs = (await chrome.tabs.query({ url: TRACK_URLS })).filter((t) => !winId || t.windowId === winId);
  const alive = [];
  for (const t of tabs) if (t.id !== selfTab && (await ping(t.id))) alive.push(t.id);
  if (winId) selfTab = null;
  const ids = [];
  if (!(S.queue.length > S.pos) && !S.left.some((x) => x.site !== "usps") && (S.uq || []).length) n = 0;   // only USPS rows: no Track123 tabs
  if (selfTab && n > 0) ids.push(selfTab);
  while (ids.length < n && alive.length) ids.push(alive.shift());
  while (ids.length < n) ids.push(await newTab("https://www.track123.com/track"));
  // USPS tabs (only when there are USPS rows)
  const uids = [];
  // smart USPS tab count: one usps.com page = 35 numbers, so 88 numbers = 3 tabs even with 6 chosen
  const usWork = Math.max(0, (S.uq || []).length - (S.upos || 0)) + S.left.filter((x) => x.site === "usps").length;
  const usNeed = usWork ? Math.max(1, Math.min(6, S.utabs || 1, Math.ceil(usWork / USPS_BATCH))) : 0;
  if (usNeed && usNeed < (S.utabs || 1)) {
    log(`Only ${usWork} USPS number${usWork > 1 ? "s" : ""} (${usNeed} usps.com page${usNeed > 1 ? "s" : ""}) - opening ${usNeed} USPS tab${usNeed > 1 ? "s" : ""} instead of ${S.utabs}.`);
    S.utabs = usNeed; S.ucap = Math.min(S.ucap || usNeed, usNeed); S.uactive = Math.min(S.uactive || usNeed, usNeed);
  }
  if (usNeed) {
    const ut = (await chrome.tabs.query({ url: ["https://tools.usps.com/*"] })).filter((t) => !winId || t.windowId === winId);
    for (const t of ut) if (uids.length < usNeed && (await ping(t.id, "usps"))) uids.push(t.id);
    while (uids.length < usNeed) uids.push(await newTab(USPS_HOME));
  }
  S.workers = {}; S.wsite = {};
  ids.concat(uids).forEach((id, i) => {
    const site = i < ids.length ? "track" : "usps";
    S.workers[id] = i + 1; S.wsite[i + 1] = site;
    S.wstate[i + 1] = { state: "starting", rows: "", n: 0, at: Date.now(), site };
    chrome.tabs.update(id, { autoDiscardable: false }).catch(() => {});   // Chrome must not put the tab to sleep
  });
  save(true);
  lightPages(S.light === false ? [] : ids);
  await closeStrays(winId);          // leftover Track123/usps.com tabs from an earlier run (crash, restart…) are closed
  uids.slice(1).forEach((id, i) => { S.rest[S.workers[id]] = Date.now() + 6000 * (i + 1); });   // USPS tabs start a few seconds apart
  ids.concat(uids).forEach((id) => kick(id));
}

// ---------------- start / stop / resume ----------------
async function startRun(m, sender) {
  await ready;
  if (S.running) return { ok: false, error: "Already running" };
  const keepLog = m.resume && S.queue.length > S.pos;
  if (!keepLog) {
    const old = S;
    S = fresh(); S.winId = old.winId || null;      // keep using the bot's window
    S.req = m.req; S.mode = m.mode; S.db = !!(m.db && await dbCfg()); S.tabs = m.mode === "manual" ? 1 : Math.max(1, Math.min(MAX_TABS, +m.tabs || 2));
    S.gentle = m.gentle !== false; S.active = S.tabs; S.light = true; S.ownWindow = m.ownWindow !== false;
    if (m.fresh > 0) S.req = Object.assign({}, S.req, { base: Object.assign({}, S.req.base, { ensureChecked: true }) });
    S.sheetName = m.sheetName || ""; S.sheetId = m.sheetId || ""; S.rangeText = m.rangeText || "";
    S.running = true; S.startedAt = Date.now(); S.note = "";
    save(true);
    log(`▶ ${m.onlyBNF ? "Blank + Not found run · " : m.onlyNF ? "Not found run · " : m.onlyBlank ? "Blank run · " : ""}${S.tabs} tab${S.tabs > 1 ? "s" : ""} · ${S.sheetName || "sheet"} · ${S.rangeText} - reading the rows…`);
    const r = await readRange(m);
    if (S.alert && /sheet/i.test(S.alert)) S.alert = "";
    if (!S.running) return { ok: true };                 // stopped meanwhile
    if (!r.ok) { S.running = false; S.note = "Sheet error - " + r.error; log("Sheet: " + r.error, "bad"); save(true); return { ok: false, error: r.error }; }
    if (r.broken && r.broken.length) log(`Sheet rows ${r.broken.slice(0, 8).join(", ")}${r.broken.length > 8 ? "…" : ""}: tracking number shows as 9.36E+21 - format the column as Plain text and retype it. Skipped.`, "warn");
    if (r.invalid && r.invalid.length) log(`Skipped sheet rows ${r.invalid.slice(0, 8).join(", ")}${r.invalid.length > 8 ? "…" : ""}: tracking number has characters Track123 doesn't accept (like _ ).`, "warn");
    const bad = (r.items || []).filter((x) => !VALID_TN.test(x.tn));
    if (bad.length) log(`Skipped ${bad.length} tracking number(s) Track123 can't take: ${bad.slice(0, 5).map((x) => "row " + x.row).join(", ")}`, "warn");
    void old;
    if (m.onlyNF && !r.onlyApplied) {          // older script: it doesn't know the "only Not found" filter
      if ((r.items || []).every((x) => x.status !== undefined)) r.items = r.items.filter((x) => /^not found$/i.test(String(x.status).trim()));
      else { S.running = false; S.note = "Update the sheet script for the Not found run"; log("The 'Only Not found' run needs the new sheet script - paste it and deploy a new version, then try again.", "bad"); save(true); return { ok: false, error: S.note }; }
    }
    if (m.onlyBNF) {                            // "Blank + Not found": keep rows whose Status is empty or says Not found
      if ((r.items || []).every((x) => x.status !== undefined)) {
        const n0 = (r.items || []).length;
        r.items = (r.items || []).filter((x) => /^(not found)?$/i.test(String(x.status).trim()));
        log(`Blank + Not found: ${r.items.length} of ${n0} rows have an empty Status or “Not found”.`);
      } else { S.running = false; S.note = "Update the sheet script for the Blank + Not found run"; log("“Blank + Not found” needs the sheet script v14 or newer - paste Tracking_Sheet_Script.gs.txt into Apps Script and deploy a new version, then try again.", "bad"); save(true); return { ok: false, error: S.note }; }
    }
    if (m.onlyBlank && !r.blankApplied) {        // older sheet script: it doesn't know "only blank"
      S.running = false; S.note = "Update the sheet script for the Blank run";
      log("“Only blank” needs the new sheet script (v11) - paste Tracking_Sheet_Script.gs.txt into Apps Script and deploy a new version, then try again.", "bad");
      save(true); return { ok: false, error: S.note };
    }
    if (m.fresh > 0) {
      if (!r.freshApplied) log("“Skip rows checked recently” needs the new sheet script (v10) - this run checks every row.", "warn");
      else if (r.freshNoColumn) log("No “Checked On” column yet - the bot adds it now; from the next run, recently checked rows are skipped.", "warn");
      else if (r.skippedFresh) log(`${r.skippedFresh} rows were checked in the last ${m.fresh} h - skipped.`);
    }
    const idx = m.useCarrier ? courierIndex(m.couriers) : null, memo = new Map(), unknown = {}, prefixHits = {};
    const pfx = m.prefixRules || [];
    const pick = (c, tn) => {
      if (!m.useCarrier) return "";
      const k = (c || "") + "|" + ((c || "") ? "" : (tn || "").toUpperCase().slice(0, 6));
      if (!memo.has(k)) memo.set(k, codeFor(c, m.carrierRules, idx, tn, pfx));
      const h = memo.get(k);
      if (h.how === "unknown") unknown[c] = (unknown[c] || 0) + 1;
      if (h.how === "prefix") prefixHits[h.pfx] = (prefixHits[h.pfx] || 0) + 1;
      return h.code;
    };
    // carrier first (tick box, and always in the Not found run): grouped by carrier, each chosen on Track123.
    // otherwise (fast): row order, auto-detect; a number auto-detect can't find is re-checked with its sheet carrier at the end.
    const first = !!(m.carrierFirst || m.onlyNF || m.onlyBNF);
    const list = (r.items || []).filter((x) => VALID_TN.test(x.tn)).map((x) => { const c = pick(x.carrier, x.tn); return first ? { row: x.row, tn: x.tn, code: c, car: x.carrier || "" } : { row: x.row, tn: x.tn, code: "", cc: c, car: x.carrier || "" }; });
    // "USPS only": the sheet is a USPS sheet - every row goes to usps.com, the Carrier column isn't looked at
    const usRow = m.sites === "usps" ? () => true : (x) => (first ? x.code : x.cc) === "usps";
    // USPS rows: "t123first" = Track123 first, what it can't find goes to usps.com · "site" = straight to usps.com · "t123" = Track123 only
    // "USPS only" = everything goes straight to usps.com (Track123 is never used, whatever the USPS-rows box says)
    const umode = m.sites === "usps" ? "site" : m.uspsMode || (m.uspsSite === false ? "t123" : "t123first");
    const isUsps = (x) => umode === "site" && usRow(x);
    if (umode === "t123first") list.forEach((x) => { if (usRow(x)) { x.usps = true; if (first && !x.code) x.code = "usps"; if (!first) x.cc = x.cc || "usps"; } });
    // "Sites" switch: one Chrome profile can do only the Track123 rows while another profile does only the USPS rows
    const only = m.sites === "track" ? (x) => !usRow(x) : m.sites === "usps" ? usRow : null;
    S.ufilter = parseUspsFilter(m.uspsFilter || UF_DEFAULT); S.ugated = 0;
    if (!S.ufilter.length) S.ufilter = parseUspsFilter(UF_DEFAULT);
    if (m.sites === "usps") {       // USPS only: numbers of other carriers (TBA, UPS, UniUni, DHL…) are never searched on usps.com
      const fr = S.ufilter, skipped = {};
      if (fr.length) {
        for (let i = list.length - 1; i >= 0; i--) { const w = notUsps(list[i].car, list[i].tn, fr); if (w) { skipped[w] = (skipped[w] || 0) + 1; list.splice(i, 1); } }
        const nSk = Object.values(skipped).reduce((a, b) => a + b, 0);
        if (nSk) log(`USPS only: ${nSk} row${nSk > 1 ? "s are" : " is"} not USPS numbers - not searched on usps.com, left as they are: ${Object.entries(skipped).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}.`);
      }
    }
    if (only) {
      const n0 = list.length; for (let i = list.length - 1; i >= 0; i--) if (!only(list[i])) list.splice(i, 1);
      log(m.sites === "usps" ? `Sites: USPS only - all ${list.length} rows are USPS rows (Carrier column not used).`
        : `Sites: only Track123 rows - ${n0 - list.length} USPS rows left for the other run.`);
    }
    S.uq = list.filter(isUsps).map((x) => ({ row: x.row, tn: x.tn, code: "", site: "usps", car: x.car || "" })); S.upos = 0;
    S.umode = umode;
    const nUs = list.filter((x) => x.usps).length;
    if (nUs) log(`USPS: ${nUs} USPS rows are tracked on Track123 first - the ones it can't find go on to usps.com at the end.`);
    S.utabs = Math.max(1, Math.min(6, +m.uspsTabs || 1)); S.uactive = S.utabs; S.ucap = S.utabs; S.ublank = 0; S.ublocks = 0; S.ufresh = 0; S.udenied = 0; S.ustop = "";
    setUspsPace(m.uspsPace);
    S.ubudget = m.uspsBudget === undefined || m.uspsBudget === "" ? 3000 : Math.max(0, +m.uspsBudget || 0);
    if (S.ubudget && (list.some((x) => x.usps) || list.some(isUsps))) log(`usps.com limit: ${S.ubudget} lookups per day on this PC (${ubud.day === today() ? ubud.n : 0} used today).`);
    const rest = list.filter((x) => !isUsps(x));
    S.queue = first ? byCarrier(rest) : rest;
    S.total = S.queue.length + S.uq.length;
    // remember this run's rows (for the final sweep): row -> [code, carrier code, site]
    S.runCode = {}; S.swept = false; S.sweeping = false;
    // [code, carrier code, site, usps-first, was Delivered in the sheet]
    const delTxt = String(m.deliveredText || "Delivered").toLowerCase().trim();
    const wasDel = {};
    (r.items || []).forEach((x) => { if (x.status !== undefined) { const t = String(x.status).toLowerCase().trim(); if (t === "delivered" || t === delTxt) wasDel[x.row] = 1; } });
    S.guardOn = (r.items || []).some((x) => x.status !== undefined);
    S.queue.forEach((x) => { S.runCode[x.row] = [x.code || "", x.cc || "", "track", x.usps ? 1 : 0, wasDel[x.row] || 0]; });
    S.uq.forEach((x) => { S.runCode[x.row] = ["", "", "usps", 0, wasDel[x.row] || 0]; });
    S.problems = []; S.kept = []; S.scheduled = !!m.scheduled;
    chrome.storage.local.remove(PROB_KEY).catch(() => {});
    if (!S.guardOn && (r.items || []).length) log("Tip: update the sheet script to v14 so rows that already say Delivered are never set back to an earlier status.", "warn");
    S.rng = { from: r.from, to: r.to, dir: r.dir || (m.dir || 1) };
    chrome.storage.local.set({ [RC_KEY]: S.runCode });
    if (S.uq.length) log(`USPS: ${S.uq.length} numbers go to usps.com (35 per page, ${S.utabs} tab${S.utabs > 1 ? "s" : ""})${S.queue.length ? " - the rest to Track123" : ""}.`);
    if (m.sites !== "usps") {        // carrier report (not for USPS only - there the carrier isn't used)
      const per = {};
      list.forEach((x) => { const k = (first ? x.code : x.cc) || "auto-detect"; per[k] = (per[k] || 0) + 1; });
      if (Object.keys(per).some((k) => k !== "auto-detect")) log((first ? "Carriers (chosen first): " : "Auto-detect in row order · sheet carrier used only if Track123 says Not found: ") + Object.entries(per).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));
      const unk = Object.entries(unknown).sort((a, b) => b[1] - a[1]);
      if (unk.length) log(`Carrier not recognised → auto-detect: ${unk.slice(0, 6).map(([k, v]) => `“${k}” ${v}`).join(" · ")}${unk.length > 6 ? " …" : ""} - add a line in ⚙ Settings > Columns if Track123 can't find them.`, "warn");
      if (idx && idx.size) {          // a rule / prefix line whose carrier Track123 doesn't know (names and codes both work)
        const badRule = (m.carrierRules || []).concat(m.prefixRules || []).filter(([, c]) => !/^auto$/i.test(String(c).trim()) && !idx.codes.has(resolveCarrier(c, idx))).map(([, c]) => c);
        if (badRule.length) log(`Settings > Columns: Track123 has no carrier ${[...new Set(badRule)].map((c) => "“" + c + "”").join(", ")} - check the spelling (Track123's carrier name or code).`, "warn");
      } else if (m.useCarrier) log("Couldn't load Track123's carrier list - only your carrier rules are used this run.", "warn");
      if (Object.keys(prefixHits).length) log("Carrier from prefix: " + Object.entries(prefixHits).map(([a, b]) => a + " → " + b + " row" + (b > 1 ? "s" : "")).join(", "), "ok");
    }
    if (!S.total) {
      S.running = false; S.note = "Nothing to check ✓";
      log(`Nothing to check in rows ${r.from} → ${r.to}${r.skipped ? ` (${r.skipped} already delivered)` : ""}.`, "ok");
      save(true); return { ok: true };
    }
    log(`${S.total} tracking numbers to check (rows ${r.from} → ${r.to}${r.skipped ? `, ${r.skipped} delivered rows skipped` : ""}) - ${Math.ceil(S.queue.length / BATCH) + Math.ceil(S.uq.length / USPS_BATCH)} batches over ${(S.queue.length ? S.tabs : 0) + (S.uq.length ? S.utabs : 0)} tab${((S.queue.length ? S.tabs : 0) + (S.uq.length ? S.utabs : 0)) > 1 ? "s" : ""}.`, "ok");
  } else {
    S.running = true; S.paused = false; S.pausedBy = ""; S.note = ""; S.mode = m.mode || S.mode; S.resumedAt = Date.now(); S.fix = {};
    if (m.mode !== "manual" && m.tabs) S.tabs = Math.max(1, Math.min(MAX_TABS, +m.tabs));
    if (m.req) S.req = Object.assign({}, m.req, { base: Object.assign({}, m.req.base, { ensureChecked: !!(S.req && S.req.base && S.req.base.ensureChecked) }) });
    S.gentle = m.gentle !== false; S.active = S.tabs; S.cool = { until: 0, level: 0, clean: 0 }; S.rest = {}; S.light = true; S.ownWindow = m.ownWindow !== false;
    S.uactive = S.utabs || 1; S.ucool = 0; S.usince = 0; S.ucap = S.utabs || 1; S.ublank = 0; S.ublocks = 0; S.ufresh = 0; S.udenied = 0; S.ustop = "";
    setUspsPace(m.uspsPace || S.upace);
    if (m.uspsBudget !== undefined && m.uspsBudget !== "") S.ubudget = Math.max(0, +m.uspsBudget || 0);
    log(`▶ Continuing - ${qLeft()} numbers left, ${S.tabs} tab${S.tabs > 1 ? "s" : ""}.`);
  }
  // smart tab count: never more Track123 tabs than there are Track123 pages of work
  // (80 numbers = 1 page = 1 tab, even with 10 tabs chosen; one page = up to 100 numbers of one carrier)
  const tb = trackBatches();
  if (tb && tb < S.tabs) {
    log(`Only ${tb} Track123 page${tb > 1 ? "s" : ""} of work - opening ${tb} tab${tb > 1 ? "s" : ""} instead of ${S.tabs}.`);
    S.tabs = tb; S.active = Math.min(S.active || tb, tb);
  }
  await openWorkers(S.tabs, m.selfTab || null);
  if (S.buffer.length) flush();
  return { ok: true };
}
function stopRun(why) {
  if (!S.running) return;
  // batches being tracked are not written - put them back at the front so "Continue" does them first
  const back = Object.values(S.inflight).flatMap((b) => b.items);
  S.queue = back.filter((x) => x.site !== "usps").concat(S.queue.slice(S.pos)); S.pos = 0; S.inflight = {};
  S.uq = back.filter((x) => x.site === "usps").concat((S.uq || []).slice(S.upos || 0)); S.upos = 0;
  lightPages([]);
  S.running = false; S.paused = false; S.pausedBy = ""; S.finishing = false; S.note = why || "Stopped"; S.alert = ""; S.wstate = {};
  log(`■ ${why || "Stopped"}${qLeft() ? ` - ${qLeft()} numbers not done yet (▶ Start continues)` : ""}`, "warn");
  save(true);
  if (S.buffer.length) flush();      // results already received are still written
}

// ---------------- messages ----------------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return;
  const tabId = sender.tab ? sender.tab.id : null;
  const go = (fn) => { ready.then(fn).then(reply, (e) => reply({ ok: false, error: e.message })); return true; };
  touch(tabId);
  switch (msg.type) {
    case "sheet": return go(() => callSheet(msg.url, msg.body));
    case "uspsOk": return go(() => {        // a usps.com tab loaded normally after the break began: usps.com isn't blocking - carry on
      const w = S.workers[tabId];
      if (!S.running || !w || !(S.ucool > Date.now()) || !(msg.at > (S.usince || 0)) || S.ucut === S.usince) return { ok: true };
      S.ucut = S.usince; S.ucool = 0; S.ufresh = 0;
      log(`USPS tab ${w}: usps.com loads normally again after a reload - the break is over, carrying on.`, "ok");
      save(true); kickAll();
      return { ok: true, cut: true };
    });
    case "uspsLate": return go(() => {      // a bot usps.com tab shows results for numbers that are still waiting (page reloaded by hand)
      if (!S.running) return { ok: true, n: 0 };
      const by = new Map((msg.items || []).filter((x) => x && x.tn && x.status).map((x) => [String(x.tn).toUpperCase(), x]));
      if (!by.size) return { ok: true, n: 0 };
      const got = [], hit = (it) => it && it.tn && by.has(it.tn.toUpperCase());
      S.uq = (S.uq || []).slice(0, S.upos || 0).concat((S.uq || []).slice(S.upos || 0).filter((it) => (hit(it) ? (got.push(it), false) : true)));
      S.left = S.left.filter((it) => (it.site === "usps" && hit(it) ? (got.push(it), false) : true));
      if (!got.length) return { ok: true, n: 0 };
      const ws = guard(got.map((it) => Object.assign({}, by.get(it.tn.toUpperCase()), { row: it.row, tn: it.tn })));
      ws.forEach((w) => { addTotal(w.st); checkProblem(w); });
      S.buffer.push(...ws);
      const brk = S.ucool > Date.now();
      S.ucool = 0; S.ublocks = 0; S.ufresh = 0; S.ublank = 0;      // the page works after a reload: usps.com isn't blocking - no break needed
      log(`usps.com page reloaded - ${got.length} number(s) picked up from it and written${brk ? "; the break is over, carrying on" : ""}.`, "ok");
      kickAll();
      save(true); flush();
      return { ok: true, n: got.length };
    });
    case "uspsGrab": return go(async () => {      // the panel's "Write usps.com results to sheet": every usps.com tab you opened yourself
      // every tools.usps.com tab - yours AND the bot's own (e.g. one you reloaded by hand during a run)
      const tabs = await chrome.tabs.query({ url: ["https://tools.usps.com/*", "https://*.usps.com/*"] });
      const all = new Map(); let pages = 0;
      for (const t of tabs) {
        const r = await new Promise((res) => { try { chrome.tabs.sendMessage(t.id, { type: "uspsGrab" }, (x) => { void chrome.runtime.lastError; res(x); }); } catch { res(null); } });
        if (r && r.items && r.items.length) { pages++; r.items.forEach((it) => all.set(String(it.tn).toUpperCase(), it)); }
      }
      return { ok: true, tabs: tabs.length, pages, items: [...all.values()] };
    });
    case "dbSignIn": return go(() => dbLogin(msg.email, msg.password, msg.url, msg.apiKey));
    case "dbStatus": return go(async () => { const c = await dbCfg(); return { ok: true, signedIn: !!(c && c.refresh), email: (c && c.email) || "", url: (c && c.url) || "", synced: S ? S.dbSynced || 0 : 0, alert: S ? S.dbAlert || "" : "" }; });
    case "dbSignOut": return go(async () => { await chrome.storage.local.remove(DB_KEY); return { ok: true }; });
    case "log": log(msg.m, msg.c); reply({ ok: true }); return;
    case "whoami": return go(() => ({ tabId, worker: (S.workers && S.workers[tabId]) || null }));
    case "startRun": return go(() => startRun(msg, sender));
    case "stopRun": return go(() => { stopRun(msg.why); return { ok: true }; });
    case "resetRun": return go(() => { if (!S.running) { const keep = { req: S.req }; S = Object.assign(fresh(), keep); save(true); } return { ok: true }; });
    case "resume": return go(() => {
      if (S.running && S.paused) { S.resumedAt = Date.now(); if (S.pausedBy === "user") log("▶ Resumed."); S.paused = false; S.pausedBy = ""; save(true); kickAll(); }
      return { ok: true };
    });
    case "pause": return go(() => {      // no new batches; the ones being tracked finish and are written, nothing is lost
      if (S.running && !S.paused) {
        S.paused = true; S.pausedBy = "user";
        const n = Object.keys(S.inflight).length;
        log(`⏸ Paused${n ? ` - ${n} tab${n > 1 ? "s finish their" : " finishes its"} current batch, then wait` : ""}. ▶ Resume carries on.`, "warn");
        save(true);
      }
      return { ok: true };
    });
    case "take": return go(() => {
      const w = S.workers[tabId];
      if (!S.running || !w) return { stop: true };
      if (S.inflight[w]) return Object.assign({ again: true }, S.inflight[w]);      // this tab's batch is not done yet
      if (S.paused) return { wait: true };
      const t = Date.now(), site = (S.wsite || {})[w] || "track";
      if (site === "usps") {
        if (S.ustop) return { stop: true };
        if (S.ucool > t) return { wait: true, why: "cool", until: S.ucool };
        if (S.uresume) {            // the rest is over: say where it carries on
          S.uresume = 0;
          const nx = S.left.find((x) => x.site === "usps") || S.uq[S.upos];
          log(`usps.com rest is over - carrying on${nx ? " from row " + nx.row : ""}. Nothing was skipped.`, "ok");
        }
        // the slow-down limits how many usps.com pages are open AT ONCE - any free tab may take the next one,
        // so a tab that is slow or stuck never holds up the others
        const ubusy = Object.keys(S.inflight).filter((k) => (S.wsite || {})[k] === "usps").length;
        if (ubusy >= (S.ucap || S.utabs || 1)) return { wait: true, why: "slow" };
      } else {
        if (S.cool && S.cool.until > t) return { wait: true, why: "cool", until: S.cool.until };
        const tbusy = Object.keys(S.inflight).filter((k) => ((S.wsite || {})[k] || "track") === "track").length;
        if (tbusy >= (S.active || S.tabs)) return { wait: true, why: "slow" };       // slowed down: at most this many Track123 pages at once - whichever tabs are free
      }
      if (S.rest && S.rest[w] > t) return { wait: true, why: "rest", until: S.rest[w] };
      let max = 0;
      if (site === "usps" && S.upos < S.uq.length) {
        const left = budgetLeft();
        if (left < 1) { parkUsps("budget"); return { stop: true }; }
        max = left;
      }
      const b = nextBatch(site, max);
      if (!b) { checkFinish(); return S.running ? { wait: true } : { stop: true }; }
      if (site === "usps") { spendBudget(b.tns.length); b.xc = Object.values(S.wsite || {}).some((x) => x !== "usps"); }   // xc: Track123 can give a second opinion
      S.inflight[w] = Object.assign(b, { at: Date.now(), seen: Date.now(), reloads: 0 });
      S.wstate[w] = { state: "tracking", rows: rowsText(b.items), n: b.tns.length, code: b.code || "", site, at: Date.now() };
      save();
      return b;
    });
    case "result": return go(() => {
      const w = S.workers[tabId];
      if (!w || !S.inflight[w]) return { ok: true };
      const tookAt = S.inflight[w].at || 0;
      delete S.inflight[w];
      const hasTrack = Object.values(S.wsite || {}).some((x) => x !== "usps");
      const direct = [];
      (msg.unresolved || []).forEach((x) => {
        // a usps.com "Awaiting Item" row with no Track123 tab in this run (USPS-only test mode): write the usps.com status as it is
        if (x.xcheck && !hasTrack) { direct.push(x.xcheck); addTotal(x.xcheck.st); return; }
        S.left = S.left.filter((y) => y.row !== x.row); S.left.push(x);
      });
      const ws = guard((msg.writes || []).concat(direct));
      ws.forEach(checkProblem);
      S.buffer.push(...ws);
      Object.entries(msg.counts || {}).forEach(([k, v]) => addTotal(k, v));
      S.wstate[w] = { state: "done", rows: "", n: 0, at: Date.now(), site: (S.wsite || {})[w] || "track" };
      if (S.fix) S.fix[w] = 0;             // this tab works again
      pace(w, msg.signal || {}, tookAt);
      if (S.mode === "manual") { S.paused = true; S.pausedBy = "manual"; }
      save(); flush(); checkFinish();
      return { ok: true };
    });
    case "schedule": return go(async () => { await chrome.storage.local.set({ [SCHED_KEY]: msg.sched || {} }); return { ok: true, next: await planSchedule() }; });
    case "state": return go(() => { const w = S.workers[tabId]; if (w) { S.wstate[w] = Object.assign({}, S.wstate[w], { state: msg.state, at: Date.now() }); save(); } return { ok: true }; });
    case "alert": return go(() => { S.alert = msg.text || ""; save(); return { ok: true }; });
    case "sleep": {   // a worker tab's wait: timed here, because Chrome slows down timers in background tabs
      setTimeout(() => { try { reply({ ok: true }); } catch {} }, Math.max(50, Math.min(5000, +msg.ms || 500)));
      if (S && tabId && S.workers) { const w = S.workers[tabId]; if (w && S.inflight[w]) S.inflight[w].seen = Date.now(); }
      return true;
    }
    case "hb": {      // keeps the background awake while a tab waits - and tells the watchdog this tab is alive
      if (S && tabId && S.workers) { const w = S.workers[tabId]; if (w && S.inflight[w]) S.inflight[w].seen = Date.now(); }
      reply({ ok: true }); return;
    }
    case "gotoRow": return go(async () => {      // show a sheet row: the sheet's tab comes to the front with that row selected
      const id = String(msg.sheetId || S.sheetId || "").replace(/[^A-Za-z0-9_-]/g, ""), row = Math.max(1, +msg.row || 1);
      if (!id) return { ok: false, error: "no sheet" };
      const tabs = await chrome.tabs.query({ url: `https://docs.google.com/spreadsheets/d/${id}/*` });
      const t = tabs.find((x) => x.active) || tabs[0];
      const gid = String(msg.gid || (t && (t.url.match(/[#&?]gid=(\d+)/) || [])[1]) || "0");
      const hash = `#gid=${gid}&range=A${row}`;
      if (t) { await chrome.tabs.update(t.id, { url: t.url.split("#")[0] + hash, active: true }); chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); }
      else await chrome.tabs.create({ url: `https://docs.google.com/spreadsheets/d/${id}/edit${hash}` });
      return { ok: true };
    });
    case "showWorker": {          // the panel's "USPS tab 2" / "Tab 3": bring that worker tab to the front
      ready.then(() => {
        const tid = +Object.keys((S && S.workers) || {}).find((k) => +S.workers[k] === +msg.w);
        if (!tid) { reply({ ok: false, gone: true }); return; }
        chrome.tabs.get(tid, (t) => {
          if (chrome.runtime.lastError || !t) { reply({ ok: false, gone: true }); return; }
          // switch to it and show its window - also when the bot's window is minimized or behind the sheet
          chrome.tabs.update(tid, { active: true }, () => {
            chrome.windows.get(t.windowId, (win) => {
              const st = win && win.state === "minimized" ? { state: "normal", focused: true } : { focused: true, drawAttention: true };
              chrome.windows.update(t.windowId, st, () => { void chrome.runtime.lastError; reply({ ok: true }); });
            });
          });
        });
      });
      return true;
    }
    case "focusTab": {
      const id = msg.tabId || tabId || +Object.keys(S.workers || {})[0];
      if (id) chrome.tabs.get(id, (t) => { if (chrome.runtime.lastError || !t) return; chrome.tabs.update(id, { active: true }); chrome.windows.update(t.windowId, { focused: true }); });
      reply({ ok: true }); return;
    }
  }
});

// a worker tab was closed: its batch goes back to the queue, the other tabs carry on
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (S.replacing && S.replacing[tabId]) { delete S.replacing[tabId]; return; }   // the watchdog swapped this tab
  const w = S.workers[tabId];
  if (!w) return;
  delete S.workers[tabId]; delete S.wstate[w];
  if (S.inflight[w]) {
    const it = S.inflight[w].items;
    if (it[0] && it[0].site === "usps") S.uq.splice(S.upos, 0, ...it); else S.queue.splice(S.pos, 0, ...it);
    delete S.inflight[w];
  }
  if (S.running && !Object.keys(S.workers).length) stopRun("Stopped - the Track123 tab was closed");
  else if (S.running) log(`Tab ${w} was closed - the other tab${Object.keys(S.workers).length > 1 ? "s" : ""} carry on.`, "warn");
  save(true);
});

// clicking the bot icon opens the bot in Chrome's side panel (next to any tab, like ShopX)
const sidePanelOn = () => { try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch {} };
sidePanelOn();
chrome.runtime.onInstalled.addListener(sidePanelOn);
chrome.runtime.onStartup.addListener(sidePanelOn);

// ---------------- scheduled runs: a daily run at a set time, with the settings of the last ▶ Start ----------------
const SCHED_KEY = "sctrk_sched", LAST_START = "sctrk_lastStart";
function nextFire(sc) {
  if (!sc || !sc.on || !/^\d{1,2}:\d{2}$/.test(sc.time || "")) return 0;
  const [h, mi] = sc.time.split(":").map(Number);
  const okDay = (d) => (sc.days === "weekdays" ? d >= 1 && d <= 5 : sc.days === "monsat" ? d >= 1 && d <= 6 : true);
  const t = new Date();
  for (let i = 0; i < 8; i++) {
    const c = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i, h, mi, 0, 0);
    if (c.getTime() > Date.now() + 20000 && okDay(c.getDay())) return c.getTime();
  }
  return 0;
}
async function planSchedule() {
  const sc = (await chrome.storage.local.get(SCHED_KEY))[SCHED_KEY];
  try { await chrome.alarms.clear("sctrk_sched"); } catch {}
  const when = nextFire(sc);
  if (when) chrome.alarms.create("sctrk_sched", { when });
  await chrome.storage.local.set({ sctrk_schedNext: when || 0 });
  return when;
}
function notify(title, message) {
  try { chrome.notifications.create("sctrk_" + Date.now(), { type: "basic", iconUrl: "icon128.png", title, message: String(message || ""), priority: 1 }); } catch {}
}
async function runScheduled() {
  await ready;
  const last = (await chrome.storage.local.get(LAST_START))[LAST_START];
  if (S.running) log("⏰ Scheduled run skipped - a run is already going.", "warn");
  else if (!last) { log("⏰ Scheduled run: press ▶ Start once by hand first - the schedule repeats that Start's settings.", "bad"); notify("Scheduled tracking run didn't start", "Press ▶ Start once by hand first."); }
  else {
    log(`⏰ Scheduled run - ${last.sheetName || "sheet"} · ${last.rangeText || ""} (settings of your last ▶ Start).`);
    const p = (n) => String(n).padStart(2, "0"), d = new Date();
    const r = await startRun(Object.assign({}, last, { type: "startRun", resume: false, selfTab: null, scheduled: true, now: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}` }), {});
    if (r && !r.ok) notify("Scheduled tracking run couldn't start", r.error || "");
  }
  planSchedule();
}
try { chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sctrk_sched") runScheduled(); }); } catch {}
chrome.runtime.onInstalled.addListener(() => { planSchedule(); });
chrome.runtime.onStartup.addListener(() => { planSchedule(); });
