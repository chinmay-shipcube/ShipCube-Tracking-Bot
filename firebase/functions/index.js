// ShipCube Tracking Bot - database API (Cloud Functions + Firestore)
//   POST /ping   -> { ok, email }                     connection test
//   POST /sync   -> writes sheet rows to Firestore     body: { source, headers, rows: [{row, tn, status, date, carrier, data}] }
// Every call needs "Authorization: Bearer <Firebase ID token>" of a signed-in @shipcube.com user.
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const DOMAIN = /@shipcube\.com$/i;
const MAX_ROWS = 200;
const TS = () => admin.firestore.FieldValue.serverTimestamp();
const clean = (v) => String(v == null ? "" : v).trim();
const isDelivered = (s) => /^delivered$/i.test(clean(s));

async function who(req) {
  const m = /^Bearer (.+)$/.exec(req.get("Authorization") || "");
  if (!m) throw Object.assign(new Error("Sign in to the bot first"), { code: 401 });
  const u = await admin.auth().verifyIdToken(m[1]);
  if (!DOMAIN.test(u.email || "") || !u.email_verified) throw Object.assign(new Error("Only verified @shipcube.com accounts can use the database"), { code: 403 });
  return u;
}

function wrap(handler) {
  return onRequest({ region: "us-central1", maxInstances: 10, timeoutSeconds: 120 }, async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
    try {
      const user = await who(req);
      res.json(await handler(req, user));
    } catch (e) {
      res.status(e.code === 401 || e.code === 403 ? e.code : 500).json({ ok: false, error: e.message || String(e) });
    }
  });
}

exports.ping = wrap(async (req, user) => ({ ok: true, email: user.email }));

exports.sync = wrap(async (req, user) => {
  const body = req.body || {};
  const rows = (Array.isArray(body.rows) ? body.rows : []).filter((r) => clean(r.tn));
  if (!rows.length) return { ok: true, written: 0, history: 0 };
  if (rows.length > MAX_ROWS) return { ok: false, error: "Too many rows in one call (max " + MAX_ROWS + ")" };

  const refs = rows.map((r) => db.collection("shipments").doc(clean(r.tn).toUpperCase()));
  const snaps = await db.getAll(...refs);             // what we already know about each shipment
  const batch = db.batch();
  let history = 0;

  rows.forEach((r, i) => {
    const ref = refs[i];
    const prev = snaps[i].exists ? snaps[i].data() : {};
    let status = clean(r.status);
    // Delivered is final: a later "in transit" never overwrites it (same rule as the sheet)
    if (isDelivered(prev.status) && !isDelivered(status)) status = prev.status;

    const doc = {
      tracking: clean(r.tn).toUpperCase(),
      status,
      carrier: clean(r.carrier) || prev.carrier || "",
      shipDate: clean(r.date) || prev.shipDate || "",
      lastRow: r.row || null,
      source: clean(body.source) || prev.source || "",
      sheet: r.data || {},                              // every column of the sheet row, as text
      updatedBy: user.email,
      updatedAt: TS(),
    };
    if (!snaps[i].exists) doc.createdAt = TS();
    if (status !== clean(prev.status)) {
      batch.set(ref.collection("history").doc(), { from: clean(prev.status), to: status, at: TS(), by: user.email });
      history++;
    }
    batch.set(ref, doc, { merge: true });
  });

  await batch.commit();
  return { ok: true, written: rows.length, history };
});
