"use strict";

/**
 * Advisor onboarding — pending approval workflow, bank fields, status helpers.
 */

window.INDIAN_BANKS = [
  "State Bank of India",
  "HDFC Bank",
  "ICICI Bank",
  "Axis Bank",
  "Kotak Mahindra Bank",
  "Punjab National Bank",
  "Bank of Baroda",
  "Canara Bank",
  "Union Bank of India",
  "Indian Bank",
  "Bank of India",
  "Central Bank of India",
  "Indian Overseas Bank",
  "UCO Bank",
  "Bank of Maharashtra",
  "Punjab & Sind Bank",
  "IDBI Bank",
  "Yes Bank",
  "IndusInd Bank",
  "Federal Bank",
  "RBL Bank",
  "Bandhan Bank",
  "IDFC FIRST Bank",
  "AU Small Finance Bank",
  "Karnataka Bank",
  "City Union Bank",
  "Karur Vysya Bank",
  "South Indian Bank",
  "Tamilnad Mercantile Bank",
  "CSB Bank",
  "Standard Chartered Bank",
  "HSBC Bank",
  "Citibank",
  "DBS Bank India",
  "Other",
];

window.normalizeAdvisorFromData = function normalizeAdvisorFromData(id, data) {
  const raw = data || {};
  let status = raw.status;
  if (!status) {
    status = raw.disabled === true ? "Inactive" : "Active";
  }
  return {
    id,
    name: raw.name || "",
    mobile: raw.mobile || "",
    managerId: raw.managerId || "",
    managerName: raw.managerName || "",
    managerEmpId: raw.managerEmpId || "",
    disabled: raw.disabled === true,
    status,
    bankAccountNumber: raw.bankAccountNumber || "",
    bankIfsc: raw.bankIfsc || "",
    bankName: raw.bankName || "",
    approvalRemarks: raw.approvalRemarks || "",
    rejectionRemarks: raw.rejectionRemarks || "",
    rejectionNotified: raw.rejectionNotified === true,
    createdAt: raw.createdAt,
    createdByRole: raw.createdByRole || "",
    createdById: raw.createdById || "",
    cardEnabled: raw.cardEnabled === true,
    cardSlug: raw.cardSlug || "",
    designation: raw.designation || "",
    email: raw.email || "",
    photoBase64: raw.photoBase64 || "",
    whatsappNumber: raw.whatsappNumber || "",
    cardBio: raw.cardBio || "",
    cardBranch: raw.cardBranch || "",
    username: raw.username || "",
  };
};

window.getAdvisorStatus = function getAdvisorStatus(advisor) {
  if (!advisor) return "Inactive";
  if (advisor.status) return advisor.status;
  return advisor.disabled ? "Inactive" : "Active";
};

/** Active advisors usable in dashboards, leads, sales, etc. */
window.isAdvisorActive = function isAdvisorActive(advisor) {
  if (!advisor || advisor.disabled) return false;
  return window.getAdvisorStatus(advisor) === "Active";
};

window.getPendingAdvisors = function getPendingAdvisors() {
  return (window._advisorsCache || [])
    .filter((a) => window.getAdvisorStatus(a) === "Pending")
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
};

window.populateBankDropdown = function populateBankDropdown(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const current = select.value;
  const esc = window._esc || ((s) => String(s ?? ""));
  select.innerHTML =
    `<option value="">— Select bank —</option>` +
    window.INDIAN_BANKS.map((bank) => `<option value="${esc(bank)}">${esc(bank)}</option>`).join("");
  if (current && window.INDIAN_BANKS.includes(current)) select.value = current;
};

window.populateAdvisorBankDropdown = function populateAdvisorBankDropdown() {
  window.populateBankDropdown("adv-bank-name");
};

window.populateManagerBankDropdown = function populateManagerBankDropdown() {
  window.populateBankDropdown("mgr-bank-name");
};

window.updatePendingAdvisorApprovalBadge = function updatePendingAdvisorApprovalBadge() {
  const pending = window.getPendingAdvisors().length;
  const badge = document.getElementById("nav-advisor-approvals-badge");
  if (badge) {
    badge.textContent = String(pending);
    badge.classList.toggle("hidden", pending === 0);
  }
};

