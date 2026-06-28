// Probes TradingView for broker/IBKR API calls using Playwright + existing session
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const sessionFile = process.env.TV_SESSION_FILE ?? '/Users/oturajuani/.tradingview-session.json';
const session = JSON.parse(readFileSync(sessionFile, 'utf8'));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

// Load saved cookies into Playwright
for (const c of session.cookies) {
  try { await context.addCookies([c]); } catch {}
}

const brokerCalls = [];

// Intercept all network requests
context.on('request', req => {
  const url = req.url();
  if (
    url.includes('broker') || url.includes('trading') || url.includes('order') ||
    url.includes('position') || url.includes('account') || url.includes('ibkr') ||
    url.includes('interactivebrokers')
  ) {
    brokerCalls.push({ type: 'REQUEST', method: req.method(), url });
  }
});

context.on('response', async res => {
  const url = res.url();
  if (
    url.includes('broker') || url.includes('trading') || url.includes('order') ||
    url.includes('position') || url.includes('ibkr') || url.includes('interactivebrokers')
  ) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch {}
    brokerCalls.push({ type: 'RESPONSE', status: res.status(), url, body });
  }
});

const page = await context.newPage();

// Go to TradingView chart
console.log('Navigating to TradingView...');
await page.goto('https://www.tradingview.com/chart/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(5000);

// Try to click on the Trading Panel button at the bottom
try {
  const tradingBtn = page.locator('[data-name="trading-panel-button"], button:has-text("Trade"), [aria-label*="Trading"]').first();
  if (await tradingBtn.isVisible()) {
    console.log('Found Trading Panel button, clicking...');
    await tradingBtn.click();
    await page.waitForTimeout(3000);
  }
} catch (e) {
  console.log('Could not click trading panel:', e.message);
}

await page.waitForTimeout(3000);

// Take screenshot
await page.screenshot({ path: '/tmp/tradingview_broker.png', fullPage: false });
console.log('Screenshot saved to /tmp/tradingview_broker.png');

console.log('\n=== Broker-related network calls intercepted ===');
for (const call of brokerCalls) {
  console.log(JSON.stringify(call, null, 2));
}

await browser.close();
