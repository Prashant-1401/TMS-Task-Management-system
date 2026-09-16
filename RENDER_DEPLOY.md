# Deploy TMS to Render — Step-by-Step (Backend + Frontend + Database for 100 Users)

> **Repo:** `https://github.com/Prashant702/TMS-Task-Mangement-system` `b527d5d` `TMS` `pool 20/30` `gunicorn -w 4`
> **Time:** `15 min` manual, `5 min` with `render.yaml` Blueprint
> **Cost:** `Frontend Static Free` + `Backend Starter ₹595` + `DB Neon Free ₹0` = `₹595` (trial 50) → `Starter+Launch ₹1,445` for 100 users `p95 180ms`

---

## Option A — One-Click with `render.yaml` (Recommended)

### 1) Push `render.yaml` (already in repo)
```bash
git add render.yaml
git commit -m "chore: add Render Blueprint for TMS (backend 4w, frontend static, DB)"
git push origin main   # origin is Prashant702/TMS-Task-Mangement-system now
# or: git push tms702 main
```

### 2) Render Dashboard → Blueprint
1. `https://dashboard.render.com` → `New +` → `Blueprint` → `Connect` `Prashant702/TMS-Task-Mangement-system` → `Connect`
2. Render detects `render.yaml` → shows `tms-backend` (Web, `starter`), `tms-frontend` (Static, `free`), `tms-db` (Postgres `starter` — **delete this block if you keep Neon**)
3. Click `Apply` → Render creates services
4. **If you keep Neon (current `backend/.env` `neon.tech`):** In `tms-db` block → `Delete` database service before `Apply`, then after `tms-backend` is created go to `tms-backend` → `Environment` → `Add` `DATABASE_URL` = `postgresql+asyncpg://neondb_owner:npg_EHonNegy03Oc@ep-cool-queen-ahdwwued-pooler.c-3.us-east-1.aws.neon.tech/neondb?ssl=require` (pooled `?sslmode=require`)
5. Fill `sync: false` vars (see §3) → `Apply`

### 3) Fill `sync: false` Environment Variables (Dashboard → tms-backend → Environment)

| Key | Value | Where to get |
|-----|-------|--------------|
| `DATABASE_URL` | `postgresql+asyncpg://...neon.tech/neondb?sslmode=require` *or* `postgresql://tms:...@render-db/tmsdb` | Neon Dashboard → `Connection string` `Pooled` + `+asyncpg` OR Render `tms-db` `Internal Database URL` |
| `SECRET_KEY` | `openssl rand -hex 32` (keep stable) | `openssl rand -hex 32` on local |
| `API_KEY` | `0114cccb4238d3faa118e312dbe75abe` (same as frontend) | Generate `openssl rand -hex 16` |
| `GEMINI_API_KEY` | `AQ.Ab8RN...` | `https://aistudio.google.com` `Create API key` |
| `SMTP_USER` | `tmsadmincontrol@gmail.com` | Gmail |
| `SMTP_PASSWORD` | `"qxnb gxka kghp ilxc"` (quoted, 16 chars, app password) | Gmail `2FA` → `App Passwords` `16` |
| `FRONTEND_URL` | `https://tms-frontend.onrender.com` (after frontend deploys) | Render `tms-frontend` URL |
| `ALLOWED_ORIGINS` | `https://tms-frontend.onrender.com,http://localhost:5173` | Frontend URL + `http://localhost:5173` for local dev |
| `MASTER_PASSWORD` | `adroit@master2025` (change!) | Your master pass |

**Frontend `tms-frontend` → Environment:**
| Key | Value |
|-----|-------|
| `VITE_API_BASE_URL` | `https://tms-backend.onrender.com` (copy from `tms-backend` URL `https://tms-backend.onrender.com`) |
| `VITE_API_KEY` | **Same** `0114cccb4238d3faa118e312dbe75abe` |

> `VITE_` vars are **build-time** → changing them triggers **rebuild** (Render auto on push, or `Manual Deploy` → `Deploy latest commit`).

### 4) Wait for Deploy (3-5 min)
* `tms-backend` → `Logs` → `[lifespan] Database schema initialized` + `Uvicorn running` (`gunicorn -w 4`)
* `tms-frontend` → `Logs` → `vite build` `540kB` `dist` `published`

