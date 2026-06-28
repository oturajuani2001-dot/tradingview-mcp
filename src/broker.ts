import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { chromium } from "playwright";

const SESSION_FILE = process.env.TV_SESSION_FILE ?? ".tv_session.json";

interface BrokerCookie {
  key: string;
  value: string;
  domain: string;
  path: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

async function loadCookies(): Promise<BrokerCookie[]> {
  if (!existsSync(SESSION_FILE)) throw new Error("No session file found. Run login first.");
  const raw = await readFile(SESSION_FILE, "utf-8");
  const data = JSON.parse(raw);
  return data.cookies as BrokerCookie[];
}

async function withBrokerPage<T>(
  fn: (page: import("playwright").Page) => Promise<T>
): Promise<T> {
  const cookies = await loadCookies();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    viewport: { width: 1280, height: 900 },
  });

  // Inject saved session cookies
  for (const c of cookies) {
    try {
      await context.addCookies([{
        name: c.key,
        value: c.value,
        domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
        path: c.path ?? "/",
        expires: c.expires ? new Date(c.expires).getTime() / 1000 : -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure ?? true,
        sameSite: "Lax",
      }]);
    } catch { /* skip malformed cookies */ }
  }

  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export interface BrokerAccount {
  broker: string;
  balance?: number;
  currency?: string;
  equity?: number;
  unrealizedPnl?: number;
  marginUsed?: number;
  marginFree?: number;
  raw?: Record<string, string>;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
  side: string;
  avgPrice?: number;
  currentPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  raw?: Record<string, string>;
}

export interface BrokerOrder {
  id?: string;
  symbol: string;
  side: string;
  type: string;
  qty?: number;
  price?: number;
  status: string;
  raw?: Record<string, string>;
}

export interface BrokerSnapshot {
  account: BrokerAccount;
  positions: BrokerPosition[];
  orders: BrokerOrder[];
  screenshotBase64?: string;
  scrapedAt: string;
}

