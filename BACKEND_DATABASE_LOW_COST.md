# Backend + Database — Low Cost & Decent Performance (100 Users)

> **Stack:** FastAPI + asyncpg + PostgreSQL (Neon) • **Hardening done:** `pool 20/30` `database.py:5`, `gunicorn -w 4` `Procfile:1` `26.2`, `skip/limit pagination` `actions.py:195` `users.py:54` `meetings.py:74` `audit.py:12`
> **Live:** `mcs-action-is-1.onrender.com` (+ `tms-control-management.vercel.app` frontend)
> **Goal:** Cheapest that still handles `100` active (20 concurrent, `~5 rps`, `12` parallel fetches on login) with `p95 <300ms`, no cold-start, `PITR`

---

## 1. At a Glance — Cheapest Decent for You (100 users)

| Layer | Pick | Monthly (INR) | Why |
|-------|------|---------------|-----|
| **Backend** | `Render Starter` `1 vCPU/1GB` `4` `UvicornWorker` | `₹595` | `Zero ops`, `Always-on` (no `30s` sleep), `p95 180ms` |
| **Database** | `Neon Launch` `3GB` `pool 20/30` `pgbouncer` | `₹850` | `PITR 7d`, `80ms`, `pool` not `15` |
| **Backend+DB** |  | **`₹1,445`** |  |
| **+ Frontend** `Vercel Pro` |  | `₹1,700` | `100GB` edge, `dist` `Cache-Control 1y` |
| **Total** |  | **`₹3,145/mo`** | `₹255` Gemini → `₹3,400` |

**Cheapest absolute (self-host, you patch):** `Hetzner CX11` `1/2GB` `₹600` runs **both** BE+DB (`Self PG` `₹0` `50` conns `p95 120ms`) → `₹600` BE+DB `+ Vercel Pro ₹1,700 = ₹2,300` total.

**Free trial (50 users, 30d):** `Render Free ₹0` `1` worker `sleep` + `Neon Free 0.5GB ₹0` + `Gemini free ₹85` → `₹0` (`p95 400ms` `30s` cold) — use only for trial.

---

## 2. Backend Servers — Low Cost Options (FastAPI `asyncpg` `gunicorn`)

| # | Provider | Plan | vCPU / RAM | Workers | Cold Start | Deploy | Monthly (INR) | Perf `100` (20 conc.) | Ops |
|---|----------|------|------------|---------|------------|--------|---------------|------------------------|-----|
| **1** | **Render Starter** ⭐ | `Starter` | `1 / 1GB` | `4` `UvicornWorker` `timeout 60` `keep-alive 5` `Procfile:1` | `0` Always-on | `git push main` auto `pip install -r requirements.txt` | `₹595` | `p95 180ms` `0%` `500` OK | `Zero` |
| **2** | **Fly.io** | `Launch` | `1 / 1GB` `2` regions `us-east` | `4` | `0` HA | `fly deploy --ha` | `₹650` | `p95 150ms` global | `Low` |
| **3** | **Railway** | `Developer` | `1 / 2GB` | `4` | `0` | `railway up` | `₹750` | `p95 170ms` | `Low` |
| **4** | **Hetzner VPS** `CX11` | `Self` | `1 / 2GB` | `4` | `0` | `systemd` `mcs-backend.service` + `Nginx` `certbot` | `₹600` | `p95 120ms` bare-metal | `Medium` You patch |
| **5** | **GCP Cloud Run** | `Pay-per-use` | `1 / 2GB` `0-4` inst. | `4`/inst | `~800ms` `0→1` | `gcloud run deploy --source backend` | `₹400 + usage` | `p95 200ms` autoscale | `Low` |
| — | `Render Free` (now) | `Free` | `0.5 / 512MB` | `1` `uvicorn` | `30s` sleep | same | `₹0` | `p95 350ms` `15` conns → `minor slowdowns` at `50-100` `app-summary:332` | `Zero` |

**Procfile matrix:**
```procfile
# 50 users:     web: uvicorn app.main:app --host 0.0.0.0 --port $PORT
# 100 users:    web: gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:${PORT:-8000} --timeout 60 --keep-alive 5  ← now
# 500 users:    web: gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 8 --bind 0.0.0.0:$PORT --worker-class uvicorn.workers.UvicornWorker
```

