// File: docs/app.js
// Phase 1 UI flow with demo data:
// Connect -> (Overdue questions if needed) -> Dashboard
//
// Later (Phase 2), btnFetchHoldings will call the Trading212 API and build the same "positions" shape.


const EXIT_TAX_RATE = 0.38;

// Phase 2 (serverless proxy): set this to your deployed Worker URL.
// Example: "https://t212-exit-tax-proxy.your-subdomain.workers.dev"
// Users can override without code changes using:
//   1) ?proxy=https://... (query param)
//   2) localStorage key "t212ProxyBaseUrl"
// Leave blank to skip proxy and use docs/data/positions.json (snapshot mode).
// When a proxy URL is configured and the user provides creds, the app will attempt the proxy and will NOT silently fall back to the snapshot on errors.
const T212_PROXY_BASE_URL = "https://t212-exit-tax-proxy.geraldboylan.workers.dev";

function getProxyBaseUrl() {
  // Allow overriding without code changes:
  // 1) ?proxy=https://... query param
  // 2) localStorage key "t212ProxyBaseUrl"
  try {
    const u = new URL(window.location.href);
    const qp = u.searchParams.get("proxy");
    if (qp && qp.startsWith("http")) return qp.replace(/\/+$/, "");
  } catch {}
  try {
    const ls = localStorage.getItem("t212ProxyBaseUrl") || "";
    if (ls && ls.startsWith("http")) {
      const isGitHubPages = /(^|\.)github\.io$/i.test(window.location.hostname);
      const isLocalhostOverride = /^(https?:\/\/)?localhost(:\d+)?/i.test(ls);
      if (!(isGitHubPages && isLocalhostOverride)) {
        return ls.replace(/\/+$/, "");
      }
    }
  } catch {}
  return (T212_PROXY_BASE_URL || "").replace(/\/+$/, "");
}

async function loadPositionsViaProxy(apiKey, apiSecret, envName = "live") {
  const base = getProxyBaseUrl();
  if (!base) throw new Error("Proxy URL not configured.");

  const url = `${base}/positions`;

  // NOTE: We deliberately use only the Content-Type header.
  // This will trigger an OPTIONS preflight for application/json, which is expected.
  // CORS must be allowed by the Worker for the page Origin.
  const res = await fetch(url, {
    method: "POST",
    mode: "cors",
    credentials: "omit",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, apiSecret, env: envName }),
  });

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const isJson = ct.includes("application/json");
  const payload = isJson ? await res.json().catch(() => null) : await res.text().catch(() => "");

  if (!res.ok) {
    // Do NOT echo secrets. Return a safe, compact error.
    const detail =
      (payload && typeof payload === "object" && (payload.error || payload.detail))
        ? `${payload.error || ""}${payload.detail ? ` ${String(payload.detail)}` : ""}`.trim()
        : (typeof payload === "string" ? payload : "");

    // Common CORS failures surface as a TypeError before we get here.
    throw new Error(`Proxy error (HTTP ${res.status})${detail ? ` - ${detail}` : ""}`);
  }

  // Accept array, {items:[...]}, or {positions:[...]}
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  if (payload && Array.isArray(payload.positions)) return payload.positions;

  throw new Error("Proxy returned unexpected JSON shape.");
}

// Approx date diff is fine for UI gating; exact anniversary uses date math.
const state = {
  asOf: null,
  positions: [],
  instrumentByIsin: new Map(),
  // User overrides: ISINs the user explicitly marks as subject to deemed disposal.
  includedIsins: new Set(),
  // Answers keyed by ISIN for deemed-disposal handling.
  // { paidExitTax: boolean, deemedDisposalValue: number }
  answersByIsin: new Map(),
  selectedIsin: null,
  rememberDevice: false,
  chart: null,
  // Single source of truth for account environment (live/demo)
  apiEnv: "live",
};

function $(id) { return document.getElementById(id); }

const EXIT_TAX_OVERRIDES_KEY = "exitTaxIncludedIsins";

