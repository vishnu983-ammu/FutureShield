#!/usr/bin/env node
/**
 * FutureShield — local static web server for the admin dashboard.
 * Do NOT open index.html via file:// — use this server instead.
 *
 *   npm run serve
 *   → http://localhost:8080/
 */

"use strict";

const express = require("express");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = parseInt(process.env.WEB_PORT || "8080", 10);
const FAVICON = path.join(ROOT, "assets", "favicon.svg");
const DOWNLOADS_DIR = path.join(ROOT, "public", "downloads");
const app = express();

app.get("/favicon.ico", (_req, res) => {
  res.type("image/svg+xml");
  res.sendFile(FAVICON);
});

// APK downloads — mirrors production (vercel/netlify) and apk-server route
app.use("/downloads", express.static(DOWNLOADS_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".apk")) {
      res.setHeader("Content-Type", "application/vnd.android.package-archive");
      res.setHeader("Content-Disposition", 'attachment; filename="future-shield.apk"');
    }
  },
}));

app.use(express.static(ROOT, {
  index: ["index.html"],
  extensions: ["html"],
  setHeaders(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
}));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || path.extname(req.path)) {
    return next();
  }
  res.sendFile(path.join(ROOT, "index.html"));
});

app.listen(PORT, () => {
  console.log("");
  console.log("  FutureShield Admin Dashboard");
  console.log("  ────────────────────────────");
  console.log(`  Local:  http://localhost:${PORT}/`);
  console.log(`  Card:   http://localhost:${PORT}/card.html`);
  console.log(`  APK:    http://localhost:${PORT}/downloads/future-shield.apk`);
  console.log("");
  console.log("  Press Ctrl+C to stop.");
  console.log("");
});
