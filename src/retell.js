/**
 * Retell AI client (blueprint §2.5). If RETELL_API_KEY is unset the whole
 * system runs in SIMULATION MODE — calls are created locally and driven by
 * the test harness, so the entire flow (dispatch → qualification → transfer
 * → billing gate → disposition) is verifiable before you spend a dollar.
 */
const cfg = require('./config');
const { db, nowIso, uid, logEvent } = require('./db');

const RETELL_BASE = 'https://api.retellai.com';
const simulation = () => !cfg.RETELL_API_KEY;

async function createPhoneCall(lead, agent, consentRecordId) {
  const callId = uid();

  if (simulation()) {
    db.prepare(`INSERT INTO calls (id, lead_id, agent_id, consent_record_id, simulated, buffer_seconds)
                VALUES (?,?,?,?,1,?)`)
      .run(callId, lead.id, agent.id, consentRecordId, agent.buffer_seconds);
    logEvent(callId, 'dial_simulated', { to: lead.phone_e164 });
    return { callId, simulated: true };
  }

  const res = await fetch(`${RETELL_BASE}/v2/create-phone-call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from_number: cfg.RETELL_PHONE_NUMBER_ID,   // state-matched number recommended
      to_number: lead.phone_e164,
      retell_agent_id: cfg.RETELL_AGENT_ID,
      // Dynamic variables consumed by the call script
      retell_llm_dynamic_variables: {
        lead_first_name: lead.first_name || 'there',
        lead_state: lead.state,
        agent_first_name: agent.first_name,
        agent_agency: agent.agency_name || 'our agency',
      },
      // Custom function metadata — comes back on every webhook/function call
      metadata: { call_id: callId, lead_id: lead.id, agent_id: agent.id },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Retell create-phone-call failed: ${res.status} ${body}`);
  }
  const data = await res.json();

  db.prepare(`INSERT INTO calls (id, retell_call_id, lead_id, agent_id, consent_record_id, buffer_seconds)
              VALUES (?,?,?,?,?,?)`)
    .run(callId, data.call_id ?? data.id, lead.id, agent.id, consentRecordId, agent.buffer_seconds);
  logEvent(callId, 'dial_created', { retell_call_id: data.call_id ?? data.id });
  return { callId, retellCallId: data.call_id ?? data.id, simulated: false };
}

/** Verify webhook signature (simple token compare; upgrade to HMAC per Retell docs). */
function webhookAuthorized(req) {
  if (!cfg.RETELL_WEBHOOK_TOKEN) return true; // open in simulation/dev
  return req.get('x-retell-signature') === cfg.RETELL_WEBHOOK_TOKEN;
}

function findCallByRetellId(retellCallId) {
  return db.prepare('SELECT * FROM calls WHERE retell_call_id = ?').get(retellCallId);
}
function findCallById(callId) {
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(callId);
}

module.exports = { createPhoneCall, webhookAuthorized, findCallByRetellId, findCallById, simulation };