### 5) Wire Frontend ↔ Backend
1. After `tms-backend` gets URL `https://tms-backend.onrender.com`, copy it
2. Go to `tms-frontend` → `Environment` → `VITE_API_BASE_URL` → paste `https://tms-backend.onrender.com` → `Save Changes` → `Manual Deploy` → `Deploy latest commit` (rebuild with new API URL)
3. Back to `tms-backend` → `Environment` → `ALLOWED_ORIGINS` add `https://tms-frontend.onrender.com` → `Save` → auto redeploy

### 6) Verify
```bash
# Backend health (no cold start on Starter):
curl https://tms-backend.onrender.com/api/health | jq
# expect: {status:"ok", smtp_configured:true, pool_size:20}

curl https://tms-backend.onrender.com/docs  # Swagger

# Frontend:
curl -I https://tms-frontend.onrender.com  # 200

# Login:
curl -X POST https://tms-backend.onrender.com/api/auth/login \
  -H "Content-Type: application/json" -H "x-api-key: 0114cccb4238d3faa118e312dbe75abe" \
  -d '{"username":"prashant","password":"TMS2026"}' | jq .token

# List with pagination (new):
curl "https://tms-backend.onrender.com/api/actions/?limit=50" -H "x-api-key: 0114cccb4238d3faa118e312dbe75abe" | jq length
```

**Import 100 users:** `python backend/scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace` then login `http://tms-frontend.onrender.com`.

---

## Option B — Manual (No Blueprint) — 5 Steps

### Step 1: Database (pick one)
**Keep Neon (current, zero migration, recommended for 100):**
* Neon `https://console.neon.tech` → Project `ep-cool-queen...` → `Connection string` `Pooled` → copy `postgresql://neondb_owner:...@ep-...-pooler.neon.tech/neondb?sslmode=require` → change to `postgresql+asyncpg://` for `backend/.env`

**Or Render Postgres:**
* Render → `New +` → `PostgreSQL` → `Name tms-db` `Plan Starter ₹850` `Region Singapore` → `Create` → copy `Internal Database URL` `postgresql://tms:...@host/tmsdb` → in backend env change to `postgresql+asyncpg://tms:...@host/tmsdb` (add `+asyncpg`)

### Step 2: Backend Web Service
* Render → `New +` → `Web Service` → `Connect` `Prashant702/TMS-Task-Mangement-system` → `Connect`
* **Settings:**
  * `Name: tms-backend`
  * `Region: Singapore` (India) `Branch: main`
  * `Root Directory: backend`
  * `Runtime: Python 3`
  * `Build Command: pip install -r requirements.txt`
  * `Start Command: gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:$PORT --timeout 60 --keep-alive 5`  (already in `Procfile:1` `starter` for 100)
  * `Plan: Starter ₹595` (Free sleeps `30s`, not for 100)
  * `Health Check Path: /api/health`
* `Environment` → `Add` all vars from §A.3 table (`DATABASE_URL`, `SECRET_KEY`, `API_KEY`, `ALLOWED_ORIGINS`, `FRONTEND_URL`, `GEMINI_API_KEY`, `SMTP_*`, `MASTER_PASSWORD`)
* `Create Web Service` → wait `Logs` `gunicorn` `4` workers `pool 20`

### Step 3: Frontend Static Site
* Render → `New +` → `Static Site` → `Connect` `Prashant702/TMS-Task-Mangement-system`
* **Settings:**
  * `Name: tms-frontend`
  * `Branch: main`
  * `Root Directory: .` (repo root, where `package.json` is)
  * `Build Command: npm install && npm run build`
  * `Publish Directory: dist`
  * `Plan: Free` (Static `100GB` free)
* `Advanced` → `Add Environment Variable`:
  * `VITE_API_BASE_URL = https://tms-backend.onrender.com` (paste backend URL after Step 2)
  * `VITE_API_KEY = 0114cccb4238d3faa118e312dbe75abe` (same as backend)
* `Create Static Site` → `vite build` `540kB`

* **SPA Rewrite:** Render Static auto handles `dist` SPA; if `404` on refresh, add `Redirects/Rewrites` → `Source: /*` `Destination: /index.html` `Action: Rewrite` (or keep `render.yaml` `routes: rewrite /* → /index.html`).

