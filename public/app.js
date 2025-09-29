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
};

let lastState = null;

// -------- TradingView --------
function initTradingView() {
  if (!window.TradingView) {
    console.error("TradingView script no cargó todavía.");
    return;
  }
  // Docs: https://www.tradingview.com/widget/advanced-chart/
  window.tvWidget = new TradingView.widget({
    container_id: "tradingview_chart",
    autosize: true,
    symbol: "BINANCE:BTCUSDT",
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

// -------- Reset demo --------
async function resetDemo() {
  const res = await fetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ balance: 1000, price: 60000 }) // valores iniciales
  });
  const json = await res.json();
  if (json.ok) renderState(json.state);
}

// -------- Render --------
function renderState(st) {
  lastState = st;
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
  // botones close
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
  initTradingView(); // Widget pro

  els.buyBtn.addEventListener("click", () => place("BUY"));
  els.sellBtn.addEventListener("click", () => place("SELL"));
  document.getElementById("resetBtn").addEventListener("click", resetDemo);

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
