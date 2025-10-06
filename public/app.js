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
    hide_top_toolbar: false,
    hide_legend: false,
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

// ----- UI update -----
async function refreshState() {
  const s = await jget("/api/state");
  currentSymbol = s.symbol;
  els.select.value = s.symbol;
  els.price.textContent = fmt(s.price);
  els.balance.textContent = fmt(s.balance);
  els.equity.textContent = fmt(s.equity);

  // abiertas
  els.openBody.innerHTML = s.positions.map(p => `
    <tr>
      <td>${p.id}</td>
      <td>${p.side}</td>
      <td>${fmt(p.entryPrice)}</td>
      <td>${fmt(p.tpPrice)}</td>
      <td>${fmt(p.slPrice)}</td>
      <td>${fmt(p.amount)}</td>
      <td>${p.leverage}</td>
      <td>${fmt(calcUPnL(p, s.price))}</td>
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
}

function calcUPnL(p, cur) {
  const notional = p.amount * p.leverage;
  const change = (cur - p.entryPrice) / p.entryPrice;
  const dir = p.side === "BUY" ? 1 : -1;
  return notional * change * dir;
}

// ----- SSE -----
function connectSSE() {
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello" || msg.type === "tick") {
      if (msg.symbol === currentSymbol) {
        els.price.textContent = fmt(msg.price);
      }
    }
    if (msg.type === "order_open" || msg.type === "order_close" || msg.type === "reset") {
      refreshState();
    }
  };
  es.onerror = () => setTimeout(connectSSE, 1500);
}
connectSSE();

// ----- Eventos UI -----
els.select.addEventListener("change", async (e) => {
  const sym = e.target.value;
  await jpost("/api/symbol", { symbol: sym });
  currentSymbol = sym;
  mountTV(sym);
  refreshState();
});

els.buy.addEventListener("click", async () => {
  const payload = {
    side: "BUY",
    amount: Number(els.amount.value),
    leverage: Number(els.leverage.value),
    tpPct: Number(els.tpPct.value),
    slPct: Number(els.slPct.value),
  };
  await jpost("/api/order", payload);
  refreshState();
});

els.sell.addEventListener("click", async () => {
  const payload = {
    side: "SELL",
    amount: Number(els.amount.value),
    leverage: Number(els.leverage.value),
    tpPct: Number(els.tpPct.value),
    slPct: Number(els.slPct.value),
  };
  await jpost("/api/order", payload);
  refreshState();
});

els.reset.addEventListener("click", async () => {
  await jpost("/api/reset", { balance: 1000 });
  refreshState();
});

// cerrar desde tabla
$("#openBody").addEventListener("click", async (e) => {
  const id = e.target?.dataset?.id;
  if (!id) return;
  await jpost("/api/close", { id: Number(id) });
  refreshState();
});

// ----- Inicialización -----
(async function init() {
  // llena select con /api/symbols
  try {
    const { symbols } = await jget("/api/symbols");
    // conserva el valor actual si existe
    const current = els.select.value || "BTCUSDT";
    els.select.innerHTML = symbols.map(s => `<option value="${s}">${s.replace("USDT","")}/USDT</option>`).join("");
    els.select.value = current;
  } catch {}
  mountTV(currentSymbol);
  refreshState();
})();
