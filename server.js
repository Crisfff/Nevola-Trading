// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ====== PARES SOPORTADOS (USDT) ======
const ALLOWED_SYMBOLS = ["BTCUSDT","ETHUSDT","XRPUSDT","BNBUSDT","ADAUSDT","UNIUSDT","TRXUSDT","SOLUSDT","DOTUSDT","LTCUSDT","SUIUSDT","AVAXUSDT","ATPUSDT"];
const ALLOWED_SET = new Set(ALLOWED_SYMBOLS);

// --------- Estado en memoria ---------
const state = {
  symbol: "BTCUSDT",
  price: 60000,
  balance: 9000,
  positions: [],   // abiertas
  history: []      // cerradas
};
let nextId = 1;

// --------- Firebase Admin (RTDB) ---------
let db = null;
try {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}";
  const svc = JSON.parse(raw);
  const privateKey = (svc.private_key || "").replace(/\\n/g, "\n");

  if (svc.client_email && privateKey && process.env.FIREBASE_DB_URL) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: svc.project_id,
        clientEmail: svc.client_email,
        privateKey
      }),
      databaseURL: process.env.FIREBASE_DB_URL
    });
    db = admin.database();
    console.log("Firebase Admin ✔ conectado");
  } else {
    console.warn("⚠️ Falta FIREBASE_DB_URL o credenciales de servicio");
  }
} catch (e) {
  console.error("Error Firebase Admin:", e.message);
}

// Paths solicitados por ti:
const ROOT = "Trading Demo/Operaciones"; // sí, con espacio tal como pediste
const PATH_OPEN = `${ROOT}/Abiertas`;
const PATH_CLOSED = `${ROOT}/Cerradas`;

// --------- Utils ---------
const round2 = (x) => Math.round(x * 100) / 100;
function stepPrice() {
  const vol = 0.0008;
  const shock = state.price * ((Math.random() - 0.5) * 2 * vol);
  state.price = Math.max(100, state.price + shock);
}
function toKucoinSymbol(sym) {
  return sym.includes("-") ? sym : sym.replace(/USDT$/i, "-USDT");
}
async function fetchKucoinPrice(symNoDash) {
  const kSym = toKucoinSymbol(symNoDash);
  const url = `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${kSym}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "trading-demo/1.1 (+render)" }, signal: controller.signal });
    if (!res.ok) throw new Error(`KuCoin HTTP ${res.status}`);
    const j = await res.json();
    const px = Number(j?.data?.price);
    if (!isFinite(px) || px <= 0) throw new Error("Precio KuCoin inválido");
    return px;
  } finally { clearTimeout(t); }
}
function calcPnL(p, exitPrice) {
  const notional = p.amount * p.leverage;
  const change = (exitPrice - p.entryPrice) / p.entryPrice;
  const dir = p.side === "BUY" ? 1 : -1;
  return round2(notional * change * dir);
}
function calcEquity() {
  const unreal = state.positions.reduce((acc, p) => acc + calcPnL(p, state.price), 0);
  return state.balance + unreal;
}

// --------- Persistencia Firebase ---------
async function fbSet(path, obj) { if (!db) return; await db.ref(path).set(obj); }
async function fbUpdate(path, obj) { if (!db) return; await db.ref(path).update(obj); }
async function fbRemove(path) { if (!db) return; await db.ref(path).remove(); }
async function fbPush(path, obj) { if (!db) return (await db.ref(path).push(obj)).key; }

async function saveOpenToFB(pos) {
  if (!db) return;
  // Guardamos por id legible (numérico) para que sea fácil de ver
  await fbSet(`${PATH_OPEN}/${pos.id}`, pos);
}
async function saveClosedToFB(rec) {
  if (!db) return;
  await fbSet(`${PATH_CLOSED}/${rec.id}`, rec);
}
async function removeOpenFromFB(id) {
  if (!db) return;
  await fbRemove(`${PATH_OPEN}/${id}`);
}

async function loadFromFirebaseOnBoot() {
  if (!db) return;
  try {
    const snapOpen = await db.ref(PATH_OPEN).once("value");
    const snapClosed = await db.ref(PATH_CLOSED).once("value");
    const opens = snapOpen.val() || {};
    const closed = snapClosed.val() || {};
    state.positions = Object.values(opens);
    state.history = Object.values(closed).sort((a,b)=>b.tsClose - a.tsClose);
    // nextId avanza
    const maxId = [...state.positions, ...state.history].reduce((m,x)=>Math.max(m, Number(x?.id||0)), 0);
    nextId = Math.max(1, maxId + 1);
    console.log(`Firebase boot: abiertas=${state.positions.length}, cerradas=${state.history.length}`);
  } catch (e) {
    console.warn("Firebase boot load error:", e.message);
  }
}
await loadFromFirebaseOnBoot().catch(()=>{});

// --------- SSE ---------
const sseClients = new Set();
function broadcastSSE(payload) {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "hello", price: state.price, symbol: state.symbol })}\n\n`);
  sseClients.add(res);
  const hb = setInterval(() => res.write(`: ping\n\n`), 15000);
  req.on("close", () => { clearInterval(hb); sseClients.delete(res); });
});

// --------- Loop de precio (cada 1s) ---------
async function tickLoop() {
  try { state.price = await fetchKucoinPrice(state.symbol); } catch { stepPrice(); }
  // NO cerramos aquí por TP/SL (lo hará el job de 1 min)
  broadcastSSE({ type: "tick", symbol: state.symbol, price: state.price, ts: Date.now() });
}
setInterval(tickLoop, 1000);

