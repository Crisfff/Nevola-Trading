import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // frontend

// --------- Estado en memoria (demo) ---------
const state = {
  symbol: "BTCUSDT",
  price: 60000,        // precio inicial (se sobrescribe con live)
  balance: 1000,       // USD demo
  positions: [],       // abiertas
  history: []          // cerradas
};

let nextId = 1;

// --------- Simulación (fallback) ---------
function stepPrice() {
  const drift = 0;
  const vol = 0.0008; // 0.08%
  const shock = state.price * (drift + (Math.random() - 0.5) * 2 * vol);
  state.price = Math.max(100, state.price + shock);
}

// ===== Precio en vivo (KuCoin, sin API keys) con fallback a simulación =====
const LIVE_SYMBOL = "BTCUSDT"; // debe coincidir con el widget (KUCOIN:BTCUSDT)

function toKucoinSymbol(sym) {
  return sym.includes("-") ? sym : sym.replace(/USDT$/i, "-USDT"); // BTCUSDT -> BTC-USDT
}

async function fetchKucoinPrice(sym) {
  const kSym = toKucoinSymbol(sym);
  const url = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${kSym}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`KuCoin HTTP ${res.status}`);
  const json = await res.json();
  const px = Number(json?.data?.price);
  if (!isFinite(px) || px <= 0) throw new Error("Precio KuCoin inválido");
  return px;
}

async function tickLoop() {
  try {
    // Intentar siempre precio real de KuCoin
    state.price = await fetchKucoinPrice(LIVE_SYMBOL);
  } catch (_e) {
    // Si falla, simular un paso para no congelar
    stepPrice();
  }

  // Auto-chequeo TP/SL
  const now = Date.now();
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const p = state.positions[i];
    const cur = state.price;
    const hitTP = p.side === "BUY" ? cur >= p.tpPrice : cur <= p.tpPrice;
    const hitSL = p.side === "BUY" ? cur <= p.slPrice : cur >= p.slPrice;
    if (hitTP || hitSL) {
      closePosition(p.id, hitTP ? "TP" : "SL", now);
    }
  }

  // Emitir tick a clientes
  broadcastSSE({ type: "tick", symbol: state.symbol, price: state.price, ts: Date.now() });
}

// Reemplaza cualquier setInterval anterior por este:
setInterval(tickLoop, 1000);

// --------- SSE: /api/stream (precio en vivo) ---------
const sseClients = new Set();

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", price: state.price })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcastSSE(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

// --------- API REST ---------

// Estado completo (balance, posiciones, historial)
app.get("/api/state", (_req, res) => {
  res.json({
    symbol: state.symbol,
    price: state.price,
    balance: round2(state.balance),
    equity: round2(calcEquity()),
    positions: state.positions,
    history: state.history
  });
});

// Crear orden de mercado (abre posición)
app.post("/api/order", (req, res) => {
  const { side, amount, leverage = 1, tpPct = 2, slPct = 2 } = req.body || {};
  if (!["BUY", "SELL"].includes(side)) return res.status(400).json({ error: "side inválido" });
  if (!(amount > 0)) return res.status(400).json({ error: "amount inválido" });
  if (!(leverage >= 1 && leverage <= 100)) return res.status(400).json({ error: "leverage 1-100" });

  const entry = state.price;
  const id = nextId++;
  const position = {
    id,
    side,
    amount: Number(amount),  // USD de margen
    leverage: Number(leverage),
    entryPrice: entry,
    tpPct: Number(tpPct),
    slPct: Number(slPct),
    tpPrice: side === "BUY" ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100),
    slPrice: side === "BUY" ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100),
    tsOpen: Date.now()
  };

  // bloquear margen
  if (state.balance < position.amount) {
    return res.status(400).json({ error: "Balance insuficiente" });
  }
  state.balance -= position.amount;
  state.positions.push(position);

  broadcastSSE({ type: "order_open", position });

  res.json({ ok: true, position });
});

// Cerrar manualmente
app.post("/api/close", (req, res) => {
  const { id } = req.body || {};
  const pos = state.positions.find(p => p.id === Number(id));
  if (!pos) return res.status(404).json({ error: "posición no encontrada" });
  const record = closePosition(pos.id, "MANUAL", Date.now());
  res.json({ ok: true, record });
});

// --------- Reset demo ---------
function resetState({ balance = 1000, price = 60000 } = {}) {
  state.symbol = "BTCUSDT";
  state.price = Number(price);
  state.balance = Number(balance);
  state.positions = [];
  state.history = [];
  nextId = 1;
}

app.post("/api/reset", (req, res) => {
  const { balance, price } = req.body || {};
  resetState({ balance, price });
  broadcastSSE({ type: "reset" });
  res.json({
    ok: true,
    state: {
      symbol: state.symbol,
      price: state.price,
      balance: state.balance,
      equity: calcEquity(),
      positions: state.positions,
      history: state.history
    }
  });
});

// --------- Helpers de trading ---------
function closePosition(id, reason, tsClose) {
  const idx = state.positions.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const p = state.positions[idx];
  const exit = state.price;
  const pnl = calcPnL(p, exit);

  // liberar margen + PnL
  state.balance += p.amount + pnl;
  const record = {
    ...p,
    exitPrice: exit,
    pnl: round2(pnl),
    reason,
    tsClose
  };
  state.positions.splice(idx, 1);
  state.history.unshift(record); // último arriba

  broadcastSSE({ type: "order_close", record, balance: round2(state.balance) });
  return record;
}

function calcPnL(p, exitPrice) {
  const notional = p.amount * p.leverage;
  const change = (exitPrice - p.entryPrice) / p.entryPrice;
  const dir = p.side === "BUY" ? 1 : -1;
  return round2(notional * change * dir);
}

function calcEquity() {
  const unrealized = state.positions.reduce((acc, p) => acc + calcPnL(p, state.price), 0);
  return state.balance + unrealized;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// Salud
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Trading Demo backend corriendo en http://localhost:${PORT}`);
});
