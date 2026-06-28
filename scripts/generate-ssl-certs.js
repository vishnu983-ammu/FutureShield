#!/usr/bin/env node
/**
 * Generate self-signed TLS certificates for local WhatsApp HTTPS.
 *
 * Usage:
 *   npm run generate:certs
 *
 * Output:
 *   certs/localhost-key.pem
 *   certs/localhost-cert.pem
 *
 * Requires OpenSSL (Git for Windows includes it, or install OpenSSL).
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CERTS_DIR = path.join(__dirname, "..", "certs");
const KEY_FILE  = path.join(CERTS_DIR, "localhost-key.pem");
const CERT_FILE = path.join(CERTS_DIR, "localhost-cert.pem");

function hasOpenSSL() {
  try {
    execSync("openssl version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  fs.mkdirSync(CERTS_DIR, { recursive: true });

  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    console.log("Certificates already exist:");
    console.log("  ", KEY_FILE);
    console.log("  ", CERT_FILE);
    console.log("\nDelete them first if you want to regenerate.");
    return;
  }

  if (!hasOpenSSL()) {
    console.error("ERROR: OpenSSL not found in PATH.");
    console.error("\nInstall one of:");
    console.error("  - Git for Windows (includes openssl.exe)");
    console.error("  - https://slproweb.com/products/Win32OpenSSL.html");
    console.error("\nThen re-run: npm run generate:certs");
    process.exit(1);
  }

  const subj = "/CN=localhost/O=FutureShield/C=IN";
  const cmd = [
    "openssl req -x509 -newkey rsa:2048",
    `-keyout "${KEY_FILE}"`,
    `-out "${CERT_FILE}"`,
    "-days 825 -nodes -sha256",
    `-subj "${subj}"`,
    "-addext \"subjectAltName=DNS:localhost,IP:127.0.0.1\"",
  ].join(" ");

  console.log("Generating self-signed certificate for localhost…");
  execSync(cmd, { stdio: "inherit", shell: true });

  console.log("\n✓ Created:");
  console.log("   ", KEY_FILE);
  console.log("   ", CERT_FILE);
  console.log("\nNext steps:");
  console.log("  1. npm run start:https");
  console.log("  2. Open https://localhost:3001/wa/health in Chrome");
  console.log("  3. Click Advanced → Proceed to localhost (trust cert once)");
  console.log("  4. In dashboard WhatsApp settings, use: https://localhost:3001");
}

main();