window.renderPendingAdvisorApprovalsPage = function renderPendingAdvisorApprovalsPage() {
  const root = document.getElementById("advisor-approvals-root");
  if (!root || window._session?.role !== "admin") return;

  const esc = window._esc || ((s) => String(s ?? ""));
  const pending = window.getPendingAdvisors();

  window.updatePendingAdvisorApprovalBadge();

  if (!pending.length) {
    root.innerHTML = `<div class="text-center py-16 text-gray-400 text-sm">
      <p class="font-medium text-gray-500">No pending advisor requests</p>
      <p class="text-xs text-gray-400 mt-1">Manager-submitted advisors awaiting your review will appear here.</p>
    </div>`;
    return;
  }

  root.innerHTML = `
    <div class="space-y-4">
      ${pending
        .map((a) => {
          const submitted = typeof window.formatDate === "function" ? window.formatDate(a.createdAt) : "—";
          return `<article class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden" data-advisor-id="${esc(a.id)}">
            <div class="px-5 py-4 border-b border-gray-100 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 class="text-base font-semibold text-gray-900">${esc(a.name)}</h3>
                <p class="text-sm text-gray-500 mt-0.5">${esc(a.mobile)}</p>
              </div>
              <span class="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">Pending Approval</span>
            </div>
            <div class="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
              <div>
                <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Assigned Manager</p>
                <p class="text-gray-800">${esc(a.managerName || "—")}</p>
                <p class="text-xs text-gray-400 font-mono mt-0.5">${esc(a.managerEmpId || a.managerId || "—")}</p>
              </div>
              <div>
                <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Bank Name</p>
                <p class="text-gray-800">${esc(a.bankName || "—")}</p>
              </div>
              <div>
                <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Account Number</p>
                <p class="text-gray-800 font-mono">${esc(a.bankAccountNumber || "—")}</p>
              </div>
              <div>
                <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">IFSC Code</p>
                <p class="text-gray-800 font-mono uppercase">${esc(a.bankIfsc || "—")}</p>
              </div>
              <div>
                <p class="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Submitted</p>
                <p class="text-gray-800">${esc(submitted)}</p>
              </div>
            </div>
            <div class="px-5 py-4 bg-gray-50 border-t border-gray-100 flex flex-wrap gap-2 justify-end">
              <button type="button" class="advisor-approval-reject-btn px-4 py-2 text-sm font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                data-advisor-id="${esc(a.id)}">Reject</button>
              <button type="button" class="advisor-approval-approve-btn px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
                data-advisor-id="${esc(a.id)}">Approve</button>
            </div>
          </article>`;
        })
        .join("")}
    </div>`;

  window.bindAdvisorApprovalsPageEvents?.();
};

window.bindAdvisorApprovalsPageEvents = function bindAdvisorApprovalsPageEvents() {
  const root = document.getElementById("advisor-approvals-root");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  root.addEventListener("click", (e) => {
    const approveBtn = e.target.closest(".advisor-approval-approve-btn");
    const rejectBtn = e.target.closest(".advisor-approval-reject-btn");
    const btn = approveBtn || rejectBtn;
    if (!btn) return;
    const advisorId = btn.getAttribute("data-advisor-id");
    if (!advisorId) return;
    window.openAdvisorApprovalActionModal(advisorId, approveBtn ? "approve" : "reject");
  });
};

window.openAdvisorApprovalActionModal = function openAdvisorApprovalActionModal(advisorId, action) {
  const advisor = (window._advisorsCache || []).find((a) => a.id === advisorId);
  if (!advisor || window._session?.role !== "admin") return;

  window._advisorApprovalTarget = { advisorId, action };
  const modal = document.getElementById("modal-advisor-approval-action");
  const title = document.getElementById("advisor-approval-modal-title");
  const subtitle = document.getElementById("advisor-approval-modal-subtitle");
  const remarks = document.getElementById("advisor-approval-remarks");
  const submitBtn = document.getElementById("btn-advisor-approval-submit");

  if (title) title.textContent = action === "approve" ? "Approve Advisor" : "Reject Advisor";
  if (subtitle) {
    subtitle.textContent =
      action === "approve"
        ? `Approve ${advisor.name} and make them active under ${advisor.managerName || "their manager"}?`
        : `Reject ${advisor.name}'s onboarding request? The manager will be notified with your remarks.`;
  }
  if (remarks) {
    remarks.value = "";
    remarks.placeholder =
      action === "approve" ? "Optional remarks for internal records…" : "Reason for rejection (shown to manager)…";
  }
  if (submitBtn) {
    submitBtn.textContent = action === "approve" ? "Approve Advisor" : "Reject Advisor";
    submitBtn.className =
      action === "approve"
        ? "flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors"
        : "flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors";
  }

  modal?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  remarks?.focus();
};

