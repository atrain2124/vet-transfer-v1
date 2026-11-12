# vet-transfer-v1

Single-agent AI qualification & warm-transfer system — the v1 "done-for-you" offer.
The AI voice agent works the agent's own lead data, qualifies prospects, and
warm-transfers them to the agent with a full screen pop. Transfers are billed
only after the buffer window; calls that drop inside the buffer are never charged.

Full design rationale: see `veteran-transfer-platform-blueprint.md` (parent directory).

## Architecture

```
Agent Dashboard (public/index.html)      ← availability, screen pop, disposition
        │  /api/*
src/server.js  (Express)                 ← dashboard API + Retell webhooks/functions
        │
src/dispatcher.js                        ← dial loop: seat state machine, concurrency,
        │                                   callback queue, pre-dial gate on EVERY dial
src/compliance.js                        ← pre-dial check: suppression → DNC → consent
        │                                   → calling hours (lead-local) → frequency caps
src/retell.js                            ← Retell AI: create-phone-call + webhooks
src/billing.js                           ← buffer-gated transfer charges + wallet ledger
src/db.js                                ← SQLite (node:sqlite, zero native deps)
```

## Quick start (simulation mode — no Retell account needed)

```bash
npm install
npm run seed        # demo agent (TX/FL), 25 consented leads, $500 wallet
npm start           # dashboard on http://localhost:3000
# second shell:
npm run simulate    # drives the full call lifecycle → verifies buffer/billing gate
```

Simulation mode creates real call rows in the local DB and the test drives them
through the same webhook surface Retell will use in production — so the entire
seat-state machine, callback queue, billing gate, and wallet are verified before
you spend anything on telephony.

## Going live with Retell AI

1. Create an account at [dashboard.retellai.com](https://dashboard.retellai.com), add
   an outbound phone number (state-matched to your leads' states).
2. Create the voice agent using `retell-ai-call-script.md` (parent directory):
   general prompt, opening disclosure, qualification questions, transfer tool,
   voicemail behavior — all specified there.
3. Add three **custom function tools** to the agent, each pointing at your server:
   | Retell function | Your endpoint |
   |---|---|
   | `getTransferDestination` | `POST /retell/function/transfer-destination` |
   | `opt_out` | `POST /retell/function/opt-out` |
   | `book_callback` | `POST /retell/function/book-callback` |
   The function body must include the call `metadata` (the server passes
   `call_id`/`lead_id`/`agent_id` on every dial; configure the function to return it).
4. Set webhooks (Retell dashboard → Webhooks) to `POST /retell/webhook`. There is
   **no separate webhook secret in Retell** — signatures are HMAC-SHA256 keyed
   with your existing Retell API key; the server verifies them automatically
   (`X-Retell-Signature` header, 5-minute replay window). In simulation mode
   (no API key configured) verification is skipped.
5. Expose the server publicly (Fly.io/Railway, or `ngrok http 3000` for testing).
6. Fill `.env`:

```ini
PORT=3000
BASE_URL=https://your-domain.com
RETELL_API_KEY=key_...
RETELL_AGENT_ID=agent_...
RETELL_PHONE_NUMBER_ID=...
RETELL_WEBHOOK_TOKEN=...
AGENT_EMAIL=agent@example.com
TRANSFER_PRICE_CENTS=5500
DEFAULT_BUFFER_SECONDS=90
```

Restart — the boot banner will read `mode: LIVE`.

## Before dialing REAL data (non-negotiable)

- [ ] TCPA counsel has reviewed the consent language and the call script disclosure
- [ ] Every lead record has an attached, audited consent record (`consent_records`)
- [ ] `externalScreen()` in `src/compliance.js` is wired to a real federal DNC +
      litigator scrub API (currently a stub that passes everything)
- [ ] Transfer phone verified; buffer and price set in `.env`
- [ ] Outbound number is state-matched to the leads being dialed

## Migrating to v2 (multi-agent platform)

Table names and the webhook contract are deliberately identical to the Postgres
schema in the blueprint (§3). The upgrade path is: swap `node:sqlite` for
Postgres, add the agents table to multi-row, add the portal auth/Stripe wallet
per the blueprint — the dispatcher, compliance, billing, and Retell layers
carry over unchanged.
