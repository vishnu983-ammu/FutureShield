/**
 * FutureShield — WhatsApp Bulk Messaging Microservice
 * ====================================================
 * Stack : Node.js + Express + whatsapp-web.js
 * Auth  : Simple Bearer token (set WA_SECRET in environment or .env)
 *
 * Endpoints:
 *   GET  /wa/status          → connection state + phone info
 *   GET  /wa/qr              → base64 QR code image (while not connected)
 *   POST /wa/send            → enqueue bulk messages
 *   GET  /wa/messages        → queue + history (last 500)
 *   POST /wa/disconnect      → log out WhatsApp session
 *   GET  /wa/health          → simple uptime check (no auth)
 *
 * Start:
 *   node whatsapp-server.js          (production)
 *   npx nodemon whatsapp-server.js   (development)
 *
 * Environment variables (optional — create a .env or set in your shell):
 *   PORT=3001
 *   WA_SECRET=change-me-to-a-strong-random-string
 *   COUNTRY_CODE=91          ← default country dialling code (India)
 *   MSG_DELAY_MIN=3000       ← min ms between messages (anti-ban)
 *   MSG_DELAY_MAX=6000       ← max ms between messages
 */

"use strict";

// ── Load .env if present ─────────────────────────────────────────────────────
try { require("dotenv").config(); } catch (_) { /* dotenv is optional */ }

const express    = require("express");
const cors       = require("cors");
const qrcode     = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT        || "3001", 10);
const WA_SECRET    = process.env.WA_SECRET            || "futureshield-wa-secret";
const COUNTRY_CODE = process.env.COUNTRY_CODE         || "91";
const DELAY_MIN    = parseInt(process.env.MSG_DELAY_MIN || "3000", 10);
const DELAY_MAX    = parseInt(process.env.MSG_DELAY_MAX || "6000", 10);

// ── State ─────────────────────────────────────────────────────────────────────
let _qrDataUrl   = null;   // base64 PNG of current QR code
let _isReady     = false;  // true when WhatsApp session is active
let _phoneInfo   = null;   // { number, pushname } after connection
let _isProcessing = false; // true while the queue worker is running

/** @type {Array<MessageRecord>} */
const _queue   = [];       // pending / sending
/** @type {Array<MessageRecord>} */
const _history = [];       // completed (sent / failed), capped at 500

/**
 * @typedef {Object} MessageRecord
 * @property {string} id
 * @property {string} phone
 * @property {string} name
 * @property {string} text
 * @property {"pending"|"sending"|"sent"|"failed"} status
 * @property {string} [error]
 * @property {string} createdAt
 * @property {string} [sentAt]
 */

// ── WhatsApp Client ───────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "futureshield" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
});

client.on("qr", async (qr) => {
  console.log("[WA] QR received — scan with WhatsApp to connect.");
  _qrDataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 2 });
  _isReady   = false;
  _phoneInfo = null;
});

client.on("ready", async () => {
  _isReady   = true;
  _qrDataUrl = null;
  const info = client.info;
  _phoneInfo = {
    number:    info?.wid?.user   || "unknown",
    pushname:  info?.pushname    || "WhatsApp",
  };
  console.log(`[WA] Connected as ${_phoneInfo.pushname} (+${_phoneInfo.number})`);
});

client.on("authenticated", () => {
  console.log("[WA] Session authenticated.");
});

client.on("auth_failure", (msg) => {
  console.error("[WA] Auth failure:", msg);
  _isReady   = false;
  _qrDataUrl = null;
});

client.on("disconnected", (reason) => {
  console.warn("[WA] Disconnected:", reason);
  _isReady   = false;
  _qrDataUrl = null;
  _phoneInfo = null;
  // Re-initialise so a new QR is generated for reconnection
  setTimeout(() => client.initialize(), 3000);
});

console.log("[WA] Initialising WhatsApp client…");
client.initialize();

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();

// Explicit CORS — allows Authorization header from any origin (required for
// browsers that send a preflight OPTIONS before authenticated GET/POST requests)
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,  // IE11 chokes on 204
}));
app.options("*", cors());     // Pre-flight for all routes
app.use(express.json({ limit: "2mb" }));

// ── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== WA_SECRET) {
    return res.status(401).json({ error: "Unauthorized. Provide a valid Bearer token." });
  }
  next();
}

// ── Helper: normalise phone number → WhatsApp Chat ID ────────────────────────
function toWaId(rawPhone) {
  let digits = String(rawPhone).replace(/\D/g, "");
  // If the number doesn't start with a country code, prepend COUNTRY_CODE
  if (digits.length === 10) digits = COUNTRY_CODE + digits;
  return `${digits}@c.us`;
}

// ── Helper: random delay (anti-spam) ─────────────────────────────────────────
function randomDelay() {
  const ms = DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));
  return new Promise(r => setTimeout(r, ms));
}

