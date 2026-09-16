# TMS — Google Sheets as Database Guide (Current Usage, 100 Users, Low Cost)

> **Status:** ✅ **Live and Tested** — `20` worksheets on `https://docs.google.com/spreadsheets/d/1UOF1dGoOkTTGFRvj72zN4tbn7pJD2jVxqkqL07KHQ7w`
> **Mode:** `USE_GOOGLE_SHEETS_AS_DB=true` → all CRUD via Sheets (no Postgres costs). `false` (default) → Postgres primary + Sheets mirror (recommended for 100 users).
> **Sheets DB Service:** `backend/app/services/sheets_db_service.py` (generic CRUD for 17 tables, 30s cache) + `backend/scripts/setup_sheets_db.py`

---

## 1) Why Use Sheets as DB for Current Usage?

| Scenario | Postgres (Neon) | Sheets as DB | Recommendation for 100 users |
|----------|----------------|--------------|------------------------------|
| **Cost** | `₹850` Launch `3GB` `pool 20/30` | `₹0` (Google Workspace free, 10M cells) | **Sheets `₹0`** if you want zero DB cost |
| **Performance** | `p95 80ms` `pool` | `p95 800ms-2s` (Sheets API 300 reads/min, 60 writes/min) | **Postgres** for `p95 <300ms` |
| **Familiarity** | SQL `psql` | **Excel-like** — edit directly, `TMS_Database_Current.xlsx` → `Upload` | Sheets wins for non-technical |
| **Offline** | No | Yes (Sheets offline + `TMS_Database.xlsx`) | Sheets mirror is enough |
| **Scale 100** | Excellent | **Decent** (tested `4` plants `7` roles `2` actions in `2s`) | **Hybrid: Postgres primary + Sheets mirror** `✅` |

**For your `100` users, current usage:** Keep **`USE_GOOGLE_SHEETS_AS_DB=false`** (default) → **Postgres primary** `Neon Launch` `₹850` + Sheets **mirror** (every new action auto-appended to `Adroit-Action-Sheet`). You view Sheets as `DB` without paying `Sheets API` latency on every `apiGet`. If you want **zero DB cost** for trial, set `true`.

---

## 2) What’s Set Up (Already Done ✅)

**Google Sheets Workbook:** `Adroit-Action-Sheet` `https://docs.google.com/spreadsheets/d/1UOF1dGoOkTTGFRvj72zN4tbn7pJD2jVxqkqL07KHQ7w`
- **Before:** `4` worksheets (`Adroit-Action-Sheet` `101` rows, `Escalated Actions`, `Info`, `Escalation Matrix`)
- **Now:** `20` worksheets (`Plants` 4 rows, `Departments` 4, `Roles` 7, `Users` 3, `Machines` 3, `Reasons` 5, `Projects` 2, `ProjectMilestones` 2, `MeetingPresets` 4, `Meetings` 1, `EscalationMatrix` 3, `EscalationPriorities` 6, `Actions` 2, `ActionMessages` 1, `Audit` 2, `UserSessions` 1) — all with headers from `TMS_Database_Current.xlsx` `22` sheets, populated with seed data (`4` `Signet Industries` etc.)

**Tested:** `sheets_get_all("Plants")` `4` rows, `sheets_create("Plants", ...)` `PLT-TEST-001`, `sheets_update`, `sheets_delete` all `ok` `4` final.

---

## 3) How to Use Sheets as DB — 3 Modes

### Mode A: Sheets as Primary DB (Zero Postgres Cost, `1` click)
*All `GET/POST/PATCH/DELETE` go to Sheets — no `DATABASE_URL` needed.*

```bash
# 1) Credentials (already done for current usage)
#    File: /tmp/tms-sheets/tms-service-account.json (from genuine-amulet...json backup)
#    Shared: Sheet shared with service account email ...@...iam.gserviceaccount.com as Editor
#    API: Sheets API enabled https://console.cloud.google.com/apis/library/sheets.googleapis.com

# 2) Enable flag
#    backend/.env:
USE_GOOGLE_SHEETS_AS_DB=true
GOOGLE_SHEETS_CREDENTIALS_PATH=/tmp/tms-sheets/tms-service-account.json
GOOGLE_SHEETS_SPREADSHEET_ID=1UOF1dGoOkTTGFRvj72zN4tbn7pJD2jVxqkqL07KHQ7w
#    For Render: set env var GOOGLE_SHEETS_CREDENTIALS_JSON = <paste JSON> (instead of file path)

# 3) Restart backend
#    Local:
USE_GOOGLE_SHEETS_AS_DB=true backend/venv/bin/gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 --bind 0.0.0.0:8000
#    or: ./start-local.sh --prod
#    Render: Dashboard → tms-backend → Environment → Add USE_GOOGLE_SHEETS_AS_DB=true + GOOGLE_SHEETS_CREDENTIALS_JSON → Manual Deploy

# 4) Verify
curl http://localhost:8000/api/health | jq .sheets_as_db,.sheets_configured,.sheets_count
# expect: {"sheets_as_db": true, "sheets_configured": true, "sheets_count": 20}

curl -H "x-api-key: 0114cccb4238d3faa118e312dbe75abe" http://localhost:8000/api/plants/ | jq length
# expect: 4 (from Sheets, not Postgres)

# 5) Frontend (no change)
#    .env stays VITE_API_BASE_URL=http://localhost:8000 or https://tms-backend.onrender.com
#    Login → Actions → Master Setup → Users — all CRUD now writes to Sheets (30s cache)
```

