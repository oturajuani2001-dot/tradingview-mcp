import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const session = JSON.parse(readFileSync('/Users/oturajuani/.tradingview-session.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
for (const c of session.cookies) { try { await context.addCookies([c]); } catch {} }

const page = await context.newPage();
await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6000);

// Screenshot before
await page.screenshot({ path: '/tmp/tv_before.png' });

// Click the watchlist name/dropdown to switch lists
try {
  // The watchlist title at the top of the right panel is usually clickable
  const listTitle = page.locator('[class*="watchlistTitle"], [class*="listTitle"], [class*="symbolsHeader"] [class*="title"]').first();
  if (await listTitle.isVisible({ timeout: 2000 })) {
    console.log('Clicking list title:', await listTitle.innerText());
    await listTitle.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/tv_after_click.png' });
  }
} catch(e) { console.log('title click err:', e.message); }

// Try the arrow/chevron next to the watchlist name
try {
  const arrow = page.locator('[class*="watchlist"] svg, [class*="listHeader"] [class*="arrow"], [class*="switcher"] svg').first();
  if (await arrow.isVisible({ timeout: 2000 })) {
    await arrow.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/tv_arrow.png' });
  }
} catch(e) { console.log('arrow err:', e.message); }

// Get all visible text in right panel
const rightPanel = page.locator('[class*="watchlistContainer"], [class*="widgetbar"], .tv-screener, [data-name="watchlist"]');
try {
  const text = await rightPanel.first().innerText();
  console.log('Right panel text (first 500):', text.slice(0, 500));
} catch(e) {}

await browser.close();
console.log('Done');
