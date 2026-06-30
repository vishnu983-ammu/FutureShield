"use strict";

/**
 * Manager Dashboard — Payment Status widget (pending / success tabs).
 * Scoped to manager + their advisors via getScopedClosedSales().
 */

window.initManagerPaymentSummary = function initManagerPaymentSummary(db, fs, ui) {
  const { doc, updateDoc, serverTimestamp } = fs;
  const esc = ui.esc || ((s) => String(s ?? ""));
  const showToast = ui.showToast || (() => {});
  const createNotification = ui.createNotification;

  function daysPending(sale) {
    const start = window.getPaymentCreatedDate ? window.getPaymentCreatedDate(sale) : null;
    if (!start) return 0;
    return Math.max(0, Math.floor((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000)));
  }

  function buildLineItems(sales) {
    const rows = [];
    (sales || []).forEach((sale) => {
      if (sale.approvalStatus !== "approved") return;
      const comm = window.getSalePaymentCommission
        ? window.getSalePaymentCommission(sale)
        : {
            advisorCommission: Number(sale.advisorCommission) || 0,
            managerCommission: Number(sale.managerCommission) || 0,
          };
      const isDirect = sale.isManagerDirectSale === true;
      const pendingDays = daysPending(sale);

      if (!isDirect) {
        const st = sale.advisorCommissionStatus || "pending";
        if (st !== "n/a") {
          rows.push({
            saleId: sale.id,
            role: "advisor",
            roleLabel: "Advisor",
            payeeName: sale.advisorName || "—",
            customerName: sale.customerName || "—",
            product: sale.productCategory || "—",
            premium: sale.premiumAmount || 0,
            amount: comm.advisorCommission || 0,
            status: st,
            pendingDays,
            transactionId: sale.advisorCommissionTransactionId || "",
            actionDate:
              st === "approved"
                ? sale.advisorCommissionApprovalDate
                : st === "denied"
                  ? sale.advisorCommissionRejectionDate
                  : null,
          });
        }
      }

      const mgrSt = sale.managerCommissionStatus || "pending";
      rows.push({
        saleId: sale.id,
        role: "manager",
        roleLabel: isDirect ? "Manager (direct sale)" : "Manager override",
        payeeName: sale.managerName || "—",
        customerName: sale.customerName || "—",
        product: sale.productCategory || "—",
        premium: sale.premiumAmount || 0,
        amount: comm.managerCommission || 0,
        status: mgrSt,
        pendingDays,
        transactionId: sale.managerCommissionTransactionId || "",
        actionDate:
          mgrSt === "approved"
            ? sale.managerCommissionApprovalDate
            : mgrSt === "denied"
              ? sale.managerCommissionRejectionDate
              : null,
      });
    });
    return rows;
  }

  window.switchManagerPaymentTab = function (tab) {
    const pendingPanel = document.getElementById("mgr-payment-pending-panel");
    const successPanel = document.getElementById("mgr-payment-success-panel");
    const pendingBtn = document.getElementById("mgr-payment-tab-pending");
    const successBtn = document.getElementById("mgr-payment-tab-success");
    const isPending = tab !== "success";
    pendingPanel?.classList.toggle("hidden", !isPending);
    successPanel?.classList.toggle("hidden", isPending);
    pendingBtn?.classList.toggle("active", isPending);
    successBtn?.classList.toggle("active", !isPending);
    window.renderManagerPaymentSummary?.(window._closedSalesCache || []);
  };

  window.sendPaymentReminderToAdmin = async function (saleId, role) {
    const session = window._session || {};
    if (session.role !== "manager") {
      showToast("Only managers can send payment reminders.", "error");
      return;
    }
    const sale = (window._closedSalesCache || []).find((s) => s.id === saleId);
    if (!sale || !window.saleBelongsToManager(sale, session.managerId)) {
      showToast("Sale not found or not in your team.", "error");
      return;
    }
    if (typeof createNotification !== "function") {
      showToast("Notifications unavailable.", "error");
      return;
    }

    const comm = window.getSalePaymentCommission ? window.getSalePaymentCommission(sale) : sale;
    const amount = role === "advisor" ? comm.advisorCommission : comm.managerCommission;
    const payee = role === "advisor" ? sale.advisorName : sale.managerName;
    const days = daysPending(sale);

    try {
      await createNotification(
        "admin",
        "admin",
        "payment_reminder",
        "Payment Reminder from Manager",
        `${session.displayName || session.name || "A manager"} requests payment for ${payee || role} — ` +
          `Customer: ${sale.customerName || "—"}, ₹${Number(amount || 0).toLocaleString("en-IN")} commission. ` +
          `Pending ${days} day${days === 1 ? "" : "s"}.`,
        {
          saleId,
          role,
          managerId: session.managerId,
          managerName: session.displayName || session.name || "",
          customerName: sale.customerName || "",
          amount: amount || 0,
          pendingDays: days,
        }
      );
      showToast("Reminder sent to Admin.", "success");
    } catch (err) {
      console.error("[PaymentSummary] reminder failed:", err);
      showToast("Could not send reminder. Try again.", "error");
    }
  };

  window.renderManagerPaymentSummary = function renderManagerPaymentSummary(allSales) {
    if (window._session?.role !== "manager") return;

    const scoped =
      typeof window.getScopedClosedSales === "function"
        ? window.getScopedClosedSales()
        : (allSales || []).filter((s) =>
            window.saleBelongsToManager(s, window._session?.managerId)
          );

    const items = buildLineItems(scoped);
    const pending = items.filter((r) => r.status === "pending");
    const success = items.filter((r) => r.status === "approved");

    const escFn = window._esc || esc;
    const pendingCountEl = document.getElementById("mgr-payment-pending-count");
    const successCountEl = document.getElementById("mgr-payment-success-count");
    const tileCountEl = document.getElementById("count-payment-pending");
    const pagePendingEl = document.getElementById("mgr-payment-page-pending-count");
    const navBadgeEl = document.getElementById("nav-mgr-payment-badge");

    if (pendingCountEl) pendingCountEl.textContent = `(${pending.length})`;
    if (successCountEl) successCountEl.textContent = `(${success.length})`;
    if (tileCountEl) tileCountEl.textContent = String(pending.length);
    if (pagePendingEl) pagePendingEl.textContent = String(pending.length);
    if (navBadgeEl) {
      navBadgeEl.textContent = String(pending.length);
      navBadgeEl.classList.toggle("hidden", pending.length === 0);
    }

    const pendingBody = document.getElementById("mgr-payment-pending-body");
    const successBody = document.getElementById("mgr-payment-success-body");

    if (pendingBody) {
      if (!pending.length) {
        pendingBody.innerHTML =
          '<tr><td colspan="7" class="text-center py-10 text-gray-400 text-sm">No pending commission payments for your team</td></tr>';
      } else {
        pendingBody.innerHTML = pending
          .sort((a, b) => b.pendingDays - a.pendingDays)
          .map((r) => {
            const safeId = escFn(r.saleId);
            const safeRole = escFn(r.role);
            return `<tr class="border-b border-gray-50 hover:bg-amber-50/30 transition-colors" data-sale-id="${escFn(r.saleId)}">
              <td class="px-4 py-3">
                <p class="font-medium text-gray-800 text-sm">${escFn(r.customerName)}</p>
                <p class="text-xs text-gray-400">${escFn(r.product)}</p>
              </td>
              <td class="px-4 py-3 text-sm">${escFn(r.payeeName)}</td>
              <td class="px-4 py-3 text-xs"><span class="font-semibold px-2 py-0.5 rounded-full bg-sky-100 text-sky-700">${escFn(r.roleLabel)}</span></td>
              <td class="px-4 py-3 font-semibold text-indigo-700 whitespace-nowrap">₹${Number(r.amount).toLocaleString("en-IN")}</td>
              <td class="px-4 py-3 whitespace-nowrap">
                <span class="text-sm font-bold text-amber-600">${r.pendingDays}</span>
                <span class="text-xs text-gray-400"> day${r.pendingDays === 1 ? "" : "s"}</span>
              </td>
              <td class="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">₹${Number(r.premium).toLocaleString("en-IN")}</td>
              <td class="px-4 py-3">
                <button type="button"
                  class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors whitespace-nowrap"
                  onclick="window.sendPaymentReminderToAdmin('${safeId}', '${safeRole}')">
                  Send Reminder to Admin
                </button>
              </td>
            </tr>`;
          })
          .join("");
      }
    }

    if (successBody) {
      if (!success.length) {
        successBody.innerHTML =
          '<tr><td colspan="6" class="text-center py-10 text-gray-400 text-sm">No processed payments yet</td></tr>';
      } else {
        successBody.innerHTML = success
          .sort((a, b) => {
            const da = window.formatPaymentActionDate?.(a.actionDate) || "";
            const db = window.formatPaymentActionDate?.(b.actionDate) || "";
            return db.localeCompare(da);
          })
          .map((r) => {
            const dateStr = window.formatPaymentActionDate
              ? window.formatPaymentActionDate(r.actionDate)
              : "—";
            return `<tr class="border-b border-gray-50 hover:bg-emerald-50/30 transition-colors">
              <td class="px-4 py-3">
                <p class="font-medium text-gray-800 text-sm">${escFn(r.customerName)}</p>
                <p class="text-xs text-gray-400">${escFn(r.product)}</p>
              </td>
              <td class="px-4 py-3 text-sm">${escFn(r.payeeName)}</td>
              <td class="px-4 py-3 text-xs"><span class="font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">${escFn(r.roleLabel)}</span></td>
              <td class="px-4 py-3 font-semibold text-emerald-700 whitespace-nowrap">₹${Number(r.amount).toLocaleString("en-IN")}</td>
              <td class="px-4 py-3 text-xs font-mono text-gray-700">${escFn(r.transactionId || "—")}</td>
              <td class="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">${escFn(dateStr)}</td>
            </tr>`;
          })
          .join("");
      }
    }
  };
};
