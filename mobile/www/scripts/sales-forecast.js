/**
 * FutureShield — Sales Forecasting Engine (pure calculation, no DOM).
 * Used by the Admin / Manager dashboard widget.
 */
(function (global) {
  "use strict";

  const TERMINAL_STATUSES = new Set([
    "closed", "pending_approval", "lost", "approved", "rejected",
  ]);

  const IN_PROGRESS_STATUSES = new Set([
    "new", "existing", "contacted", "qualified", "follow_up", "converted",
    "in_progress", "in-progress",
  ]);

  function normalizeStatus(status) {
    return String(status || "").trim().toLowerCase().replace(/\s+/g, "_");
  }

  function toDate(val) {
    if (!val) return null;
    if (typeof val.toDate === "function") return val.toDate();
    if (val instanceof Date) return val;
    if (val.seconds) return new Date(val.seconds * 1000);
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function leadCreatedAt(lead) {
    return toDate(lead?.createdAt);
  }

  function isTerminalLead(lead) {
    return TERMINAL_STATUSES.has(normalizeStatus(lead?.status));
  }

  /** Active = open follow-up scheduled. */
  function isActiveLead(lead) {
    if (!lead || isTerminalLead(lead)) return false;
    return lead.follow_up_status === "active";
  }

  /** In-progress = open pipeline status (not yet closed). */
  function isInProgressLead(lead) {
    if (!lead || isTerminalLead(lead)) return false;
    return IN_PROGRESS_STATUSES.has(normalizeStatus(lead.status));
  }

  /** Union used for forecast pipeline volume. */
  function isPipelineLead(lead) {
    return isActiveLead(lead) || isInProgressLead(lead);
  }

  function monthBounds(year, month) {
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 1, 0, 23, 59, 59, 999),
    };
  }

  function inRange(d, start, end) {
    return d >= start && d <= end;
  }

  function filterByAdvisor(items, advisorFilter, idKey, nameKey) {
    if (!advisorFilter) return items;
    return items.filter(item =>
      (item[idKey] || "") === advisorFilter.id ||
      (item[nameKey] || "") === advisorFilter.name
    );
  }

  /**
   * Compute sales forecast for the next 30 days / upcoming month.
   * @param {Object} opts
   * @param {Array}  opts.leads
   * @param {Array}  opts.sales - closed_sales records
   * @param {Date}   [opts.now]
   * @param {Object} [opts.advisorFilter] - { id, name }
   * @param {Function} [opts.getSaleDate]
   */
  function computeSalesForecast(opts) {
    try {
      const now = opts?.now instanceof Date ? opts.now : new Date();
      const leads = Array.isArray(opts?.leads) ? opts.leads : [];
      const sales = Array.isArray(opts?.sales) ? opts.sales : [];
      const getSaleDate = typeof opts?.getSaleDate === "function"
        ? opts.getSaleDate
        : (s) => toDate(s?.approvedAt);

      const scopedLeads = filterByAdvisor(leads, opts?.advisorFilter, "advisorId", "advisorName");
      const scopedSales = filterByAdvisor(sales, opts?.advisorFilter, "advisorId", "advisorName");
      const approvedSales = scopedSales.filter(s => s?.approvalStatus === "approved");

      const activeLeads = scopedLeads.filter(isActiveLead);
      const inProgressLeads = scopedLeads.filter(isInProgressLead);
      const pipelineIds = new Set();
      scopedLeads.forEach(l => {
        if (isPipelineLead(l)) pipelineIds.add(l.id || l.name || Math.random());
      });
      const pipelineCount = pipelineIds.size;

      const monthlyRates = [];
      for (let i = 1; i <= 6; i++) {
        const ref = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const { start, end } = monthBounds(ref.getFullYear(), ref.getMonth());
        const newLeads = scopedLeads.filter(l => {
          const cd = leadCreatedAt(l);
          return cd && inRange(cd, start, end);
        }).length;
        const closures = approvedSales.filter(s => {
          const ad = getSaleDate(s);
          return ad && inRange(ad, start, end);
        }).length;
        monthlyRates.push({
          month: ref,
          newLeads,
          closures,
          rate: newLeads > 0 ? closures / newLeads : null,
        });
      }

      const validRates = monthlyRates.filter(m => m.rate !== null);
      let avgConversionRate = 0;
      if (validRates.length) {
        avgConversionRate = validRates.reduce((a, m) => a + m.rate, 0) / validRates.length;
      } else if (scopedLeads.length > 0 && approvedSales.length > 0) {
        avgConversionRate = approvedSales.length / scopedLeads.length;
      }
      avgConversionRate = Math.min(Math.max(avgConversionRate, 0), 1);

      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
      const recentPremiums = approvedSales
        .map(s => {
          const ad = getSaleDate(s);
          return ad && ad >= sixMonthsAgo ? Number(s.premiumAmount) || 0 : null;
        })
        .filter(v => v !== null);
      const avgPremium = recentPremiums.length
        ? recentPremiums.reduce((a, v) => a + v, 0) / recentPremiums.length
        : 0;

      const estimatedClosures = Math.round(pipelineCount * avgConversionRate);
      const projectedRevenue = Math.round(estimatedClosures * avgPremium);

      const weekLabels = ["Week 1", "Week 2", "Week 3", "Week 4"];
      const basePerWeek = estimatedClosures / 4;
      let assigned = 0;
      const weeks = weekLabels.map((label, idx) => {
        const closures = idx < 3
          ? Math.floor(basePerWeek)
          : Math.max(0, estimatedClosures - assigned);
        if (idx < 3) assigned += closures;
        return {
          label,
          closures,
          revenue: Math.round(closures * avgPremium),
        };
      });

      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const upcoming = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      return {
        ok: true,
        pipelineCount,
        activeCount: activeLeads.length,
        inProgressCount: inProgressLeads.length,
        avgConversionRate,
        avgConversionPct: (avgConversionRate * 100).toFixed(1),
        avgPremium,
        estimatedClosures,
        projectedRevenue,
        monthlyRates,
        dataMonths: validRates.length,
        weeks,
        upcomingMonthLabel: `${monthNames[upcoming.getMonth()]} ${upcoming.getFullYear()}`,
        periodLabel: "Next 30 days",
      };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Per-team-member forecasts (managers).
   * @param {Object} opts
   * @param {Array} opts.leads
   * @param {Array} opts.sales
   * @param {Array} opts.advisors - { id, name }
   * @param {Date}   [opts.now]
   * @param {Function} [opts.getSaleDate]
   */
  function computeTeamForecasts(opts) {
    try {
      const advisors = Array.isArray(opts?.advisors) ? opts.advisors : [];
      const rows = advisors.map(adv => {
        const forecast = computeSalesForecast({
          leads: opts?.leads || [],
          sales: opts?.sales || [],
          now: opts?.now,
          advisorFilter: { id: adv.id, name: adv.name },
          getSaleDate: opts?.getSaleDate,
        });
        return {
          id: adv.id,
          name: adv.name || "Advisor",
          forecast: forecast.ok ? forecast : null,
          error: forecast.ok ? null : forecast.error,
        };
      });

      const managerLeads = (opts?.leads || []).filter(l => l.isManagerOwnLead);
      if (managerLeads.length) {
        const mgrForecast = computeSalesForecast({
          leads: managerLeads,
          sales: (opts?.sales || []).filter(s => !s.advisorId && !s.advisorName),
          now: opts?.now,
          getSaleDate: opts?.getSaleDate,
        });
        rows.unshift({
          id: "__manager__",
          name: "Manager (own leads)",
          forecast: mgrForecast.ok ? mgrForecast : null,
          error: mgrForecast.ok ? null : mgrForecast.error,
        });
      }

      return { ok: true, rows };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), rows: [] };
    }
  }

  const api = {
    computeSalesForecast,
    computeTeamForecasts,
    isActiveLead,
    isInProgressLead,
    isPipelineLead,
    normalizeStatus,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.SalesForecastEngine = api;
  }
})(typeof window !== "undefined" ? window : global);
