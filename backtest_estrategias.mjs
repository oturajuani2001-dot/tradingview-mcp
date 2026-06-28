/**
 * Backtesting real usando datos OHLCV de TradingView.
 * Evalúa cada candidato contra señales de E1-E10 (Bollinger Bands Investep).
 *
 * Ejecutar: node backtest_estrategias.mjs
 */

import { getOHLCV } from './dist/ohlcv.js';

// ── Candidatos a analizar ────────────────────────────────────────────────────
// Incluye los stocks del propio curso + otros de alta volatilidad
const CANDIDATOS = [
  // Del curso (ejemplos reales usados en las clases)
  'AAPL', 'COIN', 'CCL', 'BABA', 'AXP', 'UBER', 'WMT', 'LOW',
  // Alta beta + opciones líquidas
  'TSLA', 'NVDA', 'AMD', 'MSTR', 'HOOD', 'PLTR', 'SMCI',
  // Chinas (mencionadas como las mejores para Efecto Imán)
  'PDD', 'BIDU', 'FUTU', 'TIGR',
  // Finanzas/crypto
  'RIOT', 'MARA', 'CLSK',
  // ETFs 3x (para amplificar señales)
  'SOXL', 'TQQQ',
];

const DIAS_ANALISIS = 90; // últimos 90 días de trading

// ── Funciones de cálculo ─────────────────────────────────────────────────────

function calcMA(bars, period, field = 'close') {
  return bars.map((_, i) => {
    if (i < period - 1) return null;
    const slice = bars.slice(i - period + 1, i + 1);
    return slice.reduce((s, b) => s + b[field], 0) / period;
  });
}

function calcBBWidth(bars, period = 20) {
  const mas = calcMA(bars, period);
  return bars.map((_, i) => {
    if (mas[i] === null) return null;
    const slice = bars.slice(i - period + 1, i + 1);
    const mean = mas[i];
    const std = Math.sqrt(slice.reduce((s, b) => s + Math.pow(b.close - mean, 2), 0) / period);
    return (std * 4 / mean) * 100; // BB width as % of price
  });
}

function analyzeGaps(bars) {
  const gaps = [];
  for (let i = 1; i < bars.length; i++) {
    const gapPct = ((bars[i].open - bars[i - 1].close) / bars[i - 1].close) * 100;
    gaps.push({ day: i, pct: gapPct, abs: Math.abs(gapPct) });
  }
  return gaps;
}

