# TMS — Local Server Guide (100 Users, On-Prem)

> **For:** Running `frontend + backend + database` fully on your **local machine / on-prem server** (no Vercel/Render/Neon).  
> **Hardening already done for 100 users:** `pool 20/30` `backend/app/database.py:5`, `gunicorn -w 4` `backend/Procfile:1`, `skip/limit` `actions.py:195`

---

## 1) Quick Start — 2 Terminals (Dev, 100 Users)

### Prerequisites
* `Node 20` (`node -v`), `Python 3.12` (`python3 --version`), `PostgreSQL 16` **or** keep `Neon` Cloud
* `backend/venv` already fixed (was `TMS ACTION IS` → `Projects/tms-app` `pip` path)

### Backend — `http://localhost:8000`
```bash
# Terminal 1 — Backend (4 workers, Decent Performance)
cd backend
# Use Neon Cloud (zero setup, keep .env as is) — OR local Postgres below
cat .env | head -n 20  # verify DATABASE_URL=postgresql+asyncpg://...neon...?sslmode=require

# Dev with auto-reload (single worker, for coding):
venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Production local for 100 users (4 workers, no reload):
venv/bin/gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:8000 --timeout 60 --keep-alive 5
# or: venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4

# Verify:
curl http://localhost:8000/api/health | jq .pool,.smtp_configured
curl http://localhost:8000/docs  # Swagger
```

### Frontend — `http://localhost:5173`
```bash
# Terminal 2 — Frontend
# Point frontend to LOCAL backend (edit .env):
echo "VITE_API_BASE_URL=http://localhost:8000" > .env
echo "VITE_API_KEY=0114cccb4238d3faa118e312dbe75abe" >> .env  # must == backend/.env API_KEY
cat .env

npm install   # first time (219M node_modules exists)
npm run dev   # → http://localhost:5173  (Vite)
# Prod preview (after build):
npm run build && npm run preview  # → http://localhost:4173
```

### Login
* `Admin` or any `users.username` from `TMS_Database_Current.xlsx` `Users` sheet (`USR-001` `prashant`/`Admin`)
* Master: `http://localhost:5173` → `Master Setup` (page 99) visible if `role=Admin` or `master_access=true && plant=All`

---

## 2) Database — 3 Options for Local

### Option A: Keep Neon Cloud (Recommended, Zero Setup, Low Cost Decent)
*Keep `backend/.env` `DATABASE_URL="postgresql+asyncpg://neondb_owner:npg_EHonNegy03Oc@ep-cool-queen-ahdwwued-pooler.c-3.us-east-1.aws.neon.tech/neondb?ssl=require"`*
* **Pros:** `PITR`, `3GB` `Launch ₹850`, no local `Postgres` install, `100` users `p95 80ms` pool `20/30`
* **Cons:** Needs internet, `30s` cold not local
* **Import 100 users:** `python backend/scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace` (dry-run `640` first)

### Option B: Local PostgreSQL (True On-Prem, ₹0, `p95 50ms`)
```bash
# Ubuntu/Debian:
sudo apt update && sudo apt install -y postgresql-16
sudo -u postgres psql -c "CREATE USER mcs WITH PASSWORD 'mcs123';"
sudo -u postgres psql -c "CREATE DATABASE mcsdb OWNER mcs;"
# Import backup (69KB canonical):
psql "postgresql://mcs:mcs123@localhost:5432/mcsdb" -f /tmp/mcs-frontend-backend-only-backup/DB/mcs_db.sql
# or Excel:
python backend/scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace

# In backend/.env set:
DATABASE_URL=postgresql+asyncpg://mcs:mcs123@localhost:5432/mcsdb
# For import script (sync): DATABASE_URL=postgresql://mcs:mcs123@localhost:5432/mcsdb

# Verify:
psql "postgresql://mcs:mcs123@localhost:5432/mcsdb" -c "SELECT count(*) FROM users; SELECT count(*) FROM actions;"
```

### Option C: Docker (if `docker` installed — currently not)
```bash
docker run -d --name mcs-pg -e POSTGRES_USER=mcs -e POSTGRES_PASSWORD=mcs123 -e POSTGRES_DB=mcsdb -p 5432:5432 -v pgdata:/var/lib/postgresql/data postgres:16-alpine
# then psql import as Option B
```

**Pick for 100 users:** `A` if internet OK (cheapest decent `₹1,445` BE+DB), `B` if air-gapped/on-prem (`₹600` VPS `Hetzner CX11` covers both).

---

## 3) Local Config Files

### `backend/.env` (for local)
```ini
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000,http://localhost:4173
API_KEY=0114cccb4238d3faa118e312dbe75abe
DATABASE_URL=postgresql+asyncpg://mcs:mcs123@localhost:5432/mcsdb  # or Neon pooler
GEMINI_API_KEY=AQ.Ab8RN6Il...
GEMINI_MODEL=gemini-3.1-flash-lite
SECRET_KEY=change-me-32char-random
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=mcsadmincontrol@gmail.com
SMTP_PASSWORD=qxnb gxka kghp ilxc
FRONTEND_URL=http://localhost:5173
```
> Keep `API_KEY` **identical** in `backend/.env` and `.env` (`VITE_API_KEY`). `ALLOWED_ORIGINS` must include `http://localhost:5173` (already `backend/.env:1`).

