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

const fs         = require("fs");
const path       = require("path");
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
const INIT_TIMEOUT_MS = parseInt(process.env.WA_INIT_TIMEOUT || "90000", 10); // 90s max wait for QR

/** Locate Chrome/Chromium for Puppeteer (Windows-friendly) */
function findChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_SHIM,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const CHROME_PATH = findChromeExecutable();

// ── State ─────────────────────────────────────────────────────────────────────
let _qrDataUrl   = null;   // base64 PNG of current QR code
let _isReady     = false;  // true when WhatsApp session is active
let _phoneInfo   = null;   // { number, pushname } after connection
let _isProcessing = false; // true while the queue worker is running
let _clientInitError = null; // set if Puppeteer/Chrome fails to start
let _clientInitializing = false;
let _initStartedAt = null;   // when current init attempt began
let _qrWaitLogCount = 0;     // throttle /wa/qr waiting logs

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
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
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
  setTimeout(() => initWhatsAppClient(), 3000);
});

/** Detect init stall (Puppeteer hung or Chrome missing) */
function checkInitStall() {
  if (_isReady || _qrDataUrl || _clientInitError) return null;
  if (!_initStartedAt) return null;
  const elapsed = Date.now() - _initStartedAt;
  if (elapsed < INIT_TIMEOUT_MS) return null;

  const chromeHint = CHROME_PATH
    ? `Chrome found at ${CHROME_PATH} but WhatsApp did not start in ${INIT_TIMEOUT_MS / 1000}s.`
    : "Google Chrome not found. Install Chrome or run: npx puppeteer browsers install chrome";

  return `${chromeHint} Try: POST /wa/restart or restart npm start.`;
}

/** Start WhatsApp client without crashing the HTTP server on Puppeteer errors */
async function initWhatsAppClient() {
  if (_clientInitializing || _isReady) return;
  _clientInitializing = true;
  _clientInitError = null;
  _initStartedAt = Date.now();
  _qrWaitLogCount = 0;

  console.log("[WA] Initialising WhatsApp client (Puppeteer)…");
  if (CHROME_PATH) {
    console.log(`[WA] Using Chrome: ${CHROME_PATH}`);
  } else {
    console.warn("[WA] Chrome not found in standard paths.");
    console.warn("[WA] Install: npx puppeteer browsers install chrome");
    console.warn("[WA] Or set PUPPETEER_EXECUTABLE_PATH to your chrome.exe");
  }

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(
        `WhatsApp initialization timed out after ${INIT_TIMEOUT_MS / 1000}s. ` +
        (CHROME_PATH
          ? "Chrome is installed but Puppeteer hung — try POST /wa/restart."
          : "Install Chrome: npx puppeteer browsers install chrome")
      ));
    }, INIT_TIMEOUT_MS);
  });

  try {
    await Promise.race([client.initialize(), timeoutPromise]);
    console.log("[WA] Client initialize() completed — waiting for QR or session restore…");
  } catch (err) {
    _clientInitError = err.message || String(err);
    console.error("[WA] Client init failed (HTTP server still running):", _clientInitError);
    console.error("[WA] Fix: npx puppeteer browsers install chrome");
    console.error("[WA] Retry: POST /wa/restart with Bearer token");
    try { await client.destroy(); } catch (destroyErr) {
      console.warn("[WA] destroy after failed init:", destroyErr.message);
    }
  } finally {
    _clientInitializing = false;
  }
}

async function resetAndInitClient() {
  _clientInitializing = false;
  _clientInitError = null;
  _initStartedAt = null;
  _qrDataUrl = null;
  _isReady = false;
  _phoneInfo = null;
  try { await client.destroy(); } catch (_) {}
  await new Promise(r => setTimeout(r, 1500));
  await initWhatsAppClient();
}

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

// ── Request logging (skip noisy health checks unless DEBUG=1) ─────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const isHealth = req.path === "/wa/health";
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (process.env.DEBUG === "1" || !isHealth || res.statusCode >= 400) {
      const auth = req.headers.authorization ? "Bearer ***" : "none";
      console.log(`[HTTP] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms) auth=${auth}`);
    }
  });
  next();
});

// ── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const hasBearer  = authHeader.startsWith("Bearer ");
  const token      = hasBearer ? authHeader.slice(7) : "";

  if (!hasBearer || !token) {
    console.warn(`[AUTH] ${req.method} ${req.path} — rejected: missing Bearer token`);
    return res.status(401).json({
      error: "Unauthorized. Send header: Authorization: Bearer <WA_SECRET>",
      code:  "MISSING_TOKEN",
    });
  }

  if (token !== WA_SECRET) {
    console.warn(
      `[AUTH] ${req.method} ${req.path} — rejected: token mismatch ` +
      `(received ${token.length} chars, expected ${WA_SECRET.length} chars)`
    );
    return res.status(401).json({
      error: "Unauthorized. Bearer token does not match WA_SECRET on the server.",
      code:  "INVALID_TOKEN",
      hint:  `Server expects token starting with "${WA_SECRET.slice(0, 8)}…"`,
    });
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

/** Health check — no auth required (for uptime monitors + dashboard reachability test) */
app.get("/wa/health", (_req, res) => {
  res.json({
    ok: true,
    service: "futureshield-whatsapp",
    port: PORT,
    uptime: Math.floor(process.uptime()),
    whatsapp: {
      connected: _isReady,
      qrAvailable: !!_qrDataUrl,
      initializing: _clientInitializing,
      initError: _clientInitError,
    },
    // Helps debug token mismatches without exposing the full secret
    expectedTokenPrefix: WA_SECRET.slice(0, 8),
    expectedTokenLength: WA_SECRET.length,
  });
});

/**
 * GET /wa/test-auth
 * Authenticated ping — use after /wa/health to verify Bearer token.
 */
app.get("/wa/test-auth", requireAuth, (_req, res) => {
  res.json({
    ok: true,
    message: "Bearer token accepted.",
    whatsapp: { connected: _isReady, qrAvailable: !!_qrDataUrl },
  });
});

/**
 * GET /wa/status
 * Returns current connection state and phone info.
 */
app.get("/wa/status", requireAuth, (_req, res) => {
  const stallError = checkInitStall();
  if (stallError && !_clientInitError) _clientInitError = stallError;

  console.log(`[WA] /wa/status → connected=${_isReady}, qrAvailable=${!!_qrDataUrl}, initError=${!!_clientInitError}`);
  res.json({
    connected:    _isReady,
    qrAvailable:  !!_qrDataUrl,
    phone:        _phoneInfo,
    queueLength:  _queue.length,
    historyCount: _history.length,
    initializing: _clientInitializing,
    initError:    _clientInitError,
    chromeDetected: !!CHROME_PATH,
    waitSeconds:  _initStartedAt ? Math.floor((Date.now() - _initStartedAt) / 1000) : 0,
  });
});

/**
 * GET /wa/qr
 * Returns the current QR code as a base64 data URL.
 * Only available while not connected.
 */
app.get("/wa/qr", requireAuth, (_req, res) => {
  // Detect stall and surface as initError (stops infinite frontend retry)
  const stallError = checkInitStall();
  if (stallError && !_clientInitError) _clientInitError = stallError;

  if (_clientInitError) {
    console.log(`[WA] /wa/qr → initError: ${_clientInitError.slice(0, 80)}…`);
    return res.status(503).json({
      qrReady: false,
      initError: _clientInitError,
      message: "WhatsApp client failed to start. See initError for details.",
      chromePath: CHROME_PATH || null,
    });
  }

  if (_isReady) {
    return res.status(200).json({ connected: true, qr: null });
  }

  if (!_qrDataUrl) {
    const elapsed = _initStartedAt ? Math.floor((Date.now() - _initStartedAt) / 1000) : 0;
    if (_qrWaitLogCount++ % 10 === 0) {
      console.log(`[WA] /wa/qr → waiting for QR (${elapsed}s, initializing=${_clientInitializing})`);
    }
    return res.status(202).json({
      qrReady: false,
      initializing: _clientInitializing,
      waitSeconds: elapsed,
      maxWaitSeconds: INIT_TIMEOUT_MS / 1000,
      chromeDetected: !!CHROME_PATH,
      message: CHROME_PATH
        ? `Waiting for QR code (${elapsed}s). Puppeteer is still starting…`
        : `Chrome not detected. Run: npx puppeteer browsers install chrome`,
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
 * POST /wa/restart
 * Retry WhatsApp client initialization after Puppeteer/Chrome failure.
 */
app.post("/wa/restart", requireAuth, async (_req, res) => {
  if (_isReady) {
    return res.json({ ok: true, message: "Already connected." });
  }
  console.log("[WA] /wa/restart — resetting client and re-initializing…");
  try {
    await resetAndInitClient();
    res.json({
      ok: !_clientInitError,
      initError: _clientInitError,
      chromePath: CHROME_PATH || null,
      message: _clientInitError
        ? "Init failed — see initError."
        : "Initialization restarted. Wait for QR…",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ── 404 + error handlers ──────────────────────────────────────────────────────
app.use((req, res) => {
  console.warn(`[HTTP] 404 ${req.method} ${req.path}`);
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  console.error("[HTTP] Unhandled error:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

// ── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║  FutureShield WhatsApp Server                         ║`);
  console.log(`║  Listening on http://localhost:${PORT}                     ║`);
  console.log(`║  Health check : http://localhost:${PORT}/wa/health         ║`);
  console.log(`║  Auth token   : ${WA_SECRET}  ║`);
  console.log(`║  Chrome       : ${CHROME_PATH || "NOT FOUND — run npx puppeteer browsers install chrome"}  ║`);
  console.log(`║  Init timeout : ${INIT_TIMEOUT_MS / 1000}s                                       ║`);
  console.log(`║  Test script  : node scripts/test-wa-connection.js    ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);
  // Start WhatsApp after HTTP server is up (failures won't crash the API)
  initWhatsAppClient();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown() {
  console.log("\n[WA] Shutting down…");
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
