#!/usr/bin/env node
/**
 * Daily momentum screener — runs every weekday at 7am ET.
 * Ready in TradingView by 8 AM.
 *
 * Methodology (Clase #5 — Price Action Pro):
 *   1. First pass: NYSE+NASDAQ, $3–$25, mcap>100M, volume>300k
 *   2. For each candidate: fetch 65 daily bars + 60 1H bars
 *   3. Hard filters:
 *        – ≥2 days with intraday high ≥10% above prior close (last 60d)
 *        – ATR% ≥ 5% (stock moves enough to be worthwhile)
 *        – Daily BB setup score ≥ 60 (valid entry zone — not extended)
 *        – 1H BB also in entry zone (B% < 50 on 1H)
 *        – Volume surge ≥ 1.3x average (unusual volume yesterday)
 *        – Price ≤ 75% of 52-week high (room to run)
 *   4. Score = setupScore×1.5 + days10pct×4 + atrPct×2 + volSurge×5 + recommend×10 + 1Hbonus×15
 *   5. Top 6 → update both watchlists
 */
import { screenStocks } from "./screener.js";
import { getOHLCV } from "./ohlcv.js";
import { getWatchlist, removeSymbols, addSymbols } from "./watchlists.js";

const PICKS_LIST_ID  = "331643931"; // "Activos Para Manana"
const MAIN_LIST_ID   = "331256401"; // "Lista de seguimiento"
const SECTION_HEADER = "###Activos Para Manana";

// ── Hard filter thresholds ────────────────────────────────────────────────────
const MIN_10PCT_DAYS  = 3;     // ≥3 days of intraday +10% spike in last 60 days (proven mover)
const MIN_ATR_PCT     = 7;     // ATR14 ≥ 7% — needs enough range to hit 10% in a day
const MIN_SETUP_SCORE = 65;    // BB setup must be valid entry zone
const MIN_WIN_RATE    = 30;    // win rate ≥ 30% on historical big-day follow-through
const MIN_VOL_SURGE   = 0.8;   // min liquidity check (score boosts for higher surge)
const MAX_PRICE_VS_52 = 0.75;  // price ≤ 75% of 52-week high (still has room)
const MIN_MCAP        = 100_000_000; // market cap ≥ $100M (Class #5 rule)
const MAX_PICKS       = 6;

interface Candidate {
  symbol:       string;
  close:        number;
  change:       number;
  rsi:          number;
  recommend:    number;
  high52w:      number;
  pctOf52wHigh: number;
  atrPct:       number;
  days10pct:    number;
  days5pct:     number;
  winRate:      number;
  bbPct:        number;   // daily B%
  bbPct1H:      number;   // 1H B%
  setup:        string;
  setupScore:   number;
  trend:        string;
  volSurge:     number;
  sector:       string;
  score:        number;
}

type BacktestResult = {
  days10pct: number; days5pct: number; atrPct: number; winRate: number;
  bbPct: number; bbUpper: number; bbMiddle: number; bbLower: number;
  bbPct1H: number;
  bbExpanding: boolean; puntoMedioAlcista: boolean; bbWidthPctOfPrice: number;
  setup: string; setupScore: number;
  trend: "up" | "down" | "neutral";
};

// ── BB(20,2) helper ───────────────────────────────────────────────────────────
function computeBB(closes: number[]) {
  const n = closes.length;
  if (n < 20) return null;
  const sl = closes.slice(-20);
  const ma = sl.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(sl.reduce((a, b) => a + (b - ma) ** 2, 0) / 20);
  const upper = ma + 2 * sd, lower = ma - 2 * sd, bw = upper - lower;
  const bpct = bw > 0 ? (closes[n - 1] - lower) / bw * 100 : 50;
  return { upper, middle: ma, lower, bpct };
}

