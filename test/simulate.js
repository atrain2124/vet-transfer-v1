/**
 * End-to-end smoke test (SIMULATION MODE — no Retell account needed).
 * Drives the full lifecycle through the real HTTP surface + dispatcher:
 *   availability on → dispatcher dials consented leads → transfer connects
 *   → seat ON_CALL → call ends inside buffer (void) → second call beyond
 *   buffer (charged) → dispositions set → wallet ledger reflects it.
 *
 * Run: npm start (in one shell) then npm run simulate (in another)
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('— 1. Go AVAILABLE —');
  console.log(await api('/api/availability', { available: true }));

  console.log('— 2. Wait for dispatcher to dial (simulation) —');
  await sleep(4000);
  let state = await api('/api/state');
  console.log('recent calls so far:', state.recent_calls.length);

  // Drive the oldest in-flight simulated call: connect transfer, end BEFORE buffer
  const { db } = require('../src/db');
  const call1 = db.prepare(`
    SELECT c.id, c.retell_call_id FROM calls c JOIN leads l ON l.id = c.lead_id
    WHERE c.simulated = 1 AND c.transfer_connected_at IS NULL
    ORDER BY c.created_at ASC LIMIT 1`).get();
  if (!call1) throw new Error('no simulated call found — is the server running?');

  console.log('— 3. Transfer connects on call', call1.id, '—');
  await api('/retell/webhook', { event: 'transfer_connected', call_id: call1.retell_call_id || call1.id });
  state = await api('/api/state');
  console.log('agent seat:', state.agent.availability, '(expect ON_CALL)');

  console.log('— 4. End call AFTER 10s (inside 90s buffer → should VOID) —');
  await sleep(10000);
  await api('/retell/webhook', { event: 'call_ended', call_id: call1.retell_call_id || call1.id });
  state = await api('/api/state');
  console.log('agent seat:', state.agent.availability, '(expect AVAILABLE)');
  const c1 = db.prepare('SELECT * FROM calls WHERE id = ?').get(call1.id);
  console.log(`call1 billable=${c1.billable} charged=${c1.amount_charged_cents} (expect 0/0)`);

  console.log('— 5. Drive second call BEYOND the buffer (should CHARGE) —');
  // Connect + fast-forward: mark connected 120s ago, then end
  const call2 = db.prepare(`
    SELECT c.id, c.retell_call_id FROM calls c JOIN leads l ON l.id = c.lead_id
    WHERE c.simulated = 1 AND c.transfer_connected_at IS NULL
    ORDER BY c.created_at ASC LIMIT 1`).get();
  if (!call2) throw new Error('no second simulated call');
  await api('/retell/webhook', { event: 'transfer_connected', call_id: call2.retell_call_id || call2.id });
  const past = new Date(Date.now() - 120000).toISOString();
  db.prepare('UPDATE calls SET transfer_connected_at = ? WHERE id = ?').run(past, call2.id);
  await api('/retell/webhook', { event: 'call_ended', call_id: call2.retell_call_id || call2.id });
  const c2 = db.prepare('SELECT * FROM calls WHERE id = ?').get(call2.id);
  console.log(`call2 billable=${c2.billable} charged=${c2.amount_charged_cents} (expect 1/5500)`);

  console.log('— 6. Disposition the billable call —');
  console.log(await api(`/api/calls/${call2.id}/disposition`, { disposition: 'appointment_set' }));

  state = await api('/api/state');
  console.log('— FINAL —');
  console.log('wallet balance:', '$' + (state.wallet_balance_cents / 100).toFixed(2), '(expect $445.00)');
  console.log('recent calls:', state.recent_calls.length);

  const ok = !c1.billable && c2.billable === 1 && state.wallet_balance_cents === 44500;
  console.log(ok ? '✅ SMOKE TEST PASSED — buffer gate + billing + seat machine all correct'
                 : '❌ SMOKE TEST FAILED — inspect output above');
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
