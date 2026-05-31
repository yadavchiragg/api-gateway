"""
=============================================================
  Distributed API Gateway & Rate Limiter — FastAPI Backend
  Stack:  FastAPI + Redis (async) + Python 3.11+
=============================================================

ARCHITECTURAL OVERVIEW:
  This service acts as an API Gateway that enforces a
  Fixed-Window Rate Limiting strategy using Redis atomic
  INCR + EXPIRE operations.

  Rate Limit Rule: 5 requests per 10 seconds per unique IP.
"""

import os
import time
import random
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ─────────────────────────────────────────────────────────
# 0.  CONFIG — Load environment variables from .env file
# ─────────────────────────────────────────────────────────
load_dotenv()

REDIS_URL         = os.getenv("REDIS_URL", "redis://localhost:6379")
RATE_LIMIT_MAX    = int(os.getenv("RATE_LIMIT_MAX", 5))     # max requests
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", 10)) # window in seconds

# ─────────────────────────────────────────────────────────
# 1.  REDIS CONNECTION — async client, shared app-wide
#
#     We use FastAPI's lifespan context manager to open the
#     Redis connection at startup and close it cleanly at
#     shutdown — zero resource leaks.
# ─────────────────────────────────────────────────────────
redis_client: aioredis.Redis | None = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage Redis connection lifecycle (startup → yield → shutdown)."""
    global redis_client
    print(f"[STARTUP] Connecting to Redis at: {REDIS_URL}")
    redis_client = await aioredis.from_url(
        REDIS_URL,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=5,
    )
    try:
        await redis_client.ping()
        print("[STARTUP] ✅ Redis connection established.")
    except Exception as e:
        print(f"[STARTUP] ❌ Redis connection FAILED: {e}")

    yield  # ← App runs here

    print("[SHUTDOWN] Closing Redis connection...")
    await redis_client.aclose()


# ─────────────────────────────────────────────────────────
# 2.  FASTAPI APP INSTANCE
# ─────────────────────────────────────────────────────────
app = FastAPI(
    title="Distributed API Gateway & Rate Limiter",
    description="FinTech-grade traffic control with Redis-backed rate limiting.",
    version="1.0.0",
    lifespan=lifespan,
)

# ─────────────────────────────────────────────────────────
# 3.  CORS MIDDLEWARE
#     CRITICAL: allow_origins=["*"] ensures the Vercel/Render
#     frontend can talk to this backend without browser CORS
#     preflight rejections.
# ─────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Swap for specific domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────
# 4.  CORE RATE LIMITER LOGIC
#
#     Algorithm: Fixed-Window Counter
#
#     STEP 1 — Build a unique Redis key per IP per time window:
#                 key = "ratelimit:{ip}:{window_bucket}"
#              where window_bucket = floor(unix_time / window_size)
#              e.g., at t=173_456_789s with window=10s → bucket=17345678
#
#     STEP 2 — Atomically INCREMENT that key's counter.
#              redis.INCR is a single atomic command — safe in
#              a distributed system with multiple app instances.
#
#     STEP 3 — On the very first increment (counter == 1),
#              set a TTL of window_size seconds so Redis
#              auto-deletes the key when the window expires.
#              (We don't need cron jobs or manual cleanup!)
#
#     STEP 4 — If counter > MAX → reject with HTTP 429.
#              Otherwise → serve the request.
# ─────────────────────────────────────────────────────────

async def check_rate_limit(ip: str) -> dict:
    """
    Enforces rate limiting for a given IP address.

    Returns:
        allowed (bool)       — should the request proceed?
        current_count (int)  — requests made in this window
        remaining (int)      — requests left before blocking
        retry_after (int)    — seconds until the window resets
    """
    # Which 10-second bucket are we in right now?
    current_window = int(time.time() // RATE_LIMIT_WINDOW)

    # Unique key: one per IP per time window
    redis_key = f"ratelimit:{ip}:{current_window}"

    # ATOMIC increment — thread-safe across all app instances
    current_count = await redis_client.incr(redis_key)

    # Set expiry only when the key is brand-new (first request in window)
    if current_count == 1:
        await redis_client.expire(redis_key, RATE_LIMIT_WINDOW)

    # How many seconds until this key self-destructs?
    ttl         = await redis_client.ttl(redis_key)
    retry_after = ttl if ttl > 0 else RATE_LIMIT_WINDOW
    remaining   = max(0, RATE_LIMIT_MAX - current_count)
    allowed     = current_count <= RATE_LIMIT_MAX

    return {
        "allowed":       allowed,
        "current_count": current_count,
        "remaining":     remaining,
        "retry_after":   retry_after,
    }


# ─────────────────────────────────────────────────────────
# 5.  MOCK FINANCIAL DATA GENERATOR
# ─────────────────────────────────────────────────────────
MOCK_STOCKS = {
    "AAPL":  {"base": 189.50, "name": "Apple Inc."},
    "GOOGL": {"base": 175.20, "name": "Alphabet Inc."},
    "MSFT":  {"base": 415.80, "name": "Microsoft Corp."},
    "AMZN":  {"base": 198.60, "name": "Amazon.com Inc."},
    "TSLA":  {"base": 242.10, "name": "Tesla Inc."},
}

def generate_mock_price(ticker: str) -> dict:
    """Simulate a real stock price with ±2% random variance."""
    stock    = MOCK_STOCKS.get(ticker.upper(), MOCK_STOCKS["AAPL"])
    base     = stock["base"]
    variance = random.uniform(-0.02, 0.02)
    price    = round(base * (1 + variance), 2)
    change   = round(price - base, 2)

    return {
        "ticker":     ticker.upper(),
        "company":    stock["name"],
        "price":      price,
        "change":     change,
        "change_pct": round((change / base) * 100, 3),
        "currency":   "USD",
        "exchange":   "NASDAQ",
        "timestamp":  int(time.time()),
        "status":     "MOCK_DATA",
    }


# ─────────────────────────────────────────────────────────
# 6.  API ROUTES
# ─────────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
async def root():
    """Root health check — confirms the gateway is alive."""
    return {
        "service":    "Distributed API Gateway",
        "status":     "operational",
        "version":    "1.0.0",
        "rate_limit": f"{RATE_LIMIT_MAX} req / {RATE_LIMIT_WINDOW}s per IP",
    }


@app.get("/health", tags=["Health"])
async def health_check():
    """Deep health check — verifies Redis connectivity."""
    try:
        await redis_client.ping()
        redis_status = "connected"
    except Exception as e:
        redis_status = f"error: {str(e)}"

    return {"api": "healthy", "redis": redis_status, "ts": int(time.time())}


@app.get("/api/v1/stock-price", tags=["Financial Data"])
async def get_stock_price(request: Request, ticker: str = "AAPL"):
    """
    RATE-LIMITED ENDPOINT — Mock Stock Price Feed

    - Under limit  → 200 OK with mock stock data + rate-limit headers
    - Over limit   → 429 Too Many Requests + Retry-After header

    Query Params:
        ticker (str): e.g. AAPL, GOOGL, MSFT, AMZN, TSLA
    """
    # Extract real client IP (handles Render/Nginx proxy headers)
    forwarded_for = request.headers.get("X-Forwarded-For")
    client_ip     = forwarded_for.split(",")[0].strip() if forwarded_for else request.client.host

    # Run rate limit check
    rate_info = await check_rate_limit(client_ip)

    # RFC 6585 compliant rate-limit response headers
    headers = {
        "X-RateLimit-Limit":     str(RATE_LIMIT_MAX),
        "X-RateLimit-Remaining": str(rate_info["remaining"]),
        "X-RateLimit-Window":    f"{RATE_LIMIT_WINDOW}s",
        "X-RateLimit-Count":     str(rate_info["current_count"]),
    }

    # ── BLOCKED ──────────────────────────────────────────
    if not rate_info["allowed"]:
        headers["Retry-After"] = str(rate_info["retry_after"])
        raise HTTPException(
            status_code=429,
            detail={
                "error":       "RATE_LIMIT_EXCEEDED",
                "message":     f"Limit: {RATE_LIMIT_MAX} requests per {RATE_LIMIT_WINDOW}s.",
                "retry_after": rate_info["retry_after"],
                "client_ip":   client_ip,
            },
            headers=headers,
        )

    # ── ALLOWED ───────────────────────────────────────────
    return JSONResponse(
        content={
            "success": True,
            "data":    generate_mock_price(ticker),
            "rate_limit": {
                "limit":     RATE_LIMIT_MAX,
                "remaining": rate_info["remaining"],
                "window":    f"{RATE_LIMIT_WINDOW}s",
                "count":     rate_info["current_count"],
            },
        },
        headers=headers,
    )


@app.get("/api/v1/rate-status", tags=["Gateway Metrics"])
async def get_rate_status(request: Request):
    """Real-time rate-limit status for the calling IP — powers the dashboard."""
    forwarded_for = request.headers.get("X-Forwarded-For")
    client_ip     = forwarded_for.split(",")[0].strip() if forwarded_for else request.client.host

    current_window = int(time.time() // RATE_LIMIT_WINDOW)
    redis_key      = f"ratelimit:{client_ip}:{current_window}"

    count = await redis_client.get(redis_key)
    ttl   = await redis_client.ttl(redis_key)

    current_count = int(count) if count else 0

    return {
        "client_ip":      client_ip,
        "limit":          RATE_LIMIT_MAX,
        "window_seconds": RATE_LIMIT_WINDOW,
        "current_count":  current_count,
        "remaining":      max(0, RATE_LIMIT_MAX - current_count),
        "ttl_seconds":    ttl if ttl > 0 else 0,
        "blocked":        current_count >= RATE_LIMIT_MAX,
    }