async function backtest(symbol: string): Promise<BacktestResult | null> {
  try {
    // ── Daily bars (65 days for 60-day window + BB warmup) ───────────────────
    const dataD = await getOHLCV(symbol, "1D", { countback: 65 });
    const barsD: { open: number; high: number; low: number; close: number; volume: number }[] =
      (dataD as { bars?: typeof barsD }).bars ?? (dataD as typeof barsD);
    if (barsD.length < 22) return null;

    const closes = barsD.map(b => b.close);
    const opens  = barsD.map(b => b.open);
    const highs  = barsD.map(b => b.high);
    const lows   = barsD.map(b => b.low);
    const n      = closes.length;

    // Count days where intraday high was ≥10% above prior close
    let days10 = 0, days5 = 0;
    const nextDayResults: number[] = [];
    for (let i = 1; i < n - 1; i++) {
      const move = (highs[i] - closes[i - 1]) / closes[i - 1] * 100;
      if (move >= 10) { days10++; nextDayResults.push(closes[i + 1] - closes[i]); }
      if (move >= 5)  days5++;
    }

    // ATR (14-period)
    const trues: number[] = [];
    for (let i = 1; i < n; i++) {
      trues.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i]  - closes[i - 1])
      ));
    }
    const atr    = trues.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const atrPct = (atr / closes[n - 1]) * 100;

    const wins    = nextDayResults.filter(x => x > 0).length;
    const winRate = nextDayResults.length > 0 ? (wins / nextDayResults.length) * 100 : 0;

    // Daily BB — last 3 bars for pattern detection
    const bbBars: { upper: number; middle: number; lower: number; bpct: number }[] = [];
    for (let i = n - 3; i < n; i++) {
      const sl = closes.slice(i - 19, i + 1);
      const ma = sl.reduce((a, b) => a + b, 0) / 20;
      const sd = Math.sqrt(sl.reduce((a, b) => a + (b - ma) ** 2, 0) / 20);
      const up = ma + 2 * sd, lo = ma - 2 * sd, bw = up - lo;
      bbBars.push({ upper: up, middle: ma, lower: lo, bpct: bw > 0 ? (closes[i] - lo) / bw * 100 : 50 });
    }
    const bbCur   = bbBars[2];
    const bbPrev  = bbBars[1];
    const bbPct   = bbCur.bpct;

    // Trend — SMA20 vs SMA50
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const trend: "up" | "down" | "neutral" =
      closes[n-1] > sma20 && sma20 > sma50 ? "up"  :
      closes[n-1] < sma20 && sma20 < sma50 ? "down" : "neutral";

    // BB width / volatility expansion (Clase 2: "volatilidad cerrada = no hay nada que operar")
    const bbWidths: number[] = [];
    for (let i = n - 10; i < n; i++) {
      const sl = closes.slice(i - 19, i + 1);
      const ma = sl.reduce((a, b) => a + b, 0) / 20;
      const sd = Math.sqrt(sl.reduce((a, b) => a + (b - ma) ** 2, 0) / 20);
      bbWidths.push(4 * sd);
    }
    const avgWidth      = bbWidths.reduce((a, b) => a + b, 0) / bbWidths.length;
    const curWidth      = bbCur.upper - bbCur.lower;
    const isSqueeze     = curWidth < avgWidth * 0.75;
    const bbWidthPctOfPrice = curWidth / closes[n-1] * 100; // BB width as % of price
    // Volatility expanding = last 3 widths growing
    const bbExpanding   = bbWidths[bbWidths.length-1] > bbWidths[bbWidths.length-3];

    // Punto medio direction (Clase 7: "por arriba de punto medio → más probabilidad de subir")
    const sma20Prev     = closes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const puntoMedioAlcista = bbCur.middle > sma20Prev; // SMA20 trending up

    const lastClose = closes[n-1];
    const lastOpen  = opens[n-1];
    const isGreen   = lastClose > lastOpen;
    const prevGreen = closes[n-2] > opens[n-2];

    // ── Setup detection (all strategies from Price Action Pro) ───────────────
    let setup = "Sin Setup", setupScore = 0;

    if (bbPrev.bpct < 0 && bbPct >= 0) {
      setup = "E1-Cambio Tendencia";   setupScore = 95;
    } else if (bbPct < 0) {
      setup = isGreen ? "E6-Efecto Iman UP" : "E6-Setup Manana";
      setupScore = isGreen ? 90 : 80;
    } else if (bbPct < 15) {
      setup = "E3-Rebote Inferior";    setupScore = isGreen ? 88 : 78;
    } else if (bbPct < 30) {
      setup = "E3-Zona Entrada";       setupScore = trend === "up" ? 75 : 65;
    } else if (bbPct >= 42 && bbPct <= 58 && bbPrev.bpct < 42) {
      setup = "E2-Rebote Medio UP";    setupScore = 82;
    } else if (isSqueeze && bbPct > 50 && isGreen) {
      setup = "E7-Squeeze Breakout";   setupScore = 85;
    } else if (trend === "up" && bbPct > 30 && bbPct < 60 && isGreen && prevGreen) {
      setup = "E8-Tendencia Alcista";  setupScore = 72;
    } else if (bbPct > 80) {
      setup = "E4E5-Extendido";        setupScore = 0;
    }

    // ── 1H Bollinger check (Clase #5: multi-timeframe confirmation) ──────────
    let bbPct1H = 50; // default = neutral
    try {
      const data1H = await getOHLCV(symbol, "60", { countback: 60 });
      const bars1H: { close: number }[] =
        (data1H as { bars?: typeof bars1H }).bars ?? (data1H as typeof bars1H);
      if (bars1H.length >= 20) {
        const closes1H = bars1H.map(b => b.close);
        const bb1H = computeBB(closes1H);
        if (bb1H) bbPct1H = bb1H.bpct;
      }
    } catch { /* skip 1H if unavailable */ }

    return {
      days10pct: days10, days5pct: days5, atrPct, winRate,
      bbPct, bbUpper: bbCur.upper, bbMiddle: bbCur.middle, bbLower: bbCur.lower,
      bbPct1H,
      bbExpanding, puntoMedioAlcista, bbWidthPctOfPrice,
      setup, setupScore, trend,
    };
  } catch {
    return null;
  }
}

