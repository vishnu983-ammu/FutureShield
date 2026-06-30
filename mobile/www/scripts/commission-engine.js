"use strict";

/**
 * FutureShield — Commission reporting engine (pure logic, no I/O).
 * API params: fromDate, toDate (YYYY-MM), role, managerId, advisorId, viewMode
 */

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const VIEW_MODES = {
  ALL_COMBINED: "all_combined",
  ALL_MANAGERS: "all_managers",
  MANAGER_INDIVIDUAL: "manager_individual",
  MANAGER_TEAM: "manager_team",
  ALL_ADVISORS: "all_advisors",
  ADVISOR_INDIVIDUAL: "advisor_individual",
};

function toDate(val) {
  if (!val) return null;
  if (typeof val.toDate === "function") return val.toDate();
  if (val instanceof Date) return val;
  if (val.seconds) return new Date(val.seconds * 1000);
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthKeyFromDate(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonthKey(key) {
  const m = String(key || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}` };
}

function formatMonthLabel(key) {
  const p = parseMonthKey(key);
  if (!p) return key || "";
  return `${MONTH_NAMES[p.month - 1]} ${p.year}`;
}

function monthKeysInRange(fromMonth, toMonth) {
  const from = parseMonthKey(fromMonth);
  const to = parseMonthKey(toMonth);
  if (!from || !to) return [];
  let y = from.year;
  let m = from.month;
  const endY = to.year;
  const endM = to.month;
  const keys = [];
  while (y < endY || (y === endY && m <= endM)) {
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (keys.length > 120) break;
  }
  return keys;
}

function resolveMonthRange(fromMonth, toMonth) {
  let from = parseMonthKey(fromMonth);
  let to = parseMonthKey(toMonth);
  if (!from || !to) {
    const now = new Date();
    const cur = monthKeyFromDate(now);
    from = parseMonthKey(cur);
    to = from;
  }
  if (from.key > to.key) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  const start = new Date(from.year, from.month - 1, 1);
  const end = new Date(to.year, to.month, 0, 23, 59, 59, 999);
  const monthKeys = monthKeysInRange(from.key, to.key);
  const label = from.key === to.key
    ? formatMonthLabel(from.key)
    : `${formatMonthLabel(from.key)} – ${formatMonthLabel(to.key)}`;
  return { start, end, label, fromMonth: from.key, toMonth: to.key, monthKeys };
}

function saleApprovedDate(sale) {
  return toDate(sale?.approvedAt) || toDate(sale?.saleDate) || toDate(sale?.submittedAt);
}

function saleMonthKey(sale) {
  if (sale?.commissionMonthKey && parseMonthKey(sale.commissionMonthKey)) {
    return sale.commissionMonthKey;
  }
  const d = saleApprovedDate(sale);
  return d ? monthKeyFromDate(d) : null;
}

function saleInMonthRange(sale, fromMonth, toMonth) {
  if (sale?.approvalStatus !== "approved") return false;
  const range = resolveMonthRange(fromMonth, toMonth);
  const mk = saleMonthKey(sale);
  if (mk && range.monthKeys.includes(mk)) return true;
  const d = saleApprovedDate(sale);
  if (!d) return false;
  return d >= range.start && d <= range.end;
}

function saleBelongsToManager(sale, managerId) {
  if (!sale || !managerId) return false;
  if ((sale.managerId || "") === managerId) return true;
  if ((sale.ownerManagerId || "") === managerId) return true;
  return false;
}

function getCommissionValues(sale, computeFn) {
  if (typeof computeFn === "function") return computeFn(sale);
  const advisor = Number(sale.advisorCommission) || Number(sale.estAdvisorCommission) || 0;
  const manager = Number(sale.managerCommission) || Number(sale.estManagerCommission) || 0;
  return { advisor, manager, total: advisor + manager };
}

function getSalePremium(sale) {
  return Number(sale?.premiumAmount) || 0;
}

function advisorBelongsToManagerRecord(advisor, managerId) {
  if (!advisor || !managerId) return false;
  return (advisor.managerId || "") === managerId;
}

function resolveAdvisorRecordKey(sale, catalog) {
  if (sale?.advisorId) return sale.advisorId;
  const name = String(sale?.advisorName || "").trim().toLowerCase();
  if (name && Array.isArray(catalog)) {
    const match = catalog.find(a => String(a?.name || "").trim().toLowerCase() === name);
    if (match?.id) return match.id;
  }
  if (sale?.advisorName) return sale.advisorName;
  return "unknown";
}

function resolveAdvisorDisplayName(sale, catalog, key) {
  if (sale?.advisorName) return sale.advisorName;
  if (Array.isArray(catalog)) {
    const match = catalog.find(a => a.id === key || a.id === sale?.advisorId);
    if (match?.name) return match.name;
  }
  return key === "unknown" ? "Unknown Advisor" : key;
}

function shouldAttributeSaleToAdvisor(sale, comm) {
  if (sale?.advisorId || sale?.advisorName) return true;
  if ((comm?.advisor || 0) > 0 && !sale?.isManagerDirectSale) return true;
  if ((comm?.advisor || 0) > 0 && sale?.isManagerDirectSale) return true;
  return false;
}

function currentAndPreviousMonthKeys(now) {
  const ref = now instanceof Date ? now : new Date();
  const cur = monthKeyFromDate(ref);
  const prev = monthKeyFromDate(new Date(ref.getFullYear(), ref.getMonth() - 1, 1));
  return new Set([cur, prev]);
}

/** Map API + legacy params to canonical shape. */
function normalizeReportOpts(raw) {
  const fromDate = raw.fromDate || raw.fromMonth;
  const toDate = raw.toDate || raw.toMonth;
  const filterRole = raw.role === "all" || raw.filterRole === "all"
    ? "all"
    : (raw.filterRole === "advisor" || raw.role === "advisor" ? "advisor" : "manager");
  let managerId = raw.managerId || null;
  let advisorId = raw.advisorId || null;
  let viewMode = raw.viewMode || null;

  if (filterRole === "all") {
    viewMode = VIEW_MODES.ALL_COMBINED;
  }

  if (!viewMode) {
    const scope = raw.scopeType || "all";
    if (filterRole === "manager") {
      if (!managerId && raw.userId) managerId = raw.userId;
      if (scope === "team" && managerId) viewMode = VIEW_MODES.MANAGER_TEAM;
      else if (scope === "individual" && managerId) viewMode = VIEW_MODES.MANAGER_INDIVIDUAL;
      else if (managerId) viewMode = VIEW_MODES.MANAGER_TEAM;
      else viewMode = VIEW_MODES.ALL_MANAGERS;
    } else {
      if (!managerId && raw.parentManagerId) managerId = raw.parentManagerId;
      if (!advisorId && raw.userId) advisorId = raw.userId;
      viewMode = advisorId ? VIEW_MODES.ADVISOR_INDIVIDUAL : VIEW_MODES.ALL_ADVISORS;
    }
  }

  if (managerId === "all" || managerId === "") managerId = null;
  if (advisorId === "all" || advisorId === "") advisorId = null;

  const range = resolveMonthRange(fromDate, toDate);
  return {
    fromDate: range.fromMonth,
    toDate: range.toMonth,
    fromMonth: range.fromMonth,
    toMonth: range.toMonth,
    role: filterRole,
    managerId,
    advisorId,
    viewMode,
    sessionRole: raw.sessionRole || "admin",
    sessionManagerId: raw.sessionManagerId || null,
    now: raw.now,
    getCommissionValues: raw.getCommissionValues,
    managerCatalog: Array.isArray(raw.managerCatalog) ? raw.managerCatalog : [],
    advisorCatalog: Array.isArray(raw.advisorCatalog) ? raw.advisorCatalog : [],
  };
}

function assertSessionAccess(opts) {
  const sessionRole = opts.sessionRole;
  if (sessionRole !== "manager") return null;
  const mgrId = opts.sessionManagerId;
  if (!mgrId) return "Manager session required.";

  const allowed = currentAndPreviousMonthKeys(opts.now);
  const range = resolveMonthRange(opts.fromDate, opts.toDate);
  if (range.monthKeys.some(k => !allowed.has(k))) {
    return "Managers may only view current month or previous month data.";
  }
  if (opts.managerId && opts.managerId !== mgrId) {
    return "Managers cannot view another manager's commission data.";
  }
  if (opts.role === "advisor" && opts.managerId && opts.managerId !== mgrId) {
    return "Managers cannot view advisors outside their team.";
  }
  return null;
}

function filterSales(sales, opts) {
  const range = resolveMonthRange(opts.fromDate, opts.toDate);
  let list = (sales || []).filter(s => saleInMonthRange(s, range.fromMonth, range.toMonth));

  if (opts.sessionRole === "manager" && opts.sessionManagerId) {
    list = list.filter(s => saleBelongsToManager(s, opts.sessionManagerId));
  }

  const { viewMode, managerId, advisorId } = opts;

  if (viewMode === VIEW_MODES.ALL_COMBINED || viewMode === VIEW_MODES.ALL_MANAGERS) {
    /* no hierarchy filter */
  } else if (viewMode === VIEW_MODES.MANAGER_INDIVIDUAL || viewMode === VIEW_MODES.MANAGER_TEAM) {
    if (managerId) list = list.filter(s => saleBelongsToManager(s, managerId));
  } else if (viewMode === VIEW_MODES.ALL_ADVISORS) {
    if (managerId) list = list.filter(s => saleBelongsToManager(s, managerId));
  } else if (viewMode === VIEW_MODES.ADVISOR_INDIVIDUAL) {
    if (managerId) list = list.filter(s => saleBelongsToManager(s, managerId));
    if (advisorId) list = list.filter(s => (s.advisorId || "") === advisorId);
  }

  return { range, sales: list };
}

function aggregateCommissionReport(sales, opts) {
  const computeFn = opts?.getCommissionValues;
  const catalog = opts?.advisorCatalog || [];
  const byAdvisor = new Map();
  const byManager = new Map();
  let totalAdvisor = 0;
  let totalManager = 0;
  let saleCount = 0;

  sales.forEach(sale => {
    const comm = getCommissionValues(sale, computeFn);
    saleCount++;
    totalAdvisor += comm.advisor;
    totalManager += comm.manager;

    if (shouldAttributeSaleToAdvisor(sale, comm)) {
      const advId = resolveAdvisorRecordKey(sale, catalog);
      const advName = resolveAdvisorDisplayName(sale, catalog, advId);
      const row = byAdvisor.get(advId) || {
        id: advId, name: advName,
        advisorCommission: 0, managerCommission: 0, total: 0,
        salesCount: 0, salesAmount: 0,
      };
      row.advisorCommission += comm.advisor;
      row.managerCommission += comm.manager;
      row.total += comm.advisor;
      row.salesCount++;
      row.salesAmount += getSalePremium(sale);
      if (advName && advName !== "Unknown Advisor") row.name = advName;
      byAdvisor.set(advId, row);
    }

    const mgrKey = sale.managerId || sale.managerName || "unassigned";
    const mgrName = sale.managerName || "Unassigned";
    const mRow = byManager.get(mgrKey) || {
      id: mgrKey, name: mgrName,
      advisorCommission: 0, managerCommission: 0, total: 0,
      salesCount: 0, salesAmount: 0,
    };
    mRow.advisorCommission += comm.advisor;
    mRow.managerCommission += comm.manager;
    mRow.total += comm.total;
    mRow.salesCount++;
    mRow.salesAmount += getSalePremium(sale);
    byManager.set(mgrKey, mRow);
  });

  return {
    summary: {
      totalCommission: totalAdvisor + totalManager,
      totalAdvisorCommission: totalAdvisor,
      totalManagerCommission: totalManager,
      teamIncentive: totalAdvisor + totalManager,
      saleCount,
    },
    advisors: Array.from(byAdvisor.values()).sort((a, b) => b.advisorCommission - a.advisorCommission),
    managers: Array.from(byManager.values()).sort((a, b) => b.total - a.total),
  };
}

function buildAdvisorRowsFromSales(sales, opts) {
  const computeFn = opts?.getCommissionValues;
  const catalog = opts?.advisorCatalog || [];
  const byAdvisor = new Map();

  (sales || []).forEach(sale => {
    const comm = getCommissionValues(sale, computeFn);
    if (!shouldAttributeSaleToAdvisor(sale, comm)) return;
    const advId = resolveAdvisorRecordKey(sale, catalog);
    const advName = resolveAdvisorDisplayName(sale, catalog, advId);
    const row = byAdvisor.get(advId) || {
      id: advId, name: advName,
      advisorCommission: 0, managerCommission: 0, total: 0,
      salesCount: 0, salesAmount: 0,
    };
    row.advisorCommission += comm.advisor;
    row.salesCount++;
    row.salesAmount += getSalePremium(sale);
    row.total += comm.advisor;
    if (advName && advName !== "Unknown Advisor") row.name = advName;
    byAdvisor.set(advId, row);
  });

  return Array.from(byAdvisor.values())
    .map(toAdvisorOnlyRow)
    .sort((a, b) => b.advisorCommission - a.advisorCommission);
}

function toAdvisorOnlyRow(row) {
  const adv = row.advisorCommission || 0;
  return {
    ...row,
    rowType: "Advisor",
    advisorCommission: adv,
    managerCommission: 0,
    salesAmount: row.salesAmount || 0,
    total: adv,
  };
}

function toManagerOnlyRow(row) {
  const mgr = row.managerCommission || 0;
  return {
    ...row,
    rowType: "Manager",
    advisorCommission: 0,
    managerCommission: mgr,
    salesAmount: row.salesAmount || 0,
    total: mgr,
  };
}

function toManagerBreakdownRow(row) {
  const adv = row.advisorCommission || 0;
  const mgr = row.managerCommission || 0;
  return {
    ...row,
    rowType: "Manager",
    advisorCommission: adv,
    managerCommission: mgr,
    salesAmount: row.salesAmount || 0,
    total: adv + mgr,
  };
}

function mergeManagerCatalogRows(aggregatedManagers, catalog) {
  const list = (catalog || []).filter(m => m && !m.disabled);
  if (!list.length) return aggregatedManagers.map(toManagerBreakdownRow);
  const byId = new Map((aggregatedManagers || []).map(m => [m.id, m]));
  const rows = list.map(m => {
    const agg = byId.get(m.id);
    return toManagerBreakdownRow(agg || {
      id: m.id,
      name: m.name || m.empId || "Manager",
      advisorCommission: 0,
      managerCommission: 0,
      salesAmount: 0,
      salesCount: 0,
      total: 0,
    });
  });
  (aggregatedManagers || []).forEach(m => {
    const isExtra = m.id === "unassigned" || m.name === "Unassigned";
    if (isExtra && !rows.some(r => r.id === m.id)) {
      rows.push(toManagerBreakdownRow(m));
    }
  });
  return rows.sort((a, b) => b.total - a.total);
}

function mergeAdvisorCatalogRows(aggregatedAdvisors, catalog, managerId) {
  const aggRows = (aggregatedAdvisors || []).map(toAdvisorOnlyRow);
  const byId = new Map(aggRows.map(a => [a.id, a]));
  const byName = new Map(
    aggRows.map(a => [String(a.name || "").trim().toLowerCase(), a])
  );

  const mergeRow = (advisor, existing) => toAdvisorOnlyRow(existing || {
    id: advisor.id,
    name: advisor.name || "Advisor",
    advisorCommission: 0,
    managerCommission: 0,
    salesAmount: 0,
    salesCount: 0,
    total: 0,
  });

  if (!managerId) return aggRows;

  const team = (catalog || []).filter(a => a && !a.disabled && advisorBelongsToManagerRecord(a, managerId));

  if (!team.length) {
    return aggRows.length ? aggRows : [];
  }

  const merged = new Map();
  team.forEach(a => {
    const existing = byId.get(a.id)
      || byName.get(String(a.name || "").trim().toLowerCase())
      || null;
    merged.set(a.id, mergeRow(a, existing));
  });

  aggRows.forEach(row => {
    if (!merged.has(row.id)) {
      merged.set(row.id, row);
    }
  });

  return Array.from(merged.values()).sort((a, b) => b.advisorCommission - a.advisorCommission);
}

function buildRows(report, opts, filteredSales) {
  const { viewMode, managerId, advisorId } = opts;
  const managers = report.managers || [];
  const advisors = report.advisors || [];

  if (viewMode === VIEW_MODES.ALL_COMBINED) {
    const rows = [
      ...managers.map(m => ({ ...toManagerOnlyRow(m), name: `${m.name} (Manager)` })),
      ...advisors.map(a => ({ ...toAdvisorOnlyRow(a), name: `${a.name} (Advisor)` })),
    ];
    return {
      title: "All managers & advisors (consolidated)",
      rows,
      showTeamTotal: true,
      hideManagerColumn: false,
      hideAdvisorColumn: false,
      advisorOnlySummary: false,
      managerOnlySummary: false,
      showTypeColumn: true,
    };
  }
  if (viewMode === VIEW_MODES.ALL_MANAGERS) {
    const rows = mergeManagerCatalogRows(managers, opts.managerCatalog);
    return {
      title: "All managers — team breakdown",
      rows,
      showTeamTotal: true,
      hideManagerColumn: false,
      hideAdvisorColumn: false,
      advisorOnlySummary: false,
      managerOnlySummary: false,
      showTypeColumn: false,
      showSalesAmount: true,
    };
  }
  if (viewMode === VIEW_MODES.MANAGER_INDIVIDUAL) {
    const rows = managerId ? managers.filter(m => m.id === managerId).map(toManagerOnlyRow) : managers.map(toManagerOnlyRow);
    return {
      title: "Individual manager — incentive earned",
      rows,
      showTeamTotal: false,
      hideManagerColumn: false,
      hideAdvisorColumn: true,
      advisorOnlySummary: false,
      managerOnlySummary: true,
      showTypeColumn: false,
    };
  }
  if (viewMode === VIEW_MODES.MANAGER_TEAM) {
    const mgrRow = managerId ? managers.find(m => m.id === managerId) : null;
    const teamRows = advisors.map(toAdvisorOnlyRow);
    const rows = mgrRow
      ? [{ ...toManagerOnlyRow(mgrRow), name: `${mgrRow.name} (Manager)` }, ...teamRows]
      : teamRows;
    return {
      title: "Manager + team advisors",
      rows,
      showTeamTotal: true,
      hideManagerColumn: false,
      hideAdvisorColumn: false,
      advisorOnlySummary: false,
      managerOnlySummary: false,
      showTypeColumn: false,
    };
  }
  if (viewMode === VIEW_MODES.ALL_ADVISORS) {
    const title = managerId ? "Team advisors — advisor incentives" : "All advisors — advisor incentives";
    let rows = managerId
      ? mergeAdvisorCatalogRows(advisors, opts.advisorCatalog, managerId)
      : advisors.map(toAdvisorOnlyRow);
    if (!rows.length && filteredSales?.length) {
      rows = buildAdvisorRowsFromSales(filteredSales, opts);
    }
    return {
      title,
      rows,
      showTeamTotal: !!managerId,
      hideManagerColumn: true,
      hideAdvisorColumn: false,
      advisorOnlySummary: true,
      managerOnlySummary: false,
      showTypeColumn: false,
      showSalesAmount: true,
    };
  }
  if (viewMode === VIEW_MODES.ADVISOR_INDIVIDUAL) {
    let rows = advisorId
      ? advisors.filter(a => a.id === advisorId || a.name === advisorId).map(toAdvisorOnlyRow)
      : (managerId
        ? mergeAdvisorCatalogRows(advisors, opts.advisorCatalog, managerId)
        : advisors.map(toAdvisorOnlyRow));
    if (advisorId && !rows.length && filteredSales?.length) {
      rows = buildAdvisorRowsFromSales(filteredSales, opts)
        .filter(r => r.id === advisorId);
    }
    if (!rows.length && filteredSales?.length) {
      rows = buildAdvisorRowsFromSales(filteredSales, opts);
    }
    return {
      title: "Individual advisor — incentive earned",
      rows,
      showTeamTotal: false,
      hideManagerColumn: true,
      hideAdvisorColumn: false,
      advisorOnlySummary: true,
      managerOnlySummary: false,
      showTypeColumn: false,
      showSalesAmount: true,
    };
  }

  return {
    title: "Commission report",
    rows: managers.map(toManagerOnlyRow),
    showTeamTotal: false,
    hideManagerColumn: false,
    hideAdvisorColumn: true,
    advisorOnlySummary: false,
    managerOnlySummary: true,
    showTypeColumn: false,
  };
}

function buildCommissionReport(sales, rawOpts) {
  try {
    const opts = normalizeReportOpts(rawOpts);

    const accessErr = assertSessionAccess(opts);
    if (accessErr) return { ok: false, error: accessErr };

    const { range, sales: filtered } = filterSales(sales, opts);
    const report = aggregateCommissionReport(filtered, opts);
    let presentation = buildRows(report, opts, filtered);

    if (!presentation.rows?.length && filtered.length) {
      if (opts.viewMode === VIEW_MODES.ALL_ADVISORS || opts.viewMode === VIEW_MODES.ADVISOR_INDIVIDUAL) {
        const fallbackRows = buildAdvisorRowsFromSales(filtered, opts);
        if (fallbackRows.length) {
          presentation = {
            ...presentation,
            rows: fallbackRows,
          };
        }
      } else if (opts.viewMode === VIEW_MODES.ALL_MANAGERS) {
        const fallbackRows = mergeManagerCatalogRows(report.managers, opts.managerCatalog);
        if (fallbackRows.length) {
          presentation = { ...presentation, rows: fallbackRows };
        }
      }
    }

    if (opts.sessionRole === "manager" && opts.sessionManagerId) {
      const invalid = filtered.find(s => !saleBelongsToManager(s, opts.sessionManagerId));
      if (invalid) return { ok: false, error: "Access denied: sale outside manager hierarchy." };
    }

    let summary = { ...report.summary };
    if (presentation.advisorOnlySummary) {
      summary = {
        ...summary,
        totalCommission: summary.totalAdvisorCommission,
        totalManagerCommission: 0,
        teamIncentive: summary.totalAdvisorCommission,
      };
    } else if (presentation.managerOnlySummary) {
      summary = {
        ...summary,
        totalCommission: summary.totalManagerCommission,
        totalAdvisorCommission: 0,
        teamIncentive: summary.totalManagerCommission,
      };
    }

    return {
      ok: true,
      fromDate: range.fromMonth,
      toDate: range.toMonth,
      fromMonth: range.fromMonth,
      toMonth: range.toMonth,
      periodLabel: range.label,
      range: { start: range.start.toISOString(), end: range.end.toISOString(), monthKeys: range.monthKeys },
      role: opts.role,
      managerId: opts.managerId || null,
      advisorId: opts.advisorId || null,
      viewMode: opts.viewMode,
      presentation,
      rows: presentation.rows,
      summary,
      advisors: report.advisors,
      managers: report.managers,
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function defaultMonthRange(now) {
  const key = monthKeyFromDate(now instanceof Date ? now : new Date());
  return { fromDate: key, toDate: key, fromMonth: key, toMonth: key };
}

function listMonthOptions(now, yearsBack) {
  const ref = now instanceof Date ? now : new Date();
  const back = yearsBack || 3;
  const startYear = ref.getFullYear() - back;
  const endYear = ref.getFullYear();
  const months = [];
  for (let y = endYear; y >= startYear; y--) {
    const maxM = y === endYear ? ref.getMonth() + 1 : 12;
    for (let m = maxM; m >= 1; m--) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      months.push({ key, label: formatMonthLabel(key), year: y, month: m });
    }
  }
  return months;
}

const api = {
  VIEW_MODES,
  parseMonthKey,
  monthKeyFromDate,
  formatMonthLabel,
  resolveMonthRange,
  monthKeysInRange,
  saleInMonthRange,
  saleBelongsToManager,
  normalizeReportOpts,
  filterSales,
  aggregateCommissionReport,
  buildCommissionReport,
  defaultMonthRange,
  listMonthOptions,
  currentAndPreviousMonthKeys,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.CommissionEngine = api;
} else if (typeof global !== "undefined") {
  global.CommissionEngine = api;
}
