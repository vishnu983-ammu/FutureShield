#!/usr/bin/env node
/**
 * FutureShield — Payment Pending Notification Cron
 *
 * Finds approved closed_sales where commission payment is still pending
 * 15+ days after sale approval, notifies Admin once per sale.
 *
 * Setup:
 *   1. npm install firebase-admin
 *   2. Set GOOGLE_APPLICATION_CREDENTIALS to your Firebase service account JSON path
 *   3. npm run payment:cron
 *
 * Schedule daily via Task Scheduler (Windows), cron (Linux), or GitHub Actions.
 *
 * Optional env:
 *   FS_FIREBASE_PROJECT_ID — override project id
 *   PAYMENT_PENDING_DAYS — default 15
 *   PAYMENT_DRY_RUN=1 — log matches without writing notifications
 */

"use strict";

const path = require("path");

const DEFAULT_PENDING_DAYS = 15;

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (value.seconds) return new Date(value.seconds * 1000);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(from, to) {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function normalizePaymentStatuses(sale) {
  const isDirect = sale.isManagerDirectSale === true;
  const advisorStatus = isDirect ? "n/a" : (sale.advisorCommissionStatus || "pending");
  const managerStatus = sale.managerCommissionStatus || "pending";
  return { advisorStatus, managerStatus };
}

function saleNeedsPaymentAction(sale) {
  const { advisorStatus, managerStatus } = normalizePaymentStatuses(sale);
  return advisorStatus === "pending" || managerStatus === "pending";
}

function buildPaymentPendingMessage(sale) {
  const { advisorStatus, managerStatus } = normalizePaymentStatuses(sale);
  const pendingParts = [];
  if (advisorStatus === "pending") pendingParts.push("Advisor commission");
  if (managerStatus === "pending") pendingParts.push("Manager commission");
  return [
    `Customer: ${sale.customerName || "—"} · ${sale.phone || "—"}`,
    `Product: ${sale.productCategory || "—"}`,
    `Premium: ₹${Number(sale.premiumAmount || 0).toLocaleString("en-IN")}`,
    `Pending: ${pendingParts.join(" & ") || "Commission payment"}`,
    `Advisor: ${sale.advisorName || "—"} · Manager: ${sale.managerName || "—"}`,
  ].join("\n");
}

async function main() {
  let admin;
  try {
    admin = require("firebase-admin");
  } catch (err) {
    console.error("[Payment Cron] firebase-admin is not installed. Run: npm install firebase-admin");
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
  const pendingDays = parseInt(process.env.PAYMENT_PENDING_DAYS || String(DEFAULT_PENDING_DAYS), 10);
  const dryRun = process.env.PAYMENT_DRY_RUN === "1";
  const now = new Date();

  console.info("[Payment Cron] Checking for payments pending", pendingDays, "+ days", dryRun ? "(DRY RUN)" : "");

  const snap = await db
    .collection("closed_sales")
    .where("approvalStatus", "==", "approved")
    .get();

  console.info("[Payment Cron] Candidate approved sales:", snap.size);

  let notified = 0;
  let batch = db.batch();
  let batchOps = 0;
  const batchLimit = 400;

  for (const docSnap of snap.docs) {
    const sale = { id: docSnap.id, ...docSnap.data() };
    if (sale.paymentPendingNotificationSent === true) continue;
    if (!saleNeedsPaymentAction(sale)) continue;

    const approvedAt = toDate(sale.paymentCreatedAt || sale.approvedAt);
    if (!approvedAt) continue;

    const ageDays = daysBetween(approvedAt, now);
    if (ageDays < pendingDays) continue;

    const title = "Payment Still Pending";
    const message = buildPaymentPendingMessage(sale);
    const metadata = {
      saleId: sale.id,
      customerName: sale.customerName || "",
      premiumAmount: sale.premiumAmount || 0,
      advisorCommissionStatus: sale.advisorCommissionStatus || "pending",
      managerCommissionStatus: sale.managerCommissionStatus || "pending",
      daysPending: ageDays,
    };

    console.info(
      "[Payment Cron] Notify admin — sale",
      sale.id,
      "|",
      sale.customerName,
      "|",
      ageDays,
      "days"
    );

    if (!dryRun) {
      const notifRef = db.collection("notifications").doc();
      batch.set(notifRef, {
        recipientId: "admin",
        recipientRole: "admin",
        type: "payment_pending",
        title,
        message,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        metadata,
      });
      batchOps++;

      batch.update(docSnap.ref, {
        paymentPendingNotificationSent: true,
        paymentPendingNotificationSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      batchOps++;

      if (batchOps >= batchLimit) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    notified++;
  }

  if (!dryRun && batchOps > 0) {
    await batch.commit();
  }

  console.info("[Payment Cron] Complete — admin notifications sent:", notified);
  process.exit(0);
}

main().catch((err) => {
  console.error("[Payment Cron] Fatal error:", err);
  process.exit(1);
});
