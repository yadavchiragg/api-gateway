"use client";

/**
 * ============================================================
 *  Distributed API Gateway — Traffic Control Dashboard
 *  Stack: Next.js 14 + Tailwind CSS
 * ============================================================
 *
 *  This dashboard fires requests to the FastAPI backend and
 *  visualises each response as a coloured "packet" block:
 *    🟢 Green  → HTTP 200 OK  (request allowed)
 *    🔴 Red    → HTTP 429     (rate limit hit)
 *
 *  The API URL is read from the NEXT_PUBLIC_API_URL env var
 *  so we can swap localhost ↔ live Render URL with zero code changes.
 */

import { useState, useRef, useCallback, useEffect } from "react";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
type RequestStatus = "success" | "blocked" | "pending";

interface TrafficEntry {
  id: number;
  status: RequestStatus;
  statusCode: number;
  ticker: string;
  price?: number;
  message: string;
  timestamp: string;
  remaining?: number;
  retryAfter?: number;
  count?: number;
}

// ─────────────────────────────────────────────────────────────
// CONFIG — reads from .env.local
// ─────────────────────────────────────────────────────────────
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const TICKERS  = ["AAPL", "GOOGL", "MSFT", "AMZN", "TSLA"];

// ─────────────────────────────────────────────────────────────
// HELPER — format timestamp to HH:MM:SS.ms
// ─────────────────────────────────────────────────────────────
function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour:   "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }) + "." + String(date.getMilliseconds()).padStart(3, "0");
}

// ─────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────

/** Single traffic log row */
function TrafficRow({ entry, index }: { entry: TrafficEntry; index: number }) {
  const isSuccess = entry.status === "success";
  const isPending = entry.status === "pending";

  return (
    <div
      className={`
        traffic-row flex items-start gap-3 p-3 rounded-lg border
        transition-all duration-300 font-mono text-sm
        ${isPending
          ? "bg-zinc-900 border-zinc-700 opacity-60"
          : isSuccess
            ? "bg-emerald-950/40 border-emerald-800/50 shadow-[0_0_12px_rgba(16,185,129,0.08)]"
            : "bg-red-950/40 border-red-800/50 shadow-[0_0_12px_rgba(239,68,68,0.08)]"
        }
      `}
      style={{ animationDelay: `${index * 20}ms` }}
    >
      {/* Status badge */}
      <span
        className={`
          flex-shrink-0 px-2 py-0.5 rounded text-xs font-bold tracking-wider
          ${isPending ? "bg-zinc-800 text-zinc-400"
            : isSuccess ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
            : "bg-red-500/20 text-red-400 border border-red-500/30"}
        `}
      >
        {isPending ? "···" : entry.statusCode}
      </span>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`font-bold ${isSuccess ? "text-emerald-300" : isPending ? "text-zinc-500" : "text-red-300"}`}>
            {entry.ticker}
          </span>
          {entry.price && (
            <span className="text-emerald-400 font-semibold">
              ${entry.price.toFixed(2)}
            </span>
          )}
          <span className={`text-xs ${isSuccess ? "text-zinc-400" : isPending ? "text-zinc-600" : "text-red-400/70"}`}>
            {entry.message}
          </span>
        </div>

        {/* Meta row */}
        <div className="flex gap-3 mt-1 text-xs text-zinc-600">
          <span>{entry.timestamp}</span>
          {entry.count !== undefined && (
            <span className={isSuccess ? "text-emerald-600" : "text-red-600"}>
              req #{entry.count}
            </span>
          )}
          {entry.remaining !== undefined && (
            <span>remaining: <span className={entry.remaining > 0 ? "text-zinc-400" : "text-red-500"}>{entry.remaining}</span></span>
          )}
          {entry.retryAfter !== undefined && !isSuccess && (
            <span className="text-amber-600">retry in {entry.retryAfter}s</span>
          )}
        </div>
      </div>

      {/* Pulse indicator */}
      {!isPending && (
        <span className={`flex-shrink-0 w-2 h-2 rounded-full mt-1.5 ${isSuccess ? "bg-emerald-500" : "bg-red-500"} animate-pulse`} />
      )}
    </div>
  );
}

