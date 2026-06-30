"use strict";

/**
 * Contest Management — multiple contests in Firestore collection `contest_settings`.
 * Each document is one contest with its own isActive flag.
 */

window.initContestManagement = function initContestManagement(db, fs, ui) {
  const {
    collection,
    doc,
    setDoc,
    addDoc,
    updateDoc,
    deleteDoc,
    deleteField,
    serverTimestamp,
    onSnapshot,
  } = fs;
  const showToast = ui.showToast || (() => {});
  const esc = ui.esc || window._esc || ((s) => String(s ?? ""));

  const CONTESTS_COL = collection(db, "contest_settings");
  window._contestsCache = window._contestsCache || [];
  window._contestsCacheReady = false;
  window._selectedContestId = window._selectedContestId || null;
  window._contestProgressManagerFilter = window._contestProgressManagerFilter || "";
  window._contestFormDirty = false;
  window._pendingContestImages = window._pendingContestImages || {};
  const _expiryWriteInFlight = new Set();

  function jsAttrEsc(val) {
    return String(val ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "")
      .replace(/\n/g, "");
  }

  function renderContestPanelState(root, state, message) {
    const spinner = `<svg class="w-9 h-9 animate-spin text-indigo-600 mx-auto" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
    </svg>`;
    const icons = {
      loading: spinner,
      empty: `<svg class="w-10 h-10 text-gray-300 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/></svg>`,
      error: `<svg class="w-10 h-10 text-red-400 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
      notfound: `<svg class="w-10 h-10 text-amber-400 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    };
    root.innerHTML = `<div class="text-center py-16 px-4">
      ${icons[state] || ""}
      <p class="text-sm ${state === "error" ? "text-red-600" : "text-gray-500"} mt-4 max-w-md mx-auto">${esc(message)}</p>
    </div>`;
  }

  const MANAGER_CHART_COLOR = {
    main: "#6366f1",
    light: "#eef2ff",
    border: "#c7d2fe",
    fill: "linear-gradient(180deg, #818cf8 0%, #6366f1 55%, #4338ca 100%)",
    bar: "linear-gradient(90deg, #818cf8, #6366f1)",
  };

  function getActiveManagersList() {
    return (window._managersCache || []).filter((m) => !m.disabled);
  }

  function buildContestProgressSnapshotKey() {
    const liveIds = (window.getLiveContests?.() || []).map((c) => c.id).sort().join(",");
    const filter = window._contestProgressManagerFilter || "";
    const salesSig = (window._closedSalesCache || [])
      .filter((s) => s.approvalStatus === "approved")
      .map(
        (s) =>
          `${s.id}:${s.premiumAmount || 0}:${s.advisorId || ""}:${s.managerId || ""}:${
            s.submittedAt?.seconds || s.closedAt?.seconds || s.approvedAt?.seconds || ""
          }`
      )
      .sort()
      .join("|");
    const mgrSig = getActiveManagersList()
      .map((m) => m.id)
      .sort()
      .join(",");
    return `${liveIds}::${filter}::${salesSig}::${mgrSig}::${(window._advisorsCache || []).length}`;
  }

  /** Debounced render — coalesces rapid snapshot bursts into one paint. */
  window.scheduleContestProgressRender = function scheduleContestProgressRender() {
    if (!document.getElementById("section-contest-progress")?.classList.contains("active")) return;
    if (window._contestProgressRenderRaf) return;
    window._contestProgressRenderRaf = requestAnimationFrame(() => {
      window._contestProgressRenderRaf = null;
      window.renderContestProgressPage?.();
    });
  };

  /** One-time data bootstrap when entering Contest Progress (never re-init listeners). */
  window.ensureContestProgressDataLoaded = function ensureContestProgressDataLoaded() {
    if (window._contestProgressDataEnsured) return;
    window._contestProgressDataEnsured = true;

    if (!window._closedSalesUnsubscribe && typeof window.initClosedSalesListener === "function") {
      window.initClosedSalesListener();
    }
    if (!window._advisorsUnsubscribe && typeof window.initAdvisorsListener === "function") {
      window.initAdvisorsListener();
    }
    if (
      !(window._closedSalesCache || []).length &&
      !window._contestProgressSalesFetch &&
      typeof window.reloadClosedSalesCache === "function"
    ) {
      window._contestProgressSalesFetch = true;
      window
        .reloadClosedSalesCache({ skipCommissionRefresh: true })
        .then(() => {
          window._contestProgressLastRenderKey = "";
          window.scheduleContestProgressRender?.();
        })
        .catch(() => {})
        .finally(() => {
          window._contestProgressSalesFetch = false;
        });
    }
  };

  function renderAdminManagerTeamBlock(contest, manager, mgrIndex) {
    const progress = window.computeContestProgress(contest, manager.id, { requireLive: false });
    const criteriaType = contest.criteriaType || "sales_count";
    const managerName = manager.name || manager.empId || "Manager";

    const managerChart = renderPersonChartCard({
      name: managerName,
      roleLabel: "Manager",
      pct: progress.managerPct,
      achieved: progress.managerAchieved,
      current: progress.managerTotal,
      target: progress.managerTarget,
      criteriaType,
      color: MANAGER_CHART_COLOR,
      large: true,
      gap: progress.managerGap,
    });

    const advisorCharts = progress.advisors.length
      ? progress.advisors
          .map((a, i) =>
            renderPersonChartCard({
              name: a.name,
              roleLabel: "Advisor",
              pct: a.pct,
              achieved: a.achieved,
              current: a.current,
              target: a.target,
              criteriaType,
              color: advisorChartColor(i + mgrIndex),
              large: false,
              gap: a.gap,
            })
          )
          .join("")
      : `<p class="text-sm text-gray-400 col-span-full text-center py-4">No advisors on this team.</p>`;

    return `<div class="contest-admin-team-block mb-8 pb-8 border-b border-gray-100 last:border-0 last:pb-0 last:mb-0">
      <h4 class="text-base font-semibold text-gray-800 mb-4 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-indigo-500"></span>
        ${esc(managerName)} · Team Progress
      </h4>
      <div class="max-w-xs sm:max-w-sm mx-auto mb-6">${managerChart}</div>
      <h5 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Team Advisors</h5>
      <div class="contest-charts-grid">${advisorCharts}</div>
    </div>`;
  }

  function renderAdminContestSection(contest, managerFilterId) {
    const criteriaType = contest.criteriaType || "sales_count";
    const criteriaLabel =
      criteriaType === "sales_amount" ? "Total Sales Amount" : "Number of Sales";
    const { start, end } = contestPeriodBounds(contest);
    const periodStr =
      start && end
        ? `${start.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – ${end.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`
        : "Open period";

    const giftImg = contest.imageBase64
      ? `<img src="${contest.imageBase64}" alt="Contest prize" class="contest-prize-img" />`
      : `<div class="contest-prize-placeholder"><svg class="w-12 h-12 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v13m0-13V6a2 2 0 112 0v1m-2 0h4m-4 0a2 2 0 00-2 2v1a2 2 0 002 2h4a2 2 0 002-2v-1a2 2 0 00-2-2m-6 4h12"/></svg></div>`;

    let managers = getActiveManagersList();
    if (managerFilterId) {
      managers = managers.filter((m) => m.id === managerFilterId);
    }

    const teamBlocks = managers.length
      ? managers.map((m, i) => renderAdminManagerTeamBlock(contest, m, i)).join("")
      : `<p class="text-sm text-gray-400 text-center py-8">No managers match this filter.</p>`;

    return `<section class="contest-progress-block mb-12 pb-10 border-b border-gray-200 last:border-0 last:pb-0 last:mb-0">
      <div class="contest-hero-card mb-8">
        <div class="contest-hero-gift">${giftImg}</div>
        <div class="contest-hero-body">
          <div class="flex flex-wrap items-center gap-2 mb-1">
            <h3 class="text-lg font-bold text-gray-900">${esc(contest.title || "Sales Contest")}</h3>
            ${statusBadge(contest)}
          </div>
          <p class="text-sm text-gray-600 mt-1 whitespace-pre-wrap leading-relaxed">${esc(contest.description || "")}</p>
          <div class="flex flex-wrap gap-2 mt-3">
            <span class="contest-meta-pill">${esc(criteriaLabel)}</span>
            <span class="contest-meta-pill">${esc(periodStr)}</span>
          </div>
        </div>
      </div>
      ${teamBlocks}
    </section>`;
  }

  window.populateContestProgressManagerFilter = function populateContestProgressManagerFilter() {
    const selectEl = document.getElementById("contest-progress-manager-filter");
    if (!selectEl) return;

    const managers = getActiveManagersList();
    const current = window._contestProgressManagerFilter || "";

    selectEl.innerHTML =
      `<option value="">All Managers</option>` +
      managers
        .map((m) => {
          const label = m.name || m.empId || m.id;
          return `<option value="${esc(m.id)}">${esc(label)}</option>`;
        })
        .join("");

    selectEl.value = managers.some((m) => m.id === current) ? current : "";
    if (!selectEl.value) window._contestProgressManagerFilter = "";
  };

  window.renderContestProgressPage = function renderContestProgressPage() {
    const root = document.getElementById("contest-progress-root");
    if (!root) return;

    if (window._session?.role !== "admin") {
      renderContestPanelState(root, "error", "Contest Progress is available to administrators only.");
      return;
    }

    if ((window._closedSalesCache || []).length > 0) {
      window._closedSalesCacheReady = true;
    }
    if ((window._contestsCache || []).length > 0) {
      window._contestsCacheReady = true;
    }

    if (!window._contestsCacheReady) {
      renderContestPanelState(root, "loading", "Loading contests…");
      root.dataset.renderState = "loading";
      return;
    }

    window.populateContestProgressManagerFilter?.();

    const live = window.getLiveContests();
    const managerFilter = window._contestProgressManagerFilter || "";

    if (!live.length) {
      renderContestPanelState(
        root,
        "empty",
        "No active contests at the moment. Enable a contest in Contest Management to track progress here."
      );
      root.dataset.renderState = "empty";
      window._contestProgressLastRenderKey = "";
      return;
    }

    if (managerFilter && !getActiveManagersList().some((m) => m.id === managerFilter)) {
      window._contestProgressManagerFilter = "";
      window.populateContestProgressManagerFilter?.();
    }

    const renderKey = buildContestProgressSnapshotKey();
    if (renderKey === window._contestProgressLastRenderKey && root.dataset.renderState === "content") {
      return;
    }

    try {
      root.innerHTML = live
        .map((c) => renderAdminContestSection(c, window._contestProgressManagerFilter || ""))
        .join("");
      root.dataset.renderState = "content";
      window._contestProgressLastRenderKey = renderKey;
    } catch (err) {
      console.error("[ContestProgress] render failed:", err);
      renderContestPanelState(
        root,
        "error",
        `Could not load contest progress: ${err.message || "Unknown error"}.`
      );
    }
  };

  window.onContestProgressManagerFilterChange = function onContestProgressManagerFilterChange(e) {
    window._contestProgressManagerFilter = e.target.value || "";
    window._contestProgressLastRenderKey = "";
    window.renderContestProgressPage();
  };

  window.applyContestAdminProgressTile = function applyContestAdminProgressTile() {
    const tile = document.getElementById("dash-card-contest-progress");
    if (!tile) return;

    const isAdmin = window._session?.role === "admin";
    const live = window.getLiveContests();

    tile.classList.toggle("hidden", !isAdmin);

    const pctEl = document.getElementById("dash-contest-progress-count");
    const subEl = document.getElementById("dash-contest-progress-sub");
    if (pctEl) pctEl.textContent = isAdmin ? String(live.length) : "—";
    if (subEl) {
      subEl.textContent = !isAdmin
        ? "Active contests"
        : live.length
          ? `${live.length} active contest${live.length === 1 ? "" : "s"}`
          : "No active contests";
    }
  };

  /* Legacy alias */
  window.ensureContestResultsDataLoaded = window.ensureContestProgressDataLoaded;
  window.renderContestResultsPage = window.renderContestProgressPage;

  function getAdvisorsForManager(managerId) {
    const all = (window._advisorsCache || []).filter((a) => {
      if (a.disabled) return false;
      if (typeof window.isAdvisorActive === "function") return window.isAdvisorActive(a);
      return (a.status || "Active") === "Active";
    });
    if (typeof window.advisorBelongsToManager === "function") {
      return all.filter((a) => window.advisorBelongsToManager(a, managerId));
    }
    return all.filter((a) => a.managerId === managerId);
  }

  const ADVISOR_CHART_COLORS = [
    { main: "#f59e0b", light: "#fffbeb", border: "#fde68a", fill: "linear-gradient(180deg, #fcd34d 0%, #f59e0b 55%, #d97706 100%)", bar: "linear-gradient(90deg, #fcd34d, #f59e0b)" },
    { main: "#ec4899", light: "#fdf2f8", border: "#fbcfe8", fill: "linear-gradient(180deg, #f472b6 0%, #ec4899 55%, #db2777 100%)", bar: "linear-gradient(90deg, #f472b6, #ec4899)" },
    { main: "#14b8a6", light: "#f0fdfa", border: "#99f6e4", fill: "linear-gradient(180deg, #2dd4bf 0%, #14b8a6 55%, #0d9488 100%)", bar: "linear-gradient(90deg, #2dd4bf, #14b8a6)" },
    { main: "#8b5cf6", light: "#f5f3ff", border: "#ddd6fe", fill: "linear-gradient(180deg, #a78bfa 0%, #8b5cf6 55%, #7c3aed 100%)", bar: "linear-gradient(90deg, #a78bfa, #8b5cf6)" },
    { main: "#ef4444", light: "#fef2f2", border: "#fecaca", fill: "linear-gradient(180deg, #f87171 0%, #ef4444 55%, #dc2626 100%)", bar: "linear-gradient(90deg, #f87171, #ef4444)" },
    { main: "#3b82f6", light: "#eff6ff", border: "#bfdbfe", fill: "linear-gradient(180deg, #60a5fa 0%, #3b82f6 55%, #2563eb 100%)", bar: "linear-gradient(90deg, #60a5fa, #3b82f6)" },
    { main: "#22c55e", light: "#f0fdf4", border: "#bbf7d0", fill: "linear-gradient(180deg, #4ade80 0%, #22c55e 55%, #16a34a 100%)", bar: "linear-gradient(90deg, #4ade80, #22c55e)" },
    { main: "#f97316", light: "#fff7ed", border: "#fed7aa", fill: "linear-gradient(180deg, #fb923c 0%, #f97316 55%, #ea580c 100%)", bar: "linear-gradient(90deg, #fb923c, #f97316)" },
  ];

  function parseContestDate(val) {
    if (!val) return null;
    if (typeof val.toDate === "function") return val.toDate();
    if (val instanceof Date) return val;
    if (val.seconds) return new Date(val.seconds * 1000);
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function endOfContestDay(date) {
    if (!date) return null;
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  function isPastEndDate(endDate) {
    const end = endOfContestDay(parseContestDate(endDate));
    if (!end) return false;
    return Date.now() > end.getTime();
  }

  /** Canonical stored active flag — never treat missing field as true. */
  function readStoredIsActive(data) {
    if (!data || typeof data !== "object") return false;
    if (typeof data.isActive === "boolean") return data.isActive;
    if (typeof data.enabled === "boolean") return data.enabled;
    return false;
  }

  function normalizeContest(id, data) {
    const raw = data || {};
    const docId = String(id || "").trim();
    const isActive = readStoredIsActive(raw);
    const pastEnd = isPastEndDate(raw.endDate);
    const expired = raw.expired === true || pastEnd;
    const isLive = isActive && !pastEnd;
    let status = "disabled";
    if (pastEnd || raw.expired) status = "expired";
    else if (isActive) status = "live";

    return {
      id: docId,
      title: raw.title || "",
      description: raw.description || "",
      imageBase64: raw.imageBase64 || "",
      criteriaType: raw.criteriaType || "sales_count",
      advisorTarget: Number(raw.advisorTarget) || 0,
      managerTarget: Number(raw.managerTarget) || 0,
      startDate: raw.startDate || null,
      endDate: raw.endDate || null,
      isActive,
      expired,
      isLive,
      status,
      isPastEndDate: pastEnd,
      updatedAt: raw.updatedAt || null,
      createdAt: raw.createdAt || null,
    };
  }

  function getContestById(id) {
    return (window._contestsCache || []).find((c) => c.id === id) || null;
  }

  /** Resolve contest id from DOM — never trust inline handler args alone. */
  function resolveContestIdForToggle(contestId, inputEl) {
    let resolved = typeof contestId === "string" ? contestId.trim() : "";
    if (inputEl) {
      const fromInput = inputEl.getAttribute("data-contest-id");
      const fromRow = inputEl.closest("tr[data-contest-id]")?.getAttribute("data-contest-id");
      resolved = (fromInput || fromRow || resolved || "").trim();
    }
    return resolved;
  }

  function bindContestAdminListEvents() {
    const root = document.getElementById("contest-admin-list");
    if (!root || root.dataset.toggleBound === "1") return;
    root.dataset.toggleBound = "1";

    root.addEventListener(
      "change",
      (e) => {
        const input = e.target;
        if (!input?.classList?.contains("contest-row-active-toggle")) return;
        e.stopPropagation();
        const contestId = resolveContestIdForToggle("", input);
        if (!contestId) {
          console.error("[Contest] toggle missing contestId on row input");
          return;
        }
        window.toggleContestActive(contestId, input.checked, input);
      },
      true
    );

    root.addEventListener("click", (e) => {
      const btn = e.target.closest(".contest-table-edit-btn");
      if (!btn) return;
      e.preventDefault();
      const contestId = btn.closest("tr[data-contest-id]")?.getAttribute("data-contest-id");
      if (contestId) window.editContest(contestId);
    });
  }

  window.getLiveContests = function getLiveContests() {
    return (window._contestsCache || []).filter((c) => c.isLive);
  };

  window.getPrimaryLiveContest = function getPrimaryLiveContest() {
    const live = window.getLiveContests();
    if (!live.length) return null;
    return live.slice().sort((a, b) => {
      const ae = parseContestDate(a.endDate)?.getTime() || 0;
      const be = parseContestDate(b.endDate)?.getTime() || 0;
      return be - ae;
    })[0];
  };

  window.isContestEnabled = function isContestEnabled() {
    return window.getLiveContests().length > 0;
  };

  async function persistContestActive(contestId, isActive) {
    const id = typeof contestId === "string" ? contestId.trim() : "";
    if (!id) {
      showToast("Invalid contest — could not update status.", "error");
      return false;
    }
    const contest = getContestById(id);
    if (!contest) {
      showToast("Contest not found. Refresh the page and try again.", "error");
      return false;
    }
    if (isActive && contest.isPastEndDate) {
      showToast("Cannot enable an expired contest. Extend the end date first.", "error");
      return false;
    }
    await updateDoc(doc(db, "contest_settings", id), {
      isActive: !!isActive,
      enabled: deleteField(),
      updatedAt: serverTimestamp(),
      updatedBy: window._session?.displayName || window._session?.name || "admin",
    });
    return true;
  }

  async function processExpiredContests(contests) {
    const toExpire = contests.filter((c) => c.isActive && c.isPastEndDate);
    for (const c of toExpire) {
      if (_expiryWriteInFlight.has(c.id)) continue;
      _expiryWriteInFlight.add(c.id);
      try {
        await updateDoc(doc(db, "contest_settings", c.id), {
          isActive: false,
          expired: true,
          expiredAt: serverTimestamp(),
          enabled: deleteField(),
          updatedAt: serverTimestamp(),
        });
      } catch (err) {
        console.warn("[Contest] auto-expire failed:", c.id, err.message);
      } finally {
        _expiryWriteInFlight.delete(c.id);
      }
    }
  }

  function contestPeriodBounds(settings) {
    const start = parseContestDate(settings?.startDate);
    const end = endOfContestDay(parseContestDate(settings?.endDate));
    return { start, end };
  }

  function saleInContestPeriod(sale, settings) {
    if (!sale || sale.approvalStatus !== "approved") return false;
    const { start, end } = contestPeriodBounds(settings);
    const approved =
      typeof window.getSaleApprovedDate === "function"
        ? window.getSaleApprovedDate(sale)
        : null;
    const d = approved || parseContestDate(sale.saleDate) || parseContestDate(sale.submittedAt);
    if (!d) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  }

  function metricFromSales(sales, criteriaType) {
    if (criteriaType === "sales_amount") {
      return sales.reduce((sum, s) => sum + (Number(s.premiumAmount) || 0), 0);
    }
    return sales.length;
  }

  function formatMetric(value, criteriaType) {
    if (criteriaType === "sales_amount") {
      return "₹ " + Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
    }
    return String(value || 0);
  }

  function formatTarget(value, criteriaType) {
    return criteriaType === "sales_amount"
      ? formatMetric(value, criteriaType)
      : `${value || 0} sale${Number(value) === 1 ? "" : "s"}`;
  }

  function advisorChartColor(index) {
    return ADVISOR_CHART_COLORS[index % ADVISOR_CHART_COLORS.length];
  }

  function chartColorVars(color) {
    return `--contest-main:${color.main};--contest-light:${color.light};--contest-border:${color.border};--contest-fill:${color.fill};--contest-bar:${color.bar};`;
  }

  function getManagerDisplayName(managerId) {
    const session = window._session;
    if (session?.role === "manager" && session?.name) return session.name;
    const mgr = (window._managersCache || []).find((m) => m.id === managerId);
    return mgr?.name || mgr?.empId || session?.displayName || "Manager";
  }

  function emptyContestProgress() {
    return {
      advisors: [],
      managerTotal: 0,
      managerTarget: 0,
      managerPct: 0,
      managerGap: 0,
      managerAchieved: false,
      saleCount: 0,
      criteriaType: "sales_count",
    };
  }

  window.computeContestProgress = function computeContestProgress(settings, managerId, options) {
    const opts = options || {};
    const requireLive = opts.requireLive !== false;

    if (!settings || !managerId) return emptyContestProgress();
    if (requireLive && !settings.isLive) return emptyContestProgress();

    const criteriaType = settings.criteriaType || "sales_count";
    const advisorTarget = Number(settings.advisorTarget) || 0;
    const managerTarget = Number(settings.managerTarget) || 0;

    const scoped = (window._closedSalesCache || []).filter(
      (s) =>
        window.saleBelongsToManager?.(s, managerId) && saleInContestPeriod(s, settings)
    );

    const teamAdvisors = getAdvisorsForManager(managerId);

    const advisorRows = teamAdvisors.map((adv) => {
      const advSales = scoped.filter(
        (s) => s.advisorId === adv.id && s.isManagerDirectSale !== true
      );
      const current = metricFromSales(advSales, criteriaType);
      const pct = advisorTarget > 0 ? Math.min(100, (current / advisorTarget) * 100) : 0;
      return {
        id: adv.id,
        name: adv.name || adv.empId || "Advisor",
        current,
        target: advisorTarget,
        pct,
        achieved: advisorTarget > 0 && current >= advisorTarget,
        gap: Math.max(0, advisorTarget - current),
      };
    });

    const managerTotal = metricFromSales(scoped, criteriaType);
    const managerPct =
      managerTarget > 0 ? Math.min(100, (managerTotal / managerTarget) * 100) : 0;

    return {
      criteriaType,
      advisors: advisorRows,
      managerTotal,
      managerTarget,
      managerPct,
      managerAchieved: managerTarget > 0 && managerTotal >= managerTarget,
      managerGap: Math.max(0, managerTarget - managerTotal),
      saleCount: scoped.length,
    };
  };

  window.applyContestNavVisibility = function applyContestNavVisibility() {
    const nav = document.getElementById("nav-contest");
    const tile = document.getElementById("dash-card-contest");
    const liveDot = document.getElementById("dash-contest-live-dot");
    const isManager = window._session?.role === "manager";
    const blocked =
      typeof window.managerExamBlocksAccess === "function" &&
      window.managerExamBlocksAccess();
    const show = isManager && window.isContestEnabled() && !blocked;

    if (nav) nav.style.display = show ? "" : "none";
    if (tile) tile.classList.toggle("hidden", !show);
    if (liveDot) liveDot.classList.toggle("hidden", !show);

    if (show) window.updateContestDashboardTile?.();
    else {
      const pctEl = document.getElementById("dash-contest-pct");
      const subEl = document.getElementById("dash-contest-sub");
      if (pctEl) pctEl.textContent = "—";
      if (subEl) subEl.textContent = "Team progress";
    }
    window.applyContestAdminProgressTile?.();
  };

  window.updateContestDashboardTile = function updateContestDashboardTile() {
    if (window._session?.role !== "manager" || !window.isContestEnabled()) return;

    const contest = window.getPrimaryLiveContest();
    if (!contest) return;

    const managerId = window._session?.managerId;
    const progress = window.computeContestProgress(contest, managerId);
    const pctEl = document.getElementById("dash-contest-pct");
    const subEl = document.getElementById("dash-contest-sub");
    const live = window.getLiveContests();

    if (pctEl) pctEl.textContent = `${Math.round(progress.managerPct)}%`;
    if (subEl) {
      const suffix =
        live.length > 1 ? ` · ${live.length} active contests` : " · Tap for progress";
      subEl.textContent = progress.managerAchieved
        ? `${contest.title} · Target achieved`
        : `${contest.title}${suffix}`;
    }
  };

  function renderCylinderThemed(pct, achieved, size) {
    const h = Math.max(4, Math.min(100, pct));
    const fillCls = achieved ? "contest-cylinder-fill achieved" : "contest-cylinder-fill";
    const sizeCls = size === "lg" ? " contest-cylinder-lg" : "";
    return `<div class="contest-cylinder contest-cylinder-themed${sizeCls}" aria-hidden="true">
      <div class="${fillCls}" style="height:${h}%"></div>
      <div class="contest-cylinder-shine"></div>
    </div>`;
  }

  function renderProgressBarThemed(pct, achieved) {
    const w = Math.max(0, Math.min(100, pct));
    const barCls = achieved ? "contest-bar-fill achieved" : "contest-bar-fill";
    return `<div class="contest-bar-track contest-bar-themed"><div class="${barCls}" style="width:${w}%"></div></div>`;
  }

  function renderPersonChartCard(opts) {
    const { name, roleLabel, pct, achieved, current, target, criteriaType, color, large, gap } =
      opts;
    const status = achieved
      ? `<span class="contest-badge achieved">Target Achieved</span>`
      : `<span class="contest-badge gap">Gap: ${formatMetric(gap, criteriaType)}</span>`;

    return `<article class="contest-chart-card${large ? " contest-chart-card-lg" : ""}" style="${chartColorVars(color)}">
      <p class="contest-chart-role">${esc(roleLabel)}</p>
      <h4 class="contest-chart-name">${esc(name)}</h4>
      <div class="contest-chart-cylinder-wrap">
        ${renderCylinderThemed(pct, achieved, large ? "lg" : "md")}
        <p class="contest-chart-pct">${Math.round(pct)}%</p>
      </div>
      ${renderProgressBarThemed(pct, achieved)}
      <p class="contest-chart-metric">${formatMetric(current, criteriaType)} / ${formatTarget(target, criteriaType)}</p>
      <div class="mt-2">${status}</div>
    </article>`;
  }

  function renderProgressBar(pct, achieved) {
    const w = Math.max(0, Math.min(100, pct));
    const barCls = achieved ? "contest-bar-fill achieved" : "contest-bar-fill";
    return `<div class="contest-bar-track"><div class="${barCls}" style="width:${w}%"></div></div>`;
  }

  function renderSingleContestProgress(contest) {
    const managerId = window._session?.managerId;
    const managerName = getManagerDisplayName(managerId);
    const progress = window.computeContestProgress(contest, managerId);
    const criteriaType = contest.criteriaType || "sales_count";
    const criteriaLabel =
      criteriaType === "sales_amount" ? "Total Sales Amount" : "Number of Sales";
    const { start, end } = contestPeriodBounds(contest);
    const periodStr =
      start && end
        ? `${start.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} – ${end.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`
        : "Open period";

    const giftImg = contest.imageBase64
      ? `<img src="${contest.imageBase64}" alt="Contest prize" class="contest-prize-img" />`
      : `<div class="contest-prize-placeholder"><svg class="w-12 h-12 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v13m0-13V6a2 2 0 112 0v1m-2 0h4m-4 0a2 2 0 00-2 2v1a2 2 0 002 2h4a2 2 0 002-2v-1a2 2 0 00-2-2m-6 4h12"/></svg></div>`;

    const managerChart = renderPersonChartCard({
      name: managerName,
      roleLabel: "Manager",
      pct: progress.managerPct,
      achieved: progress.managerAchieved,
      current: progress.managerTotal,
      target: progress.managerTarget,
      criteriaType,
      color: MANAGER_CHART_COLOR,
      large: true,
      gap: progress.managerGap,
    });

    const advisorCharts = progress.advisors.length
      ? progress.advisors
          .map((a, i) =>
            renderPersonChartCard({
              name: a.name,
              roleLabel: "Advisor",
              pct: a.pct,
              achieved: a.achieved,
              current: a.current,
              target: a.target,
              criteriaType,
              color: advisorChartColor(i),
              large: false,
              gap: a.gap,
            })
          )
          .join("")
      : `<p class="text-sm text-gray-400 col-span-full text-center py-6">No advisors on your team yet.</p>`;

    return `<section class="contest-progress-block mb-12 pb-10 border-b border-gray-100 last:border-0 last:pb-0 last:mb-0">
      <div class="contest-hero-card">
        <div class="contest-hero-gift">${giftImg}</div>
        <div class="contest-hero-body">
          <h3 class="text-lg font-bold text-gray-900">${esc(contest.title || "Sales Contest")}</h3>
          <p class="text-sm text-gray-600 mt-1 whitespace-pre-wrap leading-relaxed">${esc(contest.description || "")}</p>
          <div class="flex flex-wrap gap-2 mt-3">
            <span class="contest-meta-pill">${esc(criteriaLabel)}</span>
            <span class="contest-meta-pill">${esc(periodStr)}</span>
            <span class="contest-meta-pill">${progress.saleCount} approved sale(s)</span>
          </div>
        </div>
      </div>
      <div class="mt-8">
        <h3 class="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4">Your Progress</h3>
        <div class="max-w-xs sm:max-w-sm mx-auto">${managerChart}</div>
      </div>
      <div class="mt-10">
        <h3 class="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4">Advisor Progress</h3>
        <div class="contest-charts-grid">${advisorCharts}</div>
      </div>
    </section>`;
  }

  window.renderContestPage = function renderContestPage() {
    const root = document.getElementById("contest-manager-root");
    if (!root || window._session?.role !== "manager") return;

    const live = window.getLiveContests();
    if (!live.length) {
      root.innerHTML = `<div class="text-center py-16 text-gray-400 text-sm">No active contest at the moment.</div>`;
      return;
    }

    root.innerHTML = live.map((c) => renderSingleContestProgress(c)).join("");
    window.updateContestDashboardTile?.();
  };

  function statusBadge(contest) {
    if (contest.status === "live") {
      return `<span class="contest-status-badge contest-status-live">Live</span>`;
    }
    if (contest.status === "expired") {
      return `<span class="contest-status-badge contest-status-expired">Expired</span>`;
    }
    return `<span class="contest-status-badge contest-status-disabled">Disabled</span>`;
  }

  function formatContestDates(contest) {
    const start = parseContestDate(contest.startDate);
    const end = parseContestDate(contest.endDate);
    if (!start && !end) return "No dates set";
    const fmt = (d) =>
      d ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    return `${fmt(start)} – ${fmt(end)}`;
  }

  function sortContestsForAdmin(a, b) {
    const statusOrder = { live: 0, disabled: 1, expired: 2 };
    const sa = statusOrder[a.status] ?? 9;
    const sb = statusOrder[b.status] ?? 9;
    if (sa !== sb) return sa - sb;
    const au =
      parseContestDate(a.createdAt || a.updatedAt)?.getTime() ||
      parseContestDate(a.endDate)?.getTime() ||
      0;
    const bu =
      parseContestDate(b.createdAt || b.updatedAt)?.getTime() ||
      parseContestDate(b.endDate)?.getTime() ||
      0;
    return bu - au;
  }

  const _contestToggleInFlight = new Set();

  window.renderContestAdminList = function renderContestAdminList() {
    const root = document.getElementById("contest-admin-list");
    if (!root || window._session?.role !== "admin") return;

    bindContestAdminListEvents();

    const contests = (window._contestsCache || []).slice().sort(sortContestsForAdmin);
    if (!contests.length) {
      root.innerHTML = `<p class="text-sm text-gray-400 py-4">No contests yet. Click <strong>Add New Contest</strong> to create one.</p>`;
      return;
    }

    root.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm contest-admin-table">
            <thead>
              <tr class="bg-gray-50 border-b border-gray-100 text-left">
                <th class="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Contest</th>
                <th class="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Period</th>
                <th class="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th class="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-center">Active</th>
                <th class="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              ${contests
                .map((c) => {
                  const contestId = String(c.id || "").trim();
                  if (!contestId) return "";
                  const selected = contestId === window._selectedContestId;
                  const toggleDisabled = c.isPastEndDate ? "disabled" : "";
                  const rowCls = selected ? "contest-table-row selected" : "contest-table-row";
                  const toggleTitle = c.isPastEndDate
                    ? "Expired — extend end date to re-enable"
                    : `Enable or disable ${c.title || "contest"}`;
                  return `<tr class="${rowCls}" data-contest-id="${esc(contestId)}">
                    <td class="px-4 py-3">
                      <p class="font-semibold text-gray-900">${esc(c.title || "Untitled Contest")}</p>
                      <p class="text-xs text-gray-400 mt-0.5 truncate max-w-[14rem]">${esc(c.description || "—")}</p>
                    </td>
                    <td class="px-4 py-3 text-gray-600 whitespace-nowrap">${esc(formatContestDates(c))}</td>
                    <td class="px-4 py-3">${statusBadge(c)}</td>
                    <td class="px-4 py-3 text-center">
                      <label class="contest-toggle contest-toggle-sm inline-flex" title="${esc(toggleTitle)}">
                        <input type="checkbox"
                          class="contest-row-active-toggle"
                          data-contest-id="${esc(contestId)}"
                          aria-label="${esc(`Active toggle for ${c.title || "contest"}`)}"
                          ${c.isActive ? "checked" : ""} ${toggleDisabled} />
                        <span class="contest-toggle-slider" aria-hidden="true"></span>
                      </label>
                    </td>
                    <td class="px-4 py-3 text-right whitespace-nowrap">
                      <button type="button" class="contest-table-edit-btn"
                        data-contest-id="${esc(contestId)}">Edit</button>
                    </td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
        <p class="text-xs text-gray-400 px-4 py-2 border-t border-gray-100">${contests.length} contest(s) · sorted by status, then newest</p>
      </div>`;
  };

  window.editContest = function editContest(contestId) {
    window.selectContest(contestId);
    document.getElementById("contest-editor-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  function bindContestEditorDirtyTracking() {
    const panel = document.getElementById("contest-editor-panel");
    if (!panel || panel.dataset.bound === "1") return;
    panel.dataset.bound = "1";
    panel.addEventListener("input", () => {
      window._contestFormDirty = true;
    });
    panel.addEventListener("change", (e) => {
      if (e.target.id === "contest-editor-active-toggle") return;
      window._contestFormDirty = true;
    });
  }

  window.selectContest = function selectContest(contestId) {
    if (window._session?.role !== "admin") return;
    window._selectedContestId = contestId;
    window._contestFormDirty = false;
    window._pendingContestImages[contestId] = undefined;
    window.populateContestEditor(contestId);
    window.renderContestAdminList();
  };

  window.populateContestEditor = function populateContestEditor(contestId) {
    if (window._session?.role !== "admin") return;
    const c = getContestById(contestId);
    const panel = document.getElementById("contest-editor-panel");
    const empty = document.getElementById("contest-editor-empty");

    if (!c) {
      panel?.classList.add("hidden");
      empty?.classList.remove("hidden");
      return;
    }

    panel?.classList.remove("hidden");
    empty?.classList.add("hidden");
    if (panel) panel.dataset.editingContestId = contestId;

    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v ?? "";
    };
    const toggle = document.getElementById("contest-editor-active-toggle");
    if (toggle) {
      toggle.dataset.contestId = contestId;
      toggle.checked = c.isActive === true;
      toggle.disabled = c.isPastEndDate;
    }

    setVal("contest-title", c.title);
    setVal("contest-description", c.description);
    setVal("contest-advisor-target", c.advisorTarget || "");
    setVal("contest-manager-target", c.managerTarget || "");

    document.querySelectorAll('input[name="contest-criteria"]').forEach((r) => {
      r.checked = r.value === (c.criteriaType || "sales_count");
    });

    const start = parseContestDate(c.startDate);
    const end = parseContestDate(c.endDate);
    setVal("contest-start-date", start ? start.toISOString().slice(0, 10) : "");
    setVal("contest-end-date", end ? end.toISOString().slice(0, 10) : "");

    const preview = document.getElementById("contest-image-preview");
    const placeholder = document.getElementById("contest-image-placeholder");
    const clearBtn = document.getElementById("contest-image-clear");
    const imgSrc = window._pendingContestImages[c.id] ?? c.imageBase64;

    if (imgSrc && preview) {
      preview.src = imgSrc;
      preview.classList.remove("hidden");
      placeholder?.classList.add("hidden");
      clearBtn?.classList.remove("hidden");
    } else {
      preview?.classList.add("hidden");
      placeholder?.classList.remove("hidden");
      clearBtn?.classList.add("hidden");
    }

    const statusEl = document.getElementById("contest-editor-status");
    if (statusEl) {
      if (c.status === "live") {
        statusEl.textContent = "Live — visible to managers";
        statusEl.className = "text-xs font-semibold uppercase tracking-wide text-emerald-600";
      } else if (c.status === "expired") {
        statusEl.textContent = "Expired — disabled automatically after end date";
        statusEl.className = "text-xs font-semibold uppercase tracking-wide text-amber-600";
      } else {
        statusEl.textContent = "Disabled — hidden from managers";
        statusEl.className = "text-xs font-semibold uppercase tracking-wide text-gray-400";
      }
    }
  };

  window.renderContestAdminPanel = function renderContestAdminPanel() {
    if (window._session?.role !== "admin") return;
    bindContestAdminListEvents();
    bindContestEditorDirtyTracking();
    window.renderContestAdminList();
    if (window._selectedContestId) {
      window.populateContestEditor(window._selectedContestId);
    } else if ((window._contestsCache || []).length) {
      /* Do not auto-select — let admin pick from list or add new */
      document.getElementById("contest-editor-panel")?.classList.add("hidden");
      document.getElementById("contest-editor-empty")?.classList.remove("hidden");
    } else {
      document.getElementById("contest-editor-panel")?.classList.add("hidden");
      document.getElementById("contest-editor-empty")?.classList.remove("hidden");
    }
  };

  window.toggleContestActive = async function toggleContestActive(contestId, isActive, inputEl) {
    if (window._session?.role !== "admin") return;

    const resolvedId = resolveContestIdForToggle(contestId, inputEl);
    if (!resolvedId) {
      console.error("[Contest] toggle rejected — no contestId");
      if (inputEl) inputEl.checked = !isActive;
      showToast("Could not identify which contest to update.", "error");
      return;
    }

    const contest = getContestById(resolvedId);
    if (!contest) {
      console.error("[Contest] toggle rejected — unknown contestId:", resolvedId);
      if (inputEl) inputEl.checked = !isActive;
      showToast("Contest not found. Refresh and try again.", "error");
      return;
    }

    if (_contestToggleInFlight.has(resolvedId)) {
      if (inputEl) inputEl.checked = !isActive;
      return;
    }
    _contestToggleInFlight.add(resolvedId);

    try {
      const ok = await persistContestActive(resolvedId, isActive);
      if (!ok && inputEl) inputEl.checked = !isActive;
      else showToast(isActive ? "Contest enabled." : "Contest disabled.", "success");
    } catch (err) {
      console.error("[Contest] toggle failed:", err, { contestId: resolvedId });
      if (inputEl) inputEl.checked = !isActive;
      showToast("Could not update contest status.", "error");
    } finally {
      _contestToggleInFlight.delete(resolvedId);
    }
  };

  window.handleContestActiveToggle = async function handleContestActiveToggle(e) {
    const panel = document.getElementById("contest-editor-panel");
    const toggle = e?.target;
    const id =
      toggle?.getAttribute("data-contest-id") ||
      panel?.dataset?.editingContestId ||
      window._selectedContestId;
    if (!id) {
      if (toggle) toggle.checked = false;
      return;
    }
    await window.toggleContestActive(id, toggle.checked, toggle);
  };

  window.addNewContest = async function addNewContest() {
    if (window._session?.role !== "admin") return;
    const btn = document.getElementById("btn-add-contest");
    if (btn) btn.disabled = true;
    try {
      const ref = await addDoc(CONTESTS_COL, {
        title: "New Contest",
        description: "",
        isActive: false,
        expired: false,
        criteriaType: "sales_count",
        advisorTarget: 0,
        managerTarget: 0,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedBy: window._session?.displayName || window._session?.name || "admin",
      });
      window._contestFormDirty = false;
      window.selectContest(ref.id);
      showToast("New contest created. Fill in the details and save.", "success");
    } catch (err) {
      console.error("[Contest] add failed:", err);
      showToast("Could not create contest.", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  window.handleContestImageSelect = function handleContestImageSelect(e) {
    const id = window._selectedContestId;
    if (!id) return;
    const file = e.target.files?.[0];
    const errEl = document.getElementById("err-contest-image");
    if (!file) return;
    if (file.size > 900 * 1024) {
      if (errEl) {
        errEl.textContent = "Image must be under 900 KB.";
        errEl.classList.remove("hidden");
      }
      e.target.value = "";
      return;
    }
    if (errEl) errEl.classList.add("hidden");
    const reader = new FileReader();
    reader.onload = () => {
      window._pendingContestImages[id] = reader.result;
      window._contestFormDirty = true;
      const preview = document.getElementById("contest-image-preview");
      const placeholder = document.getElementById("contest-image-placeholder");
      const clearBtn = document.getElementById("contest-image-clear");
      if (preview) {
        preview.src = reader.result;
        preview.classList.remove("hidden");
      }
      placeholder?.classList.add("hidden");
      clearBtn?.classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  };

  window.clearContestImageDraft = function clearContestImageDraft() {
    const id = window._selectedContestId;
    if (!id) return;
    window._pendingContestImages[id] = "";
    window._contestFormDirty = true;
    const input = document.getElementById("contest-image-input");
    if (input) input.value = "";
    document.getElementById("contest-image-preview")?.classList.add("hidden");
    document.getElementById("contest-image-placeholder")?.classList.remove("hidden");
    document.getElementById("contest-image-clear")?.classList.add("hidden");
  };

  window.saveContestSettings = async function saveContestSettings() {
    if (window._session?.role !== "admin") {
      showToast("Only administrators can manage contests.", "error");
      return;
    }
    const contestId = window._selectedContestId;
    if (!contestId) {
      showToast("Select or create a contest first.", "error");
      return;
    }

    const title = (document.getElementById("contest-title")?.value || "").trim();
    const description = (document.getElementById("contest-description")?.value || "").trim();
    const advisorTarget = parseFloat(document.getElementById("contest-advisor-target")?.value);
    const managerTarget = parseFloat(document.getElementById("contest-manager-target")?.value);
    const isActive = document.getElementById("contest-editor-active-toggle")?.checked === true;
    const criteriaEl = document.querySelector('input[name="contest-criteria"]:checked');
    const criteriaType = criteriaEl?.value || "sales_count";
    const startStr = document.getElementById("contest-start-date")?.value || "";
    const endStr = document.getElementById("contest-end-date")?.value || "";

    if (!title) {
      showToast("Contest title is required.", "error");
      return;
    }
    if (!Number.isFinite(advisorTarget) || advisorTarget <= 0) {
      showToast("Enter a valid Advisor Target greater than zero.", "error");
      return;
    }
    if (!Number.isFinite(managerTarget) || managerTarget <= 0) {
      showToast("Enter a valid Manager Target greater than zero.", "error");
      return;
    }
    if (!startStr || !endStr) {
      showToast("Contest start and end dates are required.", "error");
      return;
    }
    const startDate = new Date(startStr + "T00:00:00");
    const endDate = new Date(endStr + "T23:59:59");
    if (endDate < startDate) {
      showToast("End date must be on or after start date.", "error");
      return;
    }

    if (isActive && Date.now() > endDate.getTime()) {
      showToast("Cannot enable a contest whose end date has already passed.", "error");
      return;
    }

    const existing = getContestById(contestId);
    let imageBase64 = existing?.imageBase64 || "";
    if (window._pendingContestImages[contestId] !== undefined) {
      imageBase64 = window._pendingContestImages[contestId];
    }

    const btn = document.getElementById("btn-save-contest");
    const spinner = document.getElementById("contest-save-spinner");
    if (btn) btn.disabled = true;
    spinner?.classList.remove("hidden");

    try {
      const payload = {
        title,
        description,
        criteriaType,
        advisorTarget,
        managerTarget,
        isActive: !!isActive,
        imageBase64: imageBase64 || "",
        startDate,
        endDate,
        enabled: deleteField(),
        updatedAt: serverTimestamp(),
        updatedBy: window._session?.displayName || window._session?.name || "admin",
      };
      if (isPastEndDate(endDate)) {
        payload.expired = true;
      } else {
        payload.expired = false;
        payload.expiredAt = deleteField();
      }
      await updateDoc(doc(db, "contest_settings", contestId), payload);
      delete window._pendingContestImages[contestId];
      window._contestFormDirty = false;
      showToast(isActive ? "Contest saved and enabled." : "Contest saved (disabled).", "success");
    } catch (err) {
      console.error("[Contest] save failed:", err);
      showToast("Could not save contest.", "error");
    } finally {
      if (btn) btn.disabled = false;
      spinner?.classList.add("hidden");
    }
  };

  window.renderContestAdminLeaderboard = function renderContestAdminLeaderboard() {
    /* Legacy hook */
  };

  window.deleteContestSettings = async function deleteContestSettings() {
    if (window._session?.role !== "admin") return;
    const contestId = window._selectedContestId;
    if (!contestId) {
      showToast("Select a contest to delete.", "error");
      return;
    }
    const c = getContestById(contestId);
    if (!window.confirm(`Delete contest "${c?.title || contestId}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteDoc(doc(db, "contest_settings", contestId));
      delete window._pendingContestImages[contestId];
      window._contestFormDirty = false;
      if (window._selectedContestId === contestId) {
        window._selectedContestId = null;
      }
      showToast("Contest deleted.", "success");
    } catch (err) {
      console.error("[Contest] delete failed:", err);
      showToast("Could not delete contest.", "error");
    }
  };

  function contestsFromSnapshot(snap) {
    return snap.docs
      .map((d) => normalizeContest(d.id, d.data()))
      .filter((c) => c.id)
      .sort(sortContestsForAdmin);
  }

  bindContestAdminListEvents();

  onSnapshot(
    CONTESTS_COL,
    async (snap) => {
      const contests = contestsFromSnapshot(snap);
      await processExpiredContests(contests);

      window._contestsCache = contests;
      window._contestsCacheReady = true;
      console.log("[Contest] snapshot loaded", { count: contests.length, ids: contests.map((c) => c.id) });

      if (
        window._selectedContestId &&
        !contests.find((c) => c.id === window._selectedContestId)
      ) {
        window._selectedContestId = contests[0]?.id || null;
        window._contestFormDirty = false;
      }

      window.applyContestNavVisibility?.();
      window.updateContestDashboardTile?.();

      if (document.getElementById("section-contest-setup")?.classList.contains("active")) {
        window.renderContestAdminList?.();
        if (!window._contestFormDirty && window._selectedContestId) {
          window.populateContestEditor?.(window._selectedContestId);
        }
      }

      if (document.getElementById("section-contest-progress")?.classList.contains("active")) {
        window._contestProgressLastRenderKey = "";
        window.scheduleContestProgressRender?.();
      }

      if (document.getElementById("section-contest")?.classList.contains("active")) {
        if (!window.isContestEnabled() && window._session?.role === "manager") {
          if (typeof window.navigateToSection === "function") window.navigateToSection("dashboard");
          else if (typeof showSection === "function") showSection("dashboard");
        } else {
          window.renderContestPage?.();
        }
      }
    },
    (err) => {
      window._contestsCacheReady = true;
      console.warn("[Contest] listener error:", err.message);
      if (document.getElementById("section-contest-progress")?.classList.contains("active")) {
        window._contestProgressLastRenderKey = "";
        window.scheduleContestProgressRender?.();
      }
    }
  );
};
