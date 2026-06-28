#!/usr/bin/env node
/**
 * HTTP microservice wrapper around the TradingView data tools.
 *
 * The MCP server (dist/index.js) speaks stdio and is meant for local clients
 * like Claude Desktop. To consume TradingView data from a *separate* process
 * over the network (e.g. the trading bot running as another Railway service),
 * we expose the same underlying functions over a tiny read-only HTTP API.
 *
 * Routes:
 *   GET /health                         → { ok: true }              (no auth)
 *   GET /ohlcv?symbol=&resolution=&countback=  → { symbol, resolution, bars }
 *   GET /quote?symbols=A,B,C            → { quotes: [...] }
 *
 * Auth: if BRIDGE_TOKEN is set, every data route requires it via either
 *   Authorization: Bearer <token>   or   x-bridge-token: <token>
 *
 * Session: on a platform with no interactive login (Railway), provide the
 * TradingView session via the TV_SESSION_JSON env var (the contents of a
 * local .tv_session.json). It is written to TV_SESSION_FILE at boot so the
 * existing auth/session code finds it. The session still expires ~25 days
 * after it was saved — refresh it by re-running `node dist/login.js
 * --interactive` locally and pasting the new JSON into TV_SESSION_JSON.
 */
import http from "http";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { getOHLCV } from "./ohlcv.js";
import { getQuote } from "./market.js";

const PORT = parseInt(process.env.PORT || "8080", 10);
const TOKEN = process.env.BRIDGE_TOKEN || "";
const SESSION_FILE = process.env.TV_SESSION_FILE ?? ".tv_session.json";

// ─── Session bootstrap ────────────────────────────────────────────────────────
// Materialise the session file from an env var so no volume is required.
function bootstrapSession(): void {
  const raw = process.env.TV_SESSION_JSON || process.env.TV_SESSION_B64;
  if (!raw) {
    if (!existsSync(SESSION_FILE)) {
      console.error(
        `[http] WARNING: no TV_SESSION_JSON env and no session file at ${SESSION_FILE}. ` +
          `Data requests will fail until a valid session is provided.`,
      );
    }
    return;
  }
  try {
    const json = process.env.TV_SESSION_B64
      ? Buffer.from(raw, "base64").toString("utf-8")
      : raw;
    JSON.parse(json); // validate
    writeFileSync(SESSION_FILE, json);
    console.error(`[http] Session written to ${SESSION_FILE} from env`);
  } catch (err) {
    console.error(`[http] Failed to materialise session from env: ${(err as Error).message}`);
  }
}

// TradingView sessions last ~25 days before the cookies expire and a re-login
// is needed. We surface the session's age on /health so the bot can warn the
// operator BEFORE data requests start failing.
const SESSION_TTL_DAYS = 25;

function sessionInfo(): {
  present: boolean;
  savedAt: string | null;
  ageDays: number | null;
  expiresInDays: number | null;
} {
  const empty = { present: false, savedAt: null, ageDays: null, expiresInDays: null };
  try {
    if (!existsSync(SESSION_FILE)) return empty;
    const s = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    const savedAt: string | null = s.savedAt ?? null;
    if (!savedAt) return { present: true, savedAt: null, ageDays: null, expiresInDays: null };
    const t = new Date(savedAt).getTime();
    if (Number.isNaN(t)) return { present: true, savedAt, ageDays: null, expiresInDays: null };
    const ageDays = +((Date.now() - t) / 86_400_000).toFixed(1);
    const expiresInDays = +(SESSION_TTL_DAYS - ageDays).toFixed(1);
    return { present: true, savedAt, ageDays, expiresInDays };
  } catch {
    return empty;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function authorized(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true; // auth disabled
  const header = req.headers["authorization"];
  const bearer = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : "";
  const alt = req.headers["x-bridge-token"];
  const provided = bearer || (typeof alt === "string" ? alt : "");
  return provided === TOKEN;
}

// ─── Server ───────────────────────────────────────────────────────────────────
bootstrapSession();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    const path = url.pathname;

    if (path === "/health" || path === "/") {
      sendJSON(res, 200, {
        ok: true,
        service: "tradingview-http",
        time: new Date().toISOString(),
        session: sessionInfo(),
      });
      return;
    }

    if (!authorized(req)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }

    if (path === "/ohlcv") {
      const symbol = url.searchParams.get("symbol");
      const resolution = url.searchParams.get("resolution") || "1m";
      const countback = parseInt(url.searchParams.get("countback") || "300", 10);
      if (!symbol) {
        sendJSON(res, 400, { error: "missing required query param: symbol (e.g. BINANCE:BTCUSDT)" });
        return;
      }
      const bars = await getOHLCV(symbol, resolution, { countback });
      sendJSON(res, 200, { symbol, resolution, count: bars.length, bars });
      return;
    }

    if (path === "/quote") {
      const symbolsParam = url.searchParams.get("symbols") || url.searchParams.get("symbol");
      if (!symbolsParam) {
        sendJSON(res, 400, { error: "missing required query param: symbols (comma-separated)" });
        return;
      }
      const symbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean);
      const quotes = await getQuote(symbols);
      sendJSON(res, 200, { quotes });
      return;
    }

    sendJSON(res, 404, { error: "not found", routes: ["/health", "/ohlcv", "/quote"] });
  } catch (err) {
    console.error("[http] request error:", err);
    sendJSON(res, 500, { error: (err as Error).message || "internal error" });
  }
});

server.listen(PORT, () => {
  console.error(`[http] TradingView HTTP microservice listening on :${PORT}`);
  console.error(`[http] auth ${TOKEN ? "ENABLED" : "DISABLED"}`);
});