/** Gauge bar showing rate-limit consumption */
function RateLimitGauge({ used, max }: { used: number; max: number }) {
  const pct   = Math.min((used / max) * 100, 100);
  const color = used >= max ? "bg-red-500" : used >= max * 0.6 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs font-mono">
        <span className="text-zinc-400">Rate Window Usage</span>
        <span className={used >= max ? "text-red-400 font-bold" : "text-zinc-300"}>
          {used} / {max} req
        </span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Stats card */
function StatCard({ label, value, sub, accent }: {
  label: string; value: string | number; sub?: string; accent?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-1">
      <div className="text-xs text-zinc-500 uppercase tracking-widest font-mono">{label}</div>
      <div className={`text-2xl font-bold font-mono tabular-nums ${accent || "text-white"}`}>{value}</div>
      {sub && <div className="text-xs text-zinc-600 font-mono">{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN DASHBOARD COMPONENT
// ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [log, setLog]           = useState<TrafficEntry[]>([]);
  const [loading, setLoading]   = useState(false);
  const [burstMode, setBurst]   = useState(false);
  const [totalReqs, setTotal]   = useState(0);
  const [blocked,  setBlocked]  = useState(0);
  const [allowed,  setAllowed]  = useState(0);
  const [lastCount, setCount]   = useState(0);
  const [backendOk, setBackend] = useState<boolean | null>(null);
  const idRef = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);

  // ── Health check on mount ──────────────────────────────
  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then(r => r.ok ? setBackend(true) : setBackend(false))
      .catch(() => setBackend(false));
  }, []);

  // ── Auto-scroll log to bottom ──────────────────────────
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  // ── Core: fire one request to the rate-limited endpoint ─
  const fireRequest = useCallback(async (ticker?: string) => {
    const t      = ticker || TICKERS[Math.floor(Math.random() * TICKERS.length)];
    const thisId = ++idRef.current;
    const ts     = formatTime(new Date());

    // Add a "pending" placeholder immediately so UI is snappy
    const pending: TrafficEntry = {
      id: thisId, status: "pending", statusCode: 0,
      ticker: t, message: "sending...", timestamp: ts,
    };
    setLog(prev => [...prev.slice(-49), pending]); // keep last 50
    setTotal(n => n + 1);

    try {
      const res  = await fetch(`${API_BASE}/api/v1/stock-price?ticker=${t}`);
      const json = await res.json();

      if (res.ok) {
        // ── 200 OK ─────────────────────────────────────
        const entry: TrafficEntry = {
          id:         thisId,
          status:     "success",
          statusCode: 200,
          ticker:     t,
          price:      json.data?.price,
          message:    `${json.data?.company || t}`,
          timestamp:  formatTime(new Date()),
          remaining:  json.rate_limit?.remaining,
          count:      json.rate_limit?.count,
        };
        setLog(prev => prev.map(e => e.id === thisId ? entry : e));
        setAllowed(n => n + 1);
        setCount(json.rate_limit?.count ?? 0);
      } else {
        // ── 429 Too Many Requests ──────────────────────
        const detail = json.detail || {};
        const entry: TrafficEntry = {
          id:         thisId,
          status:     "blocked",
          statusCode: 429,
          ticker:     t,
          message:    detail.message || "Rate limit exceeded",
          timestamp:  formatTime(new Date()),
          remaining:  0,
          retryAfter: detail.retry_after,
          count:      lastCount + 1,
        };
        setLog(prev => prev.map(e => e.id === thisId ? entry : e));
        setBlocked(n => n + 1);
      }
    } catch (err) {
      // Network / CORS error
      const entry: TrafficEntry = {
        id:         thisId,
        status:     "blocked",
        statusCode: 0,
        ticker:     t,
        message:    "Network error — is the backend running?",
        timestamp:  formatTime(new Date()),
      };
      setLog(prev => prev.map(e => e.id === thisId ? entry : e));
      setBlocked(n => n + 1);
    }
  }, [lastCount]);

  // ── Burst: fire 8 rapid requests to trigger the limiter ─
  const fireBurst = useCallback(async () => {
    setBurst(true);
    setLoading(true);
    // Fire 8 requests with 150ms gaps between each
    for (let i = 0; i < 8; i++) {
      await fireRequest();
      await new Promise(r => setTimeout(r, 150));
    }
    setLoading(false);
    setBurst(false);
  }, [fireRequest]);

  const clearLog = () => {
    setLog([]);
    setTotal(0);
    setBlocked(0);
    setAllowed(0);
    setCount(0);
  };

  const blockRate = totalReqs > 0 ? Math.round((blocked / totalReqs) * 100) : 0;

  // ─────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-950 text-white">

      {/* ── HEADER ─────────────────────────────────────── */}
      <header className="border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo mark */}
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xs font-black">
              GW
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight">API Gateway</h1>
              <p className="text-xs text-zinc-500 font-mono">Rate Limiter · Traffic Dashboard</p>
            </div>
          </div>

          {/* Backend status pill */}
          <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-mono
            ${backendOk === true  ? "border-emerald-800 bg-emerald-950/50 text-emerald-400"
            : backendOk === false ? "border-red-800 bg-red-950/50 text-red-400"
            :                       "border-zinc-700 bg-zinc-900 text-zinc-500"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              backendOk === true ? "bg-emerald-500 animate-pulse" :
              backendOk === false ? "bg-red-500" : "bg-zinc-600"
            }`} />
            {backendOk === true ? "Backend Online" : backendOk === false ? "Backend Offline" : "Checking..."}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">

        {/* ── CONFIG STRIP ───────────────────────────────── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 font-mono text-xs text-zinc-400 flex flex-wrap gap-x-6 gap-y-1">
          <span>endpoint: <span className="text-zinc-300">{API_BASE}/api/v1/stock-price</span></span>
          <span>limit: <span className="text-emerald-400">5 req / 10s</span></span>
          <span>algorithm: <span className="text-amber-400">Fixed-Window Counter</span></span>
          <span>store: <span className="text-blue-400">Redis</span></span>
        </div>

        {/* ── STATS GRID ──────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Total Sent"  value={totalReqs} sub="all requests"      />
          <StatCard label="Allowed"     value={allowed}   sub="HTTP 200 OK"       accent="text-emerald-400" />
          <StatCard label="Blocked"     value={blocked}   sub="HTTP 429"          accent="text-red-400" />
          <StatCard label="Block Rate"  value={`${blockRate}%`} sub="of all traffic" accent={blockRate > 40 ? "text-red-400" : "text-zinc-300"} />
        </div>

        {/* ── RATE GAUGE ──────────────────────────────────── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <RateLimitGauge used={lastCount} max={5} />
          <p className="mt-2 text-xs text-zinc-600 font-mono">
            Counter resets every 10 seconds. Each Redis key auto-expires via TTL.
          </p>
        </div>

        {/* ── CONTROLS ──────────────────────────────────────── */}
        <div className="flex flex-wrap gap-3">
          {/* Single request */}
          <button
            onClick={() => { setLoading(true); fireRequest().finally(() => setLoading(false)); }}
            disabled={loading}
            className="
              px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50
              disabled:cursor-not-allowed text-white font-semibold rounded-lg
              text-sm transition-all duration-150 active:scale-95 shadow-lg
              shadow-emerald-900/30 flex items-center gap-2
            "
          >
            <span className={loading && !burstMode ? "animate-spin" : ""}>⬆</span>
            Send Request
          </button>

          {/* Burst — fires 8 to trigger rate limiter */}
          <button
            onClick={fireBurst}
            disabled={loading}
            className="
              px-5 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50
              disabled:cursor-not-allowed text-white font-semibold rounded-lg
              text-sm transition-all duration-150 active:scale-95 shadow-lg
              shadow-amber-900/30 flex items-center gap-2
            "
          >
            <span className={burstMode ? "animate-spin" : ""}>⚡</span>
            Burst Attack (×8)
          </button>

          {/* Clear log */}
          <button
            onClick={clearLog}
            disabled={loading}
            className="
              px-5 py-2.5 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50
              text-zinc-300 font-semibold rounded-lg text-sm
              transition-all duration-150 active:scale-95 border border-zinc-700
            "
          >
            Clear Log
          </button>
        </div>

        {/* ── LEGEND ──────────────────────────────────────── */}
        <div className="flex gap-4 text-xs font-mono text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
            200 OK — Allowed
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
            429 — Rate Limited
          </span>
        </div>

        {/* ── TRAFFIC LOG ─────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-300 tracking-wide uppercase font-mono">
              Traffic Log
            </h2>
            <span className="text-xs text-zinc-600 font-mono">{log.length} entries · last 50</span>
          </div>

          {log.length === 0 ? (
            <div className="border border-dashed border-zinc-800 rounded-xl p-12 text-center">
              <div className="text-3xl mb-3">📡</div>
              <p className="text-zinc-500 text-sm font-mono">No traffic yet.</p>
              <p className="text-zinc-600 text-xs mt-1 font-mono">
                Click &quot;Send Request&quot; or &quot;Burst Attack&quot; to begin.
              </p>
            </div>
          ) : (
            <div
              ref={logRef}
              className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1 scrollbar-thin scrollbar-track-zinc-900 scrollbar-thumb-zinc-700"
            >
              {[...log].reverse().map((entry, i) => (
                <TrafficRow key={entry.id} entry={entry} index={i} />
              ))}
            </div>
          )}
        </div>

        {/* ── ARCHITECTURE NOTE ───────────────────────────── */}
        <div className="border border-zinc-800/50 rounded-xl p-5 bg-zinc-900/30 space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400 font-mono">
            How It Works — Fixed-Window Algorithm
          </h3>
          <ol className="text-xs text-zinc-500 font-mono space-y-1 list-decimal list-inside">
            <li>Each request hits FastAPI, which extracts the client IP.</li>
            <li>A Redis key is built: <span className="text-zinc-300">ratelimit:{"<ip>"}:{"<window_bucket>"}</span></li>
            <li>Redis <span className="text-amber-400">INCR</span> atomically increments the counter.</li>
            <li>On first increment, <span className="text-amber-400">EXPIRE 10</span> is set — Redis auto-deletes the key after 10s.</li>
            <li>If counter &gt; 5 → <span className="text-red-400">HTTP 429 Too Many Requests</span>. Otherwise → <span className="text-emerald-400">200 OK</span>.</li>
          </ol>
        </div>

      </main>
    </div>
  );
}
