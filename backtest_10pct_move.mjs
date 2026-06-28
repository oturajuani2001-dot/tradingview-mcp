/**
 * Busca stocks que REALMENTE se mueven 10%+ en el día.
 * Métrica: días donde el precio subió/bajó 10%+ de cierre a cierre,
 * O el rango intraday High-Low fue ≥10%.
 */

import { getOHLCV } from './dist/ohlcv.js';

const CANDIDATOS = [
  // Crypto mining (alta volatilidad)
  'MSTR', 'COIN', 'RIOT', 'MARA', 'CLSK', 'HUT', 'BITF',
  // Semiconductores y tech volátil
  'SOXL', 'NVDA', 'AMD', 'SMCI', 'TSLA',
  // Chinas (del curso)
  'BABA', 'PDD', 'BIDU', 'FUTU',
  // Biotech / meme
  'GME', 'HOOD', 'PLTR',
  // ETFs 3x
  'TQQQ', 'TNA', 'LABU', 'FNGU',
];

const DIAS = 90;

async function analizar(symbol) {
  const bars = await getOHLCV(symbol, '1D', { countback: DIAS });
  if (!bars || bars.length < 20) return null;

  const moves = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];

    const dailyReturn  = ((curr.close - prev.close) / prev.close) * 100;
    const intradayRange = ((curr.high - curr.low) / curr.low) * 100;
    const gapOpen       = ((curr.open - prev.close) / prev.close) * 100;
    const openToClose   = ((curr.close - curr.open) / curr.open) * 100;

    moves.push({ dailyReturn, intradayRange, gapOpen, openToClose });
  }

  // Días que se movieron 10%+ de cierre a cierre
  const days10pct     = moves.filter(m => Math.abs(m.dailyReturn)  >= 10).length;
  const days10up      = moves.filter(m => m.dailyReturn >= 10).length;
  const days10down    = moves.filter(m => m.dailyReturn <= -10).length;
  // Días con rango intraday ≥10%
  const days10range   = moves.filter(m => m.intradayRange >= 10).length;
  // Días con rango ≥5%
  const days5pct      = moves.filter(m => Math.abs(m.dailyReturn)  >= 5).length;

  const avgDailyReturn = moves.reduce((s, m) => s + Math.abs(m.dailyReturn), 0) / moves.length;
  const avgIntradayRange = moves.reduce((s, m) => s + m.intradayRange, 0) / moves.length;

  // Mayor movimiento alcista en un día
  const maxUp   = Math.max(...moves.map(m => m.dailyReturn));
  const maxDown = Math.min(...moves.map(m => m.dailyReturn));

  // Probabilidad diaria de ver un +10%
  const prob10 = (days10pct / moves.length * 100);

  // Score: queremos alta probabilidad de 10%+ día a día
  const score = (days10pct * 5) + (days5pct * 2) + (avgDailyReturn * 3) + (days10range * 2);

  return {
    symbol,
    price: bars[bars.length - 1].close,
    days10pct, days10up, days10down, days10range, days5pct,
    avgDailyReturn, avgIntradayRange,
    maxUp, maxDown, prob10, score,
    total: moves.length,
  };
}

async function main() {
  console.log('\n' + '═'.repeat(65));
  console.log('  BACKTEST: ¿CUÁNTOS DÍAS SE MOVIÓ 10%+? (últimos 90 días)');
  console.log('═'.repeat(65) + '\n');

  const resultados = [];

  for (const sym of CANDIDATOS) {
    process.stdout.write(`  ${sym.padEnd(7)}... `);
    try {
      const r = await analizar(sym);
      if (!r) { console.log('sin datos'); continue; }
      resultados.push(r);
      console.log(
        `días 10%+: ${r.days10pct.toString().padStart(2)}  ` +
        `(↑${r.days10up} ↓${r.days10down})  ` +
        `rango avg: ${r.avgDailyReturn.toFixed(1)}%  ` +
        `max↑: +${r.maxUp.toFixed(1)}%`
      );
    } catch(e) {
      console.log(`error: ${e.message.slice(0, 40)}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  resultados.sort((a, b) => b.score - a.score);

  console.log('\n' + '═'.repeat(65));
  console.log('  RANKING — MEJOR CHANCE DE MOVIMIENTO 10%+ DIARIO');
  console.log('═'.repeat(65));
  console.log('\n  #  Stock   Precio  Días10%+ Prob10% AvgMove MaxSub  Score');
  console.log('  ' + '-'.repeat(60));

  resultados.slice(0, 10).forEach((r, i) => {
    const n   = (i+1).toString().padStart(2);
    const sym = r.symbol.padEnd(7);
    const pr  = ('$'+r.price.toFixed(0)).padStart(7);
    const d10 = (r.days10pct+'d').padStart(8);
    const pb  = (r.prob10.toFixed(0)+'%').padStart(7);
    const avg = (r.avgDailyReturn.toFixed(1)+'%').padStart(7);
    const mx  = ('+'+r.maxUp.toFixed(0)+'%').padStart(7);
    const sc  = r.score.toFixed(0).padStart(6);
    console.log(`  ${n}  ${sym} ${pr} ${d10} ${pb} ${avg} ${mx} ${sc}`);
  });

  console.log('\n' + '═'.repeat(65));
  console.log('  DETALLE TOP 10\n');

  resultados.slice(0, 10).forEach((r, i) => {
    const freq = `1 de cada ${Math.round(r.total / (r.days10pct || 1))} días`;
    console.log(`  ${i+1}. ${r.symbol} ($${r.price.toFixed(2)})`);
    console.log(`     Movimiento 10%+ : ${r.days10pct} días en 90 (${r.prob10.toFixed(0)}% probabilidad)`);
    console.log(`     Frecuencia       : ${freq}`);
    console.log(`     Subidas 10%+     : ${r.days10up} días`);
    console.log(`     Bajadas 10%+     : ${r.days10down} días`);
    console.log(`     Rango intraday ≥10%: ${r.days10range} días`);
    console.log(`     Movimiento avg   : ${r.avgDailyReturn.toFixed(1)}% por día`);
    console.log(`     Mayor subida     : +${r.maxUp.toFixed(1)}% en un día`);
    console.log(`     Mayor caída      : ${r.maxDown.toFixed(1)}% en un día\n`);
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