function analyzeForStrategies(bars) {
  const mas20 = calcMA(bars, 20);
  const mas40 = calcMA(bars, 40);
  const bbWidths = calcBBWidth(bars, 20);

  const results = {
    // Métricas generales
    totalBars: bars.length,
    avgDailyRangePct: 0,
    avgDailyGapPct: 0,

    // E1/E2 — Cambio de tendencia (hora → pero evaluamos en diario)
    e1e2_signals: 0,  // Días con cambio de tendencia claro

    // E3/E4 — Rebote en punto medio (diario)
    e3e4_signals: 0,  // Días donde precio toca MA20 y rebota

    // E5/E6 — Efecto Imán (tendencia extendida + gap)
    e5e6_signals: 0,  // Días con tendencia 5+ días + gap >2%

    // E7/E8 — Lateral + salto apertura
    e7e8_signals: 0,  // Días con lateral + gap extremo (>3%)

    // Calidad del patrón Bollinger (qué tan bien respeta la MA20)
    ma20RespectRate: 0,

    // Distancia actual de MA20 (para Efecto Imán actual)
    currentDistFromMA20: 0,

    // BB width promedio (qué tan abierto está el oscilador)
    avgBBWidth: 0,

    // Gaps stats
    gaps2pctPlus: 0,
    gaps3pctPlus: 0,
    gaps5pctPlus: 0,
    maxGap: 0,
  };

  const gaps = analyzeGaps(bars);
  const validBBWidths = bbWidths.filter(v => v !== null);

  // Rango diario promedio
  results.avgDailyRangePct = bars.reduce((s, b) => {
    return s + ((b.high - b.low) / b.low) * 100;
  }, 0) / bars.length;

  // GAP stats
  results.avgDailyGapPct = gaps.reduce((s, g) => s + g.abs, 0) / gaps.length;
  results.gaps2pctPlus = gaps.filter(g => g.abs >= 2).length;
  results.gaps3pctPlus = gaps.filter(g => g.abs >= 3).length;
  results.gaps5pctPlus = gaps.filter(g => g.abs >= 5).length;
  results.maxGap = Math.max(...gaps.map(g => g.abs)).toFixed(1);

  // BB width promedio
  results.avgBBWidth = validBBWidths.length
    ? validBBWidths.reduce((s, v) => s + v, 0) / validBBWidths.length
    : 0;

  // ── E3/E4: Rebote en punto medio ──────────────────────────────────────────
  // Señal: precio llega a MA20 (±1%) y el siguiente día sube >2% (alcista) o baja >2%
  for (let i = 21; i < bars.length - 1; i++) {
    const ma = mas20[i];
    if (!ma) continue;
    const distFromMA = Math.abs((bars[i].low - ma) / ma) * 100;
    const nextDayMove = ((bars[i + 1].close - bars[i + 1].open) / bars[i + 1].open) * 100;
    if (distFromMA <= 1.5 && Math.abs(nextDayMove) >= 2) {
      results.e3e4_signals++;
    }
  }

  // ── E5/E6: Efecto Imán ────────────────────────────────────────────────────
  // Señal: 5+ días de tendencia continua + precio alejado >3% de MA20 + GAP >2%
  for (let i = 25; i < bars.length; i++) {
    const ma = mas20[i];
    const ma40 = mas40[i];
    if (!ma || !ma40) continue;

    // Check 5-day trend
    const closes5 = bars.slice(i - 5, i).map(b => b.close);
    const isTrending = closes5.every((c, j) => j === 0 || c > closes5[j - 1]) ||
                       closes5.every((c, j) => j === 0 || c < closes5[j - 1]);

    const distFromMA20 = ((bars[i].close - ma) / ma) * 100;
    const gap = i > 0 ? ((bars[i].open - bars[i - 1].close) / bars[i - 1].close) * 100 : 0;

    if (isTrending && Math.abs(distFromMA20) >= 3 && Math.abs(gap) >= 2) {
      results.e5e6_signals++;
    }
  }

  // ── E7/E8: Lateral + salto de apertura ───────────────────────────────────
  // Señal: BB width bajo (<5%) → luego gap >3% al siguiente día
  for (let i = 22; i < bars.length - 1; i++) {
    const bbW = bbWidths[i];
    if (!bbW) continue;
    const isLateral = bbW < 5; // BB muy cerrado = lateral
    const nextGap = Math.abs((bars[i + 1].open - bars[i].close) / bars[i].close) * 100;
    if (isLateral && nextGap >= 3) {
      results.e7e8_signals++;
    }
  }

  // ── E1/E2: Cambio de tendencia ─────────────────────────────────────────────
  // Señal: 3+ días bajista → siguiente día rompe MA20 al alza (o viceversa)
  for (let i = 23; i < bars.length; i++) {
    const ma = mas20[i];
    if (!ma) continue;
    const closes3 = bars.slice(i - 3, i).map(b => b.close);
    const wasBearish = closes3.every((c, j) => j === 0 || c < closes3[j - 1]);
    const wasBullish = closes3.every((c, j) => j === 0 || c > closes3[j - 1]);
    const crossedAbove = bars[i - 1].close < ma && bars[i].close > ma;
    const crossedBelow = bars[i - 1].close > ma && bars[i].close < ma;
    if ((wasBearish && crossedAbove) || (wasBullish && crossedBelow)) {
      results.e1e2_signals++;
    }
  }

  // ── Distancia actual de MA20 ──────────────────────────────────────────────
  const lastMA20 = mas20[bars.length - 1];
  if (lastMA20) {
    results.currentDistFromMA20 = ((bars[bars.length - 1].close - lastMA20) / lastMA20) * 100;
  }

  // ── MA20 Respect Rate ─────────────────────────────────────────────────────
  // Qué % de veces el precio respetó la MA20 (rebotó en lugar de cruzarla)
  let respects = 0, crossings = 0;
  for (let i = 21; i < bars.length - 1; i++) {
    const ma = mas20[i];
    if (!ma) continue;
    const touchedMA = bars[i].low <= ma * 1.005 && bars[i].high >= ma * 0.995;
    if (touchedMA) {
      const nextClose = bars[i + 1].close;
      const prevClose = bars[i - 1].close;
      // If it "respected" (bounced) vs crossed
      if (Math.sign(bars[i].close - ma) === Math.sign(prevClose - ma)) {
        respects++;
      } else {
        crossings++;
      }
    }
  }
  results.ma20RespectRate = (respects + crossings) > 0
    ? (respects / (respects + crossings) * 100)
    : 0;

  // ── Score final ─────────────────────────────────────────────────────────
  // Ponderado por utilidad para las estrategias E1-E10
  results.score = (
    (results.e5e6_signals * 4) +     // Efecto Imán = más rentable
    (results.e3e4_signals * 3) +     // Rebote punto medio = 100-500%
    (results.e7e8_signals * 3) +     // Lateral + salto = hasta 35%
    (results.e1e2_signals * 2) +     // Cambio tendencia = hasta 35%
    (results.avgDailyRangePct * 2) + // Rango diario
    (results.gaps3pctPlus * 1.5) +   // GAPs frecuentes
    (results.avgBBWidth * 0.5)       // BB width abierto
  );

  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  BACKTESTING E1-E10 INVESTEP — TradingView WebSocket');
  console.log('  Analizando últimos 90 días de datos reales');
  console.log('═'.repeat(60) + '\n');

  const resultados = [];
  let ok = 0, err = 0;

  for (const symbol of CANDIDATOS) {
    process.stdout.write(`  ${symbol.padEnd(6)} ... `);
    try {
      const bars = await getOHLCV(symbol, '1D', { countback: DIAS_ANALISIS });
      if (!bars || bars.length < 30) {
        console.log(`sin datos (${bars?.length || 0} bars)`);
        err++;
        continue;
      }

      const analysis = analyzeForStrategies(bars);
      analysis.symbol = symbol;
      analysis.currentPrice = bars[bars.length - 1].close;
      resultados.push(analysis);

      console.log(
        `✓  rango:${analysis.avgDailyRangePct.toFixed(1)}%  ` +
        `gap3%+:${analysis.gaps3pctPlus}d  ` +
        `imán:${analysis.e5e6_signals}  ` +
        `score:${analysis.score.toFixed(0)}`
      );
      ok++;
    } catch (e) {
      console.log(`✗  ${e.message.slice(0, 50)}`);
      err++;
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Ranking ────────────────────────────────────────────────────────────────
  resultados.sort((a, b) => b.score - a.score);
  const top10 = resultados.slice(0, 10);

  console.log('\n' + '═'.repeat(60));
  console.log('  TOP 10 — MEJORES CANDIDATOS PARA ESTRATEGIAS E1-E10');
  console.log('═'.repeat(60));
  console.log(
    '\n  #  Símbolo  Precio    Rango%  GAP3%+  ImánSig  ReboteSig  Lat+Gap  Score'
  );
  console.log('  ' + '-'.repeat(72));

  top10.forEach((r, i) => {
    const rank = (i + 1).toString().padStart(2);
    const sym = r.symbol.padEnd(7);
    const price = ('$' + r.currentPrice.toFixed(0)).padStart(8);
    const range = (r.avgDailyRangePct.toFixed(1) + '%').padStart(7);
    const gaps = r.gaps3pctPlus.toString().padStart(6);
    const iman = r.e5e6_signals.toString().padStart(8);
    const rebote = r.e3e4_signals.toString().padStart(10);
    const lat = r.e7e8_signals.toString().padStart(8);
    const score = r.score.toFixed(0).padStart(6);
    console.log(`  ${rank}  ${sym} ${price} ${range} ${gaps} ${iman} ${rebote} ${lat} ${score}`);
  });

  // ── Análisis detallado de cada Top 10 ─────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  ANÁLISIS DETALLADO — ESTRATEGIAS APLICABLES POR STOCK');
  console.log('═'.repeat(60));

  top10.forEach((r, i) => {
    const strategies = [];
    if (r.e5e6_signals >= 3) strategies.push(`E5/E6 Efecto Imán (${r.e5e6_signals} señales en 90d)`);
    if (r.e3e4_signals >= 3) strategies.push(`E3/E4 Rebote Punto Medio (${r.e3e4_signals} señales)`);
    if (r.e7e8_signals >= 2) strategies.push(`E7/E8 Lateral+Salto (${r.e7e8_signals} señales)`);
    if (r.e1e2_signals >= 3) strategies.push(`E1/E2 Cambio Tendencia (${r.e1e2_signals} señales)`);

    const distSign = r.currentDistFromMA20 > 0 ? '+' : '';
    const imanNow = Math.abs(r.currentDistFromMA20) > 5 ? ' ← IMÁN ACTIVO HOY' : '';

    console.log(`\n  ${i + 1}. ${r.symbol} ($${r.currentPrice.toFixed(2)})`);
    console.log(`     Estrategias: ${strategies.join(' | ')}`);
    console.log(`     Rango diario promedio: ${r.avgDailyRangePct.toFixed(1)}%`);
    console.log(`     GAPs >3% en 90 días: ${r.gaps3pctPlus} veces (max gap: ${r.maxGap}%)`);
    console.log(`     Distancia MA20 hoy: ${distSign}${r.currentDistFromMA20.toFixed(1)}%${imanNow}`);
    console.log(`     MA20 Respect Rate: ${r.ma20RespectRate.toFixed(0)}%`);
    console.log(`     BB Width promedio: ${r.avgBBWidth.toFixed(1)}%`);
  });

  // Save JSON
  const fs = await import('fs');
  const outputPath = '/tmp/backtest_resultados.json';
  fs.writeFileSync(outputPath, JSON.stringify(resultados, null, 2));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Analizados: ${ok}/${CANDIDATOS.length}  |  Errores: ${err}`);
  console.log(`  Datos completos: ${outputPath}`);
  console.log('═'.repeat(60) + '\n');

  process.exit(0);
}

main().catch(e => { console.error('\nError fatal:', e.message); process.exit(1); });