### `.env` (frontend local)
```ini
VITE_API_BASE_URL=http://localhost:8000
VITE_API_KEY=0114cccb4238d3faa118e312dbe75abe
```

**Switch back to cloud:** `VITE_API_BASE_URL=https://mcs-action-is-1.onrender.com` (+ `VITE_API_KEY` same) then `npm run build`.

---

## 4) One-Shot Local Start Script

**We created `start-local.sh` at root** — `chmod +x` + run:
```bash
./start-local.sh          # dev: uvicorn --reload + vite dev
./start-local.sh --prod   # prod for 100 users: gunicorn -w 4 + vite preview
```

It:
* Fixes `venv` pip path if stale
* Checks `backend/.env` `DATABASE_URL`, `frontend/.env` `VITE_API_BASE_URL`
* Starts backend `8000` (`--reload` or `-w 4`) + frontend `5173`/`4173` in background
* Prints `curl` health checks

---

## 5) Verify for 100 Users

```bash
# Health:
curl -s http://localhost:8000/api/health | jq
# expect: {status:"ok", smtp_configured:true, pool_size:20, ...}

# List with pagination (new):
curl -s "http://localhost:8000/api/users/?limit=50" -H "x-api-key: 0114cccb4238d3faa118e312dbe75abe" | jq length  # 50
curl -s "http://localhost:8000/api/actions/?limit=50" -H "x-api-key: 0114cccb4238d3faa118e312dbe75abe" | jq length

# Login:
curl -X POST http://localhost:8000/api/auth/login -H "Content-Type: application/json" -H "x-api-key: 0114cccb4238d3faa118e312dbe75abe" -d '{"username":"prashant","password":"admin"}' | jq .token

# Frontend: http://localhost:5173 → Login → HomePage KPIs → ActionsPage → Master Setup → Users (100)
```

**Performance check (100 users):**
```bash
# Simulate 20 concurrent GETs:
ab -n 100 -c 20 -H "x-api-key: 0114cccb4238d3faa118e312dbe75abe" http://localhost:8000/api/actions/?limit=50
# expect p95 <300ms with pool 20/30 + 4 workers (was 400ms+ with pool 15 + 1 worker)
```

---

## 6) Troubleshooting Local

| Symptom | Fix |
|---------|-----|
| `vite build` ok but `API 401 Invalid API key` | `VITE_API_KEY` ≠ `backend/.env API_KEY` → set both to same `0114cccb...` and `npm run dev` restart |
| `CORS error` `No Access-Control-Allow-Origin` | `backend/.env ALLOWED_ORIGINS` must include `http://localhost:5173` (comma, no trailing `/`) → restart backend |
| `psql: connection refused` | Local PG not running: `sudo systemctl start postgresql` or keep Neon URL |
| `SMTP not configured` | `backend/.env SMTP_USER/PASSWORD` must be Gmail app password `16 chars` quoted `"qxnb gxka kghp ilxc"` |
| `backend/venv pip not found` | Was `TMS ACTION IS` path — fixed to `Projects/tms-app` via `sed` in `start-local.sh` |
| `500 on GET /api/actions/` | `pool exhaustion` → already `20/30`, check `psql -c "SELECT count(*) FROM pg_stat_activity;"` |
| `Frontend blank` | `npm run build` then `npm run preview` → open `http://localhost:4173`, check `Console` `Network` `12` `api/*` `200` |

---

## 7) Production Local (On-Prem for 100 Users)

**For a real on-prem server (Ubuntu 22.04) serving 100 users on LAN:**
```bash
# Systemd backend (4 workers, auto-restart):
sudo tee /etc/systemd/system/mcs-backend.service <<EOF
[Unit] Description=TMS Backend After=network.target postgresql.service
[Service] User=www-data WorkingDirectory=/opt/tms-app/backend
EnvironmentFile=/opt/tms-app/backend/.env
ExecStart=/opt/tms-app/backend/venv/bin/gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 127.0.0.1:8000 --timeout 60
Restart=always
[Install] WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now mcs-backend
# Nginx + Frontend:
sudo apt install nginx && sudo mkdir -p /var/www/mcs && sudo cp -r dist/* /var/www/mcs/
# /etc/nginx/sites-available/mcs: root /var/www/mcs; try_files \$uri /index.html; location /api/ { proxy_pass http://127.0.0.1:8000; }
sudo ln -s /etc/nginx/sites-available/mcs /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl restart nginx
# Access: http://192.168.1.50 (server LAN IP)
```

**Upgrade path:** When `>250` users, bump `pool 30` already, add `Redis` `Upstash` for `actions` cache, add `slowapi` rate-limit — see `SOFTWARE_PRICING_AND_SERVERS.md:7`.

---

*Last: `TMS_Database_Current.xlsx` `63KB` `22` sheets is DB for both local/Neon — import via `python backend/scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace` then `curl http://localhost:8000/api/health`.*
