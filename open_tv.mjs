import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const session = JSON.parse(readFileSync('/Users/oturajuani/.tradingview-session.json', 'utf8'));
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

for (const c of session.cookies) {
  try { await context.addCookies([c]); } catch {}
}

const page = await context.newPage();
await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: '/tmp/tv_watchlist.png' });
console.log('Listo - browser abierto por 60 segundos');
await page.waitForTimeout(60000);
await browser.close();
