#!/usr/bin/env node
/**
 * FutureShield — Daily Renewal Notification Cron
 *
 * Runs once per day (schedule via Task Scheduler, cron, or GitHub Actions).
 * Finds approved closed_sales where renewalNotifyDateKey == today (expiry - 5 days),
 * sends in-app notifications to Admin, Manager, and Advisor, then marks each
 * sale with renewalNotificationSent = true (once per policy).
 *
 * Setup:
 *   1. npm install firebase-admin
 *   2. Set GOOGLE_APPLICATION_CREDENTIALS to your Firebase service account JSON path
 *   3. npm run renewal:cron
 *
 * Optional env:
 *   FS_FIREBASE_PROJECT_ID — override project id
 *   RENEWAL_DRY_RUN=1 — log matches without writing notifications
 */

"use strict";

const path = require("path");

function formatDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateKeyDisplay(dateKey) {
  if (!dateKey) return "—";
  const parts = String(dateKey).split("-");
  if (parts.length !== 3) return dateKey;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function buildRenewalNotificationMessage(sale) {
  const expiryLabel = formatDateKeyDisplay(sale.renewalExpiryDateKey);
  return [
    `Customer: ${sale.customerName || "—"} · ${sale.phone || "—"}`,
    `Product: ${sale.productCategory || "—"}${sale.subCategory ? ` · ${sale.subCategory}` : ""}`,
    `Reference: ${sale.policyReference || "—"}`,
    `Expiry: ${expiryLabel} (365-day policy)`,
    `Advisor: ${sale.advisorName || "—"} · Manager: ${sale.managerName || "—"}`,
  ].join("\n");
}

async function main() {
  let admin;
  try {
    admin = require("firebase-admin");
  } catch (err) {
    console.error("[Renewal Cron] firebase-admin is not installed. Run: npm install firebase-admin");
    process.exit(1);
  }

  if (!admin.apps.length) {
    const projectId = process.env.FS_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credPath) {
      const serviceAccount = require(path.resolve(credPath));
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId || serviceAccount.project_id,
      });
    } else {
      admin.initializeApp({ projectId });
    }
  }

  const db = admin.firestore();
  const todayKey = formatDateKey(new Date());
  const dryRun = process.env.RENEWAL_DRY_RUN === "1";

  console.info("[Renewal Cron] Starting check for notify date:", todayKey, dryRun ? "(DRY RUN)" : "");

  const snap = await db.collection("closed_sales")
    .where("approvalStatus", "==", "approved")
    .where("renewalNotificationSent", "==", false)
    .where("renewalNotifyDateKey", "==", todayKey)
    .get();

  console.info("[Renewal Cron] Matched policies:", snap.size);

  let sent = 0;
  const batchLimit = 400;
  let batch = db.batch();
  let batchOps = 0;

  for (const docSnap of snap.docs) {
    const sale = { id: docSnap.id, ...docSnap.data() };
    const title = "Policy Renewal Due in 5 Days";
    const message = buildRenewalNotificationMessage(sale);
    const metadata = {
      saleId: sale.id,
      customerName: sale.customerName || "",
      phone: sale.phone || "",
      productCategory: sale.productCategory || "",
      subCategory: sale.subCategory || "",
      policyReference: sale.policyReference || "",
      policyReferenceType: sale.policyReferenceType || "",
      renewalExpiryDateKey: sale.renewalExpiryDateKey || "",
      advisorId: sale.advisorId || "",
      advisorName: sale.advisorName || "",
      managerId: sale.managerId || "",
      managerName: sale.managerName || "",
    };

    console.info("[Renewal Cron] Processing sale", sale.id, "|", sale.policyReference, "|", sale.customerName);

    if (!dryRun) {
      const recipients = [
        { id: "admin", role: "admin" },
      ];
      if (sale.managerId) recipients.push({ id: sale.managerId, role: "manager" });
      if (sale.advisorId) recipients.push({ id: sale.advisorId, role: "advisor" });

      for (const r of recipients) {
        const notifRef = db.collection("notifications").doc();
        batch.set(notifRef, {
          recipientId: r.id,
          recipientRole: r.role,
          type: "policy_renewal",
          title,
          message,
          isRead: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          metadata,
        });
        batchOps++;
      }

      batch.update(docSnap.ref, {
        renewalNotificationSent: true,
        renewalNotificationSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batchOps++;

      if (batchOps >= batchLimit) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    sent++;
  }

  if (!dryRun && batchOps > 0) {
    await batch.commit();
  }

  console.info("[Renewal Cron] Complete — policies processed:", sent);
  process.exit(0);
}

main().catch(err => {
  console.error("[Renewal Cron] Fatal error:", err);
  process.exit(1);
});
