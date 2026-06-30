"use strict";

/**
 * Product Settings — commission / incentive rate fields.
 * Loads from Firestore `commission_rules`, edits stay local until Save.
 */

window._productCommissionDirty = window._productCommissionDirty || {};

window.formatCommissionPctForInput = function formatCommissionPctForInput(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "";
};

window.getCommissionRuleForProduct = function getCommissionRuleForProduct(productKey, productCategory) {
  const rules = window._commissionRules || {};
  if (productKey && rules[productKey]) return rules[productKey];

  const norm = (s) => (s || "").trim().toLowerCase();
  const target = norm(productCategory);
  if (!target) return {};

  return (
    Object.values(rules).find((r) => norm(r.productCategory) === target) ||
    Object.values(rules).find((r) => {
      const n = norm(r.productCategory);
      return n && (n.includes(target) || target.includes(n));
    }) ||
    {}
  );
};

window.markProductCommissionDirty = function markProductCommissionDirty(productKey) {
  if (productKey) window._productCommissionDirty[productKey] = true;
};

window.clearProductCommissionDirty = function clearProductCommissionDirty(productKey) {
  if (productKey) delete window._productCommissionDirty[productKey];
};

window.renderProductCommissionFieldsMarkup = function renderProductCommissionFieldsMarkup(
  productKey,
  productName,
  rule
) {
  const esc = window._esc || ((s) => String(s ?? ""));
  const safeKey = esc(productKey);
  const safeName = esc(productName);
  const resolved = rule || window.getCommissionRuleForProduct(productKey, productName);
  const aPct = window.formatCommissionPctForInput(resolved.advisorPct);
  const mPct = window.formatCommissionPctForInput(resolved.managerOverridePct);
  const dPct = window.formatCommissionPctForInput(resolved.managerDirectPct);

  return `
    <div class="product-commission-rates" id="pcrates-${safeKey}"
         data-product-key="${safeKey}" data-product-category="${safeName}"
         data-saved-advisor="${aPct}" data-saved-manager="${mPct}" data-saved-direct="${dPct}">
      <p class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Commission / Incentive Rates</p>
      <div class="product-rate-grid">
        <div class="product-rate-field">
          <label>Advisor Incentive (%)</label>
          <input type="number" min="0" max="100" step="0.01" value="${aPct}" placeholder="0"
            class="commission-input input-advisor-pct"
            oninput="window.markProductCommissionDirty('${safeKey}')" />
        </div>
        <div class="product-rate-field">
          <label>Manager Incentive (%)</label>
          <input type="number" min="0" max="100" step="0.01" value="${mPct}" placeholder="0"
            class="commission-input input-manager-pct"
            oninput="window.markProductCommissionDirty('${safeKey}')" />
        </div>
        <div class="product-rate-field">
          <label>Direct Manager Incentive (%)</label>
          <input type="number" min="0" max="100" step="0.01" value="${dPct}" placeholder="0"
            class="commission-input input-direct-pct"
            oninput="window.markProductCommissionDirty('${safeKey}')" />
        </div>
      </div>
      <div class="flex justify-end mt-3">
        <button type="button"
          class="btn-save-product-rates text-xs font-semibold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100
                 px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-1.5"
          onclick="window.saveProductCommissionRates('${safeKey}')">
          <svg class="pc-save-spinner w-3.5 h-3.5 animate-spin hidden" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          Save Settings
        </button>
      </div>
    </div>`;
};

