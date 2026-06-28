#!/usr/bin/env node
// Fetches OHLCV data for given symbol/resolution and outputs JSON
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TV_SESSION_FILE = process.env.TV_SESSION_FILE || '/Users/oturajuani/.tradingview-session.json';

const { getOHLCV } = await import('/Users/oturajuani/tradingview-mcp-full/dist/ohlcv.js');

const symbol = process.argv[2] || 'NASDAQ:SPX';
const resolution = process.argv[3] || '60';
const countback = parseInt(process.argv[4] || '100');

try {
  const bars = await getOHLCV(symbol, resolution, { countback });
  process.stdout.write(JSON.stringify(bars));
} catch (e) {
  process.stderr.write('ERROR: ' + e.message + '\n');
  process.exit(1);
}
