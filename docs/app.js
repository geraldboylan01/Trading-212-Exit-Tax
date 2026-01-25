// File: docs/app.js
// Phase 1 UI flow with demo data:
// Connect -> (Overdue questions if needed) -> Dashboard
//
// Later (Phase 2), btnFetchHoldings will call the Trading212 API and build the same "positions" shape.

const EXIT_TAX_RATE = 0.38;

// Approx date diff is fine for UI gating; exact anniversary uses date math.
const state = {
  asOf: null,
  positions: [],
  instrumentByIsin: new Map(),
  answersByIsin: new Map(), // { lastExitTaxDate: "YYYY-MM-DD", valueAtThatDate: number }
  selectedIsin: null,
  rememberDevice: false,
  chart: null,
};

function $(id) { return document.getElementById(id); }

function normalizeIsin(isin) {
  return (isin || "").trim().toUpperCase();
}

function parseDateISO(s) {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(d) {
  if (!(d instanceof Date)) return "—";
  return d.toISOString().slice(0, 10);
}

function addYears(d, years) {
  const copy = new Date(d.getTime());
  copy.setFullYear(copy.getFullYear() + years);
  return copy;
}

function money(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(n);
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
  return state.instrumentByIsin.has(normalizeIsin(isin));
}

// ---------- Overdue logic ----------
function nextDeemedDisposalDate(earliestTxDate) {
  const start = parseDateISO(earliestTxDate);
  if (!start) return null;
  return addYears(start, 8);
}

function isOverdue(pos) {
  // Overdue means: as of date is AFTER the next deemed disposal date,
  // AND we do not have the required "last exit tax date" + "value at that date".
  const asOf = parseDateISO(state.asOf);
  const next = nextDeemedDisposalDate(pos.earliest_tx_date);
  if (!asOf || !next) return false;

  const passed = asOf.getTime() > next.getTime();

  if (!passed) return false;

  const ans = state.answersByIsin.get(normalizeIsin(pos.isin));
  const ok = ans && parseDateISO(ans.lastExitTaxDate) && Number.isFinite(ans.valueAtThatDate);
  return !ok;
}

function computeGain(pos) {
  const cost = (pos.total_cost ?? 0);
  const value = (pos.current_value ?? 0);
  return value - cost;
}

function computeTax(pos) {
  // In Phase 1, if overdue we do not compute.
  // If gain <= 0 => tax 0.
  const gain = computeGain(pos);
  if (gain <= 0) return 0;
  return gain * EXIT_TAX_RATE;
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
function renderOverdueQuestions(overduePositions) {
  const container = $("overdueList");
  container.innerHTML = "";

  for (const pos of overduePositions) {
    const isin = normalizeIsin(pos.isin);
    const existing = state.answersByIsin.get(isin);

    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <div class="overdue-item-title">${escapeHtml(pos.ticker || "Holding")} • ${escapeHtml(isin)}</div>
      <div class="overdue-item-sub">${escapeHtml(pos.name || "")}</div>

      <div class="form">
        <div class="field">
          <label>Date you last paid exit tax for this fund</label>
          <input type="date" id="d_${isin}" />
          <div class="small">If unsure, use the closest known date when you last returned exit tax for this fund.</div>
        </div>

        <div class="field">
          <label>Value of this investment on that date</label>
          <input inputmode="decimal" placeholder="e.g. 12500" id="v_${isin}" />
          <div class="small">This value is used as your new starting point for the next deemed disposal cycle.</div>
        </div>

        <div class="row row-right">
          <button class="btn btn-accent" id="s_${isin}">Save</button>
        </div>

        <div class="small" id="m_${isin}"></div>
      </div>
    `;

    container.appendChild(card);

    // populate values if already saved
    const dateEl = document.getElementById(`d_${isin}`);
    const valEl = document.getElementById(`v_${isin}`);
    const msgEl = document.getElementById(`m_${isin}`);
    const saveEl = document.getElementById(`s_${isin}`);

    if (existing) {
      if (existing.lastExitTaxDate) dateEl.value = existing.lastExitTaxDate;
      if (Number.isFinite(existing.valueAtThatDate)) valEl.value = String(existing.valueAtThatDate);
    }

    saveEl.addEventListener("click", () => {
      const lastExitTaxDate = (dateEl.value || "").trim();
      const valueAtThatDate = Number((valEl.value || "").trim());

      const okDate = !!parseDateISO(lastExitTaxDate);
      const okVal = Number.isFinite(valueAtThatDate) && valueAtThatDate >= 0;

      if (!okDate || !okVal) {
        msgEl.textContent = "Please enter a valid date and a non-negative value.";
        return;
      }

      state.answersByIsin.set(isin, { lastExitTaxDate, valueAtThatDate });
      msgEl.textContent = "Saved.";

      persistAnswersIfNeeded();
    });
  }
}

// ---------- Rendering: Dashboard ----------
function renderDashboard() {
  const relevant = state.positions.filter(p => isExitTaxInstrument(p.isin));

  // summary
  const totalValue = relevant.reduce((s, p) => s + (p.current_value ?? 0), 0);
  const totalGain = relevant.reduce((s, p) => s + computeGain(p), 0);

  let overdueCount = 0;
  let totalTax = 0;

  for (const p of relevant) {
    if (isOverdue(p)) {
      overdueCount += 1;
    } else {
      totalTax += computeTax(p);
    }
  }

  $("summary").textContent =
    `${relevant.length} exit-tax holdings • ` +
    `Value ${money(totalValue)} • ` +
    `Net P/L ${money(totalGain)} • ` +
    `Est. exit tax today ${money(totalTax)} • ` +
    `${overdueCount} overdue`;

  // overdue banner
  const banner = $("overdueBanner");
  if (overdueCount > 0) {
    banner.textContent =
      "Overdue deemed disposal detected. This tool cannot estimate exit tax for overdue holdings until you provide the value at your last exit-tax date. Consider seeking professional tax advice.";
    show(banner);
  } else {
    hide(banner);
  }

  renderHoldingsTable(relevant);
  renderChart(relevant);

  // default selection
  if (!state.selectedIsin && relevant.length > 0) {
    state.selectedIsin = normalizeIsin(relevant[0].isin);
  }

  renderRightPanel(relevant);
}

function renderHoldingsTable(rows) {
  const tbody = $("holdingsTbody");
  tbody.innerHTML = "";

  // sort overdue first, then by value desc
  const sorted = [...rows].sort((a, b) => {
    const oa = isOverdue(a) ? 0 : 1;
    const ob = isOverdue(b) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return (b.current_value ?? 0) - (a.current_value ?? 0);
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

    const next = nextDeemedDisposalDate(pos.earliest_tx_date);
    const overdue = isOverdue(pos);

    let taxCell = "";
    if (overdue) {
      taxCell = `<span class="neg">Overdue</span>`;
    } else {
      const tax = computeTax(pos);
      taxCell = `${money(tax)}`;
    }

    tr.innerHTML = `
      <td>
        <div style="font-weight:900">${escapeHtml(pos.ticker || "—")}</div>
        <div style="color: var(--muted); font-size: 12px; margin-top: 2px; max-width: 420px; overflow: hidden; text-overflow: ellipsis;">
          ${escapeHtml(pos.name || "")}
        </div>
      </td>
      <td>${escapeHtml(isin)}</td>
      <td class="num">${money(pos.current_value ?? 0)}</td>
      <td class="num ${gainClass}">${gainLabel} ${money(Math.abs(gain))}</td>
      <td>${next ? fmtDate(next) : "—"}</td>
      <td class="num">${taxCell}</td>
    `;

    tbody.appendChild(tr);
  }
}

function renderRightPanel(rows) {
  const drawerBody = $("drawerBody");
  const subtitle = $("assumptionsSubtitle");

  const selected = rows.find(p => normalizeIsin(p.isin) === state.selectedIsin);

  if (!selected) {
    subtitle.textContent = "Select a holding to view details";
    drawerBody.innerHTML = `<div class="empty">Select a holding to see how dates and tax are calculated.</div>`;
    return;
  }

  const isin = normalizeIsin(selected.isin);
  const gain = computeGain(selected);
  const gainIsLoss = gain < 0;
  const overdue = isOverdue(selected);
  const next = nextDeemedDisposalDate(selected.earliest_tx_date);

  subtitle.textContent = `${selected.ticker || "Holding"} • ${isin}`;

  const tax = overdue ? null : computeTax(selected);

  drawerBody.innerHTML = `
    <div class="section-title">Assumptions</div>
    <div class="kv">
      <div class="card">
        <div class="label">Exit tax rate</div>
        <div class="value">${(EXIT_TAX_RATE * 100).toFixed(0)}%</div>
      </div>
      <div class="card">
        <div class="label">As of date</div>
        <div class="value">${escapeHtml(state.asOf || "—")}</div>
      </div>
      <div class="card">
        <div class="label">Start date rule</div>
        <div class="value">Earliest transaction date</div>
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
        <div class="value">${money(selected.current_value ?? 0)}</div>
      </div>
      <div class="card">
        <div class="label">${gainIsLoss ? "Loss" : "Gain"}</div>
        <div class="value">${money(Math.abs(gain))}</div>
      </div>
      <div class="card">
        <div class="label">Start date used</div>
        <div class="value">${escapeHtml(selected.earliest_tx_date || "—")}</div>
      </div>
      <div class="card">
        <div class="label">Next deemed disposal date</div>
        <div class="value">${next ? fmtDate(next) : "—"}</div>
      </div>
      <div class="card">
        <div class="label">Exit tax (if today)</div>
        <div class="value">${overdue ? `<span class="neg">Overdue</span>` : money(tax)}</div>
        <div class="small">${overdue ? "Answer the overdue questions to calculate this holding." : (gain <= 0 ? "No exit tax is estimated where gain is zero or negative." : "")}</div>
      </div>
      <div class="card">
        <div class="label">Notes</div>
        <div class="value">${overdue ? "Action required" : "OK"}</div>
      </div>
    </div>
  `;
}

// ---------- Chart ----------
function renderChart(rows) {
  const ctx = $("barChart");
  if (!ctx || typeof Chart === "undefined") return;

  const labels = rows.map(p => (p.ticker || normalizeIsin(p.isin)).slice(0, 10));
  const values = rows.map(p => (p.current_value ?? 0));

  // Tax series: overdue => 0 (but tooltips will clarify via label)
  const taxes = rows.map(p => (isOverdue(p) ? 0 : computeTax(p)));

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  state.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Value", data: values },
        { label: "Exit tax (if today)", data: taxes },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        tooltip: {
          callbacks: {
            afterLabel: (tt) => {
              const idx = tt.dataIndex;
              const p = rows[idx];
              if (tt.datasetIndex === 1 && isOverdue(p)) return "Overdue (needs answers)";
              if (tt.datasetIndex === 1 && computeGain(p) <= 0) return "No tax (no gain)";
              return "";
            }
          }
        },
        legend: { labels: { color: "#e9f1ff" } }
      },
      scales: {
        x: { ticks: { color: "#e9f1ff" }, grid: { color: "rgba(233,241,255,0.06)" } },
        y: { ticks: { color: "#e9f1ff" }, grid: { color: "rgba(233,241,255,0.06)" } },
      }
    }
  });
}

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

function persistCredsIfNeeded(key, secret) {
  if (!state.rememberDevice) return;
  try {
    localStorage.setItem("t212ApiKey", key || "");
    localStorage.setItem("t212ApiSecret", secret || "");
  } catch {}
}

function loadPersistedCredsIfAny() {
  try {
    const key = localStorage.getItem("t212ApiKey") || "";
    const secret = localStorage.getItem("t212ApiSecret") || "";
    $("apiKey").value = key;
    $("apiSecret").value = secret;
  } catch {}
}

// ---------- Init / event wiring ----------
async function init() {
  $("btnReload").addEventListener("click", () => window.location.reload());
  $("btnClose").addEventListener("click", () => {
    state.selectedIsin = null;
    renderDashboard();
  });

  loadPersistedCredsIfAny();
  loadPersistedAnswersIfAny();

  $("btnFetchHoldings").addEventListener("click", async () => {
    clearConnectBanner();

    state.rememberDevice = $("rememberDevice").checked;

    const key = ($("apiKey").value || "").trim();
    const secret = ($("apiSecret").value || "").trim();

    // Phase 1: we accept empty creds but keep UX
    if (state.rememberDevice) persistCredsIfNeeded(key, secret);

    try {
      // Load DB + demo holdings
      const [instrumentDb, mock] = await Promise.all([
        loadJson("./data/exit_tax_instruments_by_isin.json"),
        safeLoadMockPositions(),
      ]);

      hydrateInstrumentDb(instrumentDb);

      state.asOf = mock.as_of || new Date().toISOString().slice(0, 10);
      state.positions = (mock.positions || []).map(p => ({
        ...p,
        isin: normalizeIsin(p.isin),
      }));

      // Filter to exit-tax relevant instruments
      const relevant = state.positions.filter(p => isExitTaxInstrument(p.isin));

      if (relevant.length === 0) {
        showConnectBanner("No exit-tax holdings found in demo data (or your DB filter excluded all positions).");
        return;
      }

      // Determine overdue holdings
      const overdue = relevant.filter(p => {
        const asOf = parseDateISO(state.asOf);
        const next = nextDeemedDisposalDate(p.earliest_tx_date);
        return asOf && next && asOf.getTime() > next.getTime();
      });

      if (overdue.length > 0) {
        renderOverdueQuestions(overdue);
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

// Fallback: if docs/data/mock_positions.json doesn't exist yet, use embedded demo.
async function safeLoadMockPositions() {
  try {
    return await loadJson("./data/mock_positions.json");
  } catch {
    return {
      as_of: new Date().toISOString().slice(0, 10),
      positions: [
        {
          name: "Vanguard FTSE All-World UCITS ETF (Acc)",
          ticker: "VWCE",
          isin: "IE00BK5BQT80",
          total_cost: 10000,
          current_value: 13750,
          earliest_tx_date: "2019-02-10"
        },
        {
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