// ── Queue Worker ─────────────────────────────────────────────────────────────
async function processQueue() {
  if (_isProcessing) return;
  _isProcessing = true;

  console.log(`[WA] Queue worker started. ${_queue.length} message(s) to send.`);

  while (_queue.length > 0) {
    if (!_isReady) {
      console.warn("[WA] Session disconnected while processing. Pausing queue.");
      break;
    }

    const msg = _queue[0];
    msg.status = "sending";

    try {
      const chatId = toWaId(msg.phone);
      await client.sendMessage(chatId, msg.text);
      msg.status = "sent";
      msg.sentAt = new Date().toISOString();
      console.log(`[WA] ✓ Sent to ${msg.phone} (${msg.name})`);
    } catch (err) {
      msg.status = "failed";
      msg.error  = err.message || "Unknown error";
      console.error(`[WA] ✗ Failed for ${msg.phone}:`, err.message);
    }

    // Move to history (cap at 500 entries)
    _history.unshift(_queue.shift());
    if (_history.length > 500) _history.length = 500;

    // Anti-spam delay between messages
    if (_queue.length > 0) await randomDelay();
  }

  _isProcessing = false;
  console.log("[WA] Queue worker finished.");
}

// ────────────────────────────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────────────────────────────

/** Health check — no auth required (for uptime monitors) */
app.get("/wa/health", (_req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
});

/**
 * GET /wa/status
 * Returns current connection state and phone info.
 */
app.get("/wa/status", requireAuth, (_req, res) => {
  console.log(`[WA] /wa/status → connected=${_isReady}, qrAvailable=${!!_qrDataUrl}`);
  res.json({
    connected:    _isReady,
    qrAvailable:  !!_qrDataUrl,
    phone:        _phoneInfo,
    queueLength:  _queue.length,
    historyCount: _history.length,
  });
});

/**
 * GET /wa/qr
 * Returns the current QR code as a base64 data URL.
 * Only available while not connected.
 */
app.get("/wa/qr", requireAuth, (_req, res) => {
  console.log(`[WA] /wa/qr hit — connected=${_isReady}, qrReady=${!!_qrDataUrl}`);
  if (_isReady) {
    console.log("[WA] /wa/qr → already connected, sending connected:true");
    return res.status(200).json({ connected: true, qr: null });
  }
  if (!_qrDataUrl) {
    console.log("[WA] /wa/qr → QR not yet generated (Puppeteer still initialising)");
    return res.status(202).json({
      qrReady: false,
      message: "QR not yet available. Puppeteer is still initialising — retry in 3 seconds.",
    });
  }
  console.log(`[WA] /wa/qr → sending QR (${_qrDataUrl.length} chars)`);
  res.json({ qrReady: true, qr: _qrDataUrl });
});

/**
 * POST /wa/send
 * Body: { messages: [{ phone, name, text }] }
 * Enqueues messages and returns immediately.
 */
app.post("/wa/send", requireAuth, (req, res) => {
  if (!_isReady) {
    return res.status(400).json({ error: "WhatsApp is not connected. Scan the QR first." });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty 'messages' array." });
  }

  const MAX_BATCH = 500;
  if (messages.length > MAX_BATCH) {
    return res.status(400).json({ error: `Maximum ${MAX_BATCH} messages per request.` });
  }

  const now = new Date().toISOString();
  const enqueued = [];

  for (const m of messages) {
    const phone = String(m.phone || "").trim();
    const text  = String(m.text  || "").trim();
    const name  = String(m.name  || "Customer").trim();

    if (!phone || !text) continue;

    /** @type {MessageRecord} */
    const record = {
      id:        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phone,
      name,
      text,
      status:    "pending",
      createdAt: now,
    };

    _queue.push(record);
    enqueued.push(record.id);
  }

  res.json({ queued: enqueued.length, ids: enqueued });

  // Start queue worker asynchronously (non-blocking)
  processQueue().catch(err => console.error("[WA] Queue error:", err));
});

/**
 * GET /wa/messages?limit=100&offset=0
 * Returns queue (all pending/sending) and paginated history.
 */
app.get("/wa/messages", requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || "100", 10), 500);
  const offset = Math.max(parseInt(req.query.offset || "0",   10), 0);

  res.json({
    queue:   _queue,
    history: _history.slice(offset, offset + limit),
    total:   _history.length,
  });
});

/**
 * POST /wa/disconnect
 * Logs out the WhatsApp session and clears local auth data.
 */
app.post("/wa/disconnect", requireAuth, async (_req, res) => {
  try {
    await client.logout();
    _isReady   = false;
    _qrDataUrl = null;
    _phoneInfo = null;
    res.json({ ok: true, message: "Logged out. Scan QR to reconnect." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════════════╗`);
  console.log(`║  FutureShield WhatsApp Server                 ║`);
  console.log(`║  Listening on http://localhost:${PORT}           ║`);
  console.log(`║  Auth token   : ${WA_SECRET.slice(0, 8)}…          ║`);
  console.log(`╚═══════════════════════════════════════════════╝\n`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  console.log("\n[WA] Shutting down…");
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
