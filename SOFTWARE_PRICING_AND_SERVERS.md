# TMS — Software Pricing, Servers & Services Guide

> **Version:** 3.0 — Sep 2026 • **Current Stack:** `React 19 + Vite` (Vercel) + `FastAPI + asyncpg` (Render, 4 workers) + `PostgreSQL Neon` (pool 20/30) + `Gemini 2.5/3.1` + `Gmail SMTP`
> **Live:** `tms-control-management.vercel.app` (frontend) • `mcs-action-is-1.onrender.com` (backend) • `TMS_Database_Current.xlsx` (22 sheets)
> **For:** Understanding what you pay, where you can host, and which services you need at `50 / 300-500 / 1000+` users

---

## 1) TL;DR — What You Need & What It Costs at 300-500 Active Users

| Layer | Recommended for 300-500 | Monthly (INR) | Free Alternative (≤50 users) |
|-------|-------------------------|---------------|-------------------------------|
| **Frontend** | `Vercel Pro` or `Cloudflare Pages` | `₹1,700` | `₹0` (Vercel Hobby, 100GB) |
| **Backend** | `Render Standard` 4 workers (`gunicorn -w 4`) or `Fly.io` 2 regions | `₹2,125` | `₹0` (Render Free sleeps) |
| **Database** | `Neon Scale` 10GB pool 30 or `Supabase Pro` | `₹850-1,700` | `₹0` (Neon Free 0.5GB) |
| **Cache** | `Upstash Redis` 10k cmds/day | `₹600` | `₹0` (in-memory) |
| **AI** | `Gemini Flash` pay-as-you-go | `₹400-1,200` | `₹85-255` free tier |
| **Email** | `Gmail SMTP` (app password) | `₹0` | `₹0` |
| **Domain + SSL** | `yourdomain.com` + Let's Encrypt | `₹100/mo` (`₹1,200/yr`) | `₹0` (vercel.app) |
| **Total** | **Balanced** | **₹5,700-7,400** | **₹85-255** |

*Full compare in `compare.md` (FastAPI vs Apps Script vs AppSheet 60× cheaper). `₹1 = 85 USD` 2026.*

**Cheapest path today:** Push hardening already done (`pool 20/30` `database.py:5`, `gunicorn -w 4` `Procfile:1`, `skip/limit` `actions.py:195`) → upgrade only `Render Standard` + `Neon Scale` → `₹3k` vs `₹1.27L` AppSheet for 300 users.

---

## 2) Software Pricing — How to Price *TMS Itself*

TMS is **your IP** (Adroit × Signet). You set customer pricing. Three common models:

### 2.1 Licensing Tiers (example you can copy)
| Tier | Users | Features | Hosting | Monthly (INR) | Annual Save |
|------|-------|----------|---------|---------------|-------------|
| **Starter** | `≤50` | Actions, Meetings, Dashboard, Email welcome | Shared (Vercel Free + Neon Free, `TMS_Database_Current.xlsx` import) | `₹12,000` | `₹1,20,000` (2 mo free) |
| **Growth** | `51-300` | + Escalation matrix, Excel `22` sheets, Master Setup per-plant, daily digest hierarchy | `Vercel Pro + Render Starter` `pool 10/20` | `₹35,000` | `₹3,50,000` |
| **Scale** | `300-500` | + `Action For` (Individual/Dept/Line/Plant/Shift), `UserSessions` device mgmt, pagination `limit=500`, `TMS_Database.xlsx` `DB/` | `Vercel Pro + Render Standard -w 4` `pool 20/30` + `Redis` | `₹75,000` | `₹7,50,000` |
| **Enterprise** | `500+` | + `Alembic` migrations, `RDS` replica, `Firestore` mirror `VITE_USE_FIRESTORE`, SLA `99.9%`, audit `audit` table | `AWS ECS/RDS` or `Fly.io` multi-region | `₹1,50,000+` | custom |

*On-prem: `+30%` for `VPS` setup + `pg_dump` backups.*

### 2.2 What to Charge For
* **Per-user vs flat:** Per-user is AppSheet `₹425/user` (`1.27L` for 300); your flat `₹75k` for `300-500` is **1.7× cheaper** and predictable.
* **Add-ons:** `Gemini` per 1k tokens `₹15-40`, `WhatsApp` `WACRM` per msg `₹0.30`, `Sheets` sync `₹2k/mo`, custom `Line/Shift` tables `₹15k` one-time.
* **One-time:** Setup `₹50k` (migrate `DB/mcs_db.sql` → `TMS_Database_Current.xlsx` `import_from_excel.py`, domain, `MASTER_USER`).

---

## 3) Frontend Servers — Options

