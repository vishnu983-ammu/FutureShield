/**
 * FutureShield — Commission Reporting API
 * POST /api/commission/report
 *
 * Params: fromDate, toDate (YYYY-MM), role (manager|advisor|all),
 *         managerId, advisorId, viewMode
 *
 * Start: npm run start:commission  (port 3003)
 */

"use strict";

try { require("dotenv").config(); } catch (_) {}

const express = require("express");
const cors = require("cors");
const {
  buildCommissionReport,
  defaultMonthRange,
  listMonthOptions,
  VIEW_MODES,
} = require("./scripts/commission-engine");

const PORT = parseInt(process.env.COMMISSION_PORT || "3003", 10);
const SECRET = process.env.COMMISSION_SECRET || process.env.WA_SECRET || "futureshield-commission-secret";

const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-User-Role", "X-Manager-Id", "X-User-Name"],
}));
app.options("*", cors());
app.use(express.json({ limit: "12mb" }));

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== SECRET) {
    return res.status(401).json({ error: "Unauthorized. Invalid or missing Bearer token." });
  }
  next();
}

function sessionFromHeaders(req) {
  const role = String(req.headers["x-user-role"] || "").toLowerCase();
  const managerId = String(req.headers["x-manager-id"] || "").trim() || null;
  if (role !== "admin" && role !== "manager") {
    return { error: "X-User-Role must be admin or manager." };
  }
  if (role === "manager" && !managerId) {
    return { error: "X-Manager-Id required for manager sessions." };
  }
  return { role, managerId };
}

function parseReportOptions(req) {
  const q = { ...req.query, ...(req.body?.options || {}) };
  const defaults = defaultMonthRange();
  const viewModes = Object.values(VIEW_MODES);
  const mid = q.managerId;
  const aid = q.advisorId;
  return {
    fromDate: q.fromDate || q.fromMonth || defaults.fromDate,
    toDate: q.toDate || q.toMonth || defaults.toDate,
    filterRole: q.role === "all" ? "all" : (q.role === "advisor" ? "advisor" : "manager"),
    role: q.role === "all" ? "all" : (q.role === "advisor" ? "advisor" : "manager"),
    managerId: !mid || mid === "all" ? null : String(mid),
    advisorId: !aid || aid === "all" ? null : String(aid),
    viewMode: viewModes.includes(q.viewMode) ? q.viewMode : null,
    managerCatalog: Array.isArray(q.managerCatalog) ? q.managerCatalog : [],
    advisorCatalog: Array.isArray(q.advisorCatalog) ? q.advisorCatalog : [],
  };
}

app.get("/api/commission/health", (_req, res) => {
  res.json({ ok: true, service: "futureshield-commission", port: PORT });
});

app.get("/api/commission/months", requireAuth, (req, res) => {
  const session = sessionFromHeaders(req);
  if (session.error) return res.status(400).json({ error: session.error });
  const months = listMonthOptions(new Date(), session.role === "manager" ? 0 : 3);
  res.json({
    months: session.role === "manager" ? months.slice(0, 2) : months,
    defaultRange: defaultMonthRange(),
  });
});

app.post("/api/commission/report", requireAuth, (req, res) => {
  const session = sessionFromHeaders(req);
  if (session.error) return res.status(400).json({ error: session.error });

  const sales = Array.isArray(req.body?.sales) ? req.body.sales : [];
  const opts = parseReportOptions(req);

  const report = buildCommissionReport(sales, {
    ...opts,
    role: opts.filterRole,
    sessionRole: session.role,
    sessionManagerId: session.managerId,
    now: new Date(),
  });

  if (!report.ok) {
    const code = /access denied|cannot view|cannot access|may only view/i.test(report.error || "") ? 403 : 400;
    return res.status(code).json(report);
  }

  res.json(report);
});

app.use((err, _req, res, _next) => {
  console.error("[Commission API]", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n  FutureShield Commission API`);
  console.log(`  Port:   ${PORT}`);
  console.log(`  POST:   http://localhost:${PORT}/api/commission/report`);
  console.log(`  Token:  ${SECRET.slice(0, 12)}…\n`);
});