// ── Clase 8: Movimiento en bloque ────────────────────────────────────────────
// "El mercado se mueve en bloque — SPY/QQQ/IWM/DIA todos confirman la dirección"
// If the market ETFs are all bearish, penalize long picks heavily.
async function checkMarketDirection(): Promise<{
  bullish: number; bearish: number; label: string;
  details: Record<string, "up" | "down" | "neutral">;
}> {
  const etfs = [
    { sym: "AMEX:SPY",   name: "SPY" },
    { sym: "NASDAQ:QQQ", name: "QQQ" },
    { sym: "AMEX:IWM",   name: "IWM" },
    { sym: "AMEX:DIA",   name: "DIA" },
  ];
  const details: Record<string, "up" | "down" | "neutral"> = {};
  let bullish = 0, bearish = 0;
  for (const etf of etfs) {
    try {
      const data  = await getOHLCV(etf.sym, "1D", { countback: 55 });
      const bars: { close: number }[] =
        (data as { bars?: typeof bars }).bars ?? (data as typeof bars);
      if (bars.length < 50) { details[etf.name] = "neutral"; continue; }
      const closes = bars.map(b => b.close);
      const n      = closes.length;
      const sma20  = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
      const sma50  = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
      const dir: "up" | "down" | "neutral" =
        closes[n-1] > sma20 && sma20 > sma50 ? "up"  :
        closes[n-1] < sma20 && sma20 < sma50 ? "down" : "neutral";
      details[etf.name] = dir;
      if (dir === "up")   bullish++;
      if (dir === "down") bearish++;
    } catch {
      details[etf.name] = "neutral";
    }
  }
  const label =
    bullish >= 3 ? "ALCISTA (bloque)" :
    bearish >= 3 ? "BAJISTA (bloque)" : "MIXTO";
  return { bullish, bearish, label, details };
}