window.closeAdvisorApprovalActionModal = function closeAdvisorApprovalActionModal() {
  document.getElementById("modal-advisor-approval-action")?.classList.add("hidden");
  document.body.style.overflow = "";
  window._advisorApprovalTarget = null;
};

window.submitAdvisorApprovalAction = async function submitAdvisorApprovalAction(e) {
  e?.preventDefault();
  const target = window._advisorApprovalTarget;
  if (!target || window._session?.role !== "admin") return;

  const remarks = (document.getElementById("advisor-approval-remarks")?.value || "").trim();
  const btn = document.getElementById("btn-advisor-approval-submit");
  const spinner = document.getElementById("advisor-approval-spinner");

  if (target.action === "reject" && !remarks) {
    window.showToast?.("Please enter rejection remarks for the manager.", "error");
    return;
  }

  if (btn) btn.disabled = true;
  spinner?.classList.remove("hidden");

  try {
    if (target.action === "approve") {
      if (typeof window._approvePendingAdvisorDoc !== "function") {
        throw new Error("Approval handler not ready.");
      }
      await window._approvePendingAdvisorDoc(target.advisorId, remarks);
    } else {
      if (typeof window._rejectPendingAdvisorDoc !== "function") {
        throw new Error("Rejection handler not ready.");
      }
      await window._rejectPendingAdvisorDoc(target.advisorId, remarks);
    }
    window.closeAdvisorApprovalActionModal();
    window.renderPendingAdvisorApprovalsPage?.();
  } catch (err) {
    console.error("[AdvisorApproval] action failed:", err);
    window.showToast?.("Could not update advisor status. Please try again.", "error");
  } finally {
    if (btn) btn.disabled = false;
    spinner?.classList.add("hidden");
  }
};

/** One-time toast when a manager's advisor request is rejected. */
window.notifyManagerOfAdvisorRejections = function notifyManagerOfAdvisorRejections() {
  const session = window._session || {};
  if (session.role !== "manager" || !session.managerId) return;

  const rejections = (window._advisorsCache || []).filter(
    (a) =>
      a.managerId === session.managerId &&
      window.getAdvisorStatus(a) === "Rejected" &&
      !a.rejectionNotified
  );

  rejections.forEach((a) => {
    const msg = a.rejectionRemarks
      ? `Advisor "${a.name}" was rejected. Admin remarks: ${a.rejectionRemarks}`
      : `Advisor "${a.name}" was rejected by admin.`;
    window.showToast?.(msg, "error", 10000);
    if (typeof window._markAdvisorRejectionNotified === "function") {
      window._markAdvisorRejectionNotified(a.id);
    }
  });
};

window.validateBankFields = function validateBankFields(ids) {
  const accountId = ids?.accountId || "adv-bank-account";
  const ifscId = ids?.ifscId || "adv-bank-ifsc";
  const bankNameId = ids?.bankNameId || "adv-bank-name";
  let ok = true;
  const account = document.getElementById(accountId)?.value.trim() || "";
  const ifsc = (document.getElementById(ifscId)?.value.trim() || "").toUpperCase();
  const bankName = document.getElementById(bankNameId)?.value || "";

  if (!/^\d{9,18}$/.test(account)) {
    window.showFieldError?.(accountId, "Enter a valid bank account number (9–18 digits).");
    ok = false;
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    window.showFieldError?.(ifscId, "Enter a valid 11-character IFSC code (e.g. SBIN0001234).");
    ok = false;
  }
  if (!bankName) {
    window.showFieldError?.(bankNameId, "Please select a bank.");
    ok = false;
  }

  return ok;
};

window.validateAdvisorBankFields = function validateAdvisorBankFields() {
  return window.validateBankFields({
    accountId: "adv-bank-account",
    ifscId: "adv-bank-ifsc",
    bankNameId: "adv-bank-name",
  });
};

window.validateManagerBankFields = function validateManagerBankFields() {
  return window.validateBankFields({
    accountId: "mgr-bank-account",
    ifscId: "mgr-bank-ifsc",
    bankNameId: "mgr-bank-name",
  });
};