function loadExitTaxOverrides() {
  try {
    const raw = localStorage.getItem(EXIT_TAX_OVERRIDES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    state.includedIsins = new Set((arr || []).map(normalizeIsin).filter(Boolean));
  } catch {
    state.includedIsins = new Set();
  }
}

function persistExitTaxOverrides() {
  try {
    localStorage.setItem(EXIT_TAX_OVERRIDES_KEY, JSON.stringify([...state.includedIsins]));
  } catch {}
}

function includeIsinForExitTax(isin) {
  const norm = normalizeIsin(isin);
  if (!norm) return;
  state.includedIsins.add(norm);
  persistExitTaxOverrides();
  // Ensure something is selected after promoting.
  state.selectedIsin = norm;
  renderDashboard();
}

function normalizeIsin(isin) {
  if (isin == null) return "";
  // Uppercase + remove ALL whitespace to be robust (Python does this too)
  return String(isin).trim().toUpperCase().replace(/\s+/g, "");
}

function looksLikeTicker(s) {
  if (s == null) return false;
  const t = String(s).trim();
  if (!t) return false;
  if (t.length > 12) return false;
  if (t.includes(" ")) return false;
  return /^[A-Za-z0-9_.-]+$/.test(t);
}

function parseDateISO(s) {
  if (!s) return null;
  // Parse as UTC midnight to avoid timezone drift.
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(String(s).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo, d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Display dates as DD/MM/YYYY (UTC) everywhere in the UI.
function fmtDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  const dd = pad2(d.getUTCDate());
  const mm = pad2(d.getUTCMonth() + 1);
  const yyyy = String(d.getUTCFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

// Mirror Python _add_years(): Feb 29 -> Feb 28 on non-leap years.
function addYearsSafeUTC(d, years) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();

  const targetYear = y + years;
  const isFeb29 = (m === 1 && day === 29);

  const targetDay = (isFeb29 && !isLeapYear(targetYear)) ? 28 : day;
  return new Date(Date.UTC(targetYear, m, targetDay));
}

function money(n, currency) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  if (currency && typeof currency === "string" && currency.length === 3) {
    try {
      return new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(n);
    } catch {
      // fall through
    }
  }
  return new Intl.NumberFormat("en-IE", { maximumFractionDigits: 2 }).format(n);
}



function ensureSegStyles() {
  if (document.getElementById("segStyles")) return;
  const style = document.createElement("style");
  style.id = "segStyles";
  style.textContent = `
    .seg { display:flex; gap:10px; margin-top:10px; }
    .seg-item { flex: 0 0 auto; display:flex; align-items:center; gap:10px; padding: 10px 14px; border-radius: 999px; border: 1px solid rgba(233,241,255,0.18); background: rgba(255,255,255,0.03); cursor:pointer; user-select:none; }
    .seg-item input { position:absolute; opacity:0; pointer-events:none; }
    .seg-item span { font-weight:800; color: var(--text); }
    .seg-item:has(input:checked) { border-color: rgba(60,196,255,0.65); box-shadow: 0 0 0 3px rgba(60,196,255,0.12); background: rgba(60,196,255,0.08); }
  `;
  document.head.appendChild(style);
}

// ---------- Environment (Live / Demo) ----------
// Fool-proof approach: app.js (state.apiEnv) is the single source of truth.
// UI can be radios OR split buttons; both are supported.
function setEnv(env) {
  state.apiEnv = (String(env).toLowerCase() === "demo") ? "demo" : "live";

  // Persist the env choice (non-sensitive). This avoids UI/DOM drift issues.
  try { localStorage.setItem("t212ApiEnv", state.apiEnv); } catch {}

  // Backup: force radios if they exist
  const liveEl = document.getElementById("env_live");
  const demoEl = document.getElementById("env_demo");
  if (liveEl && demoEl) {
    liveEl.checked = (state.apiEnv === "live");
    demoEl.checked = (state.apiEnv === "demo");
  }

  // Support split-button UI if present
  const liveBtn = document.getElementById("envLiveBtn");
  const demoBtn = document.getElementById("envDemoBtn");
  if (liveBtn && demoBtn) {
    liveBtn.classList.toggle("active", state.apiEnv === "live");
    demoBtn.classList.toggle("active", state.apiEnv === "demo");
    liveBtn.setAttribute("aria-pressed", String(state.apiEnv === "live"));
    demoBtn.setAttribute("aria-pressed", String(state.apiEnv === "demo"));
  }
}

function getEnv() {
  return (state.apiEnv === "demo") ? "demo" : "live";
}

function initEnvControl() {
  // Load persisted env if present
  try {
    const saved = String(localStorage.getItem("t212ApiEnv") || "").toLowerCase();
    if (saved === "demo" || saved === "live") state.apiEnv = saved;
  } catch {}

  // Wire split-button UI (if present)
  const liveBtn = document.getElementById("envLiveBtn");
  const demoBtn = document.getElementById("envDemoBtn");
  if (liveBtn) liveBtn.addEventListener("click", () => setEnv("live"));
  if (demoBtn) demoBtn.addEventListener("click", () => setEnv("demo"));

  // Wire radios (if present)
  const liveEl = document.getElementById("env_live");
  const demoEl = document.getElementById("env_demo");
  if (liveEl) liveEl.addEventListener("change", () => { if (liveEl.checked) setEnv("live"); });
  if (demoEl) demoEl.addEventListener("change", () => { if (demoEl.checked) setEnv("demo"); });

  // Apply state to UI
  setEnv(state.apiEnv);
}

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function viewConnect() {
  show($("viewConnect"));
  hide($("viewOverdue"));
  hide($("viewDashboard"));
}

function viewOverdue() {
  hide($("viewConnect"));
  show($("viewOverdue"));
  hide($("viewDashboard"));
}

function viewDashboard() {
  hide($("viewConnect"));
  hide($("viewOverdue"));
  show($("viewDashboard"));
}

// ---------- Instrument DB ----------
function hydrateInstrumentDb(dbJson) {
  state.instrumentByIsin.clear();

  // supports dict or list shapes
  if (Array.isArray(dbJson)) {
    for (const row of dbJson) {
      const isin = normalizeIsin(row?.isin);
      if (!isin) continue;
      state.instrumentByIsin.set(isin, row);
    }
    return;
  }

  if (dbJson && typeof dbJson === "object") {
    for (const [rawIsin, info] of Object.entries(dbJson)) {
      const isin = normalizeIsin(rawIsin);
      if (!isin) continue;
      state.instrumentByIsin.set(isin, info);
    }
    return;
  }

  throw new Error("Instrument DB JSON has an unexpected shape.");
}

function isExitTaxInstrument(isin) {
  // Project rule: if ISIN exists in our DB, treat as exit-tax instrument.
  // Plus: user overrides (includedIsins) are treated as subject to deemed disposal.
  const norm = normalizeIsin(isin);
  if (!norm) return false;
  return state.instrumentByIsin.has(norm) || state.includedIsins.has(norm);
}

// ---------- Python-mirroring helpers ----------
function getCreatedAtISO(pos) {
  // Python uses p.get("createdAt") and parses as ISO datetime.
  // If missing, Python falls back to now.
  const raw = pos?.createdAt || pos?.created_at || null;
  if (raw && typeof raw === "string") return raw;
  return new Date().toISOString();
}

function createdAtUTCDate(pos) {
  const raw = getCreatedAtISO(pos);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function getTotalCost(pos) {
  return (
    pos?.walletImpact?.totalCost ??
    pos?.total_cost ??
    0
  );
}

function getCurrentValue(pos) {
  return (
    pos?.walletImpact?.currentValue ??
    pos?.current_value ??
    0
  );
}

function getUnrealisedPL(pos) {
  // Python prefers walletImpact.unrealizedProfitLoss, otherwise current_value - total_cost.
  const w = pos?.walletImpact?.unrealizedProfitLoss;
  if (typeof w === "number" && !Number.isNaN(w)) return w;
  return getCurrentValue(pos) - getTotalCost(pos);
}

function getCurrency(pos) {
  // Mirror Python snapshot.py preference: instrument.currency OR walletImpact.currency
  // In practice, walletImpact currency is usually present; fall back to instrument then legacy.
  return (
    pos?.walletImpact?.currency ??
    pos?.instrument?.currency ??
    pos?.currency ??
    null
  );
}

// ---------- Deemed disposal logic + core math ----------
// Phase 1: We use Trading212 `createdAt` as the start date.
// Note: once we integrate transactions, we can switch start-date to earliest transaction date.

function deemedDisposalInfo(pos) {
  const start = createdAtUTCDate(pos);
  const asOf = parseDateISO(state.asOf);

  if (!asOf) {
    return {
      start,
      asOf: null,
      cyclesCompleted: 0,
      lastDd: null,
      nextDd: addYearsSafeUTC(start, 8),
      paymentDeadline: null,
      inPaymentWindow: false,
    };
  }

  // Exact cycle detection (8-year anniversaries) to avoid false positives.
  let cyclesCompleted = 0;
  while (true) {
    const candidate = addYearsSafeUTC(start, (cyclesCompleted + 1) * 8);
    if (asOf.getTime() >= candidate.getTime()) cyclesCompleted += 1;
    else break;
  }

  const lastDd = cyclesCompleted >= 1 ? addYearsSafeUTC(start, cyclesCompleted * 8) : null;
  const nextDd = addYearsSafeUTC(start, (cyclesCompleted + 1) * 8);

  // Per your UX rule: if DD happened earlier this year, payment may not be due until end of Oct.
  // Using Oct 31 of the deemed-disposal YEAR as the “still OK” window.
  const paymentDeadline = lastDd
    ? new Date(Date.UTC(lastDd.getUTCFullYear(), 9, 31)) // Oct=9 (0-indexed)
    : null;

  const inPaymentWindow = !!(lastDd && asOf.getTime() <= paymentDeadline.getTime());

  return { start, asOf, cyclesCompleted, lastDd, nextDd, paymentDeadline, inPaymentWindow };
}

function nextDeemedDisposalDate(pos) {
  return deemedDisposalInfo(pos).nextDd;
}

function hasDeemedDisposalValue(pos) {
  const ans = state.answersByIsin.get(normalizeIsin(pos.isin));
  return ans && Number.isFinite(ans.deemedDisposalValue) && ans.deemedDisposalValue >= 0;
}

function isOverdue(pos) {
  const info = deemedDisposalInfo(pos);
  if (info.cyclesCompleted < 1) return false;

  // If still within payment window, not overdue.
  if (info.inPaymentWindow) return false;

  const ans = state.answersByIsin.get(normalizeIsin(pos.isin));
  const paid = !!ans?.paidExitTax;

  // Outside payment window and not paid -> overdue.
  return !paid;
}

function needsQuestions(pos) {
  const info = deemedDisposalInfo(pos);
  if (info.cyclesCompleted < 1) return false;

  // Once we’ve passed a DD, we need the market value on that DD date to rebase correctly.
  if (!hasDeemedDisposalValue(pos)) return true;

  // If overdue, show the guidance/checkbox screen as well.
  if (isOverdue(pos)) return true;

  return false;
}

function taxableGainToday(pos) {
  // If we have deemed disposal value (rebased cost), use it.
  if (hasDeemedDisposalValue(pos)) {
    const ans = state.answersByIsin.get(normalizeIsin(pos.isin));
    return Math.max(getCurrentValue(pos) - ans.deemedDisposalValue, 0);
  }

  // Otherwise (pre-first-DD), mirror Python CLI Phase 1:
  return Math.max(getCurrentValue(pos) - getTotalCost(pos), 0);
}

function computeTax(pos) {
  const info = deemedDisposalInfo(pos);

  // If past DD but missing DD value, can’t estimate reliably.
  if (info.cyclesCompleted >= 1 && !hasDeemedDisposalValue(pos)) return null;

  // If overdue, don’t estimate.
  if (isOverdue(pos)) return null;

  return taxableGainToday(pos) * EXIT_TAX_RATE;
}

function computeGain(pos) {
  return getUnrealisedPL(pos);
}

// ---------- Loading JSON ----------
async function loadJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return await res.json();
}

function showConnectBanner(msg) {
  const el = $("connectBanner");
  el.textContent = msg;
  show(el);
}

function clearConnectBanner() {
  const el = $("connectBanner");
  hide(el);
  el.textContent = "";
}

// ---------- Rendering: Overdue Questions ----------
function renderOverdueQuestions(positionsNeedingInfo) {
  const container = $("overdueList");
  container.innerHTML = "";
  ensureSegStyles();

  for (const pos of positionsNeedingInfo) {
    const isin = normalizeIsin(pos.isin);
    const info = deemedDisposalInfo(pos);
    const existing = state.answersByIsin.get(isin);

    const lastDdStr = info.lastDd ? fmtDate(info.lastDd) : "—";
    const deadlineStr = info.paymentDeadline ? fmtDate(info.paymentDeadline) : "—";
    const overdueNow = isOverdue(pos);

    const guidance = overdueNow
      ? `This holding appears to be past its deemed disposal date and outside the payment window (deadline ${deadlineStr}). If you have not paid exit tax for the deemed disposal on ${lastDdStr}, you may be overdue — consider seeking professional tax advice.`
      : `This holding has passed a deemed disposal date (${lastDdStr}). To calculate correctly, we need the market value of your holding on that deemed disposal date.`;

    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <div class="overdue-item-title">${escapeHtml(pos.ticker || "Holding")} • ${escapeHtml(isin)}</div>
      <div class="overdue-item-sub">${escapeHtml(pos.name || "")}</div>

      <div class="form">
        <div class="field">
          <label>Deemed disposal date we detected</label>
          <input type="text" value="${escapeHtml(lastDdStr)}" disabled />
          <div class="small">This is the most recent 8-year deemed disposal date based on the start date we’re using.</div>
        </div>

        <div class="field">
          <label>Have you already paid exit tax for this deemed disposal?</label>

          <div class="seg" role="group" aria-label="Exit tax paid">
            <label class="seg-item" for="paid_yes_${isin}">
              <input type="radio" id="paid_yes_${isin}" name="paid_${isin}" value="yes" />
              <span>Yes</span>
            </label>
            <label class="seg-item" for="paid_no_${isin}">
              <input type="radio" id="paid_no_${isin}" name="paid_${isin}" value="no" checked />
              <span>No</span>
            </label>
          </div>

          <div class="small">If you have not paid and the deadline has passed (${escapeHtml(deadlineStr)}), this may be overdue.</div>
        </div>

        <div class="field">
          <label>Value of this investment on ${escapeHtml(lastDdStr)}</label>
          <input inputmode="decimal" placeholder="e.g. 12500" id="v_${isin}" />
          <div class="small">We use this as the new cost base after the deemed disposal date.</div>
        </div>

        <div class="small" style="margin-top: 8px;">${escapeHtml(guidance)}</div>

        <div class="row row-right" style="margin-top: 14px;">
          <button class="btn btn-accent" id="s_${isin}">Save</button>
        </div>

        <div class="small" id="m_${isin}"></div>
      </div>
    `;

    container.appendChild(card);

    const paidYesEl = document.getElementById(`paid_yes_${isin}`);
    const paidNoEl = document.getElementById(`paid_no_${isin}`);
    const valEl = document.getElementById(`v_${isin}`);
    const msgEl = document.getElementById(`m_${isin}`);
    const saveEl = document.getElementById(`s_${isin}`);

    if (existing) {
      const paid = !!existing.paidExitTax;
      paidYesEl.checked = paid;
      paidNoEl.checked = !paid;
      if (Number.isFinite(existing.deemedDisposalValue)) valEl.value = String(existing.deemedDisposalValue);
    } else {
      // default to "No" (user hasn't paid) unless they explicitly say otherwise
      paidYesEl.checked = false;
      paidNoEl.checked = true;
    }

    saveEl.addEventListener("click", () => {
      const paidExitTax = !!paidYesEl.checked;
      const deemedDisposalValue = Number((valEl.value || "").trim());

      const okVal = Number.isFinite(deemedDisposalValue) && deemedDisposalValue >= 0;

      if (!okVal) {
        msgEl.textContent = "Please enter a non-negative value for the holding on the deemed disposal date.";
        return;
      }

      state.answersByIsin.set(isin, { paidExitTax, deemedDisposalValue });
      msgEl.textContent = "Saved.";

      persistAnswersIfNeeded();
    });
  }
}

// ---------- Rendering: Dashboard ----------
function renderDashboard() {
  const relevant = state.positions.filter(p => isExitTaxInstrument(p.isin));
  const other = state.positions.filter(p => !isExitTaxInstrument(p.isin));

  const currencies = new Set(relevant.map(p => getCurrency(p)).filter(Boolean));
  const singleCcy = currencies.size === 1 ? [...currencies][0] : null;

  const totalValue = relevant.reduce((s, p) => s + getCurrentValue(p), 0);
  const totalPL = relevant.reduce((s, p) => s + getUnrealisedPL(p), 0);

  let overdueCount = 0;
  let totalTax = 0;
  let needsInfoCount = 0;

  for (const p of relevant) {
    if (isOverdue(p)) {
      overdueCount += 1;
      continue;
    }

    const t = computeTax(p);
    if (t == null) {
      needsInfoCount += 1;
      continue;
    }
    totalTax += t;
  }

  $("summary").textContent =
    `${relevant.length} exit-tax holdings • ` +
    `Value ${money(totalValue, singleCcy)} • ` +
    `Net P/L ${money(totalPL, singleCcy)} • ` +
    `Est. exit tax today ${money(totalTax, singleCcy)} • ` +
    `${overdueCount} overdue` +
    (needsInfoCount ? ` • ${needsInfoCount} needs info` : "") +
    (singleCcy ? "" : " • Mixed currency") +
    (other.length ? ` • ${other.length} other securities` : "");

  // banner
  const banner = $("overdueBanner");
  if (overdueCount > 0) {
    banner.textContent =
      "Overdue deemed disposal detected for one or more holdings. This tool will not estimate tax for overdue holdings. Consider seeking professional tax advice.";
    show(banner);
  } else if (needsInfoCount > 0) {
    banner.textContent =
      "More information is required to estimate tax for some holdings that have passed a deemed disposal date (we need the holding value on the deemed disposal date).";
    show(banner);
  } else {
    hide(banner);
  }

  if (other.length > 0) {
    // Dev aid: list non-exit-tax securities so we can add to DB or include via override.
    console.warn("Securities not currently treated as exit-tax:", other.map(p => ({
      isin: p.isin,
      ticker: p.ticker,
      name: p.name,
      currency: getCurrency(p),
    })));
  }

  renderHoldingsTable(relevant);
  renderOtherSecuritiesTable(other);

  // default selection
  if (!state.selectedIsin && relevant.length > 0) {
    state.selectedIsin = normalizeIsin(relevant[0].isin);
  }

  renderRightPanel(relevant, other);
}

function renderHoldingsTable(rows) {
  const tbody = $("holdingsTbody");
  tbody.innerHTML = "";

  // sort overdue first, then by value desc
  const sorted = [...rows].sort((a, b) => {
    const oa = isOverdue(a) ? 0 : 1;
    const ob = isOverdue(b) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return getCurrentValue(b) - getCurrentValue(a);
  });

  for (const pos of sorted) {
    const isin = normalizeIsin(pos.isin);
    const tr = document.createElement("tr");

    if (state.selectedIsin === isin) tr.classList.add("selected");

    tr.addEventListener("click", () => {
      state.selectedIsin = isin;
      renderDashboard(); // cheap rerender for now
    });

    const gain = computeGain(pos);
    const gainIsLoss = gain < 0;

    const gainClass = gainIsLoss ? "neg" : "pos";
    const gainLabel = gainIsLoss ? "Loss" : "Gain";

    const next = nextDeemedDisposalDate(pos);
    const overdue = isOverdue(pos);

    let taxCell = "";
    if (overdue) {
      taxCell = `<span class="neg">Overdue</span>`;
    } else {
      const tax = computeTax(pos);
      if (tax == null) taxCell = `<span class="muted">Needs info</span>`;
      else taxCell = `${money(tax, getCurrency(pos))}`;
    }

    tr.innerHTML = `
      <td>
        <div style="font-weight:900; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(pos.name || pos.ticker || "—")}</div>
        <div style="color: var(--muted); font-size: 12px; margin-top: 2px;">${escapeHtml(pos.ticker || "—")}</div>
      </td>
      <td>${escapeHtml(isin)}</td>
      <td class="num">${money(getCurrentValue(pos), getCurrency(pos))}</td>
      <td class="num ${gainClass}">${gainLabel} ${money(Math.abs(gain), getCurrency(pos))}</td>
      <td>${next ? fmtDate(next) : "—"}</td>
      <td class="num">${taxCell}</td>
    `;

    tbody.appendChild(tr);
  }
}

function renderRightPanel(relevantRows, otherRows) {
  const drawerBody = $("drawerBody");
  const subtitle = $("assumptionsSubtitle");

  const allRows = [...(relevantRows || []), ...(otherRows || [])];
  const selected = allRows.find(p => normalizeIsin(p.isin) === state.selectedIsin);

  if (!selected) {
    subtitle.textContent = "Select a security to view details";
    drawerBody.innerHTML = `<div class="empty">Select a security to see how dates and tax are calculated.</div>`;
    return;
  }

  const isin = normalizeIsin(selected.isin);
  const isExitTax = isExitTaxInstrument(isin);
  const gain = computeGain(selected);
  const gainIsLoss = gain < 0;
  const overdue = isExitTax ? isOverdue(selected) : false;
  const next = isExitTax ? nextDeemedDisposalDate(selected) : null;

  subtitle.textContent = `${selected.ticker || "Holding"} • ${isin}`;

  const tax = isExitTax ? computeTax(selected) : null;
  const needsInfo = isExitTax ? ((tax == null) && !overdue) : false;

  drawerBody.innerHTML = `
    <div class="section-title">Assumptions</div>
    <div class="kv">
      <div class="card">
        <div class="label">Exit tax rate</div>
        <div class="value">${(EXIT_TAX_RATE * 100).toFixed(0)}%</div>
      </div>
      <div class="card">
        <div class="label">As of date</div>
        <div class="value">${escapeHtml(fmtDate(parseDateISO(state.asOf)))}</div>
      </div>
      <div class="card">
        <div class="label">Start date rule</div>
        <div class="value">createdAt from Trading 212</div>
      </div>
      <div class="card">
        <div class="label">Cycle rule</div>
        <div class="value">8-year deemed disposal</div>
      </div>
    </div>

    <div class="section-title">Selected holding</div>
    <div class="kv">
      <div class="card">
        <div class="label">Value</div>
        <div class="value">${money(getCurrentValue(selected), getCurrency(selected))}</div>
      </div>
      <div class="card">
        <div class="label">${gainIsLoss ? "Loss" : "Gain"}</div>
        <div class="value">${money(Math.abs(gain), getCurrency(selected))}</div>
      </div>
      <div class="card">
        <div class="label">Start date used</div>
        <div class="value">${escapeHtml(fmtDate(createdAtUTCDate(selected)))}</div>
      </div>
      <div class="card">
        <div class="label">Next deemed disposal date</div>
        <div class="value">${isExitTax ? (next ? fmtDate(next) : "—") : "N/A"}</div>
      </div>
      <div class="card">
        <div class="label">Exit tax (if today)</div>
        <div class="value">${isExitTax ? (overdue ? `<span class="neg">Overdue</span>` : (needsInfo ? `<span class="muted">Needs info</span>` : money(tax, getCurrency(selected)))) : "N/A"}</div>
        <div class="small">${
          !isExitTax
            ? "This security is not currently treated as subject to deemed disposal. If it should be, click Include in the Other securities table."
            : (overdue
              ? "If the payment deadline has passed and you have not paid exit tax, consider seeking professional advice."
              : (needsInfo
                ? "We need the holding value on the deemed disposal date to estimate tax since that date."
                : (taxableGainToday(selected) <= 0 ? "No exit tax is estimated where taxable gain is zero." : "")
              )
            )
        }</div>
      </div>
      <div class="card">
        <div class="label">Notes</div>
        <div class="value">${!isExitTax ? "Not included" : (overdue ? "Action required" : "OK")}</div>
      </div>
    </div>
  `;
}
function renderOtherSecuritiesTable(rows) {
  const tbody = $("otherTbody");
  const empty = $("otherEmpty");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!rows || rows.length === 0) {
    if (empty) empty.classList.remove("hidden");
    return;
  }
  if (empty) empty.classList.add("hidden");

  // sort by value desc
  const sorted = [...rows].sort((a, b) => getCurrentValue(b) - getCurrentValue(a));

  for (const pos of sorted) {
    const isin = normalizeIsin(pos.isin);
    const tr = document.createElement("tr");

    if (state.selectedIsin === isin) tr.classList.add("selected");

    tr.addEventListener("click", () => {
      state.selectedIsin = isin;
      renderDashboard();
    });

    const gain = computeGain(pos);
    const gainIsLoss = gain < 0;

    const gainClass = gainIsLoss ? "neg" : "pos";
    const gainLabel = gainIsLoss ? "Loss" : "Gain";

    tr.innerHTML = `
      <td>
        <div style="font-weight:900; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(pos.name || pos.ticker || "—")}</div>
        <div style="color: var(--muted); font-size: 12px; margin-top: 2px;">${escapeHtml(pos.ticker || "—")}</div>
      </td>
      <td>${escapeHtml(isin)}</td>
      <td class="num">${money(getCurrentValue(pos), getCurrency(pos))}</td>
      <td class="num ${gainClass}">${gainLabel} ${money(Math.abs(gain), getCurrency(pos))}</td>
      <td>N/A</td>
      <td class="num"><button class="btn btn-ghost" type="button" data-isin="${escapeHtml(isin)}">Include</button></td>
    `;

    const btn = tr.querySelector("button[data-isin]");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        includeIsinForExitTax(isin);
      });
    }

    tbody.appendChild(tr);
  }
}

// ---------- Chart ----------
// Chart rendering removed.

// ---------- Persistence (optional) ----------
function persistAnswersIfNeeded() {
  if (!state.rememberDevice) return;
  try {
    const obj = {};
    for (const [isin, ans] of state.answersByIsin.entries()) obj[isin] = ans;
    localStorage.setItem("exitTaxAnswersByIsin", JSON.stringify(obj));
  } catch {}
}

function loadPersistedAnswersIfAny() {
  try {
    const raw = localStorage.getItem("exitTaxAnswersByIsin");
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return;
    for (const [isin, ans] of Object.entries(obj)) {
      if (!isin) continue;
      if (!ans) continue;
      state.answersByIsin.set(normalizeIsin(isin), ans);
    }
  } catch {}
}

function persistCredsIfNeeded(key, secret, env) {
  if (!state.rememberDevice) return;
  try {
    localStorage.setItem("t212ApiKey", key || "");
    localStorage.setItem("t212ApiSecret", secret || "");
    localStorage.setItem("t212ApiEnv", env || "live");
  } catch {}
}

function loadPersistedCredsIfAny() {
  try {
    const key = localStorage.getItem("t212ApiKey") || "";
    const secret = localStorage.getItem("t212ApiSecret") || "";
    const env = localStorage.getItem("t212ApiEnv") || "live";
    $("apiKey").value = key;
    $("apiSecret").value = secret;

    // Keep a code-owned truth for env as well
    state.apiEnv = (String(env).toLowerCase() === "demo") ? "demo" : "live";

    const liveEl = document.getElementById("env_live");
    const demoEl = document.getElementById("env_demo");
    if (state.apiEnv === "demo") {
      if (demoEl) demoEl.checked = true;
    } else {
      if (liveEl) liveEl.checked = true;
    }
  } catch {}
}

// ---------- Init / event wiring ----------
async function init() {
  $("btnReload").addEventListener("click", () => window.location.reload());
  $("btnClose").addEventListener("click", () => {
    state.selectedIsin = null;
    renderDashboard();
  });
  ensureSegStyles();
  loadPersistedCredsIfAny();
  initEnvControl();
  loadPersistedAnswersIfAny();
  loadExitTaxOverrides();

  $("btnFetchHoldings").addEventListener("click", async () => {
    clearConnectBanner();

    state.rememberDevice = $("rememberDevice").checked;

    const key = ($("apiKey").value || "").trim();
    const secret = ($("apiSecret").value || "").trim();
    const checkedEnv = document.querySelector('input[name="apiEnv"]:checked')?.value;
    if (checkedEnv) setEnv(checkedEnv);
    const env = getEnv();

    // Persist creds + selected env only if the user opted in.
    if (state.rememberDevice) persistCredsIfNeeded(key, secret, env);

    try {
      // Load DB + holdings
      const instrumentDb = await loadJson("./data/exit_tax_instruments_by_isin.json");
      hydrateInstrumentDb(instrumentDb);

      let positions;

      // 1) Try serverless proxy (live/demo), only if proxy URL is configured and creds are present.
      const proxyBase = getProxyBaseUrl();
      if (proxyBase && key && secret) {
        try {
          positions = await loadPositionsViaProxy(key, secret, env);
          showConnectBanner(`Loaded holdings from Trading 212 (${env}) via proxy.`);
        } catch (proxyErr) {
          const msg = String(proxyErr?.message || proxyErr || "");
          console.warn("Proxy fetch failed:", proxyErr);

          // CORS failures usually surface as TypeError: Failed to fetch before we get an HTTP status.
          if (/failed to fetch/i.test(msg) || /cors/i.test(msg)) {
            showConnectBanner(
              `Proxy call blocked (likely CORS).\n` +
              `Origin: ${window.location.origin}\n` +
              `Proxy: ${proxyBase}\n` +
              `Fix: add this origin to the Worker ALLOWED_ORIGINS and redeploy.`
            );
            return;
          }

          // If auth fails, the most common cause is selecting the wrong environment for the key.
          if (/HTTP 401/i.test(msg) || /unauthor/i.test(msg)) {
            showConnectBanner(
              `Trading 212 rejected these credentials (401).\n` +
              `You selected ${env.toUpperCase()}. If these are demo keys, switch Environment to DEMO; if live keys, switch to LIVE.\n` +
              `Then try again.`
            );
            return;
          }

          showConnectBanner(`Proxy call failed (${env}): ${msg}`);
          return;
        }
      }

      // 2) If proxy wasn't attempted (no proxy URL or missing creds), fall back to snapshot/demo.
      if (!positions) {
        const proxyBase = getProxyBaseUrl();
        if (proxyBase && (!key || !secret)) {
          showConnectBanner("Enter your Trading 212 API key + secret (and choose Live/Demo), then click ‘Fetch holdings’." );
          return;
        }

        try {
          positions = await loadPositionsFromDocs();
          const b = $("connectBanner");
          b.textContent = "Loaded holdings from docs/data/positions.json (snapshot mode).";
          b.classList.remove("hidden");
        } catch (err) {
          // 3) Final fallback: demo
          const demo = await safeLoadMockPositions();
          positions = demo.positions || demo.items || demo;
          const b = $("connectBanner");
          b.textContent = "Using demo holdings (could not load proxy or snapshot).";
          b.classList.remove("hidden");
        }
      }

      state.positions = (positions || []).map((p) => {
        const isin = normalizeIsin(p?.isin || p?.instrument?.isin);
        const dbInfo = state.instrumentByIsin.get(isin) || {};
        let rawTicker = p?.ticker ?? p?.instrument?.ticker ?? dbInfo.ticker;
        let rawName = p?.name ?? p?.instrument?.name ?? dbInfo.name;

        // If upstream swaps name/ticker, fix it.
        if (looksLikeTicker(rawName) && !looksLikeTicker(rawTicker)) {
          [rawName, rawTicker] = [rawTicker, rawName];
        }

        return {
          ...p,
          isin,
          ticker: rawTicker,
          name: rawName,
        };
      });
      state.asOf = new Date().toISOString().slice(0, 10);

      // Filter to exit-tax relevant instruments
      const relevant = state.positions.filter(p => isExitTaxInstrument(p.isin));

      if (relevant.length === 0) {
        showConnectBanner("No exit-tax holdings found in demo data (or your DB filter excluded all positions).");
        return;
      }

      // Determine holdings needing info (UX gating)
      const needs = relevant.filter(needsQuestions);

      if (needs.length > 0) {
        renderOverdueQuestions(needs);
        viewOverdue();
      } else {
        viewDashboard();
        renderDashboard();
      }
    } catch (e) {
      showConnectBanner(String(e.message || e));
    }
  });

  $("btnOverdueContinue").addEventListener("click", () => {
    viewDashboard();
    renderDashboard();
  });

  // start on connect view
  viewConnect();
}

async function loadPositionsFromDocs() {
  // Prefer a real snapshot JSON placed at: docs/data/positions.json
  // This keeps the UI static-file friendly (works on GitHub Pages) while we postpone live API wiring.
  const url = new URL("./data/positions.json", import.meta.url);
  // Cache-bust to avoid GH Pages / browser caching stale snapshots
  url.searchParams.set("t", String(Date.now()));
  const res = await fetch(url.toString(), { cache: "no-store" });

  if (!res.ok) {
    throw new Error(
      `positions.json not found (HTTP ${res.status}). Put a Trading212 positions export at docs/data/positions.json`
    );
  }

  const data = await res.json();

  // Accept either a plain list of positions, {items:[...]}, or {positions:[...]}
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.positions)) return data.positions;

  throw new Error(
    "Unsupported positions.json format. Expected an array, {items:[...]}, or {positions:[...]}"
  );
}

// Fallback: if docs/data/mock_positions.json doesn't exist yet, use embedded demo.
async function safeLoadMockPositions() {
  try {
    return await loadJson("./data/mock_positions.json");
  } catch {
    return {
      as_of: new Date().toISOString().slice(0, 10),
      positions: [
        {
          instrument: { isin: "IE00BK5BQT80", ticker: "VWCE", name: "Vanguard FTSE All-World UCITS ETF (Acc)" },
          createdAt: "2019-02-10T00:00:00Z",
          walletImpact: { totalCost: 10000, currentValue: 13750, unrealizedProfitLoss: 3750, currency: "EUR" },
          // Keep legacy fields for compatibility:
          name: "Vanguard FTSE All-World UCITS ETF (Acc)",
          ticker: "VWCE",
          isin: "IE00BK5BQT80",
          total_cost: 10000,
          current_value: 13750,
          earliest_tx_date: "2019-02-10"
        },
        {
          instrument: { isin: "IE00B4L5Y983", ticker: "IWDA", name: "iShares Core MSCI World UCITS ETF (Acc)" },
          createdAt: "2016-05-20T00:00:00Z",
          walletImpact: { totalCost: 9000, currentValue: 8200, unrealizedProfitLoss: -800, currency: "EUR" },
          name: "iShares Core MSCI World UCITS ETF (Acc)",
          ticker: "IWDA",
          isin: "IE00B4L5Y983",
          total_cost: 9000,
          current_value: 8200,
          earliest_tx_date: "2016-05-20"
        }
      ]
    };
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();
