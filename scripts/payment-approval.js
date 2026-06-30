"use strict";

/**
 * Payment Status — commission payout workflow for approved closed_sales.
 * Requires Transaction ID (approve) or Rejection Reason (deny) via modals.
 */

window.PAYMENT_PENDING_DAYS = 15;

window.normalizePaymentStatuses = function (sale) {
  if (!sale || sale.approvalStatus !== "approved") {
    return { advisorStatus: "n/a", managerStatus: "n/a" };
  }
  const isDirect = sale.isManagerDirectSale === true;
  const advisorStatus = isDirect ? "n/a" : (sale.advisorCommissionStatus || "pending");
  const managerStatus = sale.managerCommissionStatus || "pending";
  return { advisorStatus, managerStatus };
};

window.saleNeedsPaymentAction = function (sale) {
  const { advisorStatus, managerStatus } = window.normalizePaymentStatuses(sale);
  return advisorStatus === "pending" || managerStatus === "pending";
};

window.getPaymentCreatedDate = function (sale) {
  if (!sale) return null;
  const vals = [sale.paymentCreatedAt, sale.approvedAt, sale.submittedAt];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!v) continue;
    if (typeof v.toDate === "function") return v.toDate();
    if (v instanceof Date) return v;
    if (v.seconds) return new Date(v.seconds * 1000);
  }
  return null;
};