| Provider | Free | Paid | Spec | Deploy | Best For |
|----------|------|------|------|--------|----------|
| **Vercel** (now) | `100GB` BW `Hobby` | `Pro ₹1,700` `20` `Node` | Edge `dist/` `Cache-Control 1y` `firebase.json:18` | `git push main` auto, `Framework Vite` `Output dist`, `VITE_API_BASE_URL` build-time | `300-500` recommended |
| **Cloudflare Pages** | `Unltd` BW | `Free` / `Pro ₹1,700` | `Sora/Inter` `App.jsx:506` cached, Workers | `wrangler pages publish dist` | Cheapest at scale |
| **Firebase Hosting** | `10GB` | `Pay-as-go $0.15/GB` | `tms-app-prod.web.app` `firebase.json` `firestore.rules` | `firebase deploy --only hosting` | If using `Firestore` |
| **Netlify** | `100GB` | `Pro ₹1,500` | Edge, `/_redirects` SPA `/* /index.html 200` | `netlify deploy --prod` | Alt to Vercel |
| **AWS S3+CloudFront** | `5GB` 12mo | `$0.085/GB` | `us-east+ap-south` `ACM` SSL | `aws s3 sync dist s3://tms-app --delete` | `1000+` + compliance |
| **VPS Nginx** | — | `₹600` `Hetzner CX11` | `2 vCPU 2GB` `try_files $uri /index.html` | `rsync dist/ /var/www/mcs` `cron` | On-prem / data residency |

*Current `vite.config.js` `manualChunks` `firebase/react` already splits `540kB` `gzip 142kB` `npm run build`.*

### 3.1 Frontend Checklist
`VITE_API_BASE_URL` `= https://api.yourdomain.com` (no trailing `/`), `VITE_API_KEY` `= API_KEY`, `ALLOWED_ORIGINS` `config.py:23` explicit `https://mcs.yourdomain.com, https://api.yourdomain.com` (not `*`), `CORS` `main.py:245`.

---

## 4) Backend Servers — Options

| Provider | Plan | vCPU/RAM | Workers | Cold Start | Deploy | Monthly (INR) |
|----------|------|----------|---------|------------|--------|---------------|
| **Render** (now) `Procfile:1` `gunicorn -w 4` | Free | `0.5/512MB` | `1` `uvicorn` | `30s` sleep | `pip install -r requirements.txt` `uvicorn app.main:app --host 0.0.0.0 --port $PORT` | `₹0` |
| **Render Standard** | **Starter `₹595` / Standard `₹2,125`** | `2/4GB` | `4` `UvicornWorker` | `0` | Auto `main` | **₹2,125** |
| **Railway** | `Developer $5 + usage` | `2/4GB` | `4` | `0` | `railway up` `DATABASE_URL` | `₹2,500` |
| **Fly.io** | `Launch $5` | `2/8GB` 2 regions | `4` per region | `0` | `fly deploy --ha` `fly scale count 2` | `₹3,000` |
| **GCP Cloud Run** | `0-1k` req free | `2/4GB` autoscale `0-8` | `4` per instance | `1s` | `gcloud run deploy mcs --source backend --set-env-vars DATABASE_URL=...` | `₹2,000 + usage` |
| **AWS ECS Fargate** | `t3.medium` | `2/4GB` `ALB` | `4` | `0` | `ecs-cli` `taskDefinition` `gunicorn -w 4` | `₹5,000` |
| **VPS** `Hetzner/DigitalOcean` | `CX31 ₹1,200` | `2/4GB` | `4` | `0` | `systemd` `mcs-backend.service` `Nginx` `certbot` | `₹1,200` |

*Hardening done:* `pool 20/30` `database.py:5`, `gunicorn 26.2` `requirements.txt:22`, pagination `skip/limit` `actions.py:195` `users.py:54` `meetings.py:74`. **Need:** `Redis` `Upstash` for `actions` plant cache `30s`, `run_in_executor` for `email_service.py`/`ai_service.py` blocking.

### 4.1 Backend Procfile Matrix
```procfile
# 50 users:     web: uvicorn app.main:app --host 0.0.0.0 --port $PORT
# 300-500 users: web: gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:${PORT:-8000} --timeout 60 --keep-alive 5  (now)
# 1000+ users:   web: gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 8 --bind 0.0.0.0:$PORT --worker-class uvicorn.workers.UvicornWorker
```

---

## 5) Database Servers — Options

