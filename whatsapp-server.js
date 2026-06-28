/**
 * FutureShield — WhatsApp Bulk Messaging Microservice (per-user sessions)
 * ========================================================================
 * Each dashboard user links their own WhatsApp via QR (X-User-Id header).
 * Global WA_SECRET authenticates the app; sessions are isolated by user id.
 *
 * Endpoints (require Authorization + X-User-Id unless noted):
 *   GET  /wa/health          → uptime (no user header)
 *   GET  /wa/status          → per-user connection state
 *   GET  /wa/qr              → per-user QR code
 *   POST /wa/send            → enqueue messages for that user's session
 *   POST /wa/upload          → upload attachment for that user
 *   GET  /wa/messages        → per-user queue + history
 *   POST /wa/restart         → retry Puppeteer init for that user
 *   POST /wa/disconnect      → logout that user's WhatsApp session
 */

"use strict";

try { require("dotenv").config(); } catch (_) {}

const fs      = require("fs");
const path    = require("path");
const http    = require("http");
const https   = require("https");
const { execSync } = require("child_process");
const express = require("express");
const cors    = require("cors");
const qrcode  = require("qrcode");
const multer  = require("multer");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const UPLOAD_ROOT = path.join(__dirname, "uploads", "wa");
try { fs.mkdirSync(UPLOAD_ROOT, { recursive: true }); } catch (_) {}

const PORT            = parseInt(process.env.PORT || "3001", 10);
const WA_SECRET       = process.env.WA_SECRET || "futureshield-wa-secret";
const COUNTRY_CODE    = process.env.COUNTRY_CODE || "91";
const DELAY_MIN       = parseInt(process.env.MSG_DELAY_MIN || "3000", 10);
const DELAY_MAX       = parseInt(process.env.MSG_DELAY_MAX || "6000", 10);
const INIT_TIMEOUT_MS = parseInt(process.env.WA_INIT_TIMEOUT || "90000", 10);
const USE_HTTPS       = process.env.USE_HTTPS === "1" || process.env.USE_HTTPS === "true";
const SSL_KEY_PATH    = process.env.SSL_KEY  || path.join(__dirname, "certs", "localhost-key.pem");
const SSL_CERT_PATH   = process.env.SSL_CERT || path.join(__dirname, "certs", "localhost-cert.pem");
const MAX_USER_SESSIONS = parseInt(process.env.WA_MAX_USER_SESSIONS || "20", 10);

const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|3gpp|quicktime)|application\/pdf)/i;

function findChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

const CHROME_PATH = findChromeExecutable();
const WWEBJS_CACHE_DIR = path.join(__dirname, ".wwebjs_cache");
const WWEBJS_AUTH_DIR = path.join(__dirname, ".wwebjs_auth");

/** @type {Map<string, UserSession>} */
const _sessions = new Map();

/**
 * @typedef {Object} UserSession
 * @property {string} userId
 * @property {import('whatsapp-web.js').Client|null} client
 * @property {string|null} qrDataUrl
 * @property {boolean} isReady
 * @property {{ number: string, pushname: string }|null} phoneInfo
 * @property {boolean} isProcessing
 * @property {string|null} clientInitError
 * @property {boolean} clientInitializing
 * @property {boolean} clientInitialized
 * @property {number|null} initStartedAt
 * @property {number} qrWaitLogCount
 * @property {Promise<void>|null} restartPromise
 * @property {Promise<void>|null} initPromise
 * @property {Array<object>} queue
 * @property {Array<object>} history
 */

function createUserSession(userId) {
  return {
    userId,
    client: null,
    qrDataUrl: null,
    isReady: false,
    phoneInfo: null,
    isProcessing: false,
    clientInitError: null,
    clientInitializing: false,
    clientInitialized: false,
    initStartedAt: null,
    qrWaitLogCount: 0,
    restartPromise: null,
    initPromise: null,
    queue: [],
    history: [],
  };
}

function getUserSession(userId, create = true) {
  if (!_sessions.has(userId)) {
    if (!create) return null;
    if (_sessions.size >= MAX_USER_SESSIONS) {
      const err = new Error(`Maximum concurrent WhatsApp sessions (${MAX_USER_SESSIONS}) reached. Disconnect an unused session or restart the server.`);
      err.code = "SESSION_LIMIT";
      throw err;
    }
    _sessions.set(userId, createUserSession(userId));
  }
  return _sessions.get(userId);
}