window.formatPaymentActionDate = function (value) {
  if (!value) return "";
  const d = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

window.getSalePaymentCommission = function (sale) {
  const empty = {
    advisorCommission: 0,
    managerCommission: 0,
    advisorCommissionPct: null,
    managerCommissionPct: null,
    managerDirectPct: null,
  };
  if (!sale) return empty;

  let advisorCommission = 0;
  let managerCommission = 0;

  if (typeof window.getSaleCommissionValues === "function") {
    const vals = window.getSaleCommissionValues(sale);
    advisorCommission = Number(vals.advisor ?? vals.advisorCommission) || 0;
    managerCommission = Number(vals.manager ?? vals.managerCommission) || 0;
  } else {
    advisorCommission = Number(sale.advisorCommission) || 0;
    managerCommission = Number(sale.managerCommission) || 0;
  }

  let advisorCommissionPct = sale.advisorCommissionPct;
  let managerCommissionPct = sale.managerCommissionPct;
  let managerDirectPct = sale.managerDirectPct;

  const premium = Number(sale.premiumAmount) || 0;
  const isDirect = sale.isManagerDirectSale === true;
  const missingAmount = isDirect
    ? managerCommission === 0
    : advisorCommission === 0 || managerCommission === 0;
  const missingPct =
    (isDirect && managerDirectPct == null) ||
    (!isDirect && (advisorCommissionPct == null || managerCommissionPct == null));

  if (
    premium > 0 &&
    typeof window.computeSaleCommissions === "function" &&
    (missingAmount || missingPct)
  ) {
    const comm = window.computeSaleCommissions({
      productCategory: sale.productCategory,
      premiumAmount: premium,
      isManagerDirectSale: isDirect,
      fallback: sale,
    });
    if (isDirect) {
      if (managerCommission === 0) managerCommission = comm.managerCommission || 0;
      if (managerDirectPct == null) managerDirectPct = comm.managerDirectPct;
    } else {
      if (advisorCommission === 0) advisorCommission = comm.advisorCommission || 0;
      if (managerCommission === 0) managerCommission = comm.managerCommission || 0;
      if (advisorCommissionPct == null) advisorCommissionPct = comm.advisorCommissionPct;
      if (managerCommissionPct == null) managerCommissionPct = comm.managerCommissionPct;
    }
  }

  return {
    advisorCommission,
    managerCommission,
    advisorCommissionPct: advisorCommissionPct ?? null,
    managerCommissionPct: managerCommissionPct ?? null,
    managerDirectPct: managerDirectPct ?? null,
  };
};

window.initPaymentApproval = function initPaymentApproval(db, fs, ui) {
  const { doc, updateDoc, serverTimestamp } = fs;
  const esc = ui.esc || ((s) => String(s ?? ""));
  const showToast = ui.showToast || (() => {});

  function findSale(saleId) {
    return (window._closedSalesCache || []).find((s) => s.id === saleId) || null;
  }

  function roleLabel(role) {
    return role === "advisor" ? "Advisor Commission" : "Manager Commission";
  }

  function commissionAmountForRole(sale, role) {
    const comm = window.getSalePaymentCommission(sale);
    return role === "advisor" ? comm.advisorCommission : comm.managerCommission;
  }

  function commissionDetailForRole(sale, role) {
    const comm = window.getSalePaymentCommission(sale);
    const isDirect = sale.isManagerDirectSale === true;
    if (role === "advisor") {
      return {
        amount: comm.advisorCommission || 0,
        detail: comm.advisorCommissionPct != null ? `${comm.advisorCommissionPct}% of premium` : "",
      };
    }
    if (isDirect) {
      return {
        amount: comm.managerCommission || 0,
        detail: comm.managerDirectPct != null ? `${comm.managerDirectPct}% direct incentive` : "",
      };
    }
    return {
      amount: comm.managerCommission || 0,
      detail: comm.managerCommissionPct != null ? `${comm.managerCommissionPct}% override` : "",
    };
  }

  window.openPaymentApproveModal = function (saleId, role) {
    if (window._session?.role !== "admin") return;
    const sale = findSale(saleId);
    if (!sale) {
      showToast("Sale record not found.", "error");
      return;
    }
    const { amount, detail } = commissionDetailForRole(sale, role);
    document.getElementById("payment-approve-sale-id").value = saleId;
    document.getElementById("payment-approve-role").value = role;
    document.getElementById("payment-approve-customer").textContent = sale.customerName || "—";
    document.getElementById("payment-approve-role-label").textContent = roleLabel(role);
    document.getElementById("payment-approve-amount").textContent =
      "₹" + Number(amount).toLocaleString("en-IN") + (detail ? ` · ${detail}` : "");
    document.getElementById("payment-approve-txn-id").value = "";
    document.getElementById("modal-payment-approve").classList.remove("hidden");
    setTimeout(() => document.getElementById("payment-approve-txn-id")?.focus(), 80);
  };

  window.closePaymentApproveModal = function () {
    document.getElementById("modal-payment-approve")?.classList.add("hidden");
    document.getElementById("payment-approve-txn-id").value = "";
  };

  window.submitPaymentApprove = async function (e) {
    e.preventDefault();
    if (window._session?.role !== "admin") return;

    const saleId = document.getElementById("payment-approve-sale-id").value;
    const role = document.getElementById("payment-approve-role").value;
    const txnId = document.getElementById("payment-approve-txn-id").value.trim();
    const btn = document.getElementById("btn-payment-approve");
    const spinner = document.getElementById("payment-approve-spinner");

    if (!txnId) {
      showToast("Transaction ID is required to approve payment.", "error");
      document.getElementById("payment-approve-txn-id")?.focus();
      return;
    }

    btn.disabled = true;
    spinner?.classList.remove("hidden");

    const patch = {};
    const clientDate = new Date();
    if (role === "advisor") {
      patch.advisorCommissionStatus = "approved";
      patch.advisorCommissionApprovalDate = serverTimestamp();
      patch.advisorCommissionTransactionId = txnId;
      patch.advisorCommissionRejectionReason = "";
      patch.advisorCommissionRejectionDate = null;
    } else {
      patch.managerCommissionStatus = "approved";
      patch.managerCommissionApprovalDate = serverTimestamp();
      patch.managerCommissionTransactionId = txnId;
      patch.managerCommissionRejectionReason = "";
      patch.managerCommissionRejectionDate = null;
    }

    try {
      await updateDoc(doc(db, "closed_sales", saleId), patch);
      const cachePatch = { ...patch };
      if (role === "advisor") cachePatch.advisorCommissionApprovalDate = clientDate;
      else cachePatch.managerCommissionApprovalDate = clientDate;
      window.patchClosedSaleInCache?.(saleId, cachePatch);
      window.renderPaymentStatusPage?.(window._closedSalesCache || []);
      window.closePaymentApproveModal();
      showToast(`${roleLabel(role)} approved. Transaction ID saved.`, "success");
    } catch (err) {
      console.error("[PaymentStatus] approve failed:", err);
      showToast("Could not approve payment. Please try again.", "error");
    } finally {
      btn.disabled = false;
      spinner?.classList.add("hidden");
    }
  };

  window.openPaymentRejectModal = function (saleId, role) {
    if (window._session?.role !== "admin") return;
    const sale = findSale(saleId);
    if (!sale) {
      showToast("Sale record not found.", "error");
      return;
    }
    const { amount, detail } = commissionDetailForRole(sale, role);
    document.getElementById("payment-reject-sale-id").value = saleId;
    document.getElementById("payment-reject-role").value = role;
    document.getElementById("payment-reject-customer").textContent = sale.customerName || "—";
    document.getElementById("payment-reject-role-label").textContent = roleLabel(role);
    document.getElementById("payment-reject-amount").textContent =
      "₹" + Number(amount).toLocaleString("en-IN") + (detail ? ` · ${detail}` : "");
    document.getElementById("payment-reject-reason").value = "";
    document.getElementById("modal-payment-reject").classList.remove("hidden");
    setTimeout(() => document.getElementById("payment-reject-reason")?.focus(), 80);
  };

  window.closePaymentRejectModal = function () {
    document.getElementById("modal-payment-reject")?.classList.add("hidden");
    document.getElementById("payment-reject-reason").value = "";
  };

  window.submitPaymentReject = async function (e) {
    e.preventDefault();
    if (window._session?.role !== "admin") return;

    const saleId = document.getElementById("payment-reject-sale-id").value;
    const role = document.getElementById("payment-reject-role").value;
    const reason = document.getElementById("payment-reject-reason").value.trim();
    const btn = document.getElementById("btn-payment-reject");
    const spinner = document.getElementById("payment-reject-spinner");

    if (!reason) {
      showToast("Rejection reason is required.", "error");
      document.getElementById("payment-reject-reason")?.focus();
      return;
    }

    btn.disabled = true;
    spinner?.classList.remove("hidden");

    const patch = {};
    const clientDate = new Date();
    if (role === "advisor") {
      patch.advisorCommissionStatus = "denied";
      patch.advisorCommissionRejectionDate = serverTimestamp();
      patch.advisorCommissionRejectionReason = reason;
      patch.advisorCommissionTransactionId = "";
    } else {
      patch.managerCommissionStatus = "denied";
      patch.managerCommissionRejectionDate = serverTimestamp();
      patch.managerCommissionRejectionReason = reason;
      patch.managerCommissionTransactionId = "";
    }

    try {
      await updateDoc(doc(db, "closed_sales", saleId), patch);
      const cachePatch = { ...patch };
      if (role === "advisor") cachePatch.advisorCommissionRejectionDate = clientDate;
      else cachePatch.managerCommissionRejectionDate = clientDate;
      window.patchClosedSaleInCache?.(saleId, cachePatch);
      window.renderPaymentStatusPage?.(window._closedSalesCache || []);
      window.closePaymentRejectModal();
      showToast(`${roleLabel(role)} rejected.`, "success");
    } catch (err) {
      console.error("[PaymentStatus] reject failed:", err);
      showToast("Could not reject payment. Please try again.", "error");
    } finally {
      btn.disabled = false;
      spinner?.classList.add("hidden");
    }
  };

  function renderPaymentActionCell(sale, role) {
    const { advisorStatus, managerStatus } = window.normalizePaymentStatuses(sale);
    const status = role === "advisor" ? advisorStatus : managerStatus;

    if (status === "n/a") {
      return `<span class="text-gray-300 text-xs">—</span>`;
    }

    if (status === "approved") {
      const dateStr = window.formatPaymentActionDate(
        role === "advisor" ? sale.advisorCommissionApprovalDate : sale.managerCommissionApprovalDate
      );
      const txnId =
        role === "advisor"
          ? sale.advisorCommissionTransactionId
          : sale.managerCommissionTransactionId;
      return `<div class="space-y-1">
        <span class="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700">Approved</span>
        ${txnId ? `<p class="text-xs text-gray-600">Txn: <span class="font-mono">${esc(txnId)}</span></p>` : ""}
        ${dateStr ? `<p class="text-xs text-gray-400">${esc(dateStr)}</p>` : ""}
      </div>`;
    }

    if (status === "denied") {
      const dateStr = window.formatPaymentActionDate(
        role === "advisor" ? sale.advisorCommissionRejectionDate : sale.managerCommissionRejectionDate
      );
      const reason =
        role === "advisor"
          ? sale.advisorCommissionRejectionReason
          : sale.managerCommissionRejectionReason;
      return `<div class="space-y-1">
        <span class="inline-block text-xs font-semibold px-2.5 py-1 rounded-full bg-red-100 text-red-700">Rejected</span>
        ${reason ? `<p class="text-xs text-red-600/90 max-w-[180px]">${esc(reason)}</p>` : ""}
        ${dateStr ? `<p class="text-xs text-gray-400">${esc(dateStr)}</p>` : ""}
      </div>`;
    }

    const safeId = esc(sale.id);
    return `<div class="space-y-1">
      <div class="flex items-center gap-1.5 flex-wrap">
        <button type="button" class="btn-approve text-xs !px-2 !py-1"
          onclick="window.openPaymentApproveModal('${safeId}', '${role}')">✓ Approve</button>
        <button type="button" class="btn-reject text-xs !px-2 !py-1"
          onclick="window.openPaymentRejectModal('${safeId}', '${role}')">✗ Reject</button>
      </div>
      <p class="text-xs text-amber-600 font-medium">Pending payout</p>
    </div>`;
  }

  function renderCommissionCell(sale, role) {
    const { amount, detail } = commissionDetailForRole(sale, role);
    const isDirect = sale.isManagerDirectSale === true;
    if (role === "advisor" && isDirect) {
      return `<span class="text-gray-300">—</span>`;
    }
    const cls = role === "advisor" ? "text-sky-700" : "text-violet-700";
    return `<div>
      <p class="font-bold ${cls} text-sm">₹${Number(amount).toLocaleString("en-IN")}</p>
      ${detail ? `<p class="text-xs text-gray-500 mt-0.5">${esc(detail)}</p>` : ""}
    </div>`;
  }

  window.renderPaymentStatusPage = function renderPaymentStatusPage(allSales) {
    const tbody = document.getElementById("payment-status-table-body");
    const countEl = document.getElementById("payment-status-pending-count");
    const totalEl = document.getElementById("payment-status-pending-total");
    const navBadge = document.getElementById("nav-payment-status-badge");
    if (window._session?.role !== "admin") return;

    const escFn = window._esc || esc;
    const pendingSales = (allSales || [])
      .filter((s) => s.approvalStatus === "approved" && window.saleNeedsPaymentAction(s))
      .sort((a, b) => {
        const da = window.getPaymentCreatedDate(a)?.getTime() || 0;
        const db = window.getPaymentCreatedDate(b)?.getTime() || 0;
        return db - da;
      });

    if (countEl) countEl.textContent = String(pendingSales.length);
    if (navBadge) {
      if (pendingSales.length > 0) {
        navBadge.textContent = pendingSales.length > 99 ? "99+" : pendingSales.length;
        navBadge.classList.remove("hidden");
      } else {
        navBadge.classList.add("hidden");
      }
    }

    let pendingTotal = 0;
    pendingSales.forEach((s) => {
      const comm = window.getSalePaymentCommission(s);
      const { advisorStatus, managerStatus } = window.normalizePaymentStatuses(s);
      if (advisorStatus === "pending") pendingTotal += comm.advisorCommission || 0;
      if (managerStatus === "pending") pendingTotal += comm.managerCommission || 0;
    });
    if (totalEl) {
      totalEl.textContent = "₹ " + pendingTotal.toLocaleString("en-IN", { maximumFractionDigits: 0 });
    }

    if (!tbody) return;

    if (!pendingSales.length) {
      tbody.innerHTML =
        `<tr><td colspan="10" class="text-center py-14 text-gray-400 text-sm">No pending commission payments — all caught up!</td></tr>`;
      return;
    }

    tbody.innerHTML = pendingSales
      .map((s) => {
        const isDirect = s.isManagerDirectSale === true;
        const approvedStr = window.formatPaymentActionDate(s.approvedAt) || "—";
        const saleType = isDirect
          ? `<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">Manager self-sale</span>`
          : `<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">Advisor sale</span>`;

        return `<tr class="border-b border-gray-50 hover:bg-teal-50/40 transition-colors" id="payment-row-${escFn(s.id)}" data-sale-id="${escFn(s.id)}">
          <td class="px-5 py-3">
            <p class="font-medium text-gray-800">${escFn(s.customerName)}</p>
            <p class="text-xs text-gray-400 mt-0.5">${saleType}</p>
          </td>
          <td class="px-5 py-3 text-sm">${escFn(s.productCategory)}</td>
          <td class="px-5 py-3 font-semibold text-indigo-700 whitespace-nowrap">₹${Number(s.premiumAmount || 0).toLocaleString("en-IN")}</td>
          <td class="px-5 py-3 text-sm">${isDirect ? `<span class="text-gray-400 text-xs">N/A</span>` : escFn(s.advisorName || "—")}</td>
          <td class="px-5 py-3">${renderCommissionCell(s, "advisor")}</td>
          <td class="px-5 py-3 text-sm">${escFn(s.managerName || "—")}</td>
          <td class="px-5 py-3">${renderCommissionCell(s, "manager")}</td>
          <td class="px-5 py-3 align-top min-w-[150px]">${isDirect ? `<span class="text-gray-300 text-xs">—</span>` : renderPaymentActionCell(s, "advisor")}</td>
          <td class="px-5 py-3 align-top min-w-[150px]">${renderPaymentActionCell(s, "manager")}</td>
          <td class="px-5 py-3 text-xs text-gray-400 whitespace-nowrap">${escFn(approvedStr)}</td>
        </tr>`;
      })
      .join("");

    if (typeof window.flushNotificationFocus === "function") {
      setTimeout(() => window.flushNotificationFocus(), 80);
    }
  };

  window.renderPaymentApprovalTable = window.renderPaymentStatusPage;

  window.backfillPaymentApprovalFields = async function () {
    if (window._session?.role !== "admin") {
      console.warn("[PaymentStatus] backfill: admin only");
      return 0;
    }
    const sales = (window._closedSalesCache || []).filter((s) => s.approvalStatus === "approved");
    let updated = 0;
    for (const sale of sales) {
      const isDirect = sale.isManagerDirectSale === true;
      const needsAdvisor = !isDirect && !sale.advisorCommissionStatus;
      const needsManager = !sale.managerCommissionStatus;
      const needsCreated = !sale.paymentCreatedAt;
      const needsFlag = sale.paymentPendingNotificationSent === undefined;
      if (!needsAdvisor && !needsManager && !needsCreated && !needsFlag) continue;

      const patch = {};
      if (needsAdvisor) patch.advisorCommissionStatus = "pending";
      if (isDirect && !sale.advisorCommissionStatus) patch.advisorCommissionStatus = "n/a";
      if (needsManager) patch.managerCommissionStatus = "pending";
      if (needsCreated) patch.paymentCreatedAt = sale.approvedAt || serverTimestamp();
      if (needsFlag) patch.paymentPendingNotificationSent = false;

      try {
        await updateDoc(doc(db, "closed_sales", sale.id), patch);
        window.patchClosedSaleInCache?.(sale.id, patch);
        updated++;
      } catch (err) {
        console.warn("[PaymentStatus] backfill skip", sale.id, err.message);
      }
    }
    window.renderPaymentStatusPage?.(window._closedSalesCache || []);
    console.info("[PaymentStatus] backfill complete — updated", updated, "sale(s)");
    return updated;
  };
};
