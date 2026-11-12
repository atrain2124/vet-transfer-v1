require('dotenv').config();

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  BASE_URL: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  // Retell AI (https://dashboard.retellai.com → API Keys)
  // Leave RETELL_API_KEY empty to run in SIMULATION MODE (no real dials;
  // dispatcher creates local call rows so the full flow can be smoke-tested).
  RETELL_API_KEY: process.env.RETELL_API_KEY || '',
  RETELL_AGENT_ID: process.env.RETELL_AGENT_ID || '',
  RETELL_PHONE_NUMBER_ID: process.env.RETELL_PHONE_NUMBER_ID || '',
  // From Retell dashboard → Webhooks. Simple shared-secret check on x-retell-signature.
  RETELL_WEBHOOK_TOKEN: process.env.RETELL_WEBHOOK_TOKEN || '',

  // Per-transfer pricing & billing (cents)
  TRANSFER_PRICE_CENTS: parseInt(process.env.TRANSFER_PRICE_CENTS || '5500', 10),
  DEFAULT_BUFFER_SECONDS: parseInt(process.env.DEFAULT_BUFFER_SECONDS || '90', 10),
  DEFAULT_CONCURRENCY: parseInt(process.env.DEFAULT_CONCURRENCY || '4', 10),

  // Compliance parameters
  FREQUENCY_CAP_24H: parseInt(process.env.FREQUENCY_CAP_24H || '1', 10),
  FREQUENCY_CAP_7D: parseInt(process.env.FREQUENCY_CAP_7D || '3', 10),
  CALLING_HOURS_START: 8,  // local time of the LEAD
  CALLING_HOURS_END: 21,   // exclusive; 8am–9pm federal window

  // Agent whose seat this v1 instance serves
  AGENT_EMAIL: process.env.AGENT_EMAIL || 'agent@example.com',
};