function sanitizeUserId(raw) {
  const id = String(raw || "").trim();
  if (!/^[-_\w]{3,128}$/i.test(id)) return null;
  return id;
}

function buildPuppeteerConfig() {
  return {
    headless: true,
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
    ],
  };
}

function userUploadDir(userId) {
  const dir = path.join(UPLOAD_ROOT, userId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWaUpload(userId) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, userUploadDir(userId)),
      filename: (_req, file, cb) => {
        const safe = `${Date.now()}-${(file.originalname || "file").replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        cb(null, safe);
      },
    }),
    limits: { fileSize: 16 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME.test(file.mimetype || "")) cb(null, true);
      else cb(new Error("Only images, videos, and PDF files are allowed."));
    },
  });
}

function attachClientEvents(session, client) {
  client.on("qr", async (qr) => {
    console.log(`[WA:${session.userId}] QR received`);
    session.qrDataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 2 });
    session.isReady = false;
    session.phoneInfo = null;
  });

  client.on("ready", () => {
    session.isReady = true;
    session.qrDataUrl = null;
    session.clientInitError = null;
    const info = client.info;
    session.phoneInfo = {
      number: info?.wid?.user || "unknown",
      pushname: info?.pushname || "WhatsApp",
    };
    console.log(`[WA:${session.userId}] Connected as ${session.phoneInfo.pushname} (+${session.phoneInfo.number})`);
  });

  client.on("authenticated", () => {
    console.log(`[WA:${session.userId}] Session authenticated`);
  });

  client.on("auth_failure", (msg) => {
    console.error(`[WA:${session.userId}] Auth failure:`, msg);
    session.isReady = false;
    session.qrDataUrl = null;
  });

  client.on("disconnected", (reason) => {
    console.warn(`[WA:${session.userId}] Disconnected:`, reason);
    session.isReady = false;
    session.clientInitialized = false;
    session.qrDataUrl = null;
    session.phoneInfo = null;
  });
}

function createWhatsAppClient(session) {
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: session.userId }),
    puppeteer: buildPuppeteerConfig(),
  });
  attachClientEvents(session, client);
  return client;
}

function sessionAuthDir(userId) {
  return path.join(WWEBJS_AUTH_DIR, `session-${userId}`);
}

function isClientAlive(session) {
  try {
    return !!(session.client?.pupBrowser?.isConnected?.());
  } catch (_) {
    return false;
  }
}

function killStaleBrowserForSession(userId) {
  const marker = `session-${userId}`.replace(/'/g, "''");
  if (process.platform === "win32") {
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: "ignore", timeout: 15000 }
      );
    } catch (_) {}
  } else {
    try {
      execSync(`pkill -f "session-${userId}"`, { stdio: "ignore", timeout: 5000 });
    } catch (_) {}
  }

  const lockFile = path.join(sessionAuthDir(userId), "SingletonLock");
  try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (_) {}
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function destroyClientSafely(session) {
  const client = session.client;
  session.client = null;
  session.clientInitialized = false;
  if (!client) return;

  try {
    const browser = client.pupBrowser;
    if (browser?.isConnected?.()) await browser.close();
  } catch (err) {
    console.warn(`[WA:${session.userId}] browser close:`, err.message);
  }

  try {
    await client.destroy();
  } catch (err) {
    console.warn(`[WA:${session.userId}] client destroy:`, err.message);
  }

  killStaleBrowserForSession(session.userId);
  await delay(1500);
}

function checkInitStall(session) {
  if (session.isReady || session.qrDataUrl || session.clientInitError) return null;
  if (!session.initStartedAt) return null;
  const elapsed = Date.now() - session.initStartedAt;
  if (elapsed < INIT_TIMEOUT_MS) return null;
  return CHROME_PATH
    ? `Chrome found but WhatsApp did not start in ${INIT_TIMEOUT_MS / 1000}s for user ${session.userId}. Try POST /wa/restart.`
    : "Google Chrome not found. Install Chrome or run: npx puppeteer browsers install chrome";
}

async function runClientInitialize(session) {
  if (session.clientInitializing || session.isReady || !session.client) return;
  if (session.clientInitialized || isClientAlive(session)) return;

  session.clientInitializing = true;
  session.clientInitError = null;
  session.initStartedAt = Date.now();
  session.qrWaitLogCount = 0;

  console.log(`[WA:${session.userId}] Initialising client…`);

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Initialization timed out after ${INIT_TIMEOUT_MS / 1000}s.`));
    }, INIT_TIMEOUT_MS);
  });

  try {
    await Promise.race([session.client.initialize(), timeoutPromise]);
    session.clientInitialized = true;
    console.log(`[WA:${session.userId}] initialize() completed`);
  } catch (err) {
    session.clientInitError = err.message || String(err);
    console.error(`[WA:${session.userId}] Init failed:`, session.clientInitError);
    if (/already running/i.test(session.clientInitError)) {
      killStaleBrowserForSession(session.userId);
      await delay(1000);
    }
    await destroyClientSafely(session);
  } finally {
    session.clientInitializing = false;
  }
}

