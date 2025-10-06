// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // en Node <18; en Node 18+ ya existe global fetch
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // sirve frontend

// ====== PARES SOPORTADOS (USDT) ======
const ALLOWED_SYMBOLS = [
  "BTCUSDT","ETHUSDT","XRPUSDT","BNBUSDT",
  // puedes dejar los demás si quieres; no estorban
  "ADAUSDT","UNIUSDT","TRXUSDT","SOLUSDT","DOTUSDT","LTCUSDT",
  "SUIUSDT","AVAXUSDT","ATPUSDT"
];
const ALLOWED_SET = new Set(ALLOWED_SYMBOLS);

// --------- Estado en memoria (demo) ---------
const state = {
  symbol: "BTCUSDT",
  price: 60000,      // se sobrescribe con live
  balance: 1000,     // USD demo
  positions: [],     // abiertas
  history: []        // cerradas
};
let nextId = 1;

// --------- Utilidades ---------
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const round2 = (x) => Math.round(x * 100) / 100;

// simulación (fallback si falla KuCoin)
function stepPrice() {
  const drift = 0;
  const vol = 0.0008; // 0.08%
  const shock = state.price * ((Math.random() - 0.5) * 2 * vol + drift);
  state.price = Math.max(100, state.price + shock);
}

// KuCoin helpers
function toKucoinSymbol(sym) {
  return sym.includes("-") ? sym : sym.replace(/USDT$/i, "-USDT"); // BTCUSDT -> BTC-USDT
}

async function fetchKucoinPrice(symNoDash) {
  const kSym = toKucoinSymbol(symNoDash); // p.ej. BTC-USDT
  const url = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${kSym}`;

  // timeout defensivo para no colgar el tick
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "trading-demo/1.0 (+https://render.com)" },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`KuCoin HTTP ${res.status}`);
    const json = await res.json();
    const px = Number(json?.data?.price);
    if (!isFinite(px) || px <= 0) throw new Error("Precio KuCoin inválido");
    return px;
  } finally {
    clearTimeout(t);
  }
}

// ===== Loop de precio: usa siempre state.symbol =====
async function tickLoop() {
  try {
    // intenta precio real del símbolo actual
    state.price = await fetchKucoinPrice(state.symbol);
  } catch {
    // si falla KuCoin (símbolo no existe o red), simula para no congelar
    stepPrice();
  }

  // Auto TP/SL
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

  // Emitir tick
  broadcastSSE({ type: "tick", symbol: state.symbol, price: state.price, ts: Date.now() });
}

// único intervalo (no uses watchers en Render)
setInterval(tickLoop, 1000);

// --------- SSE: /api/stream (precio en vivo) ---------
const sseClients = new Set();
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  // saludo inicial
  res.write(`data: ${JSON.stringify({ type: "hello", price: state.price, symbol: state.symbol })}\n\n`);
  sseClients.add(res);

  // heartbeat para que proxies no corten
  const hb = setInterval(() => res.write(`: ping\n\n`), 15000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

function broadcastSSE(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// --------- API REST ---------
app.get("/api/symbols", (_req, res) => res.json({ symbols: ALLOWED_SYMBOLS }));

app.post("/api/symbol", (req, res) => {
  const raw = (req.body?.symbol || "").toUpperCase();
  if (!ALLOWED_SET.has(raw)) {
    return res.status(400).json({ ok: false, error: "Símbolo no permitido", allowed: ALLOWED_SYMBOLS });
  }
  state.symbol = raw; // ej: ETHUSDT
  broadcastSSE({ type: "symbol", symbol: state.symbol });
  res.json({ ok: true, symbol: state.symbol });
});

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

  if (state.balance < position.amount) return res.status(400).json({ error: "Balance insuficiente" });

  state.balance -= position.amount;
  state.positions.push(position);
  broadcastSSE({ type: "order_open", position, balance: round2(state.balance) });
  res.json({ ok: true, position, balance: round2(state.balance) });
});

app.post("/api/close", (req, res) => {
  const { id } = req.body || {};
  const pos = state.positions.find(p => p.id === Number(id));
  if (!pos) return res.status(404).json({ error: "posición no encontrada" });
  const record = closePosition(pos.id, "MANUAL", Date.now());
  res.json({ ok: true, record, balance: round2(state.balance), equity: round2(calcEquity()) });
});

// Reset demo
function resetState({ balance = 1000, price = 60000 } = {}) {
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
  res.json({ ok: true, state: {
    symbol: state.symbol,
    price: state.price,
    balance: state.balance,
    equity: calcEquity(),
    positions: state.positions,
    history: state.history
  }});
});

// Helpers de trading
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
function closePosition(id, reason, tsClose) {
  const idx = state.positions.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const p = state.positions[idx];
  const exit = state.price;
  const pnl = calcPnL(p, exit);
  state.balance += p.amount + pnl; // liberar margen + PnL

  const record = {
    ...p,
    exitPrice: exit,
    pnl: round2(pnl),
    reason,
    tsClose
  };
  state.positions.splice(idx, 1);
  state.history.unshift(record);
  broadcastSSE({ type: "order_close", record, balance: round2(state.balance) });
  return record;
}

// Salud
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Trading Demo backend corriendo en http://localhost:${PORT}`);
});