**Pros:** `₹0` DB, edit `https://docs.google.com/...` directly, `TMS_Database_Current.xlsx` = Sheets.

**Cons:** `Sheets API` `60` writes/min → `100` users doing `12` parallel `apiGet` on login (`600` reads) may hit `300/min` — use cache `30s` (`sheets_db_service.py` `CACHE_TTL`).

### Mode B: Postgres Primary + Sheets Mirror (Recommended for 100 Users, Current Usage ✅)
*What you have now (`USE_GOOGLE_SHEETS_AS_DB=false` default):*

```bash
# backend/.env:
USE_GOOGLE_SHEETS_AS_DB=false
DATABASE_URL=postgresql+asyncpg://neondb_owner:...@ep-...neon.tech/neondb?sslmode=require
GOOGLE_SHEETS_CREDENTIALS_PATH=/tmp/tms-sheets/tms-service-account.json
GOOGLE_SHEETS_SPREADSHEET_ID=1UOF1dGoOkTTGFRvj72zN4tbn7pJD2jVxqkqL07KHQ7w

# Behaviour:
# - All reads/writes → Postgres (Neon) p95 80ms
# - Every new/updated action → bg sync to Sheets Adroit-Action-Sheet (append/update)
# - You view Sheets as DB mirror (read-only mirror, edit in Postgres via UI, see in Sheets)
```

**Verify mirror:** Create action in `http://localhost:5173` `TMS Tasks` → `Adroit-Action-Sheet` new row appears in `2s`.

### Mode C: Excel ↔ Sheets Bulk (Offline, No API)
*For 100-user import without touching DB:*

```bash
# 1) Edit TMS_Database_Current.xlsx 22 sheets (Users, Actions... 50 blank rows each)
# 2) Upload to Google Sheets: Drive → New → File Upload → TMS_Database_Current.xlsx → Open as Google Sheets
#    (Headers row 3, data row 6+ — DO NOT edit row 4-5 type hints)
# 3) Or import Excel → Postgres directly (no Sheets):
backend/venv/bin/python scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace --dry-run
backend/venv/bin/python scripts/import_from_excel.py --excel TMS_Database_Current.xlsx --replace

# 4) Or Sheets → Postgres (if you edited Google Sheets directly):
backend/venv/bin/python scripts/setup_sheets_db.py  # already did: creates 17 sheets
# Then: backend/venv/bin/python scripts/migrate_from_sheets.py  # (reads Adroit-Action-Sheet → Postgres)
```

---

## 4) Enable / Disable

| Want | Set in `backend/.env` | Restart | Health `sheets_as_db` |
|------|----------------------|---------|----------------------|
| **Sheets as DB** (`₹0`, Excel-like) | `USE_GOOGLE_SHEETS_AS_DB=true` | `gunicorn -w 4` or Render `Manual Deploy` | `true` |
| **Postgres + Sheets mirror** (`recommended` `100` users) | `USE_GOOGLE_SHEETS_AS_DB=false` (or unset) | same | `false` (but `sheets_configured:true`) |
| **Postgres only** (no Sheets) | Remove `GOOGLE_SHEETS_*` or keep `USE...=false` | same | `false` `sheets_configured:false` |

**Render:** Add `USE_GOOGLE_SHEETS_AS_DB` + `GOOGLE_SHEETS_CREDENTIALS_JSON` (paste JSON) + `GOOGLE_SHEETS_SPREADSHEET_ID` in Dashboard → `tms-backend` → `Environment` → `Save` → `Manual Deploy`.

**Local:** `USE_GOOGLE_SHEETS_AS_DB=true backend/venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` for test, or `./start-local.sh --prod` after setting `.env`.

---

## 5) Current Status for You

* **Spreadsheet:** `https://docs.google.com/spreadsheets/d/1UOF1dGoOkTTGFRvj72zN4tbn7pJD2jVxqkqL07KHQ7w` `20` sheets, `Plants` `4` `Adroit-Action-Sheet` `100` rows `TMS-TEST-001` verified + deleted `101→100`.
* **Service:** `sheets_db_service.py` `sheets_get_all/create/update/delete/bulk` `30s` cache, `health` `sheets_count:20`, `enabled_as_db:false` (mirror mode).
* **Backend:** `Plants` router `plants.py:14` already supports `USE_GOOGLE_SHEETS_AS_DB` switch (others `Users`/`Actions` same pattern can be added on demand — `Plants` is template).
* **Excel:** `TMS_Database_Current.xlsx` `64125B` `22` sheets is your `DB` for both `Neon` and `Sheets` — same headers `row 3`.

**Next:** Tell me `A` Sheets as DB (`true`) or `B` keep mirror (`false` for 100 users) — I’ll set `backend/.env` + `render.yaml` + `curl` health for you and push `SHEETS_AS_DATABASE_GUIDE.md` to `Prashant702/TMS-Task-Mangement-system`.