async function ensureUserClientStarted(session) {
  if (session.restartPromise) await session.restartPromise;
  if (session.isReady) return;
  if (session.clientInitialized || isClientAlive(session)) return;
  if (session.initPromise) return session.initPromise;

  session.initPromise = (async () => {
    if (session.isReady || session.clientInitializing || session.clientInitialized || isClientAlive(session)) return;
    if (!session.client) session.client = createWhatsAppClient(session);
    await runClientInitialize(session);
  })().finally(() => {
    session.initPromise = null;
  });

  return session.initPromise;
}

async function resetAndInitClient(session, opts = {}) {
  if (session.restartPromise) return session.restartPromise;

  session.restartPromise = (async () => {
    session.clientInitializing = false;
    session.clientInitialized = false;
    session.clientInitError = null;
    session.initStartedAt = null;
    session.qrDataUrl = null;
    session.isReady = false;
    session.phoneInfo = null;

    console.log(`[WA:${session.userId}] Resetting client…`);
    await destroyClientSafely(session);
    killStaleBrowserForSession(session.userId);

    if (opts.clearCache !== false && fs.existsSync(WWEBJS_CACHE_DIR)) {
      try { fs.rmSync(WWEBJS_CACHE_DIR, { recursive: true, force: true, maxRetries: 2 }); } catch (_) {}
    }

    await delay(2000);
    session.client = createWhatsAppClient(session);
    await runClientInitialize(session);
  })().finally(() => {
    session.restartPromise = null;
  });

  return session.restartPromise;
}

function toWaId(rawPhone) {
  let digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length === 10) digits = COUNTRY_CODE + digits;
  return `${digits}@c.us`;
}

function randomDelay() {
  return new Promise(r => setTimeout(r, DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN))));
}

async function processQueue(session) {
  if (session.isProcessing) return;
  session.isProcessing = true;

  while (session.queue.length > 0) {
    if (!session.isReady || !session.client) {
      console.warn(`[WA:${session.userId}] Session disconnected while processing queue`);
      break;
    }

    const msg = session.queue[0];
    msg.status = "sending";

    try {
      const chatId = toWaId(msg.phone);
      if (msg.mediaPath && fs.existsSync(msg.mediaPath)) {
        const media = MessageMedia.fromFilePath(msg.mediaPath);
        const caption = (msg.text || "").trim();
        if (caption) await session.client.sendMessage(chatId, media, { caption });
        else await session.client.sendMessage(chatId, media);
      } else if ((msg.text || "").trim()) {
        await session.client.sendMessage(chatId, msg.text);
      } else {
        throw new Error("Message has no text and no valid attachment.");
      }
      msg.status = "sent";
      msg.sentAt = new Date().toISOString();
      console.log(`[WA:${session.userId}] ✓ Sent to ${msg.phone}`);
    } catch (err) {
      msg.status = "failed";
      msg.error = err.message || "Unknown error";
      console.error(`[WA:${session.userId}] ✗ Failed for ${msg.phone}:`, err.message);
    }

    session.history.unshift(session.queue.shift());
    if (session.history.length > 500) session.history.length = 500;

    if (session.queue.length > 0) await randomDelay();
  }

  session.isProcessing = false;
}

function resolveSharedAttachment(userId, attachment) {
  if (!attachment?.attachmentId) return null;
  const stored = path.join(userUploadDir(userId), path.basename(String(attachment.attachmentId)));
  if (!fs.existsSync(stored)) return null;
  return {
    mediaPath: stored,
    mediaMimetype: attachment.mimetype || "",
    mediaFilename: attachment.filename || path.basename(stored),
  };
}

