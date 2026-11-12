/**
 * Dispatcher (blueprint §4) — the dial loop.
 *
 * Seat state machine: AVAILABLE → (transfer connected) → ON_CALL → (ends) → AVAILABLE.
 * Dials only launch against AVAILABLE seats with wallet ≥ transfer price.
 * Callback-queue leads are drawn FIRST (already consented, already engaged).
 */
const { db, nowIso, uid, logEvent } = require('./db');
const cfg = require('./config');
const { preDialCheck } = require('./compliance');
const { createPhoneCall, simulation } = require('./retell');

let timer = null;

function activeDialCount(agentId) {
  // In-flight AI qualification legs: leads currently 'dialing'
  return db.prepare(`
    SELECT COUNT(*) AS n FROM calls c
    JOIN leads l ON l.id = c.lead_id
    WHERE c.agent_id = ? AND l.status = 'dialing' AND c.ai_leg_ended_at IS NULL`).get(agentId).n;
}

function licensedStates(agentId) {
  return db.prepare('SELECT state FROM agent_licenses WHERE agent_id = ? AND verified = 1')
    .all(agentId).map(r => r.state);
}

function nextLead(agentId, states) {
  // 1. Callback queue first (scheduled time reached)
  const cb = db.prepare(`
    SELECT cb.id AS callback_id, l.* FROM callbacks cb
    JOIN leads l ON l.id = cb.lead_id
    WHERE cb.status = 'pending' AND cb.scheduled_at <= ?
      AND l.state IN (${states.map(() => '?').join(',')})
    ORDER BY cb.priority DESC, cb.scheduled_at ASC LIMIT 1`)
    .get(nowIso(), ...states);
  if (cb) return { lead: cb, callbackId: cb.callback_id };

  // 2. Fresh data — FRESH FIRST, then aged (per owner policy). Within each
  //    source: highest manual priority first, then oldest import first.
  //    A high `priority` (e.g. 10) beats any source_type, so a hot aged list
  //    can be force-jumped ahead of fresh if you ever want that.
  const ph = db.prepare(`
    SELECT * FROM leads
    WHERE status = 'new' AND state IN (${states.map(() => '?').join(',')})
    ORDER BY CASE WHEN priority >= 10 THEN 0 ELSE 1 END,
             CASE source_type WHEN 'fresh' THEN 0 ELSE 1 END,
             priority DESC,
             created_at ASC
    LIMIT 1`).get(...states);
  if (ph) return { lead: ph };
  return null;
}

async function tick() {
  try {
    const agents = db.prepare("SELECT * FROM agents WHERE availability = 'AVAILABLE'").all();
    for (const agent of agents) {
      const balance = db.prepare(
        'SELECT COALESCE(SUM(amount_cents),0) AS bal FROM wallet_ledger WHERE agent_id = ?'
      ).get(agent.id).bal;

      if (balance < cfg.TRANSFER_PRICE_CENTS) {
        db.prepare("UPDATE agents SET availability = 'PAUSED_LOW_BALANCE' WHERE id = ?").run(agent.id);
        continue;
      }

      const states = licensedStates(agent.id);
      if (states.length === 0) continue;

      while (activeDialCount(agent.id) < agent.concurrency_pref) {
        const pick = nextLead(agent.id, states);
        if (!pick) break;

        const { lead, callbackId } = pick;
        const check = preDialCheck(lead);
        if (!check.allowed) {
          logSkip(lead, check.reason, callbackId);
          continue;
        }

        try {
          await createPhoneCall(lead, agent, check.consentRecordId);
          db.prepare("UPDATE leads SET status = 'dialing' WHERE id = ?").run(lead.id);
          if (callbackId) {
            db.prepare("UPDATE callbacks SET status = 'done' WHERE id = ?").run(callbackId);
          }
        } catch (err) {
          console.error(`[dispatcher] dial failed for lead ${lead.id}:`, err.message);
          break; // don't hammer the API this tick
        }
      }
    }
  } catch (err) {
    console.error('[dispatcher] tick error:', err);
  }
}

function logSkip(lead, reason, callbackId) {
  // Failed pre-dial checks are marked worked (suppressed leads marked suppressed)
  // so they never block the pipeline. All skips are audit-visible via the lead's raw status.
  if (reason.startsWith('suppressed:')) {
    db.prepare("UPDATE leads SET status = 'suppressed' WHERE id = ?").run(lead.id);
  } else {
    db.prepare("UPDATE leads SET status = 'worked' WHERE id = ?").run(lead.id);
  }
  if (callbackId) db.prepare("UPDATE callbacks SET status = 'done' WHERE id = ?").run(callbackId);
  console.log(`[dispatcher] skip lead ${lead.id}: ${reason}`);
}

function start(intervalMs = 2000) {
  if (timer) return;
  console.log(`[dispatcher] started (mode: ${simulation() ? 'SIMULATION' : 'LIVE Retell'}, interval ${intervalMs}ms)`);
  tick();
  timer = setInterval(tick, intervalMs);
}

module.exports = { start, tick };