async function run() {
  const date = new Date().toLocaleString("es-US", { timeZone: "America/New_York" });
  console.log(`\n=== Daily Picks [${date}] ===`);
  console.log("Step 1: Screening candidates (mcap>100M, vol>300k, $3-$25)...");

  // ── Clase 8: Movimiento en bloque ──────────────────────────────────────────
  const market = await checkMarketDirection();
  const dirIcon = (d: string) => d === "up" ? "↑" : d === "down" ? "↓" : "→";
  const mktLine = Object.entries(market.details)
    .map(([k, v]) => `${k}:${dirIcon(v)}`).join("  ");
  console.log(`\nMercado [${market.label}]: ${mktLine}`);
  if (market.bearish >= 3) console.log("⚠  Bloque bajista — picks penalizados fuertemente.");
  if (market.bullish >= 3) console.log("✓  Bloque alcista — bonus aplicado a picks.");
  // Score modifier: +15 if all bullish, -25 if all bearish (Clase 8)
  const marketBonus   = market.bullish >= 3 ? 15 : market.bullish >= 2 ? 5  : 0;
  const marketPenalty = market.bearish >= 3 ? -25 : market.bearish >= 2 ? -12 : 0;
  const marketAdj     = marketBonus + marketPenalty;

  const result = await screenStocks({
    filters: [
      { left: "close",            operation: "in_range", right: [3, 40] },
      { left: "volume",           operation: "greater",  right: 300_000 },
      { left: "market_cap_basic", operation: "greater",  right: MIN_MCAP },
    ],
    columns: [
      "name", "close", "change", "RSI",
      "volume", "average_volume_10d_calc",
      "market_cap_basic", "exchange", "sector",
      "price_52_week_high", "Recommend.All",
      "price_target_1y",
    ],
    sort:  { sortBy: "volume", sortOrder: "desc" },
    range: [0, 200],
  });

  const pool = result.results.filter(
    r => typeof r.symbol === "string" &&
    ((r.symbol as string).startsWith("NYSE:") || (r.symbol as string).startsWith("NASDAQ:"))
  );

  console.log(`Found ${pool.length} candidates. Running backtest + 1H BB check...`);

  const qualified: Candidate[] = [];

  for (const r of pool) {
    const sym     = r.symbol as string;
    const vol     = Number(r.volume) || 0;
    const avgVol  = Number(r.average_volume_10d_calc) || 1;
    const volSurge = vol / avgVol;

    // Hard filter: unusual volume (Clase #5 — volumen inusual es clave)
    if (volSurge < MIN_VOL_SURGE) continue;

    const bt = await backtest(sym);
    if (!bt) continue;

    // Hard filter: historical volatility + minimum win rate
    if (bt.days10pct < MIN_10PCT_DAYS || bt.atrPct < MIN_ATR_PCT) continue;
    if (bt.winRate < MIN_WIN_RATE && bt.days10pct < 5) continue;
    // Hard filter: valid BB entry zone (not extended)
    if (bt.setupScore < MIN_SETUP_SCORE) continue;
    // Hard filter: daily BB must not be extended (>75% = cerca de banda superior, no entrar)
    if (bt.bbPct > 75) continue;
    // Hard filter: 1H BB only blocks if realmente en la banda superior
    if (bt.bbPct1H > 85) continue;

    const close     = Number(r.close);
    const high52w   = Number(r["price_52_week_high"]) || 0;
    const recommend = Number(r["Recommend.All"]) || 0;

    // Hard filter: price must have upside room vs 52w high
    if (high52w > 0 && close / high52w > MAX_PRICE_VS_52) continue;
    // Soft filter: skip strong sell signals
    if (recommend < -0.3) continue;

    const change        = Number(r.change);
    const rsi           = Number(r.RSI);
    const pctOf52wHigh  = high52w > 0 ? (close / high52w) * 100 : 0;

    // Bonus: 1H BB in entry zone (Clase #5: multi-temporalidad)
    const bonus1H = bt.bbPct1H < 35 ? 15 : bt.bbPct1H < 50 ? 8 : 0;
    // Bonus: BB expanding / volatility open (Clase #2: volatilidad abierta = hay movimiento)
    const bonusExpanding = bt.bbExpanding ? 10 : 0;
    // Bonus: punto medio alcista (Clase #7: por arriba de punto medio → más prob de subir)
    const bonusPuntoMedio = bt.puntoMedioAlcista ? 8 : 0;
    // Bonus: energy or tech sector (Clase #5: sectores en high demand)
    const secLow = String(r.sector ?? "").toLowerCase();
    const bonusSector = secLow.includes("tech") || secLow.includes("energy") || secLow.includes("electronic") ? 6 : 0;
    // Penalty: BB in squeeze AND not E7 breakout setup (Clase #2: volatilidad cerrada = no operar)
    const penaltySqueeze = (!bt.bbExpanding && bt.setup !== "E7-Squeeze Breakout") ? -10 : 0;
    // Bonus: analyst target price ≥50% above current (Finviz: "Target Price 50% Above" filter)
    const targetPrice  = Number(r["price_target_1y"]) || 0;
    const targetRatio  = targetPrice > 0 ? targetPrice / close : 0;
    const bonusTarget  = targetRatio >= 1.5 ? 20 : targetRatio >= 1.25 ? 10 : 0;

    // Score formula — all criteria from all classes
    const score =
      bt.setupScore  * 1.5 +        // BB setup quality
      bt.days10pct   * 4   +        // proven 10%+ mover history
      bt.atrPct      * 2   +        // daily range (needs room for 10%)
      Math.min(volSurge, 6) * 5 +  // volume surge (Clase #5: volumen inusual es clave)
      bt.winRate     * 0.3 +        // historical win rate on big days
      recommend      * 10  +        // analyst buy signal
      bonus1H + bonusExpanding + bonusPuntoMedio + bonusSector + penaltySqueeze +
      bonusTarget +   // Finviz: target price ≥50% arriba = analistas ven upside fuerte
      marketAdj;      // Clase 8: movimiento en bloque

    qualified.push({
      symbol: sym, close, change, rsi, recommend,
      high52w, pctOf52wHigh,
      atrPct:    bt.atrPct,
      days10pct: bt.days10pct,
      days5pct:  bt.days5pct,
      winRate:   bt.winRate,
      bbPct:     bt.bbPct,
      bbPct1H:   bt.bbPct1H,
      setup:     bt.setup,
      setupScore: bt.setupScore,
      trend:     bt.trend,
      volSurge,
      sector:    String(r.sector ?? ""),
      score,
      targetRatio,
    } as any);
  }

  if (!qualified.length) {
    console.log("No stocks passed all filters today. Watchlist not changed.");
    return;
  }

  const picks = qualified
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PICKS);

  const newSymbols = picks.map(p => p.symbol);

  // ── Update "Activos Para Manana" ──────────────────────────────────────────
  const picksWl  = await getWatchlist(PICKS_LIST_ID);
  const oldPicks = picksWl.symbols.slice();
  if (picksWl.symbols.length > 0) await removeSymbols(PICKS_LIST_ID, picksWl.symbols);
  await addSymbols(PICKS_LIST_ID, newSymbols);

  // ── Update "Lista de seguimiento" ─────────────────────────────────────────
  const mainWl   = await getWatchlist(MAIN_LIST_ID);
  const toRemove = mainWl.symbols.filter(s => oldPicks.includes(s));
  if (toRemove.length > 0) await removeSymbols(MAIN_LIST_ID, toRemove);
  await addSymbols(MAIN_LIST_ID, [SECTION_HEADER, ...newSymbols]);

  // ── Print summary ─────────────────────────────────────────────────────────
  const recLabel = (r: number) => r >= 0.5 ? "STRONG BUY" : r >= 0.3 ? "BUY" : "NEUTRAL";

  console.log(`\n✓ ${picks.length} picks | Mercado: ${market.label} | mcap>100M, vol>${MIN_VOL_SURGE}x, ATR≥${MIN_ATR_PCT}%, ≥${MIN_10PCT_DAYS}d +10%, BB diario+1H valido:\n`);
  console.log("  Symbol          Price   Setup                  D-B%  1H-B%  ATR%  10%d  Win%  VolSurge  Target  Sector");
  console.log("  " + "─".repeat(112));
  for (const p of picks) {
    const pr = (p as any).targetRatio as number;
    const tgtStr = pr > 0 ? `+${((pr-1)*100).toFixed(0)}%`.padStart(5) : "  --";
    console.log(
      `  ${p.symbol.padEnd(16)} $${p.close.toFixed(2).padStart(5)}` +
      `  ${p.setup.padEnd(22)}` +
      `  ${p.bbPct.toFixed(0).padStart(4)}%` +
      `  ${p.bbPct1H.toFixed(0).padStart(4)}%` +
      `  ${p.atrPct.toFixed(1).padStart(4)}%` +
      `  ${String(p.days10pct).padStart(3)}d` +
      `  ${p.winRate.toFixed(0).padStart(3)}%` +
      `  ${p.volSurge.toFixed(1).padStart(5)}x` +
      `  ${tgtStr}` +
      `  ${p.sector}`
    );
  }
  console.log("\nWatchlists updated. Done.\n");
}

run().catch(err => {
  console.error("[daily_picks] ERROR:", err.message);
  process.exit(1);
});