export async function getBrokerSnapshot(withScreenshot = false): Promise<BrokerSnapshot> {
  return withBrokerPage(async (page) => {
    // Navigate to TradingView chart
    await page.goto("https://www.tradingview.com/chart/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Wait for chart to load
    await page.waitForTimeout(5000);

    // Close any open dialogs (Escape) and look for the already-connected bottom panel
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2000);

    // Check if broker is already connected (bottom panel present)
    let bottomPanelFound = false;
    const bottomSelectors = [
      '[class*="bottomBar"] [class*="trading"]',
      '[class*="tradingPanel"]',
      '[class*="brokerPanel"]',
      '[data-name="trading-toolbar"]',
      '[class*="orderPanel"]',
    ];
    for (const sel of bottomSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 })) {
          bottomPanelFound = true;
          await el.click();
          await page.waitForTimeout(1500);
          break;
        }
      } catch { /* try next */ }
    }

    // If no bottom panel, try expanding it via the bottom area of the chart
    if (!bottomPanelFound) {
      try {
        // Look for a small toggle at the bottom of the chart
        const toggle = page.locator('[class*="paneControls"], [class*="chartBottom"], [class*="paneSeparator"]').last();
        if (await toggle.isVisible({ timeout: 2000 })) {
          await toggle.click();
          await page.waitForTimeout(2000);
        }
      } catch { /* skip */ }
    }

    // Read any tab (Positions / Orders / Account Summary) that may be visible
    for (const tabText of ['Positions', 'Orders', 'Account Summary', 'Account']) {
      try {
        const tab = page.locator(`[role="tab"]:has-text("${tabText}"), button:has-text("${tabText}")`).first();
        if (await tab.isVisible({ timeout: 1500 })) {
          await tab.click();
          await page.waitForTimeout(1500);
        }
      } catch { /* skip */ }
    }

    await page.waitForTimeout(2000);

    // Capture screenshot if requested
    let screenshotBase64: string | undefined;
    if (withScreenshot) {
      const buf = await page.screenshot({ fullPage: false });
      screenshotBase64 = buf.toString("base64");
    }

    // Broad scrape: read all visible text from trading-related containers
    const allTradingText: string[] = [];
    try {
      const containers = await page.locator(
        '[class*="trading"], [class*="broker"], [class*="account"], [class*="position"], [class*="order"], [class*="balance"], [class*="equity"], [class*="pnl"]'
      ).all();
      for (const el of containers) {
        try {
          const t = (await el.innerText()).trim();
          if (t.length > 3 && t.length < 500) allTradingText.push(t);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    // Scrape account summary — wide net of selectors
    const accountRaw: Record<string, string> = {};
    try {
      const items = await page.locator(
        '[class*="summaryRow"], [class*="accountRow"], [class*="infoRow"], [class*="balanceRow"], [class*="metricRow"]'
      ).all();
      for (const item of items) {
        const text = (await item.innerText()).trim();
        const parts = text.split(/\n|\t/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) accountRaw[parts[0]] = parts.slice(1).join(" ");
      }
    } catch { /* skip */ }

    // Scrape positions
    const positionsRaw: Record<string, string>[] = [];
    try {
      const rows = await page.locator(
        '[class*="position"]:not([class*="header"]) [class*="row"], [class*="positionsTable"] tr:not(:first-child)'
      ).all();
      for (const row of rows) {
        const text = (await row.innerText()).trim().replace(/\n/g, " | ");
        if (text.length > 2) positionsRaw.push({ _raw: text });
      }
    } catch { /* skip */ }

    // Scrape orders
    const ordersRaw: Record<string, string>[] = [];
    try {
      const ordersTab = page.locator('text=Orders').first();
      if (await ordersTab.isVisible({ timeout: 1500 })) {
        await ordersTab.click();
        await page.waitForTimeout(1000);
      }
      const rows = await page.locator(
        '[class*="order"]:not([class*="header"]) [class*="row"], [class*="ordersTable"] tr:not(:first-child)'
      ).all();
      for (const row of rows) {
        const text = (await row.innerText()).trim().replace(/\n/g, " | ");
        if (text.length > 2) ordersRaw.push({ _raw: text });
      }
    } catch { /* skip */ }

    // Parse numeric fields from accountRaw
    const parseNum = (v?: string) => v ? parseFloat(v.replace(/[^0-9.\-]/g, "")) || undefined : undefined;

    const findVal = (obj: Record<string, string>, ...keys: string[]) => {
      for (const key of keys) {
        const found = Object.entries(obj).find(([k]) =>
          keys.some(k2 => k.toLowerCase().includes(k2.toLowerCase()))
        );
        if (found) return found[1];
      }
      return undefined;
    };

    const account: BrokerAccount = {
      broker: "Interactive Brokers",
      balance: parseNum(findVal(accountRaw, "balance", "cash", "net")),
      equity: parseNum(findVal(accountRaw, "equity", "value")),
      unrealizedPnl: parseNum(findVal(accountRaw, "unrealized", "p&l", "pnl")),
      marginUsed: parseNum(findVal(accountRaw, "margin used", "used margin")),
      marginFree: parseNum(findVal(accountRaw, "available", "free margin")),
      raw: Object.keys(accountRaw).length > 0 ? accountRaw : undefined,
    };

    const positions: BrokerPosition[] = positionsRaw.map(p => ({
      symbol: "–",
      qty: 0,
      side: "–",
      status: "open",
      raw: p,
    }));

    const orders: BrokerOrder[] = ordersRaw.map(o => ({
      symbol: "–",
      side: "–",
      type: "–",
      status: "–",
      raw: o,
    }));

    // Extract watchlist prices already visible in the sidebar
    const watchlistPrices: Record<string, { price: string; change: string; changePct: string }> = {};
    try {
      const wlRows = await page.locator('[class*="watchlist"] [class*="row"], [class*="symbolsList"] [class*="item"]').all();
      for (const row of wlRows) {
        const text = (await row.innerText()).trim().split(/\n/).map(s => s.trim()).filter(Boolean);
        if (text.length >= 2) {
          const symbol = text[0];
          watchlistPrices[symbol] = {
            price: text[1] ?? "",
            change: text[2] ?? "",
            changePct: text[3] ?? "",
          };
        }
      }
    } catch { /* skip */ }

    return {
      account,
      positions,
      orders,
      watchlistPrices: Object.keys(watchlistPrices).length > 0 ? watchlistPrices : undefined,
      screenshotBase64,
      scrapedAt: new Date().toISOString(),
    } as BrokerSnapshot & { watchlistPrices?: Record<string, unknown> };
  });
}