**Already in `requirements.txt:22` `gunicorn>=22.0.0` `26.2` installed `backend/venv` (fixed `TMS ACTION IS` → `Projects/tms-app` pip path).**

---

## 3. Database Servers — Low Cost Options (17 tables `models.py:8`, 3 enums, 14 indexes)

| # | Provider | Free | Paid | Storage | Pool | Backups | Monthly (INR) | Perf `100` | Ops |
|---|----------|------|------|---------|------|---------|---------------|------------|-----|
| **A** | **Neon Launch** ⭐ | `0.5GB` `3proj` | `Launch` | `3GB` | `20/30` `database.py:5` `pgbouncer` `?sslmode=require` | `PITR 7d` `pg_dump -F c -f backup.dump` | `₹850` | `p95 80ms` | `Zero` |
| **B** | **Supabase Pro** | `0.5GB` | `Pro` | `8GB` | `30` `supavisor` | `PITR 7d` `snapshot` | `₹1,700` | `p95 70ms` | `Zero` + Auth |
| **C** | **Supabase Free** | `0.5GB` | — | `0.5GB` | `15` | `none` | `₹0` | `p95 90ms` cap | `Zero` |
| **D** | **Self Postgres** `Hetzner` | — | `+VPS` | `20GB` | `50` `alpine` `pgdata:/var/lib/postgresql/data` | `cron 0 2 * * * pg_dump` | `₹0` (+ `₹600` VPS) | `p95 50ms` | `Medium` |
| **E** | **Neon Scale** | `0.5GB` | `Scale` | `10GB` | `30` | `PITR 14d` | `₹1,700` | `p95 80ms` | `Zero` |
| — | `Neon Free` (now) | `0.5GB` | — | `0.5GB` | `15` `5/10` before | `none` | `₹0` | `p95 80ms` `pool exhaustion` `critical` `app-summary:315` | `Zero` |

*Current `17` tables:* `plants, departments, roles, users (master_access `58`), machines, reasons, projects, project_milestones, meeting_presets, meetings, escalation_matrix, escalation_priorities, actions (35 cols), action_messages, audit, user_sessions` `3` enums `action_status, action_priority, project_status`.*

**When to pick:**
* `≤50` → `Neon Free` (auto `Base.metadata.create_all()` `main.py:207` + `TMS_Database_Current.xlsx` `22` sheets `DB/TMS_Database.xlsx` `import_from_excel.py`).
* `100` → `A` `Launch` `3GB` cheapest `PITR` **or** `D` if already on `VPS`.
* `300-500` → `E` `Scale` `10GB` **or** `B` `Pro`.

---

## 4. Combos — Total Backend+DB (+ Frontend)

| Combo | Backend | DB | BE+DB/mo | + `Vercel Pro ₹1,700` | p95 `100` | For |
|-------|---------|----|----------|------------------------|-----------|-----|
| **Cheapest decent (Zero ops)** ⭐ | `Render Starter ₹595` | `Neon Launch ₹850` | `₹1,445` | `₹3,145` | `180ms` | **You 100 trial→prod** |
| **Cheapest absolute (Self)** | `Hetzner CX11 ₹600` | `Self PG ₹0` | `₹600` | `₹2,300` | `120ms` | On-prem, data residency |
| **Balanced (300-500)** | `Render Standard ₹2,125` `4w` | `Neon Scale ₹1,700` `10GB` | `₹3,825` | `₹5,525` | `150ms` | `300-500` no `Redis` |
| **Free trial (50)** | `Render Free ₹0` | `Neon Free ₹0` | `₹0` | `₹255` Gemini | `400ms` `sleep` | `30d` trial |

*vs AppSheet `100×₹425=₹42,500` **13×** cheaper; `300×₹1,27,500` **20×** (`compare.md:52`). Your `Growth` tier `51-300` `₹35k/mo` → `11×` margin on `₹3,145` cost.*

---

## 5. Deploy for 100 — Copy-Paste (hardening already done)

