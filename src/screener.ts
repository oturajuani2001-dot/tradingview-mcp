import { fetchPost } from "./client.js";
import type { ScreenerResult } from "./types.js";

const SCANNER = "https://scanner.tradingview.com";

export type Market = "america" | "crypto" | "forex" | "futures" | "india" | "australia" | "canada";

export interface ScreenerFilter {
  left: string;
  operation:
    | "greater"
    | "less"
    | "greater_or_equal"
    | "less_or_equal"
    | "equal"
    | "not_equal"
    | "in_range"
    | "not_in_range"
    | "in"
    | "not_in"
    | "crosses_up"
    | "crosses_down";
  right: number | string | number[] | string[];
}

export interface ScreenerSort {
  sortBy: string;
  sortOrder: "asc" | "desc";
}

export interface ScreenerOptions {
  filters?: ScreenerFilter[];
  columns?: string[];
  sort?: ScreenerSort;
  range?: [number, number];
}

const DEFAULT_STOCK_COLUMNS = [
  "name",
  "close",
  "change",
  "change_abs",
  "volume",
  "market_cap_basic",
  "price_earnings_ttm",
  "earnings_per_share_basic_ttm",
  "sector",
  "exchange",
  "description",
];

const DEFAULT_CRYPTO_COLUMNS = [
  "name",
  "close",
  "change",
  "change_abs",
  "volume",
  "market_cap_calc",
  "exchange",
  "description",
];

const DEFAULT_FOREX_COLUMNS = [
  "name",
  "close",
  "change",
  "change_abs",
  "volume",
  "exchange",
  "description",
];

interface ScanResponse {
  data: Array<{ s: string; d: unknown[] }>;
  totalCount: number;
}

async function scan(
  market: Market,
  columns: string[],
  options: ScreenerOptions
): Promise<{ results: ScreenerResult[]; totalCount: number }> {
  const body: Record<string, unknown> = {
    columns,
    options: { lang: "en" },
    range: options.range ?? [0, 50],
  };
  if (options.filters?.length) body.filter = options.filters;
  if (options.sort) body.sort = options.sort;

  const data = await fetchPost<ScanResponse>(`${SCANNER}/${market}/scan`, body);
  return {
    results: (data.data ?? []).map((row) => ({ s: row.s, d: row.d as unknown[] })),
    totalCount: data.totalCount ?? 0,
  };
}

export async function screenStocks(options: ScreenerOptions = {}) {
  const columns = options.columns ?? DEFAULT_STOCK_COLUMNS;
  const { results, totalCount } = await scan("america", columns, options);
  return {
    columns,
    results: results.map((row) => {
      const obj: Record<string, unknown> = { symbol: row.s };
      columns.forEach((col, i) => { obj[col] = (row.d as unknown[])[i]; });
      return obj;
    }),
    totalCount,
  };
}

export async function screenCrypto(options: ScreenerOptions = {}) {
  const columns = options.columns ?? DEFAULT_CRYPTO_COLUMNS;
  const { results, totalCount } = await scan("crypto", columns, options);
  return {
    columns,
    results: results.map((row) => {
      const obj: Record<string, unknown> = { symbol: row.s };
      columns.forEach((col, i) => { obj[col] = (row.d as unknown[])[i]; });
      return obj;
    }),
    totalCount,
  };
}

export async function screenForex(options: ScreenerOptions = {}) {
  const columns = options.columns ?? DEFAULT_FOREX_COLUMNS;
  const { results, totalCount } = await scan("forex", columns, options);
  return {
    columns,
    results: results.map((row) => {
      const obj: Record<string, unknown> = { symbol: row.s };
      columns.forEach((col, i) => { obj[col] = (row.d as unknown[])[i]; });
      return obj;
    }),
    totalCount,
  };
}

// Common screener fields by category (not exhaustive — TV has hundreds)
export const SCREENER_FIELDS = {
  price: ["close", "open", "high", "low", "change", "change_abs", "change_from_open"],
  volume: ["volume", "average_volume_10d_calc", "average_volume_30d_calc", "average_volume_60d_calc", "average_volume_90d_calc"],
  market_data: ["market_cap_basic", "enterprise_value_fq", "shares_outstanding"],
  fundamentals: [
    "price_earnings_ttm", "price_earnings_growth_ttm", "price_sales_fq",
    "price_book_fq", "earnings_per_share_basic_ttm", "dividends_yield",
    "return_on_equity", "return_on_assets", "net_income", "gross_profit_margin",
    "operating_margin", "net_margin", "debt_to_equity",
  ],
  technical: [
    "RSI", "RSI[1]", "MACD.macd", "MACD.signal", "Stoch.K", "Stoch.D",
    "ADX", "ADX+DI", "ADX-DI", "CCI20", "aroon_up", "aroon_down",
    "BBpower", "AO", "Mom", "VWAP", "VWMA20",
    "SMA5", "SMA10", "SMA20", "SMA50", "SMA100", "SMA200",
    "EMA5", "EMA10", "EMA20", "EMA50", "EMA100", "EMA200",
    "Recommend.All", "Recommend.MA", "Recommend.Other",
  ],
  metadata: ["name", "description", "type", "exchange", "sector", "industry", "country", "currency_code"],
  volatility: ["beta_1_year", "52_week_high", "52_week_low", "all_time_high", "all_time_low"],
};
