// public/app.js
const $ = (q) => document.querySelector(q);
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

const els = {
  select: $("#symbolSelect"),
  price: $("#price"),
  balance: $("#balance"),
  equity: $("#equity"),
  amount: $("#amount"),
  leverage: $("#leverage"),
  tpPct: $("#tpPct"),
  slPct: $("#slPct"),
  buy: $("#buyBtn"),
  sell: $("#sellBtn"),
  reset: $("#resetBtn"),
  openBody: $("#openBody"),
  histBody: $("#histBody"),
};

let currentSymbol = "BTCUSDT";
let lastState = null;   // <- cache local para recalcular UPnL y equity
let lastPrice = null;

// ----- TradingView -----
function mountTV(sym) {
  $("#tradingview_chart").innerHTML = "";
  /* global TradingView */
  new TradingView.widget({
    autosize: true,
    symbol: `BINANCE:${sym}`,
    interval: "60",
    timezone: "Etc/UTC",
    theme: "dark",
    style: "1",
    locale: "es",
    container_id: "tradingview_chart",
  });
}

// ----- Fetch helpers -----
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ---- Cálculos ----
function calcUPnL(p, cur) {
  const notional = p.amount * p.leverage;
  const change = (cur - p.entryPrice) / p.entryPrice;
  const dir = p.side === "BUY" ? 1 : -1;
  return notional * change * dir;
}
function sumUPnL(positions, cur) {
  return positions.reduce((acc, p) => acc + calcUPnL(p, cur), 0);
}

// ----- UI render -----
async function refreshState() {
  const s = await jget("/api/state");
  lastState = s;
  currentSymbol = s.symbol;
  lastPrice = s.price;

  // símbolo y precio
  els.select.value = s.symbol;
  els.price.textContent = fmt(s.price);

  // account
  els.balance.textContent = fmt(s.balance);
  els.equity.textContent = fmt(s.equity);

  // abiertas
  els.openBody.innerHTML = s.positions.map(p => `
    <tr data-row="${p.id}">
      <td>${p.id}</td>
      <td>${p.side}</td>
      <td>${fmt(p.entryPrice)}</td>
      <td>${fmt(p.tpPrice)}</td>
      <td>${fmt(p.slPrice)}</td>
      <td>${fmt(p.amount)}</td>
      <td>${p.leverage}</td>
      <td class="upnl">0.00</td>
      <td><button class="close" data-id="${p.id}">Cerrar</button></td>
    </tr>
  `).join("");

  // historial
  els.histBody.innerHTML = s.history.map(h => `
    <tr>
      <td>${h.id}</td>
      <td>${h.side}</td>
      <td>${fmt(h.entryPrice)}</td>
      <td>${fmt(h.exitPrice)}</td>
      <td>${fmt(h.amount)}</td>
      <td>${h.leverage}</td>
      <td style="color:${h.pnl>=0?'#22c55e':'#ef4444'}">${fmt(h.pnl)}</td>
      <td>${h.reason}</td>
    </tr>
  `).join("");

  // primer render de UPnL con el precio actual
  updateLivePnL(lastPrice);
}

function updateLivePnL(curPrice) {
  if (!lastState) return;
  // actualizar cada celda .upnl
  for (const p of lastState.positions) {
    const row = els.openBody.querySelector(`tr[data-row="${p.id}"] .upnl`);
    if (!row) continue;
    const u = calcUPnL(p, curPrice);
    row.textContent = fmt(u);
    row.style.color = u >= 0 ? "#22c55e" : "#ef4444";
  }
  // equity en vivo = balance + sum(UPnL)
  const liveEquity = lastState.balance + sumUPnL(lastState.positions, curPrice);
  els.equity.textContent = fmt(liveEquity);
}

// ----- SSE -----
function connectSSE() {
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if ((msg.type === "hello" || msg.type === "tick") && msg.symbol) {
      // solo si es el símbolo actual
      if (msg.symbol === currentSymbol) {
        lastPrice = msg.price;
        els.price.textContent = fmt(lastPrice);
        // recalcula UPnL y equity sin pedir /api/state
        updateLivePnL(lastPrice);
      }
    }
    if (msg.type === "symbol" || msg.type === "order_open" || msg.type === "order_close" || msg.type === "reset") {
      // cuando cambia estructura de posiciones o símbolo, sí pedimos estado completo
      refreshState();
    }
  };
  es.onerror = () => setTimeout(connectSSE, 1500);
}
connectSSE();

// ----- Eventos UI -----
$("#openBody").addEventListener("click", async (e) => {
  const id = e.target?.dataset?.id;
  if (!id) return;
  await jpost("/api/close", { id: Number(id) });
  await refreshState();
});

els.select.addEventListener("change", async (e) => {
  const sym = e.target.value;
  await jpost("/api/symbol", { symbol: sym });
  currentSymbol = sym;
  mountTV(sym);
  await refreshState();
});

els.buy.addEventListener("click", async () => {
  const payload = {
    side: "BUY",
    amount: Math.max(1, Number(els.amount.value || 0)),
    leverage: Math.min(100, Math.max(1, Number(els.leverage.value || 1))),
    tpPct: Math.max(0.1, Number(els.tpPct.value || 2)),
    slPct: Math.max(0.1, Number(els.slPct.value || 2)),
  };
  await jpost("/api/order", payload);
  await refreshState();
});

els.sell.addEventListener("click", async () => {
  const payload = {
    side: "SELL",
    amount: Math.max(1, Number(els.amount.value || 0)),
    leverage: Math.min(100, Math.max(1, Number(els.leverage.value || 1))),
    tpPct: Math.max(0.1, Number(els.tpPct.value || 2)),
    slPct: Math.max(0.1, Number(els.slPct.value || 2)),
  };
  await jpost("/api/order", payload);
  await refreshState();
});

els.reset.addEventListener("click", async () => {
  await jpost("/api/reset", { balance: 1000 });
  await refreshState();
});

// ----- Inicialización -----
(async function init() {
  // llena selector con los símbolos del backend
  try {
    const { symbols } = await jget("/api/symbols");
    const base = symbols.filter(s => ["BTCUSDT","ETHUSDT","XRPUSDT","BNBUSDT"].includes(s));
    const list = base.length ? base : symbols;
    els.select.innerHTML = list.map(s => `<option value="${s}">${s.replace("USDT","")}/USDT</option>`).join("");
  } catch {
    // fallback mínimo
    els.select.innerHTML = ["BTCUSDT","ETHUSDT","XRPUSDT","BNBUSDT"]
      .map(s => `<option value="${s}">${s.replace("USDT","")}/USDT</option>`).join("");
  }
  mountTV(currentSymbol);
  await refreshState();
})();
