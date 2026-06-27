#!/usr/bin/env node
/**
 * FutureShield — Automated APK Build Script
 * ==========================================
 * 1. Copies index.html into mobile/www/
 * 2. Syncs Capacitor Android project
 * 3. Runs Gradle assembleDebug
 * 4. Copies output → public/downloads/future-shield.apk
 *
 * Prerequisites:
 *   - Node.js 18+
 *   - Java JDK 17+ (JAVA_HOME set)
 *   - Android SDK (ANDROID_HOME set)
 *   - First run: npm run setup:mobile
 *
 * Usage:
 *   npm run build:apk
 */

"use strict";

const { execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const ROOT     = path.join(__dirname, "..");
const MOBILE   = path.join(ROOT, "mobile");
const WWW      = path.join(MOBILE, "www");
const ANDROID  = path.join(MOBILE, "android");
const OUT_DIR  = path.join(ROOT, "public", "downloads");
const OUT_FILE = path.join(OUT_DIR, "future-shield.apk");
const SRC_HTML = path.join(ROOT, "index.html");

function run(cmd, cwd, label) {
  console.log(`\n▶ ${label || cmd}`);
  execSync(cmd, { cwd, stdio: "inherit", env: process.env });
}

function ensureMobileDeps() {
  const pkgLock = path.join(MOBILE, "node_modules");
  if (!fs.existsSync(pkgLock)) {
    run("npm install", MOBILE, "Installing mobile/Capacitor dependencies");
  }
}

function copyWebAssets() {
  if (!fs.existsSync(SRC_HTML)) {
    console.error("ERROR: index.html not found at project root.");
    process.exit(1);
  }
  fs.mkdirSync(WWW, { recursive: true });
  fs.copyFileSync(SRC_HTML, path.join(WWW, "index.html"));
  console.log("✓ Copied index.html → mobile/www/");
}

function ensureAndroidPlatform() {
  if (!fs.existsSync(ANDROID)) {
    run("npx cap add android", MOBILE, "Adding Android platform (first-time setup)");
  }
}

function findApkOutput() {
  const candidates = [
    path.join(ANDROID, "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
    path.join(ANDROID, "app", "build", "outputs", "apk", "release", "app-release.apk"),
    path.join(ANDROID, "app", "build", "outputs", "apk", "release", "app-release-unsigned.apk"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main() {
  console.log("FutureShield APK Build");
  console.log("══════════════════════");

  ensureMobileDeps();
  copyWebAssets();
  ensureAndroidPlatform();

  run("npx cap sync android", MOBILE, "Syncing Capacitor Android project");

  const isWin   = process.platform === "win32";
  const gradlew = isWin ? "gradlew.bat" : "./gradlew";
  const gradlePath = path.join(ANDROID, isWin ? "gradlew.bat" : "gradlew");

  if (!fs.existsSync(gradlePath)) {
    console.error("ERROR: Gradle wrapper not found. Run: npm run setup:mobile");
    process.exit(1);
  }

  // Debug build — no signing keystore required
  run(`${gradlew} assembleDebug`, ANDROID, "Building Android APK (debug)");

  const builtApk = findApkOutput();
  if (!builtApk) {
    console.error("ERROR: Built APK not found under android/app/build/outputs/apk/");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(builtApk, OUT_FILE);

  const sizeMB = (fs.statSync(OUT_FILE).size / (1024 * 1024)).toFixed(2);
  console.log("\n══════════════════════════════════════════════");
  console.log(`✓ APK ready: ${OUT_FILE}`);
  console.log(`  Size: ${sizeMB} MB`);
  console.log(`  Public URL: /downloads/future-shield.apk`);
  console.log("══════════════════════════════════════════════\n");
}

main();