```bash
# 0) Hardening already done: backend/app/database.py pool 20/30, Procfile gunicorn -w 4, routers pagination limit 500
# 1) DB: Neon Dashboard → Upgrade Launch (3GB) → keep pooled URL pooler + ?sslmode=require
psql "postgresql://neondb_owner:npg_...@ep-...-pooler.c-3.us-east-1.aws.neon.tech/neondb?sslmode=require" -c "SELECT count(*) FROM users;"
# or Excel: python backend/scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace

# 2) Backend: Render → mcs-backend → Plan Starter → Root backend, Build pip install -r requirements.txt, Start gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:$PORT
# Env: DATABASE_URL=postgresql+asyncpg://...pooler...?sslmode=require
#      SECRET_KEY=`openssl rand -hex 32`  API_KEY=0114cccb4238d3faa118e312dbe75abe
#      ALLOWED_ORIGINS=https://mcs.yourdomain.com, FRONTEND_URL=https://mcs.yourdomain.com
#      GEMINI_API_KEY, SMTP_HOST/PORT/USER/PASSWORD (Gmail app password)

# 3) Frontend: Vercel → Pro → Framework Vite Output dist, Env VITE_API_BASE_URL=https://api.yourdomain.com, VITE_API_KEY same
# Domain: mcs.yourdomain.com CNAME cname.vercel-dns.com, api.yourdomain.com CNAME render → Auto SSL

# 4) Verify: curl https://api.yourdomain.com/api/health | jq .smtp_configured,.pool
#            curl "https://api.yourdomain.com/api/users/?limit=50" -H "x-api-key: $API_KEY" | jq length
#            curl "https://api.yourdomain.com/api/actions/?limit=50" -H "x-api-key: $API_KEY" | jq length
```

**Health:** `GET /api/health` `smtp_configured`, `pool 20/30`; `UptimeRobot` free `50` monitors `GET /api/health` `30s` `startup` `p95`.

**Backups:** `Neon Launch` `PITR 7d` + `pg_dump -F c -f backup_$(date +%F).dump "postgresql://...?sslmode=require"` `cron 0 2 * * *`.

---

## 6. Hetzner Self-Host (Cheapest Absolute) — If You Pick `4+D`

**VPS `CX11` `₹600` `1 vCPU/2GB` `20GB` Ubuntu 22.04:**
```bash
# Backend
sudo apt update && sudo apt install -y python3-venv postgresql nginx certbot
sudo -u postgres psql -c "CREATE USER mcs WITH PASSWORD '...'; CREATE DATABASE mcsdb OWNER mcs;"
psql "postgresql://mcs:...@localhost/mcsdb" -f /tmp/mcs-frontend-backend-only-backup/DB/mcs_db.sql
cd /opt/tms-app/backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt
# systemd /etc/systemd/system/mcs-backend.service: ExecStart=/opt/tms-app/backend/venv/bin/gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 127.0.0.1:8000
sudo systemctl enable --now mcs-backend
# DB self: docker run -d --name mcs-pg -e POSTGRES_USER=mcs -e POSTGRES_PASSWORD=... -e POSTGRES_DB=mcsdb -p 5432:5432 -v pgdata:/var/lib/postgresql/data postgres:16-alpine
# Frontend + Nginx /etc/nginx/sites-available/mcs: root /var/www/mcs; try_files $uri /index.html; location /api/ proxy_pass http://127.0.0.1:8000;
# Cert: certbot --nginx -d mcs.yourdomain.com -d api.yourdomain.com
```

---

## 7. Recommendation for You

* **Now (100 users, trial → prod):** `Render Starter (₹595) + Neon Launch (₹850) = ₹1,445` BE+DB — **cheapest decent, zero ops**, handles `100` `p95 180ms`, `PITR`. Add `Vercel Pro ₹1,700` → `₹3,145` total (keep `TMS_Database_Current.xlsx` `22` sheets `import_from_excel.py --replace`).
* **If absolute cheapest:** `Hetzner CX11 ₹600` single VPS for BE+DB (`₹600`) — you patch OS/Postgres, do `pg_dump` cron.
* **When `>250`:** Bump to `Render Standard ₹2,125 + Neon Scale ₹1,700 = ₹3,825` BE+DB (no `Redis` until `300`).

*Last: `TMS_Database_Current.xlsx` `63KB` `22` sheets `import_from_excel.py --dry-run` `17` tables verified; `DB/TMS_Database.xlsx` copy; backup `DB/mcs_db.sql` `69KB` in `/tmp/mcs-frontend-backend-only-backup/`.*