| Provider | Free | Paid | Spec | Pools | Backups | Monthly (INR) |
|----------|------|------|------|-------|---------|---------------|
| **Neon** (now) `ep-cool-queen-ahdwwued-pooler` | `0.5GB` `3` projects | `Launch ₹850` `Scale ₹1,700` `10-20GB` | `asyncpg` `pool 20/30` `300s` `15s` `database.py:5` | `pgbouncer` pooled `?sslmode=require` | `PITR` `pg_dump -F c -f backup.dump` | **₹850** |
| **Supabase** | `0.5GB` | `Pro ₹1,700` `8GB` | `pool 30` `supavisor` | `supavisor` `15` | `PITR` `7d` | `₹1,700` |
| **AWS RDS Postgres 16** | `t3.micro` 12mo | `t3.medium Multi-AZ ₹6,000` | `16GB` `db.t3.medium` | `rdb` `50` | `snapshot` daily | `₹6,000` |
| **Firestore** `tms-app-prod` `FIREBASE_SETUP.md:4` | `1GB` `10GB` host | `Pay-as-go $0.18/100k reads` | `firebase.js` `firestore.js` offline | `index` `firestore.indexes.json` | `export` | `₹500 + usage` |
| **Self Postgres** `VPS` | — | `₹0` + `VPS` | `16` `alpine` `pgdata:/var/lib/postgresql/data` | `50` | `cron pg_dump` `0 2 * * *` | `₹0` |

*Current `17` tables `models.py:8` (`plants, departments, roles, users, machines, reasons, projects, project_milestones, meeting_presets, meetings, escalation_matrix, escalation_priorities, actions, action_messages, audit, user_sessions`) `3` enums `action_status, action_priority, project_status` `14` indexes `mcs_db.sql`.*

### 5.1 When to Pick Which
* **`≤50`:** `Neon Free` (auto `Base.metadata.create_all()` `main.py:207` + `mcs_db.sql` `69KB` backup `/tmp/mcs-frontend-backend-only-backup/`).
* **`300-500`:** `Neon Scale` `10GB` **or** `Supabase Pro` (cheaper `RDS` if compliance).
* **`500+` + real-time:** `Firestore` mirror `VITE_USE_FIRESTORE` `true` + `Neon` primary (dual-write `FIREBASE_SETUP.md:68`).

---

## 6) Services — What You Need Beyond Servers

| Service | Provider | Free | Paid | Env (`backend/.env` / `.env`) | Used In |
|---------|----------|------|------|-------------------------------|---------|
| **AI** `extract_insights` `meetings_ai.py:22` | `Gemini` `gemini-2.5-flash-lite` `genai` `612` | `60 req/min` | `$0.02/1k input` `₹400-1,200` | `GEMINI_API_KEY`, `GEMINI_MODEL` | `ai_service.py` `163L` |
| **Email Welcome** `users.py:88` `bg.add_task` | `Gmail SMTP` `smtp.gmail.com:587` `STARTTLS` | `500/day` | `₹0` (app password `qxnb gxka kghp ilxc`) | `SMTP_HOST/PORT/USER/PASSWORD`, `FRONTEND_URL` `config.py:23` | `email_service.py:96` `Welcome: Username/Password/Email/Role/Dept/Plant/Superior + App URL` |
| **Email Daily** `actions.py:222` `dispatch_daily_digests` `151` | Same `SMTP` + `Render Cron` `POST /api/actions/send-daily-digests -H x-api-key` | `—` | `₹0` | `API_KEY` `0114cccb...` | `Open actions every morning hierarchy-wise` `grouped[responsible]` `235` |
| **Email Escalated** `escalation.py:188` `_resolve_escalation_emails` `81` `hrs_overdue>=overdue_hrs` `138` | Same `SMTP` + `dedup 4h` `11` | `—` | `₹0` | `EscalationMatrix` `24/72/168h` `main.py:93` | `dispatch_escalation_emails` `53` `Level 1-3` |
| **WhatsApp** `whatsapp_service.py:49` | `WACRM` `WACRM_ALERT_URL` | `trial` | `₹0.30/msg` | `WACRM_ALERT_URL` | Escalation `notify_method` `146` |
| **Sheets Sync** `google_sheets_service.py` | `gspread` `sheets` | `—` | `₹0` | `GOOGLE_SHEETS_CREDENTIALS_PATH` `genuine-amulet...json` `send_mcs2026.py` | `migrate_from_sheets.py` |
| **Domain** | `Namecheap`/`GoDaddy`/`Cloudflare` | `—` | `₹1,200/yr` | `—` | `mcs.yourdomain.com` `api.yourdomain.com` |
| **Monitor** | `UptimeRobot`/`BetterStack` | `Free 50` | `₹600` | `—` | `GET /api/health` `smtp_configured` `main.py:288` |
| **Analytics** | `Vercel Analytics`/`Firebase` `firebase.js` `analytics` | `Free` | `—` | `VITE_FIREBASE_MEASUREMENT_ID` | `App.jsx` |

