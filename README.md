# Distributed API Gateway & Rate Limiter

Deployment Link: https://api-gateway-frontend-b1xq.onrender.com

**FinTech-grade traffic control** using FastAPI + Redis + Next.js.
Built for portfolio use — demonstrable in Big Tech interviews.

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js Dashboard  →  FastAPI Gateway  →  Redis Counter     │
│  (Vercel / Render)      (Render Web)       (Render Redis)    │
└──────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
api-gateway/
├── backend/
│   ├── main.py            ← FastAPI app + rate limiter logic
│   ├── requirements.txt   ← Python dependencies
│   ├── render.yaml        ← Render IaC (deploys backend + Redis)
│   └── .env.example       ← Environment variable template
│
└── frontend/
    ├── src/app/
    │   ├── page.tsx        ← Traffic dashboard (main UI)
    │   ├── layout.tsx      ← Root layout + fonts
    │   └── globals.css     ← Tailwind base + animations
    ├── package.json
    ├── tailwind.config.ts
    ├── next.config.js
    └── .env.local.example  ← Frontend env variable template
```

---

## Phase 1 — Run the Backend Locally

### Step 1 — Start Redis via Docker

```bash
# Pull and start Redis on default port 6379
# -d         → run in background (detached)
# --rm       → auto-remove container when stopped
# -p 6379:6379 → map container port to host
docker run -d --rm --name redis-dev -p 6379:6379 redis:7-alpine

# Verify it's running
docker ps
# You should see redis-dev in the list

# Test the connection manually (optional)
docker exec -it redis-dev redis-cli ping
# → PONG
```

### Step 2 — Set Up Python Environment

```bash
cd api-gateway/backend

# Create a virtual environment (keeps deps isolated)
python3 -m venv venv
source venv/bin/activate        # macOS/Linux
# venv\Scripts\activate         # Windows

# Install all dependencies
pip install -r requirements.txt
```

### Step 3 — Configure Environment Variables

```bash
# Copy the template and edit it
cp .env.example .env

# .env contents (defaults work for local Docker Redis):
# REDIS_URL=redis://localhost:6379
# RATE_LIMIT_MAX=5
# RATE_LIMIT_WINDOW=10
```

### Step 4 — Start the FastAPI Server

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Expected output:
# [STARTUP] Connecting to Redis at: redis://localhost:6379
# [STARTUP] ✅ Redis connection established.
# INFO:     Uvicorn running on http://0.0.0.0:8000
```

### Step 5 — Test the Rate Limiter

```bash
# Fire 7 rapid requests — first 5 should succeed, 6th and 7th should be blocked
for i in {1..7}; do
  curl -s -o /dev/null -w "Request $i: HTTP %{http_code}\n" \
    "http://localhost:8000/api/v1/stock-price?ticker=AAPL"
done

# Expected output:
# Request 1: HTTP 200
# Request 2: HTTP 200
# Request 3: HTTP 200
# Request 4: HTTP 200
# Request 5: HTTP 200
# Request 6: HTTP 429   ← BLOCKED
# Request 7: HTTP 429   ← BLOCKED
```

### Interactive API Docs (Swagger UI)
Open: http://localhost:8000/docs

---

## Phase 2 — Run the Frontend Locally

### Step 1 — Install Node Dependencies

```bash
cd api-gateway/frontend

# Requires Node.js 18+
node --version   # Should be v18.x or v20.x

npm install
```

### Step 2 — Configure Environment Variables

```bash
cp .env.local.example .env.local

# .env.local:
# NEXT_PUBLIC_API_URL=http://localhost:8000
```

### Step 3 — Start the Dev Server

```bash
npm run dev

# Open: http://localhost:3000
```

### Step 4 — Test the Dashboard

1. Click **"Send Request"** — watch a green ✅ block appear
2. Click **"Burst Attack (×8)"** — the first 5 go green, then red 🔴 blocks appear
3. Wait 10 seconds — click again — it resets!

