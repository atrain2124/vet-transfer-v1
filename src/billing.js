/**
 * Billing — buffer-gated transfer charges (blueprint §5.4).
 * Invariant: a transfer_charge is written ONLY if
 *   (transfer_ended_at - transfer_connected_at) >= buffer_seconds
 * Everything else voids — the agent is never charged for a call that
 * died inside the buffer window.
 */
const { db, walletAdjust, logEvent } = require('./db');
const cfg = require('./config');

function evaluateCallBilling(call) {
  if (call.billable || !call.transfer_connected_at) return call;

  const connected = new Date(call.transfer_connected_at).getTime();
  const ended = new Date(call.transfer_ended_at || call.ai_leg_ended_at || Date.now()).getTime();
  const buffer = call.buffer_seconds ?? cfg.DEFAULT_BUFFER_SECONDS;
  const seconds = Math.floor((ended - connected) / 1000);
  const billable = seconds >= buffer;

  const updated = db.prepare(`
    UPDATE calls SET transfer_ended_at = COALESCE(transfer_ended_at, ?),
                     billable = ?, amount_charged_cents = ?
    WHERE id = ? AND billable = 0`)
    .run(call.transfer_ended_at || new Date(ended).toISOString(),
         billable ? 1 : 0,
         billable ? cfg.TRANSFER_PRICE_CENTS : 0,
         call.id);

  if (updated.changes === 0) return db.prepare('SELECT * FROM calls WHERE id = ?').get(call.id);

  logEvent(call.id, billable ? 'charge_applied' : 'charge_voided', { seconds, buffer });

  if (call.agent_id) {
    if (billable) {
      walletAdjust(call.agent_id, 'transfer_charge', -cfg.TRANSFER_PRICE_CENTS, call.id,
        `Transfer ${seconds}s (buffer ${buffer}s)`);
    } else {
      walletAdjust(call.agent_id, 'void', 0, call.id,
        `Voided: ended at ${seconds}s < buffer ${buffer}s`);
    }
  }
  return db.prepare('SELECT * FROM calls WHERE id = ?').get(call.id);
}

module.exports = { evaluateCallBilling };
