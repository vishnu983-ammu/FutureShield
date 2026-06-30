"use strict";

/**
 * Notification bell — click-to-navigate using full-page routes.
 */

window.getNotificationRoute = function getNotificationRoute(notif) {
  if (!notif) return null;
  const type = String(notif.type || "");
  const meta = notif.metadata || {};
  const role = window._session?.role || notif.recipientRole || "admin";

  const saleId = meta.saleId || meta.closedSaleId || null;
  const leadId = meta.leadId || null;
  const managerId = meta.managerId || null;

  switch (type) {
    case "payment_pending":
    case "payment_reminder":
      if (role === "manager") {
        return { section: "mgrpaymentsummary", recordId: saleId, recordKind: "sale" };
      }
      return { section: "paymentstatus", recordId: saleId, recordKind: "sale" };

    case "sale_submitted":
      if (saleId) {
        return { section: "approvals", tab: "sales", recordId: saleId, recordKind: "sale" };
      }
      if (leadId) {
        return { section: "approvals", tab: "leads", recordId: leadId, recordKind: "lead" };
      }
      return { section: "approvals", tab: "sales" };

    case "lead_approved":
    case "lead_rejected":
      return { section: "leads", recordId: leadId, recordKind: "lead" };

    case "sale_approved":
    case "sale_rejected":
      return { section: "closedsales", recordId: saleId, recordKind: "sale" };

    case "followup_scheduled":
      return { section: "followups", recordId: leadId, recordKind: "lead" };

    case "policy_renewal":
      return { section: "closedsales", recordId: saleId, recordKind: "sale" };

    case "new_lead":
      return { section: "leads", recordId: leadId, recordKind: "lead" };

    case "credential_update":
      return { section: "profile" };

    case "exam_failed":
      return role === "admin"
        ? { section: "managers", recordId: managerId, recordKind: "manager" }
        : { section: "managerexam" };

    case "exam_reassigned":
      return role === "manager" ? { section: "managerexam" } : { section: "managers", recordId: managerId, recordKind: "manager" };

    default:
      if (role === "admin") return { section: "dashboard" };
      if (role === "manager") return { section: "dashboard" };
      return { section: "digitalcard" };
  }
};

window.applyNotificationRecordHighlight = function applyNotificationRecordHighlight(focus) {
  if (!focus?.recordId) return false;
  document.querySelectorAll(".notif-record-highlight").forEach((el) => {
    el.classList.remove("notif-record-highlight");
  });

  let el = null;
  const id = String(focus.recordId).replace(/"/g, "");
  if (focus.recordKind === "sale" && focus.section === "paymentstatus") {
    el = document.getElementById(`payment-row-${id}`);
  } else if (focus.recordKind === "sale") {
    el = document.querySelector(`tr[data-sale-id="${id}"]`);
  } else if (focus.recordKind === "lead") {
    el = document.querySelector(`tr[data-lead-id="${id}"]`);
  } else if (focus.recordKind === "manager") {
    el = document.querySelector(`tr[data-manager-id="${id}"]`);
  }

  if (!el) return false;
  el.classList.add("notif-record-highlight");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => el.classList.remove("notif-record-highlight"), 4500);
  return true;
};

window.flushNotificationFocus = function flushNotificationFocus() {
  const focus = window._notificationFocusPending;
  if (!focus) return;
  if (window.applyNotificationRecordHighlight(focus)) {
    window._notificationFocusPending = null;
  }
};

window.navigateFromNotification = function navigateFromNotification(notif) {
  const route = window.getNotificationRoute(notif);
  if (!route?.section) {
    window.showToast?.("No linked page for this notification.", "error");
    return;
  }

  const session = window._session || {};
  if (route.section === "paymentstatus" && session.role !== "admin") {
    window.showToast?.("Payment Status is available to administrators only.", "error");
    return;
  }
  if (route.section === "mgrpaymentsummary" && session.role !== "manager") {
    window.showToast?.("Payment Summary is available to managers only.", "error");
    return;
  }
  if (route.section === "approvals" && session.role !== "admin") {
    window.showToast?.("Pending Approvals is available to administrators only.", "error");
    return;
  }
  if (route.section === "managers" && session.role !== "admin") {
    window.showToast?.("Managers management is available to administrators only.", "error");
    return;
  }

  document.getElementById("notif-panel")?.classList.add("hidden");

  const navOpts = { navFocus: route };
  if (typeof window.navigateToSection === "function") {
    window.navigateToSection(route.section, navOpts);
  } else if (typeof window.showSection === "function") {
    window.showSection(route.section, navOpts);
  }
};

window.handleNotificationClick = async function handleNotificationClick(notifId) {
  const notif = (window._notifsCache || []).find((n) => n.id === notifId);
  if (!notif) return;

  if (typeof window.markNotificationRead === "function") {
    await window.markNotificationRead(notifId);
  }

  const item = document.querySelector(`.notif-item[data-notif-id="${notifId}"]`);
  item?.classList.remove("unread");
  const dot = item?.querySelector(".notif-unread-dot");
  if (dot) dot.remove();

  window.navigateFromNotification(notif);
};
