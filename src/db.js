/**
 * Data layer — SQLite (node:sqlite built-in). Zero native deps.
 * Schema mirrors blueprint §3; migrate to Postgres when you graduate to the
 * multi-agent platform (v2) — table/column names are kept identical.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// Resolve the data directory. DB_PATH (e.g. /var/data/app.db on Render with a
// Persistent Disk) wins. If its parent can't be created (disk not attached /
// not on a paid plan), fall back to local ./data LOUDLY — ephemeral storage
// means the DB is wiped on every deploy/restart. Never crash-loop over this.
let DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
let persistent = true;
try {
  require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
} catch (err) {
  persistent = false;
  DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
  require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });
  console.warn('='.repeat(70));
  console.warn(`WARNING: DB_PATH parent not writable (${err.code}) — using EPHEMERAL local storage.`);
  console.warn('The database will be WIPED on every deploy/restart. Attach a Render');
  console.warn('Persistent Disk at /var/data (paid plan) to make storage durable.');
  console.warn('='.repeat(70));
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  first_name      TEXT NOT NULL,
  last_name       TEXT DEFAULT '',
  agency_name     TEXT DEFAULT '',
  transfer_phone  TEXT,
  availability    TEXT NOT NULL DEFAULT 'UNAVAILABLE'
                  CHECK (availability IN ('AVAILABLE','ON_CALL','UNAVAILABLE','PAUSED_LOW_BALANCE')),
  concurrency_pref INTEGER NOT NULL DEFAULT 4,
  buffer_seconds  INTEGER NOT NULL DEFAULT 90,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_licenses (
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  state          TEXT NOT NULL,
  license_number TEXT NOT NULL,
  verified       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, state)
);

CREATE TABLE IF NOT EXISTS lead_vendors (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  indemnified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  first_name    TEXT, last_name TEXT,
  phone_e164    TEXT NOT NULL,
  email         TEXT,
  state         TEXT NOT NULL,
  date_of_birth TEXT,
  veteran_flag  INTEGER DEFAULT 0,
  raw_payload   TEXT DEFAULT '{}',
  vendor_id     TEXT REFERENCES lead_vendors(id),
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','dialing','qualified','callback_booked','worked','suppressed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_state_status ON leads (state, status);

CREATE TABLE IF NOT EXISTS consent_records (
  id                TEXT PRIMARY KEY,
  lead_id           TEXT NOT NULL REFERENCES leads(id),
  phone_e164        TEXT NOT NULL,
  consent_type      TEXT NOT NULL CHECK (consent_type IN ('PEWC','PEC')),
  ai_referenced     INTEGER NOT NULL,          -- disclosure explicitly mentions AI (FL requirement)
  capture_channel   TEXT NOT NULL,
  disclosure_text   TEXT NOT NULL,
  seller_named      TEXT NOT NULL,
  affirmative_action TEXT NOT NULL,
  evidence_url      TEXT,
  captured_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_phone ON consent_records (phone_e164, consent_type);

CREATE TABLE IF NOT EXISTS suppression (
  phone_e164 TEXT NOT NULL,
  reason     TEXT NOT NULL,
  source     TEXT NOT NULL,
  evidence   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (phone_e164, reason)
);

CREATE TABLE IF NOT EXISTS calls (
  id                    TEXT PRIMARY KEY,
  retell_call_id        TEXT UNIQUE,
  lead_id               TEXT NOT NULL REFERENCES leads(id),
  agent_id              TEXT REFERENCES agents(id),
  consent_record_id     TEXT NOT NULL REFERENCES consent_records(id),
  simulated             INTEGER NOT NULL DEFAULT 0,
  ai_leg_started_at     TEXT,
  ai_leg_ended_at       TEXT,
  transfer_connected_at TEXT,
  transfer_ended_at     TEXT,
  buffer_seconds        INTEGER,
  billable              INTEGER NOT NULL DEFAULT 0,
  amount_charged_cents  INTEGER NOT NULL DEFAULT 0,
  recording_url         TEXT,
  transcript            TEXT,
  disposition           TEXT CHECK (disposition IN
    ('sold','appointment_set','callback_requested','not_interested',
     'not_qualified','bad_number','wrong_person','no_answer')),
  disposition_note      TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls (lead_id);

CREATE TABLE IF NOT EXISTS call_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id    TEXT NOT NULL REFERENCES calls(id),
  event_type TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  entry_type          TEXT NOT NULL CHECK (entry_type IN ('topup','transfer_charge','void','refund','adjustment')),
  amount_cents        INTEGER NOT NULL,
  call_id             TEXT REFERENCES calls(id),
  memo                TEXT,
  balance_after_cents INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS callbacks (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT NOT NULL REFERENCES leads(id),
  priority     INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ── Lightweight column migrations (upgrades existing Render DBs in place) ──
function addColumnIfMissing(table, colDef) {
  const name = colDef.trim().split(/\s+/)[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  }
}
addColumnIfMissing('leads', "source_type TEXT NOT NULL DEFAULT 'aged'"); // 'fresh' | 'aged'
addColumnIfMissing('leads', "priority INTEGER NOT NULL DEFAULT 0");      // manual boost overrides source order
addColumnIfMissing('leads', "outcome TEXT");                             // agent-tagged contact disposition
addColumnIfMissing('leads', "imported_at TEXT");

// ── Small helpers ──────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const uid = () => require('crypto').randomUUID();

function getAgentByEmail(email) {
  return db.prepare('SELECT * FROM agents WHERE email = ?').get(email);
}

function walletBalance(agentId) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(amount_cents),0) AS bal FROM wallet_ledger WHERE agent_id = ?'
  ).get(agentId);
  return row.bal;
}

function walletAdjust(agentId, entryType, amountCents, callId, memo) {
  const bal = walletBalance(agentId) + amountCents;
  db.prepare(`INSERT INTO wallet_ledger (agent_id, entry_type, amount_cents, call_id, memo, balance_after_cents)
              VALUES (?,?,?,?,?,?)`)
    .run(agentId, entryType, amountCents, callId, memo || null, bal);
  return bal;
}

function logEvent(callId, eventType, payload) {
  db.prepare('INSERT INTO call_events (call_id, event_type, payload) VALUES (?,?,?)')
    .run(callId, eventType, JSON.stringify(payload || {}));
}

module.exports = { db, nowIso, uid, getAgentByEmail, walletBalance, walletAdjust, logEvent };
