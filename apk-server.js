/**
 * FutureShield — APK Upload & Distribution Server
 * ================================================
 * Handles admin APK uploads and serves files from public/downloads/.
 *
 * Endpoints:
 *   GET  /api/apk/health     → uptime check (no auth)
 *   GET  /api/apk/info       → file metadata (size, modified, downloadUrl)
 *   POST /api/apk/upload     → upload .apk → saved as future-shield.apk
 *   GET  /downloads/*          → static APK files
 *
 * Start:
 *   node apk-server.js
 *   npm run start:apk
 *
 * Environment:
 *   APK_PORT=3002
 *   APK_SECRET=futureshield-apk-secret   (Bearer token for upload)
 */

"use strict";

try { require("dotenv").config(); } catch (_) { /* optional */ }

const express = require("express");
const cors    = require("cors");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");

const PORT        = parseInt(process.env.APK_PORT || process.env.PORT || "3002", 10);
const APK_SECRET  = process.env.APK_SECRET || process.env.WA_SECRET || "futureshield-apk-secret";
const APK_FILENAME = "future-shield.apk";
const DOWNLOADS_DIR = path.join(__dirname, "public", "downloads");
const APK_PATH    = path.join(DOWNLOADS_DIR, APK_FILENAME);

// Ensure downloads directory exists
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
}));
app.options("*", cors());
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== APK_SECRET) {
    return res.status(401).json({ error: "Unauthorized. Invalid or missing Bearer token." });
  }
  next();
}

// ── Multer: memory buffer then write atomically ───────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250 MB max
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".apk") {
      return cb(new Error("Only .apk files are allowed."));
    }
    cb(null, true);
  },
});

function getApkInfo(req) {
  const baseUrl = resolvePublicBaseUrl(req);
  const relativeUrl = `/downloads/${APK_FILENAME}`;
  if (!fs.existsSync(APK_PATH)) {
    return {
      exists: false,
      filename: APK_FILENAME,
      downloadUrl: relativeUrl,
      absoluteDownloadUrl: baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl,
    };
  }
  const stat = fs.statSync(APK_PATH);
  return {
    exists:      true,
    filename:    APK_FILENAME,
    downloadUrl: relativeUrl,
    absoluteDownloadUrl: baseUrl ? `${baseUrl}${relativeUrl}` : relativeUrl,
    sizeBytes:   stat.size,
    sizeMB:      (stat.size / (1024 * 1024)).toFixed(2),
    modifiedAt:  stat.mtime.toISOString(),
  };
}

function resolvePublicBaseUrl(req) {
  if (!req) return "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  return host ? `${proto}://${host}`.replace(/\/$/, "") : "";
}

function delaySync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/** Save APK bytes — direct overwrite + retries (OneDrive-safe on Windows). */
function saveApkBuffer(buffer) {
  const strategies = [
    () => fs.writeFileSync(APK_PATH, buffer),
    () => {
      const tmpPath = `${APK_PATH}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, buffer);
      try {
        fs.renameSync(tmpPath, APK_PATH);
      } finally {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      }
    },
  ];

  let lastErr;
  for (const strategy of strategies) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        strategy();
        return;
      } catch (err) {
        lastErr = err;
        if (err.code !== "EBUSY" && err.code !== "EPERM") break;
        delaySync(150 * (attempt + 1));
      }
    }
  }
  const hint = /OneDrive/i.test(DOWNLOADS_DIR)
    ? " File may be locked by OneDrive — pause sync on public/downloads or move the project outside OneDrive."
    : "";
  const error = new Error((lastErr?.message || "Failed to save APK") + hint);
  error.code = lastErr?.code;
  throw error;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/apk/health", (_req, res) => {
  res.json({ ok: true, service: "futureshield-apk-server", port: PORT });
});

app.get("/api/apk/info", requireAuth, (req, res) => {
  res.json(getApkInfo(req));
});

app.post("/api/apk/upload", requireAuth, (req, res) => {
  upload.single("apk")(req, res, (err) => {
    if (err) {
      const msg = err.message || "Upload failed.";
      const code = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(code).json({ error: msg });
    }
    if (!req.file || !req.file.buffer?.length) {
      return res.status(400).json({ error: "No APK file received. Use field name 'apk'." });
    }

    try {
      saveApkBuffer(req.file.buffer);
      console.log(`[APK] Uploaded ${APK_FILENAME} (${req.file.size} bytes)`);
      res.json({ success: true, message: "APK saved successfully.", ...getApkInfo(req) });
    } catch (writeErr) {
      console.error("[APK] Write error:", writeErr);
      res.status(500).json({ error: writeErr.message || "Failed to save APK to disk." });
    }
  });
});

// Static file serving — APK downloads (no auth required for GET)
app.use("/downloads", express.static(DOWNLOADS_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".apk")) {
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.setHeader("Content-Disposition", `attachment; filename="${APK_FILENAME}"`);
    }
  },
}));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const info = getApkInfo();
  console.log(`\n  FutureShield APK Server`);
  console.log(`  ─────────────────────────────────────────`);
  console.log(`  Port:        ${PORT}`);
  console.log(`  Upload:      POST http://localhost:${PORT}/api/apk/upload`);
  console.log(`  Download:    http://localhost:${PORT}/downloads/${APK_FILENAME}`);
  console.log(`  Storage:     ${DOWNLOADS_DIR}`);
  console.log(`  Auth token:  ${APK_SECRET}`);
  console.log(`  APK on disk: ${info.exists ? `yes (${info.sizeMB} MB)` : "not yet — upload or run npm run build:apk"}`);
  console.log(`  ─────────────────────────────────────────\n`);
});