window.initProductCommissionSettings = function initProductCommissionSettings(db, fs, ui) {
  const { doc, setDoc, serverTimestamp } = fs;
  const showToast = ui.showToast || (() => {});

  window.hydrateProductCommissionFields = function hydrateProductCommissionFields(opts) {
    const force = opts?.force === true;
    document.querySelectorAll(".product-commission-rates").forEach((wrap) => {
      const key = wrap.dataset.productKey;
      if (!key) return;
      if (!force && window._productCommissionDirty[key]) return;

      const rule = window.getCommissionRuleForProduct(key, wrap.dataset.productCategory);
      const advisor = wrap.querySelector(".input-advisor-pct");
      const manager = wrap.querySelector(".input-manager-pct");
      const direct = wrap.querySelector(".input-direct-pct");

      if (advisor) advisor.value = window.formatCommissionPctForInput(rule.advisorPct);
      if (manager) manager.value = window.formatCommissionPctForInput(rule.managerOverridePct);
      if (direct) direct.value = window.formatCommissionPctForInput(rule.managerDirectPct);

      wrap.dataset.savedAdvisor = advisor?.value ?? "";
      wrap.dataset.savedManager = manager?.value ?? "";
      wrap.dataset.savedDirect = direct?.value ?? "";
      wrap.classList.remove("commission-rates-dirty");
    });
  };

  function readRatesFromWrap(wrap) {
    const advisorPct = parseFloat(wrap.querySelector(".input-advisor-pct")?.value);
    const managerPct = parseFloat(wrap.querySelector(".input-manager-pct")?.value);
    const directPct = parseFloat(wrap.querySelector(".input-direct-pct")?.value);
    return {
      advisorPct: Number.isFinite(advisorPct) ? advisorPct : 0,
      managerOverridePct: Number.isFinite(managerPct) ? managerPct : 0,
      managerDirectPct: Number.isFinite(directPct) ? directPct : 0,
    };
  }

  function setSaveButtonLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.classList.toggle("opacity-60", loading);
    const spinner = btn.querySelector(".pc-save-spinner");
    if (spinner) spinner.classList.toggle("hidden", !loading);
  }

  window.saveProductCommissionRates = async function saveProductCommissionRates(productKey, opts) {
    const silent = opts?.silent === true;
    const wrap = document.getElementById(`pcrates-${productKey}`);
    if (!wrap) {
      if (!silent) showToast("Could not find product rate fields.", "error");
      return false;
    }

    const productCategory = wrap.dataset.productCategory;
    const rates = readRatesFromWrap(wrap);
    const btn = wrap.querySelector(".btn-save-product-rates");

    setSaveButtonLoading(btn, true);
    try {
      await setDoc(
        doc(db, "commission_rules", productKey),
        {
          productCategory,
          advisorPct: rates.advisorPct,
          managerOverridePct: rates.managerOverridePct,
          managerDirectPct: rates.managerDirectPct,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      window.clearProductCommissionDirty(productKey);
      wrap.dataset.savedAdvisor = String(rates.advisorPct);
      wrap.dataset.savedManager = String(rates.managerOverridePct);
      wrap.dataset.savedDirect = String(rates.managerDirectPct);
      wrap.classList.remove("commission-rates-dirty");

      if (!silent) showToast(`Incentive settings saved for "${productCategory}".`, "success");
      return true;
    } catch (err) {
      console.error("[ProductCommission] save failed:", err);
      if (!silent) showToast("Could not save incentive settings. Please try again.", "error");
      return false;
    } finally {
      setSaveButtonLoading(btn, false);
    }
  };

  window.saveAllProductCommissionRates = async function saveAllProductCommissionRates() {
    const btn = document.getElementById("btn-save-all-product-rates");
    const spinner = document.getElementById("product-rates-save-all-spinner");
    const wraps = Array.from(document.querySelectorAll(".product-commission-rates"));

    if (!wraps.length) {
      showToast("No products to save.", "error");
      return;
    }

    if (btn) btn.disabled = true;
    spinner?.classList.remove("hidden");

    let saved = 0;
    let failed = 0;
    try {
      for (const wrap of wraps) {
        const key = wrap.dataset.productKey;
        if (!key) continue;
        const ok = await window.saveProductCommissionRates(key, { silent: true });
        if (ok) saved += 1;
        else failed += 1;
      }

      if (failed === 0) {
        showToast(
          saved === 1
            ? "Incentive settings saved."
            : `Incentive settings saved for ${saved} products.`,
          "success"
        );
      } else if (saved > 0) {
        showToast(`Saved ${saved} product(s); ${failed} failed.`, "error");
      } else {
        showToast("Could not save incentive settings.", "error");
      }
    } finally {
      if (btn) btn.disabled = false;
      spinner?.classList.add("hidden");
    }
  };

  const productList = document.getElementById("product-list");
  if (productList) {
    productList.addEventListener("input", (e) => {
      const input = e.target;
      if (!input.matches(".product-commission-rates .commission-input")) return;
      const wrap = input.closest(".product-commission-rates");
      const key = wrap?.dataset.productKey;
      if (key) {
        window.markProductCommissionDirty(key);
        wrap?.classList.add("commission-rates-dirty");
      }
    });
  }

  if (typeof window.hydrateProductCommissionFields === "function") {
    window.hydrateProductCommissionFields({ force: true });
  }
};