function sessionStatusPayload(session) {
  const stallError = checkInitStall(session);
  if (stallError && !session.clientInitError) session.clientInitError = stallError;
  const alive = session.clientInitialized || isClientAlive(session);
  const initError = alive && (session.qrDataUrl || session.isReady) ? null : session.clientInitError;
  return {
    userId: session.userId,
    connected: session.isReady,
    qrAvailable: !!session.qrDataUrl,
    phone: session.phoneInfo,
    queueLength: session.queue.length,
    historyCount: session.history.length,
    initializing: session.clientInitializing,
    initError,
    chromeDetected: !!CHROME_PATH,
    waitSeconds: session.initStartedAt ? Math.floor((Date.now() - session.initStartedAt) / 1000) : 0,
  };
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-User-Id"],
  optionsSuccessStatus: 200,
}));
app.options("*", cors());
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  const start = Date.now();
  const isHealth = req.path === "/wa/health";
  res.on("finish", () => {
    if (process.env.DEBUG === "1" || !isHealth || res.statusCode >= 400) {
      const uid = req.headers["x-user-id"] || "-";
      console.log(`[HTTP] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms) user=${uid}`);
    }
  });
  next();
});

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : "";
  if (!token) {
    return res.status(401).json({ error: "Unauthorized. Send Authorization: Bearer <WA_SECRET>", code: "MISSING_TOKEN" });
  }
  if (token !== WA_SECRET) {
    return res.status(401).json({ error: "Bearer token does not match WA_SECRET.", code: "INVALID_TOKEN" });
  }
  next();
}

function requireUserId(req, res, next) {
  const userId = sanitizeUserId(req.headers["x-user-id"] || req.query.userId);
  if (!userId) {
    return res.status(400).json({ error: "Missing or invalid X-User-Id header (3–128 chars, alphanumeric/_/-)." });
  }
  try {
    req.waUserId = userId;
    req.waSession = getUserSession(userId);
    next();
  } catch (err) {
    res.status(503).json({ error: err.message, code: err.code });
  }
}

let _serverProtocol = "http";

app.get("/wa/health", (_req, res) => {
  res.json({
    ok: true,
    service: "futureshield-whatsapp",
    port: PORT,
    protocol: _serverProtocol,
    multiUser: true,
    activeSessions: _sessions.size,
    uptime: Math.floor(process.uptime()),
    expectedTokenPrefix: WA_SECRET.slice(0, 8),
    expectedTokenLength: WA_SECRET.length,
  });
});

app.get("/wa/test-auth", requireAuth, (req, res) => {
  res.json({ ok: true, message: "Bearer token accepted." });
});

app.get("/wa/status", requireAuth, requireUserId, async (req, res) => {
  const session = req.waSession;
  try {
    await ensureUserClientStarted(session);
  } catch (err) {
    session.clientInitError = err.message;
  }
  res.json(sessionStatusPayload(session));
});

app.get("/wa/qr", requireAuth, requireUserId, async (req, res) => {
  const session = req.waSession;
  try {
    await ensureUserClientStarted(session);
  } catch (err) {
    return res.status(503).json({ qrReady: false, initError: err.message });
  }

  const alive = session.clientInitialized || isClientAlive(session);
  const initError = alive && (session.qrDataUrl || session.isReady) ? null : session.clientInitError;
  if (initError) {
    return res.status(503).json({
      qrReady: false,
      initError,
      message: "WhatsApp client failed to start.",
      chromePath: CHROME_PATH || null,
    });
  }

  if (session.isReady) {
    return res.json({ connected: true, qr: null, phone: session.phoneInfo });
  }

  if (!session.qrDataUrl) {
    const elapsed = session.initStartedAt ? Math.floor((Date.now() - session.initStartedAt) / 1000) : 0;
    return res.status(202).json({
      qrReady: false,
      initializing: session.clientInitializing,
      waitSeconds: elapsed,
      maxWaitSeconds: INIT_TIMEOUT_MS / 1000,
      chromeDetected: !!CHROME_PATH,
      message: `Waiting for QR code (${elapsed}s)…`,
    });
  }

  res.json({ qrReady: true, qr: session.qrDataUrl });
});

app.post("/wa/upload", requireAuth, requireUserId, (req, res) => {
  const upload = createWaUpload(req.waUserId).single("file");
  upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    res.json({
      ok: true,
      attachmentId: req.file.filename,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
    });
  });
});