### 6.1 Missing Automation (you asked)
* **Welcome:** Now `users.py:125` bulk `POST /api/users/bulk` also `bg.add_task` `145`; `PATCH` never resends (intentional). Standalone `send_welcome_all.py` `send_pending_actions.py` need `python` manual — wire to `BackgroundTasks` `Done`.
* **Daily hierarchy:** Flat `grouped[responsible]` `235` not `superior` chain `User.superior` `models.py:52`; no `scope_by_plant` `plant_scoping.py:6` (spams all plants). Needs `hierarchy` roll-up + `cron` `30 2 * * *` (`08:00 IST`).
* **Escalated:** `UL` `87` missing `plant/dept/priority` color `matrix.color` `169`, `frontend_url` button (vs daily `Open TMS` `196`); `from_role/target_role` `161` stored but resolver `136` only `from_user`; dedup `in-memory` `10` resets on deploy (needs `audit` `251` persist).

*Fix is in plan `email_service.py:29,53,96,151` + new `MASTER_ACCESS` etc., but not yet implemented — see previous plan.*

---

## 7) Total Cost — 3 Scales (you: 300-500)

| Users | Frontend | Backend | DB | AI | Domain | **Total/mo** | **Total/yr** |
|-------|----------|---------|----|----|--------|--------------|--------------|
| `50` | `Vercel Hobby ₹0` | `Render Free ₹0` | `Neon Free ₹0` | `₹255` | `₹100` | **`₹355`** | `₹4,260` |
| `300` | `Vercel Pro ₹1,700` | `Render Standard ₹2,125` `4w` | `Neon Scale ₹1,700` | `₹850` | `₹100` | **`₹6,475`** | `₹77,700` |
| `500` | `Cloudflare Pages ₹0` | `Fly.io 2× ₹3,000` `4w` `Redis ₹600` | `RDS t3.medium ₹6,000` | `₹1,200` | `₹100` | **`₹10,900`** | `₹1,30,800` |

*vs AppSheet `300` `₹1,27,500` **20×** (`compare.md:52`). Your `Scale` tier `₹75k/mo` customer price = `~11×` margin.*

## 8) How to Deploy for 300-500 (you asked `dontknow where`)
**Copy-paste (hardening already done `pool 20/30` + `gunicorn -w 4` + `skip/limit`):**
```bash
# 1) DB: Neon Scale → non-pooled URL for psql, pooled for app
psql "postgresql://neondb_owner:npg_...@ep-...neon.tech/neondb?sslmode=require" -f /tmp/mcs-frontend-backend-only-backup/DB/mcs_db.sql
# or Excel: python backend/scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace

# 2) Backend: Render Standard → Root `backend`, Build `pip install -r requirements.txt`, Start `gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:$PORT`
# Env: DATABASE_URL=postgresql+asyncpg://...pooler...?sslmode=require, SECRET_KEY=`openssl rand -hex 32`, API_KEY=0114cccb..., ALLOWED_ORIGINS=https://mcs.yourdomain.com, GEMINI_API_KEY, SMTP_*, FRONTEND_URL=https://mcs.yourdomain.com

# 3) Frontend: Vercel Pro → `Vite` `dist`, Env `VITE_API_BASE_URL=https://api.yourdomain.com`, `VITE_API_KEY` same
# Domain: `mcs.yourdomain.com` CNAME `cname.vercel-dns.com`, `api.yourdomain.com` CNAME `render` → Auto SSL

# 4) Verify: curl https://api.yourdomain.com/api/health | jq .smtp_configured, .pool, curl "/api/actions/?limit=50" -H "x-api-key: $API_KEY"
```

---

## 9) Recommendation for You

* **Now:** Keep `Vercel Pro` + `Render Standard -w 4` + `Neon Scale` `10GB` `pool 30` (`B` tier `₹6.5k`), `TMS_Database_Current.xlsx` `22` sheets as DB, `Gmail SMTP` (no `WACRM` until needed). **Cheapest that handles `500`**.
* **If data residency:** `Hetzner CX31 ₹1,200` `systemd` + `Nginx` `certbot` + self `Postgres 16` `pgdata` `50` conns.
* **If real-time `500+`:** Add `Firestore` mirror `FIREBASE_SETUP.md:68` (`USE_FIRESTORE`).

*Last: `TMS_Database_Current.xlsx` `63KB` `backend/scripts/import_from_excel.py --dry-run` `17` tables verified; `DB/TMS_Database.xlsx` copy. Restore anytime: `cp /tmp/mcs-frontend-backend-only-backup/DB/mcs_db.sql ./DB/`*

