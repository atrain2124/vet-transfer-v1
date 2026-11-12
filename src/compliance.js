/**
 * Consent & Suppression — the pre-dial allow/deny gate (blueprint §2.4).
 * EVERY dial must pass through preDialCheck(); it fails CLOSED.
 *
 * External lookups (federal DNC scrub, litigator lists) are integration
 * points stubbed below — wire Blacklist Alliance / DNC.com / a DNC-scrub
 * API here before going live with real data.
 */
const { db } = require('./db');
const cfg = require('./config');

// State → IANA timezone (for lead-local calling hours)
const STATE_TZ = {
  AL:'America/Chicago', AK:'America/Anchorage', AZ:'America/Phoenix', AR:'America/Chicago',
  CA:'America/Los_Angeles', CO:'America/Denver', CT:'America/New_York', DE:'America/New_York',
  DC:'America/New_York', FL:'America/New_York', GA:'America/New_York', HI:'Pacific/Honolulu',
  ID:'America/Boise', IL:'America/Chicago', IN:'America/Indiana/Indianapolis', IA:'America/Chicago',
  KS:'America/Chicago', KY:'America/New_York', LA:'America/Chicago', ME:'America/New_York',
  MD:'America/New_York', MA:'America/New_York', MI:'America/New_York', MN:'America/Chicago',
  MS:'America/Chicago', MO:'America/Chicago', MT:'America/Denver', NE:'America/Chicago',
  NV:'America/Los_Angeles', NH:'America/New_York', NJ:'America/New_York', NM:'America/Denver',
  NY:'America/New_York', NC:'America/New_York', ND:'America/Chicago', OH:'America/New_York',
  OK:'America/Chicago', OR:'America/Los_Angeles', PA:'America/New_York', RI:'America/New_York',
  SC:'America/New_York', SD:'America/Chicago', TN:'America/Chicago', TX:'America/Chicago',
  UT:'America/Denver', VT:'America/New_York', VA:'America/New_York', WA:'America/Los_Angeles',
  WV:'America/New_York', WI:'America/Chicago', WY:'America/Denver',
};

function isWithinCallingHours(state, when = new Date()) {
  const tz = STATE_TZ[state] || 'America/New_York';
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hour12: false, timeZone: tz }).format(when), 10);
  // CT (9am start) and FL (8am–8pm) overlays included here
  if (state === 'CT') return hour >= 9 && hour < 21;
  if (state === 'FL') return hour >= 8 && hour < 20;
  return hour >= cfg.CALLING_HOURS_START && hour < cfg.CALLING_HOURS_END;
}

/** External DNC/litigator stub — replace with real API before live dialing. */
function externalScreen(/* phoneE164 */) {
  // TODO: federal DNC (cached ≤31 days, nightly incremental),
  // litigator/serial-complainant scrub, state DNC lists.
  return { clean: true, source: null };
}

/**
 * @returns {allowed: boolean, reason: string, consentRecordId?: string}
 */
function preDialCheck(lead) {
  const phone = lead.phone_e164;

  // 1. Internal suppression (any channel, free-form opt-outs included)
  const sup = db.prepare('SELECT reason FROM suppression WHERE phone_e164 = ?').get(phone);
  if (sup) return { allowed: false, reason: `suppressed:${sup.reason}` };

  // 2. External DNC / litigator screen
  const ext = externalScreen(phone);
  if (!ext.clean) return { allowed: false, reason: `external:${ext.source}` };

  // 3. Valid PEWC consent with AI reference
  const consent = db.prepare(`
    SELECT id FROM consent_records
    WHERE phone_e164 = ? AND consent_type = 'PEWC' AND ai_referenced = 1
    ORDER BY captured_at DESC LIMIT 1`).get(phone);
  if (!consent) return { allowed: false, reason: 'no_valid_pewc_consent' };

  // 4. Calling hours (lead-local)
  if (!isWithinCallingHours(lead.state)) return { allowed: false, reason: 'outside_calling_hours' };

  // 5. Frequency caps
  const caps = db.prepare(`
    SELECT
      SUM(CASE WHEN created_at >= datetime('now','-1 day') THEN 1 ELSE 0 END) AS d1,
      COUNT(*) AS d7
    FROM calls WHERE lead_id = ?`).get(lead.id);
  if ((caps.d1 || 0) >= cfg.FREQUENCY_CAP_24H) return { allowed: false, reason: 'freq_cap_24h' };
  if ((caps.d7 || 0) >= cfg.FREQUENCY_CAP_7D)  return { allowed: false, reason: 'freq_cap_7d' };

  return { allowed: true, reason: 'ok', consentRecordId: consent.id };
}

module.exports = { preDialCheck, isWithinCallingHours, STATE_TZ };
