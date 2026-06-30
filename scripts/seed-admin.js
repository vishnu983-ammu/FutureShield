#!/usr/bin/env node
/**
 * FutureShield — bootstrap the first system admin (run once).
 *
 *   1. Copy .env.example → .env and set ADMIN_SEED_PASSWORD
 *   2. Set GOOGLE_APPLICATION_CREDENTIALS to your Firebase service account JSON
 *   3. npm run seed:admin
 *
 * Does NOT run from the browser. Removes hardcoded default passwords from the client.
 */

"use strict";

const crypto = require("crypto");
const path = require("path");

try {
  require("dotenv").config();
} catch (_) {
  /* optional */
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password), "utf8").digest("hex");
}

async function main() {
  const username = (process.env.ADMIN_SEED_USERNAME || "admin").trim().toLowerCase();
  const password = process.env.ADMIN_SEED_PASSWORD;

  if (!password || password.length < 8) {
    console.error(
      "[Seed Admin] Set ADMIN_SEED_PASSWORD in .env (minimum 8 characters), then re-run."
    );
    process.exit(1);
  }

  let admin;
  try {
    admin = require("firebase-admin");
  } catch (_) {
    console.error("[Seed Admin] firebase-admin is required. Run: npm install");
    process.exit(1);
  }

  if (!admin.apps.length) {
    const projectId = process.env.FS_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || "future-shield";
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath) {
      const serviceAccount = require(path.resolve(credPath));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId || serviceAccount.project_id,
      });
    } else {
      console.error(
        "[Seed Admin] Set GOOGLE_APPLICATION_CREDENTIALS to your Firebase service account JSON path."
      );
      process.exit(1);
    }
  }

  const db = admin.firestore();
  const ref = db.collection("system_admins").doc(username);
  const snap = await ref.get();

  if (snap.exists) {
    console.info(`[Seed Admin] Admin "${username}" already exists — no changes made.`);
    process.exit(0);
  }

  await ref.set({
    passwordHash: hashPassword(password),
    name: process.env.ADMIN_SEED_NAME || "Administrator",
    isActive: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    seededVia: "scripts/seed-admin.js",
  });

  console.info(`[Seed Admin] Created system admin "${username}". Change the password after first login.`);
}

main().catch((err) => {
  console.error("[Seed Admin] Failed:", err.message || err);
  process.exit(1);
});
