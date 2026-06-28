import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const session = JSON.parse(readFileSync('/Users/oturajuani/.tradingview-session.json', 'utf8'));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

for (const c of session.cookies) {
  try { await context.addCookies([c]); } catch {}
}

const page = await context.newPage();
await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(8000);
await page.screenshot({ path: '/tmp/tv_debug1.png' });

// Find watchlist-related elements and their text
const allText = await page.evaluate(() => {
  const results = [];
  // Look for elements that contain watchlist switcher / header
  const selectors = [
    '[class*="watchlist"]',
    '[class*="widgetbar"]',
    '[class*="listTitle"]',
    '[class*="switcher"]',
    '[data-name="watchlist"]',
    '[class*="symbolsList"]',
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    els.forEach((el, i) => {
      if (i < 3) {
        results.push({
          selector: sel,
          class: el.className,
          text: el.innerText?.slice(0, 200),
          tag: el.tagName,
        });
      }
    });
  }
  return results;
});

console.log('Watchlist-related elements found:');
for (const el of allText) {
  console.log(`\n[${el.selector}] <${el.tag}> class="${el.class?.slice(0, 80)}"`);
  if (el.text) console.log('  text:', el.text.replace(/\n/g, ' | ').slice(0, 150));
}

await browser.close();
console.log('\nScreenshot saved to /tmp/tv_debug1.png');
