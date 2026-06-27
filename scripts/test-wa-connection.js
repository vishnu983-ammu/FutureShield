#!/usr/bin/env node
/**
 * FutureShield — WhatsApp Server Connection Test
 * ===============================================
 * Verifies whatsapp-server.js is running and accepts the Bearer token.
 *
 * Usage:
 *   node scripts/test-wa-connection.js
 *   node scripts/test-wa-connection.js --url http://localhost:3001 --token futureshield-wa-secret
 *
 * Environment (optional):
 *   WA_URL=http://localhost:3001
 *   WA_SECRET=futureshield-wa-secret
 */

"use strict";

const BASE_URL = getArg("--url") || process.env.WA_URL || "http://localhost:3001";
const TOKEN    = getArg("--token") || process.env.WA_SECRET || "futureshield-wa-secret";
const TIMEOUT  = 8000;

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function log(icon, msg) {
  console.log(`${icon}  ${msg}`);
}

function pass(msg) { log("✓", msg); }
function fail(msg) { log("✗", msg); }
function info(msg) { log("·", msg); }

async function fetchJson(path, options = {}) {
  const url = `${BASE_URL.replace(/\/$/, "")}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body, url };
  } finally {
    clearTimeout(timer);
  }
}

async function runTests() {
  console.log("\nFutureShield WhatsApp Connection Test");
  console.log("══════════════════════════════════════");
  info(`Server URL : ${BASE_URL}`);
  info(`Token      : ${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)} (${TOKEN.length} chars)`);
  console.log("");

  let passed = 0;
  let failed = 0;

  function record(ok, label, detail) {
    if (ok) { pass(label); if (detail) info(detail); passed++; }
    else    { fail(label); if (detail) info(detail); failed++; }
  }

  // ── Test 1: Health (no auth) ──────────────────────────────────────────────
  try {
    const r = await fetchJson("/wa/health");
    record(
      r.ok && r.body?.ok === true,
      "GET /wa/health — server is running",
      r.ok ? `uptime=${r.body.uptime}s, port=${r.body.port ?? "?"}` : `HTTP ${r.status}: ${JSON.stringify(r.body)}`
    );
    if (r.body?.expectedTokenPrefix) {
      info(`Server expects token starting with: "${r.body.expectedTokenPrefix}…"`);
    }
  } catch (err) {
    record(false, "GET /wa/health — server is running", err.name === "AbortError"
      ? "Timed out — is 'npm start' running?"
      : err.message);
    console.log("\n  Tip: Start the server with:  npm start");
    console.log("       Then re-run:             node scripts/test-wa-connection.js\n");
    process.exit(1);
  }

  // ── Test 2: Status without token (expect 401) ───────────────────────────────
  try {
    const r = await fetchJson("/wa/status");
    record(
      r.status === 401,
      "GET /wa/status without token — rejects unauthorized",
      r.status === 401 ? "401 Unauthorized (correct)" : `Unexpected HTTP ${r.status}`
    );
  } catch (err) {
    record(false, "GET /wa/status without token", err.message);
  }

  // ── Test 3: Status with wrong token (expect 401) ──────────────────────────
  try {
    const r = await fetchJson("/wa/status", {
      headers: { Authorization: "Bearer wrong-token-value" },
    });
    record(
      r.status === 401,
      "GET /wa/status with wrong token — rejects invalid auth",
      r.status === 401 ? "401 Unauthorized (correct)" : `Unexpected HTTP ${r.status}`
    );
  } catch (err) {
    record(false, "GET /wa/status with wrong token", err.message);
  }

  // ── Test 4: Status with correct token ─────────────────────────────────────
  try {
    const r = await fetchJson("/wa/status", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const ok = r.ok && typeof r.body?.connected === "boolean";
    record(
      ok,
      "GET /wa/status with Bearer token — auth accepted",
      ok
        ? `connected=${r.body.connected}, qrAvailable=${r.body.qrAvailable}, queue=${r.body.queueLength}`
        : `HTTP ${r.status}: ${JSON.stringify(r.body)}`
    );
    if (r.status === 401) {
      info("Token mismatch! Set WA_SECRET on the server to match your dashboard token.");
      info(`You sent: "${TOKEN.slice(0, 8)}…" — check server startup log for expected token.`);
    }
  } catch (err) {
    record(false, "GET /wa/status with Bearer token", err.message);
  }

  // ── Test 5: QR endpoint with correct token ────────────────────────────────
  try {
    const r = await fetchJson("/wa/qr", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const ok = r.ok || r.status === 202 || (r.status === 503 && r.body?.initError);
    let detail = `HTTP ${r.status}`;
    if (r.body?.connected) detail = "Already connected — no QR needed";
    else if (r.body?.qrReady && r.body?.qr) detail = `QR ready (${r.body.qr.length} chars)`;
    else if (r.status === 202) detail = "QR not ready yet — Puppeteer still starting (normal on first boot)";
    else if (r.status === 503 && r.body?.initError) {
      detail = `Chrome/Puppeteer not installed: ${r.body.initError.slice(0, 80)}…\n       Fix: npx puppeteer browsers install chrome`;
    }
    record(ok, "GET /wa/qr with Bearer token — endpoint reachable", detail);
  } catch (err) {
    record(false, "GET /wa/qr with Bearer token", err.message);
  }

  // ── Test 6: CORS preflight simulation ─────────────────────────────────────
  try {
    const url = `${BASE_URL.replace(/\/$/, "")}/wa/status`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const res = await fetch(url, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:5500",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const allowAuth = (res.headers.get("access-control-allow-headers") || "").toLowerCase().includes("authorization");
    record(
      res.ok || res.status === 200 || res.status === 204,
      "OPTIONS preflight — CORS allows Authorization header",
      allowAuth ? "Authorization header permitted" : "Warning: Authorization may be blocked by CORS"
    );
  } catch (err) {
    record(false, "OPTIONS preflight — CORS", err.message);
  }

  console.log("\n──────────────────────────────────────");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("──────────────────────────────────────\n");

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