---

## Phase 3 — Deploy to Render

### Deploy Backend + Redis

```bash
# Option A: Use the render.yaml Blueprint (recommended)
# 1. Push your backend/ folder to GitHub
# 2. Go to render.com → New → Blueprint
# 3. Connect your GitHub repo → Render auto-reads render.yaml
# 4. It creates BOTH the web service AND the Redis instance automatically

# Option B: Manual
# 1. New Web Service → connect GitHub → set root directory to "backend"
# 2. Build Command:  pip install -r requirements.txt
# 3. Start Command:  uvicorn main:app --host 0.0.0.0 --port $PORT
# 4. New Redis → free tier → copy the "Internal Redis URL"
# 5. Add env var: REDIS_URL = <the internal URL from step 4>
```

### Deploy Frontend to Render (or Vercel)

```bash
# Vercel (recommended for Next.js — faster, free tier):
npm install -g vercel
cd frontend
vercel deploy

# Then in Vercel dashboard → Settings → Environment Variables:
# NEXT_PUBLIC_API_URL = https://your-backend.onrender.com
```

---

## Phase 4 — Algorithm Deep-Dive (Interview Ready)

### The Fixed-Window Counter Algorithm

**The Redis key structure:**
```
ratelimit:{client_ip}:{window_bucket}

Example at unix time 1,700,000,045 with 10s window:
  bucket = floor(1700000045 / 10) = 170000004
  key    = "ratelimit:192.168.1.1:170000004"
```

**The two atomic Redis commands:**
```
INCR  ratelimit:192.168.1.1:170000004  → returns new integer count
EXPIRE ratelimit:192.168.1.1:170000004 10  → set TTL on first call only
```

**Why `INCR` is safe in distributed systems:**
- Redis is single-threaded for command execution
- `INCR` is an atomic operation — no race conditions
- Even with 10 app instances, Redis serialises all INCRs
- No locks needed, no lost updates

**The window lifecycle:**
```
t=0s  → bucket=0, key created, count=1, TTL=10s set
t=2s  → same key, count=2
t=8s  → same key, count=5 (LIMIT HIT)
t=10s → Redis auto-deletes the key (TTL expires)
t=10s → new bucket=1, new key, counter resets to 0
```

**Trade-offs vs Sliding Window:**
| Feature          | Fixed Window      | Sliding Window        |
|------------------|-------------------|-----------------------|
| Memory           | O(1) per IP       | O(n) per IP           |
| Accuracy         | ±window_size      | Exact                 |
| Edge case        | 2x burst possible | None                  |
| Implementation   | Simple (INCR)     | Complex (sorted sets) |
| Performance      | O(1)              | O(log n)              |

> The "2x burst" edge case: a client can make 5 requests at t=9s and
> 5 more at t=11s (the new window) — 10 total in 2 seconds. For strict
> FinTech limits, use a Sliding Window with Redis ZADD + ZRANGEBYSCORE.
> For most API gateways, Fixed Window is perfectly adequate.

---

## Environment Variables Reference

| Variable              | Location | Description                        |
|-----------------------|----------|------------------------------------|
| `REDIS_URL`           | backend  | Redis connection string            |
| `RATE_LIMIT_MAX`      | backend  | Max requests per window (default 5)|
| `RATE_LIMIT_WINDOW`   | backend  | Window size in seconds (default 10)|
| `NEXT_PUBLIC_API_URL` | frontend | FastAPI backend base URL           |

---

## API Endpoints

| Method | Path                    | Description                    |
|--------|-------------------------|--------------------------------|
| GET    | `/`                     | Gateway health check           |
| GET    | `/health`               | Deep health + Redis status     |
| GET    | `/api/v1/stock-price`   | **Rate-limited** stock price   |
| GET    | `/api/v1/rate-status`   | Current rate limit status      |
| GET    | `/docs`                 | Interactive Swagger UI         |
