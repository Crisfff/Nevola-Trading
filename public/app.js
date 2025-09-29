// Utils & selects
const $ = (q) => document.querySelector(q);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString();

const els = {
  price: $("#price"),
  balance: $("#balance"),
  equity: $("#equity"),
  openBody: $("#openBody"),
  histBody: $("#histBody"),
  buyBtn: $("#buyBtn"),
  sellBtn: $("#sellBtn"),
  amount: $("#amount"),
  leverage: $("#leverage"),
  tpPct: $("#tpPct"),
  slPct: $("#slPct"),
  symbolSelect: $("#symbolSelect"),
};

let lastState = null;
let currentSymbol = "BTCUSDT";
let tvChart = null;

// -------- TradingView --------
function initTradingView(initial = "BTCUSDT") {
  if (!window.TradingView) {
    console.error("TradingView script no cargó todavía.");
    return;
  }
  window.tvWidget = new TradingView.widget({
    container_id: "tradingview_chart",
    autosize: true,
    symbol: `KUCOIN:${initial}`,
    interval: "30",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "1",
    locale: "es",
    toolbar_bg: "#0b1220",
    enable_publishing: false,
    hide_legend: false,
    allow_symbol_change: true,
    withdateranges: true,
    studies: [],
    details: false,
    hotlist: false,
    calendar: false,
  });

  window.tvWidget.onChartReady(() => {
    tvChart = window.tvWidget.chart();
  });
}

function setWidgetSymbol(symUSDT) {
  const tvSym = `KUCOIN:${symUSDT}`;
  if (tvChart) {
    tvChart.setSymbol(tvSym, "30");
  } else if (window.tvWidget) {
    window.tvWidget.onChartReady(() => window.tvWidget.chart().setSymbol(tvSym, "30"));
  }
}

// -------- API helpers --------
async function getState() {
  const res = await fetch("/api/state");
  const json = await res.json();
  renderState(json);
}

async function place(side) {
  const body = {
    side,
    amount: Number(els.amount.value),
    leverage: Number(els.leverage.value),
    tpPct: Number(els.tpPct.value),
    slPct: Number(els.slPct.value),
  };
  const res = await fetch("/api/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) alert(json.error || "Error al abrir posición");
}

async function closePosition(id) {
  const res = await fetch("/api/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const json = await res.json();
  if (!json.ok) alert("No se pudo cerrar la posición");
}

// -------- Símbolos --------
async function loadSymbols() {
  try {
    const res = await fetch("/api/symbols");
    const { symbols } = await res.json();
    els.symbolSelect.innerHTML = "";
    symbols.forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s.replace("USDT", "/USDT");
      els.symbolSelect.appendChild(opt);
    });
    els.symbolSelect.value = currentSymbol;
  } catch {
    // fallback simple
    els.symbolSelect.innerHTML = `<option value="BTCUSDT">BTC/USDT</option>`;
  }
}

async function changeSymbol(sym) {
  try {
    const res = await fetch("/api/symbol", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym })
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "No se pudo cambiar símbolo");
    currentSymbol = json.symbol;
    setWidgetSymbol(currentSymbol);
    // refrescar estado para que tablas/price queden consistentes
    getState();
  } catch (e) {
    alert(e.message);
    els.symbolSelect.value = currentSymbol; // revert
  }
}

// -------- Reset demo --------
async function resetDemo() {
  const res = await fetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ balance: 1000, price: 60000 })
  });
  const json = await res.json();
  if (json.ok) renderState(json.state);
}

// -------- Render --------
function renderState(st) {
  lastState = st;
  if (st.symbol && st.symbol !== currentSymbol) {
    currentSymbol = st.symbol;
    if (els.symbolSelect) els.symbolSelect.value = currentSymbol;
    setWidgetSymbol(currentSymbol);
  }

  els.price.textContent = fmt(st.price);
  els.balance.textContent = "$" + fmt(st.balance);
  els.equity.textContent = "$" + fmt(st.equity);

  // Posiciones abiertas
  els.openBody.innerHTML = "";
  st.positions.forEach(p => {
    const upnl = pnlNow(p, st.price);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.id}</td>
      <td style="color:${p.side === "BUY" ? "#22c55e" : "#ef4444"}">${p.side}</td>
      <td>${fmt(p.entryPrice)}</td>
      <td>${fmt(p.tpPrice)}</td>
      <td>${fmt(p.slPrice)}</td>
      <td>${fmt(p.amount)}</td>
      <td>${p.leverage}</td>
      <td style="color:${upnl >= 0 ? "#22c55e" : "#ef4444"}">${fmt(upnl)}</td>
      <td><button class="closeBtn" data-id="${p.id}">Cerrar</button></td>
    `;
    els.openBody.appendChild(tr);
  });
  els.openBody.querySelectorAll(".closeBtn").forEach(b =>
    b.addEventListener("click", () => closePosition(Number(b.dataset.id)))
  );

  // Historial
  els.histBody.innerHTML = "";
  st.history.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.id}</td>
      <td style="color:${r.side === "BUY" ? "#22c55e" : "#ef4444"}">${r.side}</td>
      <td>${fmt(r.entryPrice)}</td>
      <td>${fmt(r.exitPrice)}</td>
      <td>${fmt(r.amount)}</td>
      <td>${r.leverage}</td>
      <td style="color:${r.pnl >= 0 ? "#22c55e" : "#ef4444"}">${fmt(r.pnl)}</td>
      <td>${r.reason}</td>
    `;
    els.histBody.appendChild(tr);
  });
}

function pnlNow(p, price) {
  const notional = p.amount * p.leverage;
  const chg = (price - p.entryPrice) / p.entryPrice;
  const dir = p.side === "BUY" ? 1 : -1;
  return Math.round(notional * chg * dir * 100) / 100;
}

// -------- Init --------
function init() {
  initTradingView(currentSymbol); // inicia widget

  // Controles
  els.buyBtn.addEventListener("click", () => place("BUY"));
  els.sellBtn.addEventListener("click", () => place("SELL"));
  document.getElementById("resetBtn").addEventListener("click", resetDemo);

  // Símbolos
  loadSymbols();
  if (els.symbolSelect) {
    els.symbolSelect.addEventListener("change", (e) => changeSymbol(e.target.value));
  }

  // Stream de precios (SSE)
  const es = new EventSource("/api/stream");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "tick") {
        els.price.textContent = fmt(msg.price);
        if (lastState) {
          lastState.price = msg.price;
          els.equity.textContent = "$" + fmt(
            lastState.balance +
            lastState.positions.reduce((a, p) => a + pnlNow(p, msg.price), 0)
          );
        }
      } else if (msg.type === "symbol") {
        // si el backend cambia el símbolo, sincroniza UI y widget
        currentSymbol = msg.symbol;
        if (els.symbolSelect) els.symbolSelect.value = currentSymbol;
        setWidgetSymbol(currentSymbol);
        getState();
      } else {
        // hello / order_open / order_close / reset
        getState();
      }
    } catch {}
  };

  // Pull suave para refrescar tablas
  setInterval(getState, 3000);
  getState();
}

document.addEventListener("DOMContentLoaded", init);