// --------- JOB cada 1 minuto: revisar TP/SL de TODAS las abiertas ---------
async function minuteJob() {
  // 1) refrescar precio del símbolo actual (por seguridad)
  try { state.price = await fetchKucoinPrice(state.symbol); } catch { /* ignore */ }

  // 2) evaluar todas las abiertas (pueden ser de distintos símbolos)
  //    — si quieres precisión por símbolo, puedes traer precio por símbolo aquí.
  const now = Date.now();
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const p = state.positions[i];
    // si la posición es de otro símbolo, trae precio de ese símbolo:
    let cur = state.price;
    if (p.symbol !== state.symbol) {
      try { cur = await fetchKucoinPrice(p.symbol); } catch { /* si falla, salta esa vuelta */ continue; }
    }
    const hitTP = p.side === "BUY" ? cur >= p.tpPrice : cur <= p.tpPrice;
    const hitSL = p.side === "BUY" ? cur <= p.slPrice : cur >= p.slPrice;
    if (hitTP || hitSL) {
      await closePosition(p.id, hitTP ? "TP" : "SL", now, cur);
    }
  }
  broadcastSSE({ type: "tick", symbol: state.symbol, price: state.price, ts: Date.now() });
}
setInterval(minuteJob, 60_000);

// --------- API ---------
app.get("/api/symbols", (_req, res) => res.json({ symbols: ALLOWED_SYMBOLS }));
app.post("/api/symbol", async (req, res) => {
  const raw = (req.body?.symbol || "").toUpperCase();
  if (!ALLOWED_SET.has(raw)) return res.status(400).json({ ok:false, error:"Símbolo no permitido", allowed: ALLOWED_SYMBOLS });
  state.symbol = raw;
  broadcastSSE({ type: "symbol", symbol: state.symbol });
  res.json({ ok:true, symbol: state.symbol });
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

// Abrir posición
app.post("/api/order", async (req, res) => {
  const { side, amount, leverage = 1, tpPct = 2, slPct = 2 } = req.body || {};
  if (!["BUY","SELL"].includes(side)) return res.status(400).json({ error:"side inválido" });
  if (!(amount > 0)) return res.status(400).json({ error:"amount inválido" });
  if (!(leverage >= 1 && leverage <= 100)) return res.status(400).json({ error:"leverage 1-100" });

  const entry = state.price;
  const id = nextId++;
  const pos = {
    id,
    symbol: state.symbol,
    side,
    amount: Number(amount),
    leverage: Number(leverage),
    entryPrice: entry,
    tpPct: Number(tpPct),
    slPct: Number(slPct),
    tpPrice: side === "BUY" ? entry * (1 + tpPct/100) : entry * (1 - tpPct/100),
    slPrice: side === "BUY" ? entry * (1 - slPct/100) : entry * (1 + slPct/100),
    tsOpen: Date.now()
  };
  if (state.balance < pos.amount) return res.status(400).json({ error:"Balance insuficiente" });

  state.balance -= pos.amount;
  state.positions.push(pos);
  // Persistir en Firebase
  await saveOpenToFB(pos).catch(()=>{});
  broadcastSSE({ type: "order_open", position: pos, balance: round2(state.balance) });
  res.json({ ok:true, position: pos, balance: round2(state.balance) });
});

// Cerrar manual
app.post("/api/close", async (req, res) => {
  const { id } = req.body || {};
  const rec = await closePosition(Number(id), "MANUAL", Date.now());
  if (!rec) return res.status(404).json({ error:"posición no encontrada" });
  res.json({ ok:true, record: rec, balance: round2(state.balance), equity: round2(calcEquity()) });
});

// Cerrar todo (opcional)
app.post("/api/close_all", async (_req, res) => {
  const closed = [];
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const p = state.positions[i];
    const rec = await closePosition(p.id, "MANUAL_ALL", Date.now());
    if (rec) closed.push(rec);
  }
  res.json({ ok:true, closed, balance: round2(state.balance), equity: round2(calcEquity()) });
});

// Reset demo
app.post("/api/reset", async (req, res) => {
  const { balance = 1000, price = 60000 } = req.body || {};
  state.price = Number(price);
  state.balance = Number(balance);
  state.positions = [];
  state.history = [];
  nextId = 1;

  // Limpiar en Firebase
  if (db) {
    await fbRemove(PATH_OPEN).catch(()=>{});
    await fbRemove(PATH_CLOSED).catch(()=>{});
  }

  broadcastSSE({ type: "reset" });
  res.json({ ok:true, state: {
    symbol: state.symbol, price: state.price, balance: state.balance,
    equity: calcEquity(), positions: state.positions, history: state.history
  }});
});

// Salud
app.get("/healthz", (_req, res) => res.json({ ok:true }));

// --------- Cierre de posición con persistencia ---------
async function closePosition(id, reason, tsClose, overridePrice = null) {
  const idx = state.positions.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const p = state.positions[idx];

  // si me dieron precio puntual (del minute job) úsalo
  const exit = overridePrice ?? state.price;
  const pnl = calcPnL(p, exit);
  state.balance += p.amount + pnl; // liberar margen + PnL

  const record = { ...p, exitPrice: exit, pnl: round2(pnl), reason, tsClose };

  // Persistencia: mover de Abiertas -> Cerradas
  state.positions.splice(idx, 1);
  state.history.unshift(record);

  try {
    await removeOpenFromFB(p.id);
    await saveClosedToFB(record);
  } catch (e) {
    console.warn("FB move open->closed error:", e.message);
  }

  broadcastSSE({ type: "order_close", record, balance: round2(state.balance) });
  return record;
}

app.listen(PORT, () => console.log(`Trading Demo backend en http://localhost:${PORT}`));