app.post("/wa/send", requireAuth, requireUserId, (req, res) => {
  const session = req.waSession;
  if (!session.isReady) {
    return res.status(400).json({ error: "Your WhatsApp is not connected. Scan the QR code first." });
  }

  const { messages, attachment } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Provide a non-empty 'messages' array." });
  }
  if (messages.length > 500) {
    return res.status(400).json({ error: "Maximum 500 messages per request." });
  }

  const sharedMedia = resolveSharedAttachment(req.waUserId, attachment);
  if (attachment?.attachmentId && !sharedMedia) {
    return res.status(400).json({ error: "Attachment not found. Upload the file again." });
  }

  const now = new Date().toISOString();
  const enqueued = [];

  for (const m of messages) {
    const phone = String(m.phone || "").trim();
    const text  = String(m.text  || "").trim();
    const name  = String(m.name  || "Customer").trim();
    if (!phone) continue;
    if (!text && !sharedMedia) continue;
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phone, name, text,
      status: "pending",
      createdAt: now,
      userId: req.waUserId,
      ...(sharedMedia || {}),
    };
    session.queue.push(record);
    enqueued.push(record.id);
  }

  if (!enqueued.length) {
    return res.status(400).json({ error: "No valid messages (need phone + text or attachment)." });
  }

  res.json({ queued: enqueued.length, ids: enqueued, hasAttachment: !!sharedMedia, userId: req.waUserId });
  processQueue(session).catch(err => console.error(`[WA:${req.waUserId}] Queue error:`, err));
});

app.get("/wa/messages", requireAuth, requireUserId, (req, res) => {
  const session = req.waSession;
  const limit  = Math.min(parseInt(req.query.limit || "100", 10), 500);
  const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
  res.json({
    userId: req.waUserId,
    queue: session.queue,
    history: session.history.slice(offset, offset + limit),
    total: session.history.length,
  });
});

app.post("/wa/restart", requireAuth, requireUserId, async (req, res) => {
  const session = req.waSession;
  if (session.isReady) {
    return res.json({ ok: true, message: "Already connected." });
  }
  try {
    await resetAndInitClient(session, { clearCache: req.body?.clearCache !== false });
    res.json({
      ok: !session.clientInitError,
      initError: session.clientInitError,
      message: session.clientInitError ? "Init failed — see initError." : "Initialization restarted. Wait for QR…",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/wa/disconnect", requireAuth, requireUserId, async (req, res) => {
  const session = req.waSession;
  try {
    if (session.initPromise) await session.initPromise.catch(() => {});
    if (session.client && session.isReady) {
      try {
        await session.client.logout();
      } catch (logoutErr) {
        console.warn(`[WA:${session.userId}] logout failed (${logoutErr.message}), destroying client…`);
        await destroyClientSafely(session);
      }
    } else {
      await destroyClientSafely(session);
    }
    session.isReady = false;
    session.qrDataUrl = null;
    session.phoneInfo = null;
    session.clientInitError = null;
    res.json({ ok: true, message: "Logged out. Scan QR to reconnect.", userId: req.waUserId });
  } catch (err) {
    await destroyClientSafely(session).catch(() => {});
    session.isReady = false;
    session.qrDataUrl = null;
    session.phoneInfo = null;
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "File too large (max 16 MB)." : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error("[HTTP] Unhandled error:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

function resolveTlsCredentials() {
  const keyExists  = fs.existsSync(SSL_KEY_PATH);
  const certExists = fs.existsSync(SSL_CERT_PATH);
  if (USE_HTTPS && (!keyExists || !certExists)) {
    console.error("[TLS] USE_HTTPS set but certs missing. Run: npm run generate:certs");
    process.exit(1);
  }
  if (keyExists && certExists) {
    return { key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) };
  }
  return null;
}

function startHttpServer() {
  const tls = resolveTlsCredentials();
  _serverProtocol = tls ? "https" : "http";
  const server = tls ? https.createServer(tls, app) : http.createServer(app);

  server.listen(PORT, "0.0.0.0", () => {
    const base = `${_serverProtocol}://localhost:${PORT}`;
    console.log(`\n╔═══════════════════════════════════════════════════════╗`);
    console.log(`║  FutureShield WhatsApp Server (per-user sessions)     ║`);
    console.log(`║  Listening on ${base.padEnd(37)}║`);
    console.log(`║  Health: ${base}/wa/health`.padEnd(56) + `║`);
    console.log(`║  Header: X-User-Id required on session routes         ║`);
    console.log(`╚═══════════════════════════════════════════════════════╝\n`);
  });

  return server;
}

startHttpServer();

async function shutdown() {
  console.log("\n[WA] Shutting down all sessions…");
  for (const session of _sessions.values()) {
    await destroyClientSafely(session).catch(() => {});
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  console.error("[WA] Unhandled rejection (server stays up):", msg);
});
