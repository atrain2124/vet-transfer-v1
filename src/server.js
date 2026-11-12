/**
 * HTTP surface — agent dashboard API + Retell webhooks & custom functions.
 *
 * Retell configuration (dashboard → Agent → Function tools):
 *   getTransferDestination → POST /retell/function/transfer-destination
 *   opt_out                → POST /retell/function/opt-out
 *   book_callback          → POST /retell/function/book-callback
 * Webhooks (dashboard → Webhooks):
 *   POST /retell/webhook   (call_started / call_ended / call_analyzed / transfer events)
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { db, nowIso, uid, getAgentByEmail, walletBalance, logEvent } = require('./db');
const { evaluateCallBilling } = require('./billing');
const { createPhoneCall, findCallByRetellId, findCallById, simulation } = require('./retell');
const dispatcher = require('./dispatcher');

const app = express();
// Capture the raw body BEFORE JSON parsing — HMAC signature verification
// (below) must run over the exact bytes Retell sent.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const agent = () => getAgentByEmail(cfg.AGENT_EMAIL);

// ── Agent dashboard API ────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const a = agent();
  if (!a) return res.status(404).json({ error: 'agent not found — run npm run seed' });
  const active = db.prepare(`
    SELECT c.id, c.transfer_connected_at, c.buffer_seconds, l.first_name, l.last_name,
           l.phone_e164, l.email, l.state, l.date_of_birth, l.veteran_flag,
           c.consent_record_id
    FROM calls c JOIN leads l ON l.id = c.lead_id
    WHERE c.agent_id = ? AND l.status = 'dialing' AND c.transfer_connected_at IS NOT NULL
      AND c.transfer_ended_at IS NULL
    ORDER BY c.transfer_connected_at DESC LIMIT 1`).get(a.id);
  const recent = db.prepare(`
    SELECT c.id, c.billable, c.amount_charged_cents, c.disposition, c.transfer_connected_at,
           l.first_name, l.last_name, l.state
    FROM calls c JOIN leads l ON l.id = c.lead_id
    WHERE c.agent_id = ? ORDER BY c.created_at DESC LIMIT 10`).all(a.id);
  res.json({
    agent: { name: a.first_name, availability: a.availability, buffer_seconds: a.buffer_seconds },
    wallet_balance_cents: walletBalance(a.id),
    transfer_price_cents: cfg.TRANSFER_PRICE_CENTS,
    simulation: simulation(),
    active_call: active || null,
    recent_calls: recent,
  });
});

app.post('/api/availability', (req, res) => {
  const a = agent();
  const available = !!req.body.available;
  if (a.availability === 'ON_CALL' && !available)
    return res.status(409).json({ error: 'cannot toggle while ON_CALL' });
  const target = available ? 'AVAILABLE' : 'UNAVAILABLE';
  db.prepare('UPDATE agents SET availability = ? WHERE id = ?').run(target, a.id);
  res.json({ availability: target });
});

app.post('/api/calls/:id/disposition', (req, res) => {
  const { disposition, note } = req.body;
  const valid = ['sold','appointment_set','callback_requested','not_interested',
                 'not_qualified','bad_number','wrong_person','no_answer'];
  if (!valid.includes(disposition)) return res.status(400).json({ error: 'invalid disposition' });
  db.prepare('UPDATE calls SET disposition = ?, disposition_note = ? WHERE id = ?')
    .run(disposition, note || null, req.params.id);
  logEvent(req.params.id, 'disposition_set', { disposition });

  // Propagate the tag onto the CONTACT (lead) so the database of people is
  // dispositioned, not just the call record. Mapping:
  //   terminal  → contact is done, never dialed again (status 'worked' + outcome set)
  //   callback  → contact returns via the callback queue (stays callable)
  //   no_answer → contact stays eligible; frequency caps govern retry
  const call = findCallById(req.params.id);
  if (call) {
    const terminal = ['sold','appointment_set','not_interested','not_qualified','bad_number','wrong_person'];
    if (terminal.includes(disposition)) {
      db.prepare("UPDATE leads SET status = 'worked', outcome = ? WHERE id = ?")
        .run(disposition, call.lead_id);
    } else if (disposition === 'callback_requested') {
      db.prepare("UPDATE leads SET outcome = 'callback_requested' WHERE id = ?").run(call.lead_id);
      if (req.body.callback_in_hours) {
        db.prepare('INSERT INTO callbacks (id, lead_id, priority, scheduled_at) VALUES (?,?,?,?)')
          .run(uid(), call.lead_id, 10,
               new Date(Date.now() + req.body.callback_in_hours * 3600e3).toISOString());
        db.prepare("UPDATE leads SET status = 'callback_booked' WHERE id = ?").run(call.lead_id);
      }
    } else if (disposition === 'no_answer') {
      db.prepare("UPDATE leads SET outcome = 'no_answer' WHERE id = ?").run(call.lead_id);
    }
  }
  res.json({ ok: true });
});

// ── Contact records: list + manual agent tagging ───────────────────
// The leads table IS the contact CRM: every contact carries consent, source
// (fresh/aged), call history, and an outcome tag. /api/contacts is the
// workable view of it.
app.get('/api/contacts', (req, res) => {
  const a = agent();
  const { filter } = req.query; // 'needs_disposition' | 'done' | 'all'
  let where = "l.status IN ('worked','callback_booked','dialing')";
  if (filter === 'done') where = "l.status = 'worked' AND l.outcome IS NOT NULL";
  if (filter === 'needs_disposition') where = "(l.status = 'dialing' OR (l.status = 'worked' AND l.outcome IS NULL))";
  const rows = db.prepare(`
    SELECT l.id, l.first_name, l.last_name, l.phone_e164, l.email, l.state,
           l.date_of_birth, l.veteran_flag, l.source_type, l.status, l.outcome,
           l.imported_at,
           (SELECT COUNT(*) FROM calls c WHERE c.lead_id = l.id) AS call_count,
           (SELECT c.disposition FROM calls c WHERE c.lead_id = l.id AND c.disposition IS NOT NULL
            ORDER BY c.created_at DESC LIMIT 1) AS last_call_disposition
    FROM leads l WHERE ${where}
    ORDER BY l.created_at DESC LIMIT 200`).all();
  res.json({ contacts: rows });
});

app.post('/api/contacts/:id/outcome', (req, res) => {
  const { outcome } = req.body;
  const valid = ['sold','appointment_set','callback_requested','not_interested',
                 'not_qualified','bad_number','wrong_person','no_answer','do_not_call'];
  if (!valid.includes(outcome)) return res.status(400).json({ error: 'invalid outcome' });
  if (outcome === 'do_not_call') {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (lead) {
      db.prepare('INSERT OR IGNORE INTO suppression (phone_e164, reason, source) VALUES (?,?,?)')
        .run(lead.phone_e164, 'opt_out_voice', 'agent_tag');
      db.prepare("UPDATE leads SET status = 'suppressed' WHERE id = ?").run(lead.id);
    }
  }
  db.prepare("UPDATE leads SET outcome = ?, status = CASE WHEN ? = 'do_not_call' THEN status ELSE 'worked' END WHERE id = ?")
    .run(outcome, outcome, req.params.id);
  res.json({ ok: true });
});

// ── Data import: CSV with MANDATORY consent fields ─────────────────
// Every imported record must carry a consent timestamp; batch-level consent
// attributes (seller, channel, disclosure, action, source_type) apply to all
// rows. Rows missing phone/state/consent_captured_at are REJECTED, not
// silently fixed — the file goes back to the vendor.
const CSV_REQUIRED = ['first_name','last_name','phone','state','consent_captured_at'];

app.post('/api/leads/import', (req, res) => {
  const { csv, source_type = 'aged', seller_named, capture_channel,
          disclosure_text, affirmative_action = 'checkbox_esignature', vendor_name } = req.body;
  if (!csv || !seller_named || !capture_channel || !disclosure_text)
    return res.status(400).json({ error: 'csv, seller_named, capture_channel, disclosure_text are required' });
  if (!['fresh','aged'].includes(source_type))
    return res.status(400).json({ error: "source_type must be 'fresh' or 'aged'" });

  let vendorId = null;
  if (vendor_name) {
    const existing = db.prepare('SELECT id FROM lead_vendors WHERE name = ?').get(vendor_name);
    if (existing) {
      vendorId = existing.id;
    } else {
      vendorId = uid();
      db.prepare('INSERT INTO lead_vendors (id, name) VALUES (?,?)').run(vendorId, vendor_name);
    }
  }

  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const col of CSV_REQUIRED) if (!(col in idx))
    return res.status(400).json({ error: `CSV missing required column: ${col}` });

  let inserted = 0; const rejected = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = lines[i].split(',').map(c => c.trim());
    const rec = Object.fromEntries(header.map((h, j) => [h, cells[j]]));
    const phone = rec.phone.startsWith('+') ? rec.phone : `+1${rec.phone.replace(/\D/g, '')}`;
    if (!/^\+1\d{10}$/.test(phone) || !rec.state || !rec.consent_captured_at) {
      rejected.push({ line: i + 1, reason: 'missing/invalid phone, state, or consent_captured_at' });
      continue;
    }
    const leadId = uid();
    db.prepare(`INSERT INTO leads (id, first_name, last_name, phone_e164, email, state,
                date_of_birth, veteran_flag, source_type, vendor_id, imported_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(leadId, rec.first_name || null, rec.last_name || null, phone, rec.email || null,
           rec.state.toUpperCase(), rec.dob || null, rec.veteran_flag === '1' || rec.veteran_flag === 'true' ? 1 : 0,
           source_type, vendorId || null, nowIso());
    db.prepare(`INSERT INTO consent_records (id, lead_id, phone_e164, consent_type, ai_referenced,
                capture_channel, disclosure_text, seller_named, affirmative_action, captured_at)
                VALUES (?,?,?, 'PEWC', 1, ?,?,?,?,?)`)
      .run(uid(), leadId, phone, capture_channel, disclosure_text, seller_named,
           affirmative_action, new Date(rec.consent_captured_at).toISOString());
    inserted++;
  }
  res.json({ inserted, rejected, source_type });
});

// ── Retell custom functions ────────────────────────────────────────
app.post('/retell/function/transfer-destination', (req, res) => {
  // Resolve the transfer target, pre-checking wallet + seat state, so an
  // ineligible agent's phone never rings (blueprint §5.2).
  const a = agent();
  const call = findCallById(req.body?.metadata?.call_id || '');
  if (!a || !call) return res.json({ transfer: false });

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(call.lead_id);
  const licensed = db.prepare('SELECT 1 FROM agent_licenses WHERE agent_id = ? AND state = ?')
    .get(a.id, lead.state);
  const balance = walletBalance(a.id);

  if (a.availability !== 'AVAILABLE' || !licensed || balance < cfg.TRANSFER_PRICE_CENTS || !a.transfer_phone) {
    return res.json({ transfer: false });
  }
  return res.json({ transfer: true, destination: a.transfer_phone });
});

app.post('/retell/function/opt-out', (req, res) => {
  const call = findCallById(req.body?.metadata?.call_id || '');
  const lead = call && db.prepare('SELECT * FROM leads WHERE id = ?').get(call.lead_id);
  if (lead) {
    db.prepare('INSERT OR IGNORE INTO suppression (phone_e164, reason, source, evidence) VALUES (?,?,?,?)')
      .run(lead.phone_e164, 'opt_out_voice', 'ai_call',
           JSON.stringify(req.body?.transcript_snippet || ''));
    db.prepare("UPDATE leads SET status = 'suppressed' WHERE id = ?").run(lead.id);
    logEvent(call.id, 'opt_out_detected', { phone: lead.phone_e164 });
  }
  // Propagation to email/SMS/CRM channels happens via the outbox in v2 —
  // see blueprint §6.3. v1 scope: voice + local suppression (instant).
  res.json({ ok: true });
});

app.post('/retell/function/book-callback', (req, res) => {
  const call = findCallById(req.body?.metadata?.call_id || '');
  if (!call) return res.json({ ok: false });
  const minutes = parseInt(req.body?.minutes_from_now || '60', 10);
  db.prepare('INSERT INTO callbacks (id, lead_id, priority, scheduled_at) VALUES (?,?,?,?)')
    .run(uid(), call.lead_id, 10, new Date(Date.now() + minutes * 60000).toISOString());
  db.prepare("UPDATE leads SET status = 'callback_booked' WHERE id = ?").run(call.lead_id);
  logEvent(call.id, 'callback_booked', { minutes_from_now: minutes });
  res.json({ ok: true });
});

// ── Retell webhook signature verification ──────────────────────────
// Per https://docs.retellai.com/features/secure-webhook — there is NO separate
// webhook secret in Retell: the HMAC key IS your Retell API key.
// Header format: "v=<ms timestamp>,d=<hex hmac-sha256(rawBody + timestamp, api_key)>"
function verifyRetellSignature(req) {
  const secret = process.env.RETELL_API_KEY;
  if (!secret) return true; // simulation/dev mode — no key configured yet
  const header = req.get('x-retell-signature') || '';
  const m = header.match(/^v=(\d+),d=([0-9a-f]{64})$/i);
  if (!m) return false;
  const [, timestamp, digest] = m;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false; // replay guard
  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody + timestamp)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digest.toLowerCase()));
}

// ── Retell webhooks ────────────────────────────────────────────────
app.post('/retell/webhook', (req, res) => {
  if (!verifyRetellSignature(req)) return res.status(401).json({ error: 'bad signature' });

  const event = req.body.event || req.body.event_type;
  const rid = req.body.call?.call_id || req.body.call_id || '';
  // Resolve by Retell call id first, then internal id (simulation mode dials
  // have retell_call_id NULL and are addressed by internal id).
  const call = findCallByRetellId(rid) || findCallById(rid);
  if (!call) return res.json({ ok: true, note: 'unknown call' });

  switch (event) {
    case 'call_started':
      db.prepare('UPDATE calls SET ai_leg_started_at = ? WHERE id = ?').run(nowIso(), call.id);
      logEvent(call.id, 'call_started', {});
      break;

    case 'transfer_connected': // warm transfer bridge completed
      db.prepare('UPDATE calls SET transfer_connected_at = ? WHERE id = ?').run(nowIso(), call.id);
      db.prepare("UPDATE agents SET availability = 'ON_CALL' WHERE id = ?").run(call.agent_id);
      logEvent(call.id, 'transfer_connected', {});
      break;

    case 'call_ended': {
      const now = nowIso();
      const wasConnected = !!call.transfer_connected_at;
      db.prepare(`UPDATE calls SET transfer_ended_at = CASE WHEN transfer_connected_at IS NOT NULL THEN ? ELSE transfer_ended_at END,
                         ai_leg_ended_at = ? WHERE id = ?`).run(now, now, call.id);
      // Billing gate + seat release
      const fresh = findCallById(call.id);
      evaluateCallBilling(fresh);
      db.prepare("UPDATE leads SET status = 'worked' WHERE id = ? AND status = 'dialing'").run(call.lead_id);
      db.prepare("UPDATE agents SET availability = 'AVAILABLE' WHERE id = ? AND availability = 'ON_CALL'")
        .run(call.agent_id);
      logEvent(call.id, 'call_ended', { was_connected: wasConnected });
      break;
    }

    case 'call_analyzed':
      db.prepare('UPDATE calls SET recording_url = ?, transcript = ? WHERE id = ?')
        .run(req.body.call?.recording_url || null,
             JSON.stringify(req.body.call?.transcript || null), call.id);
      logEvent(call.id, 'call_analyzed', {});
      break;

    default:
      logEvent(call.id, `webhook:${event}`, {});
  }
  res.json({ ok: true });
});

// ── Boot ───────────────────────────────────────────────────────────
app.listen(cfg.PORT, '0.0.0.0', () => {
  console.log(`vet-transfer-v1 listening on :${cfg.PORT} (mode: ${simulation() ? 'SIMULATION' : 'LIVE'})`);
  dispatcher.start(2000);
});
