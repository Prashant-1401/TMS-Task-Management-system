#!/bin/bash
# MCS — Local Server Start (100 Users, On-Prem)
# Usage: ./start-local.sh          # dev (uvicorn --reload + vite dev)
#        ./start-local.sh --prod   # prod for 100 users (gunicorn -w 4 + vite preview)
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="dev"
if [[ "$1" == "--prod" ]]; then MODE="prod"; fi

echo "=== MCS Local Server ($MODE) ==="
echo "Root: $ROOT"

# Fix venv pip path if stale (was MCS ACTION IS → Projects/mcs-app)
if grep -q "MCS ACTION IS" "$ROOT/backend/venv/bin/pip" 2>/dev/null; then
  echo "Fixing venv pip path..."
  sed -i "s|/home/prashant/MCS ACTION IS|/home/prashant/Projects/mcs-app|g" "$ROOT/backend/venv/bin/pip" "$ROOT/backend/venv/bin/pip3" "$ROOT/backend/venv/bin/pip3.12" 2>/dev/null || true
fi

# Check env
echo "--- Checking env ---"
if [[ ! -f "$ROOT/backend/.env" ]]; then
  echo "Missing backend/.env — copy from backend/.env.example"; exit 1
fi
if [[ ! -f "$ROOT/.env" ]]; then
  echo "Creating .env for local frontend..."
  echo "VITE_API_BASE_URL=http://localhost:8000" > "$ROOT/.env"
  echo "VITE_API_KEY=0114cccb4238d3faa118e312dbe75abe" >> "$ROOT/.env"
fi
echo "backend/.env DATABASE_URL: $(grep -E "^DATABASE_URL" "$ROOT/backend/.env" | head -n1 | cut -c1-70)..."
echo "backend/.env API_KEY: $(grep -E "^API_KEY" "$ROOT/backend/.env" | head -n1)"
echo ".env VITE_API_BASE_URL: $(grep VITE_API_BASE_URL "$ROOT/.env" || echo "MISSING")"
echo ".env VITE_API_KEY: $(grep VITE_API_KEY "$ROOT/.env" | head -n1)"

# Kill old
echo "--- Stopping old servers if running ---"
pkill -f "uvicorn app.main:app" 2>/dev/null || true
pkill -f "gunicorn.*app.main" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1

if [[ "$MODE" == "prod" ]]; then
  echo "--- Building frontend (prod) ---"
  npm run build
  echo "--- Starting backend PROD (gunicorn -w 4) on :8000 ---"
  nohup "$ROOT/backend/venv/bin/gunicorn" app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:8000 --timeout 60 --keep-alive 5 --chdir "$ROOT/backend" > /tmp/mcs-backend.log 2>&1 &
  BACK_PID=$!
  echo "Backend PID $BACK_PID log /tmp/mcs-backend.log"
  sleep 3
  echo "--- Starting frontend PROD preview on :4173 ---"
  nohup npm run preview -- --host 0.0.0.0 --port 4173 > /tmp/mcs-frontend.log 2>&1 &
  FRONT_PID=$!
  echo "Frontend PID $FRONT_PID log /tmp/mcs-frontend.log"
  sleep 3
  echo "--- Health ---"
  curl -s http://localhost:8000/api/health | head -n 30 || echo "Backend not yet ready, check /tmp/mcs-backend.log"
  echo ""
  echo "Open: Frontend http://localhost:4173  Backend http://localhost:8000/docs"
else
  echo "--- Starting backend DEV (uvicorn --reload) on :8000 ---"
  nohup "$ROOT/backend/venv/bin/uvicorn" app.main:app --host 0.0.0.0 --port 8000 --reload --app-dir "$ROOT/backend" > /tmp/mcs-backend.log 2>&1 &
  BACK_PID=$!
  echo "Backend PID $BACK_PID log /tmp/mcs-backend.log"
  sleep 3
  echo "--- Starting frontend DEV (vite) on :5173 ---"
  nohup npm run dev -- --host 0.0.0.0 > /tmp/mcs-frontend.log 2>&1 &
  FRONT_PID=$!
  echo "Frontend PID $FRONT_PID log /tmp/mcs-frontend.log"
  sleep 4
  echo "--- Health ---"
  curl -s http://localhost:8000/api/health 2>&1 | head -n 30 || echo "Backend not yet ready"
  echo ""
  echo "Open: Frontend http://localhost:5173  Backend http://localhost:8000/docs"
fi

echo ""
echo "Logs: tail -f /tmp/mcs-backend.log /tmp/mcs-frontend.log"
echo "Stop: pkill -f uvicorn; pkill -f gunicorn; pkill -f vite"
echo "Switch to cloud: echo VITE_API_BASE_URL=https://mcs-action-is-1.onrender.com > .env && npm run build"
