/**
 * Seed: one demo agent (TX/FL licensed), a vendor, 25 consented leads,
 * suppression examples, and a $500 wallet top-up.
 * Run: npm run seed
 */
const { db, uid, getAgentByEmail, walletAdjust } = require('./src/db');
const cfg = require('./src/config');

function runSeed() {
  const agentId = uid();
  const vendorId = uid();

db.prepare(`INSERT INTO agents (id, email, first_name, last_name, agency_name, transfer_phone)
            VALUES (?,?,?,?,?,?)`)
  .run(agentId, cfg.AGENT_EMAIL, 'Demo', 'Agent', 'Demo Insurance Group', '+15551230000');

db.prepare('INSERT INTO agent_licenses (agent_id, state, license_number, verified) VALUES (?,?,?,1)')
  .run(agentId, 'TX', 'TX-DEMO-001');
db.prepare('INSERT INTO agent_licenses (agent_id, state, license_number, verified) VALUES (?,?,?,1)')
  .run(agentId, 'FL', 'FL-DEMO-001');

db.prepare('INSERT INTO lead_vendors (id, name, indemnified) VALUES (?,?,1)')
  .run(vendorId, 'Aged Lead Store (demo)');

const first = ['James','Mary','Robert','Patricia','John','Jennifer','Michael','Linda','David','Elizabeth',
               'William','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen',
               'Christopher','Lisa','Daniel','Nancy','Matthew'];
const last = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
              'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
              'Lee','Perez','Thompson','White','Harris'];

let seeded = 0;
for (let i = 0; i < 25; i++) {
  const leadId = uid();
  const state = i % 3 === 0 ? 'FL' : 'TX';
  const phone = `+1212${String(5550000 + i).slice(-7)}`;
  db.prepare(`INSERT INTO leads (id, first_name, last_name, phone_e164, email, state, date_of_birth, veteran_flag, vendor_id)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(leadId, first[i], last[i], phone, `${first[i].toLowerCase()}${i}@example.com`,
         state, `19${50 + (i % 20)}-0${(i % 9) + 1}-1${i % 9}`, i % 2, vendorId);

  // Valid PEWC consent with AI reference (the only kind preDialCheck allows)
  db.prepare(`INSERT INTO consent_records
              (id, lead_id, phone_e164, consent_type, ai_referenced, capture_channel,
               disclosure_text, seller_named, affirmative_action, captured_at)
              VALUES (?,?,?,?,1,'web_form',?,?,?,?)`)
    .run(uid(), leadId, phone, 'PEWC',
         'I agree to receive marketing calls, including AI-generated voice calls, from Demo Insurance Group at this number. Consent is not a condition of purchase.',
         'Demo Insurance Group', 'checkbox_esignature',
         new Date(Date.now() - i * 3600e3).toISOString());
}

// Suppression examples: one opt-out, one bad vintage consent (no AI reference)
const supLead = uid();
db.prepare(`INSERT INTO leads (id, first_name, last_name, phone_e164, state, vendor_id)
            VALUES (?,?,?,?,?,?)`)
  .run(supLead, 'Opted', 'Out', '+19990000001', 'TX', vendorId);
db.prepare('INSERT INTO suppression (phone_e164, reason, source) VALUES (?,?,?)')
  .run('+19990000001', 'opt_out_sms', 'prior_campaign');

walletAdjust(agentId, 'topup', 50000, null, 'Seed top-up ($500)');

console.log(`Seeded agent ${cfg.AGENT_EMAIL}: 25 dialable leads (TX/FL), 1 suppressed, wallet $500.00.`);
return { agentId };
}

if (require.main === module) runSeed();
module.exports = { runSeed };