### Step 4: Wire & Redeploy (as §A.5)
* Backend `ALLOWED_ORIGINS` add `https://tms-frontend.onrender.com` → backend auto redeploys
* Frontend `VITE_API_BASE_URL` already set → if you changed backend URL, `Manual Deploy` frontend

### Step 5: Verify (§A.6)

---

## 7) Custom Domain (Optional, 2 min)

* Render `tms-frontend` → `Settings` → `Custom Domains` → `Add` `tms.yourdomain.com` → `CNAME` `tms-frontend.onrender.com` `Verify` → Auto `SSL`
* `tms-backend` → `Settings` → `Custom Domains` → `Add` `api.yourdomain.com` → `CNAME` `tms-backend.onrender.com`
* Update `ALLOWED_ORIGINS` `https://tms.yourdomain.com,https://api.yourdomain.com` + `FRONTEND_URL` `https://tms.yourdomain.com` → redeploy backend → frontend `VITE_API_BASE_URL=https://api.yourdomain.com` → redeploy frontend

---

## 8) Troubleshooting

| Symptom | Fix |
|---------|-----|
| `vite build` `VITE_API_BASE_URL is not defined` | `tms-frontend` `Environment` `VITE_API_BASE_URL` missing → add `https://tms-backend.onrender.com` → `Manual Deploy` (Vite build-time) |
| `Login 401 Invalid API key` | `VITE_API_KEY` ≠ `backend API_KEY` → set both to same `0114cccb...` → redeploy frontend |
| `CORS No Access-Control-Allow-Origin` | `backend ALLOWED_ORIGINS` missing frontend URL → add `https://tms-frontend.onrender.com` → backend redeploys (check `app/main.py:250` `known` list includes `tms-control-management`) |
| `GET /api/actions/ 500 pool Timeout` | `Neon Free` `15` conns exhausted → upgrade `Neon Launch` `3GB` or use Render `tms-db` `starter` (already `20/30`) |
| `Backend 503` first hit | `Free` plan sleep → upgrade `Starter` `₹595` `Always-on` (we did `gunicorn -w 4` needs `Starter`) |
| `POST /api/actions/ 500` `sn` duplicate | `await _generate_sn` race → retry auto (`actions.py:306`) but if `sn` `ACT-001` dup, `DELETE FROM actions WHERE sn ~ '^ACT-'` then re-import |
| `SMTP not configured` | `SMTP_USER`/`SMTP_PASSWORD` missing `backend/.env` → set Gmail app password `"qxnb gxka kghp ilxc"` quoted → `curl /api/health` `smtp_configured:true` |

**Logs:** `tms-backend` `Logs` `tail -f`, `tms-frontend` `Deploys` `Build Logs`. One-click `Blueprint` logs at `Render Dashboard → Blueprint → tms`.

---

## 9) Cost for 100 Users

* **Trial 50:** `tms-frontend Free ₹0` + `tms-backend Free ₹0` + `tms-db Free ₹0` = `₹0` (`30s` cold, `p95 400ms`)
* **100 Prod (recommended):** `Frontend Free ₹0` + `Backend Starter ₹595` + `DB Neon Launch ₹850` = `₹1,445` `+ Vercel Pro ₹1,700` if you keep `Vercel` `→ ₹3,145`
* **300-500:** `Backend Standard ₹2,125` + `Neon Scale ₹1,700` `10GB` `pool 30` = `₹3,825` `+ Vercel Pro ₹1,700 = ₹5,525`

*vs AppSheet `100×₹425=₹42,500` **13×** cheaper (`BACKEND_DATABASE_LOW_COST.md:4`).*

---

## 10) Next Deploy

```bash
git add render.yaml RENDER_DEPLOY.md
git commit -m "chore: add Render Blueprint + deploy guide for TMS (100 users)"
git push tms702 main   # Prashant702/TMS-Task-Mangement-system
# Render auto-deploys both services on push main
```

*Already pushed `b527d5d` to `Prashant-1401/TMS-Task-Management-system` and `Prashant702/TMS-Task-Mangement-system` `b527d5d` `TMS`.*

---

*Last: `MCS`→`TMS` rebrand `TMS_Database_Current.xlsx` `22` sheets `import_from_excel.py --excel TMS_Database_Current.xlsx --replace` then `curl https://tms-backend.onrender.com/api/health`.*
