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
const cfg = require('./config');
const { db, nowIso, uid, getAgentByEmail, walletBalance, logEvent } = require('./db');
const { evaluateCallBilling } = require('./billing');
const { createPhoneCall, webhookAuthorized, findCallByRetellId, findCallById, simulation } = require('./retell');
const dispatcher = require('./dispatcher');

const app = express();
app.use(express.json());
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
  res.json({ ok: true });
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

// ── Retell webhooks ────────────────────────────────────────────────
app.post('/retell/webhook', (req, res) => {
  if (!webhookAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

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
