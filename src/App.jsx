import React, { useState, useEffect, useRef, useCallback } from "react";

/* ===================== API CONFIG ===================== */
const RAW_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "https://mcs-action-is-1.onrender.com";
const API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");
const API_KEY = import.meta.env.VITE_API_KEY || "";
let AUTH_TOKEN = null;
let CURRENT_ROLES = [];
let _onAuthExpired = null;
function setAuthToken(token) { AUTH_TOKEN = token; }
function getAuthToken() { return AUTH_TOKEN; }
function setCurrentRoles(roles) { CURRENT_ROLES = roles || []; }
function getCurrentRoles() { return CURRENT_ROLES; }
function setOnAuthExpired(fn) { _onAuthExpired = fn; }

async function apiFetch(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const token = AUTH_TOKEN || localStorage.getItem("mcs_token");
  if (token) headers["Authorization"] = `Bearer ${token}`;
  console.debug("API", options.method || "GET", url);
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    const p = new URL(url).pathname;
    if (p !== "/api/ping" && !p.startsWith("/api/sessions/")) {
      _onAuthExpired?.();
    }
  }
  if (!res.ok) {
    let detail;
    try { const err = await res.json(); detail = err.detail || res.statusText; } catch { detail = res.statusText; }
    console.error("API error", res.status, detail, url);
    throw new Error(detail || `API error ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}
function apiGet(path, params) {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiFetch(path + qs);
}
function apiPost(path, body) { return apiFetch(path, { method: "POST", body: JSON.stringify(body) }); }
function apiPatch(path, body) { return apiFetch(path, { method: "PATCH", body: JSON.stringify(body) }); }
function apiDelete(path) { return apiFetch(path, { method: "DELETE" }); }

/* ─── Background Autosave Engine ─────────────────────────────
   - Tracks every create/update as a pending op. On success it is cleared;
     on failure it stays queued so a background timer can retry it.
   - Exposes a tiny status emitter (autosaveStatus) so the UI can show
     "Saving…" / "All changes saved" / "Pending N".
   - Also drives a periodic localStorage snapshot of core collections.
*/
const autosaveListeners = new Set();
let _autosaveState = { status: "idle", pending: 0, lastSaved: null };
function emitAutosave() {
  _autosaveState = { ..._autosaveState, pending: pendingOps.size };
  autosaveListeners.forEach(fn => { try { fn(_autosaveState); } catch {} });
}
export function subscribeAutosave(fn) {
  autosaveListeners.add(fn);
  fn(_autosaveState);
  return () => autosaveListeners.delete(fn);
}
function setAutosaveStatus(status) {
  _autosaveState = { ..._autosaveState, status };
  emitAutosave();
}

// Pending operations queue: key → { resource, id, data, op }
const pendingOps = new Map();
function opKey(resource, id) { return `${resource}:${id ?? "new"}`; }
function queueOp(resource, id, data, op) {
  pendingOps.set(opKey(resource, id), { resource, id, data, op });
  emitAutosave();
}
function clearOp(resource, id) {
  pendingOps.delete(opKey(resource, id));
  emitAutosave();
}

let _flushing = false;
async function flushPendingSaves() {
  if (_flushing || pendingOps.size === 0) return;
  _flushing = true;
  setAutosaveStatus("saving");
  const entries = [...pendingOps.values()];
  for (const op of entries) {
    try {
      if (op.op === "create") {
        const saved = await apiPost(`/api/${op.resource}/`, normKeys(op.data));
        if (saved && saved.id) clearOp(op.resource, op.id || "new");
      } else {
        const id = op.id || (op.data && op.data.id);
        if (!id) { clearOp(op.resource, op.id || "new"); continue; }
        await apiPatch(`/api/${op.resource}/${id}`, normKeys(op.data));
        clearOp(op.resource, id);
      }
    } catch (e) {
      // keep in queue for next retry
      console.warn(`[autosave] retry pending ${op.resource}:${op.id || "new"} —`, e.message);
    }
  }
  _flushing = false;
  if (pendingOps.size === 0) {
    _autosaveState = { ..._autosaveState, status: "saved", lastSaved: Date.now() };
  } else {
    _autosaveState = { ..._autosaveState, status: "pending", lastSaved: Date.now() };
  }
  emitAutosave();
}

/* ─── Reconcile pending ops with live server data ──────────────
   After a real-time poll refetches server data, any optimistic
   create that has already been persisted shows up in the server
   response. Clear those pending ops so the "Saving… / Pending N"
   indicator hides once the change is live, and the local temp-id
   echo is replaced by the authoritative server record. ──────── */
function reconcilePendingWithServer(resource, serverItems) {
  if (pendingOps.size === 0) return;
  const serverKeys = new Set(
    (serverItems || []).map(it => {
      const t = (it.text || it.name || "").trim().toLowerCase();
      const r = (it.responsible || it.facilitator || "").trim().toLowerCase();
      const c = (it.created || it.date || "").toString().slice(0, 10);
      return `${t}|${r}|${c}`;
    })
  );
  let changed = false;
  for (const op of [...pendingOps.values()]) {
    if (op.resource !== resource || op.op !== "create") continue;
    const d = op.data || {};
    const key = `${(d.text || d.name || "").trim().toLowerCase()}|${(d.responsible || d.facilitator || "").trim().toLowerCase()}|${(d.created || "").toString().slice(0, 10)}`;
    if (serverKeys.has(key)) {
      clearOp(resource, op.id);
      changed = true;
    }
  }
  if (changed && pendingOps.size === 0) {
    _autosaveState = { ..._autosaveState, status: "saved", lastSaved: Date.now() };
    emitAutosave();
  }
}


/* ─── API Persistence Sync (fire-and-forget with error log) ── */
async function apiCreate(resource, data, { track = true } = {}) {
  const id = data && (data.id || "new");
  if (track) queueOp(resource, id, data, "create");
  try {
    const result = await apiPost(`/api/${resource}/`, normKeys(data));
    if (track) clearOp(resource, id);
    return result;
  } catch (e) {
    console.error(`POST /api/${resource}/ failed:`, e.message);
    throw e; // leave in queue for background retry
  }
}
async function apiUpdate(resource, id, data, { track = true } = {}) {
  if (track) queueOp(resource, id, data, "update");
  try {
    const result = await apiPatch(`/api/${resource}/${id}`, normKeys(data));
    if (track) clearOp(resource, id);
    return result;
  } catch (e) {
    console.error(`PATCH /api/${resource}/${id} failed:`, e.message);
    throw e; // leave in queue for background retry
  }
}
async function apiRemove(resource, id) {
  try {
    const result = await apiDelete(`/api/${resource}/${id}`);
    return result;
  } catch (e) {
    console.error(`DELETE /api/${resource}/${id} failed:`, e.message);
    throw e;
  }
}

// LocalStorage snapshot backup of core editable collections.
const SNAPSHOT_KEY = "mcs_autosave_snapshot";
function snapshotLocal(state) {
  try {
    const payload = {
      ts: Date.now(),
      actions: state.actions || [],
      meetings: state.meetings || [],
      projects: state.projects || [],
      machines: state.machines || [],
    };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("[autosave] snapshot skipped:", e.message);
  }
}
function loadSnapshot() {
  try {
    const s = localStorage.getItem(SNAPSHOT_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

/* ─── Key transforms (snake_case ↔ camelCase) ─────────────── */
const SNAKE_TO_CAMEL = {
  plant_id: "plantId", dept_id: "deptId", machine_id: "machineId",
  machine_name: "machineName", date_of_action: "dateOfAction",
  allocated_by: "allocatedBy", closed_on: "closedOn", closed_by: "closedBy",
  revision_history: "revisionHistory", responsible_user_id: "responsibleUserId",
  reason_id: "reasonId", action_point_type: "actionPointType",
  reason_of_action: "reasonOfAction", project_id: "projectId",
  project_name: "projectName",
  is_active: "isActive", action_count: "actionCount",
  start_date: "startDate", end_date: "endDate",
  completed_sessions: "completedSessions", pending_confirmation: "pendingConfirmation",
  asset_no: "assetNo", notify_method: "notifyMethod",
  overdue_days: "overdueDays", overdue_hrs: "overdueHrs",
  from_role: "fromRole", target_role: "targetRole",
  from_user: "fromUser", target_user: "targetUser",
  applicable_to: "applicableTo",
  scheduled_days: "scheduledDays", guidelines: "guidelines",
  src_id: "srcId", src: "src", meetingid: "meetingId", meeting_name: "meetingName",
};
const CAMEL_TO_SNAKE = Object.fromEntries(
  Object.entries(SNAKE_TO_CAMEL).map(([s, c]) => [c, s])
);

function denormKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(denormKeys);
  const out = {};
  Object.keys(obj).forEach(k => { out[SNAKE_TO_CAMEL[k] || k] = obj[k]; });
  return out;
}
function normKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normKeys);
  const out = {};
  Object.keys(obj).forEach(k => { out[CAMEL_TO_SNAKE[k] || k] = obj[k]; });
  // Backend schemas use "project" (not "project_name") — remap after normKeys
  if ("project_name" in out) { out.project = out.project_name; delete out.project_name; }
  return out;
}

/* ─── Resolve display names → FK IDs for actions & meetings ────── */
function resolveRecordIds(record, plants, depts, machines, projects, meetings) {
  const r = { ...record };
  // Action: plant name → plant_id
  if (r.plant && !r.plant_id) {
    const match = (plants || []).find(p => p.name === r.plant || p.id === r.plant);
    if (match) { r.plant_id = match.id; delete r.plant; }
  }
  // Action: section (dept name) → dept_id
  if (r.section && !r.dept_id) {
    const match = (depts || []).find(d => d.name === r.section || d.id === r.section);
    if (match) { r.dept_id = match.id; }
  }
  // Action: machineName → machine_id
  if (r.machineName && !r.machine_id) {
    const match = (machines || []).find(m => m.name === r.machineName || m.id === r.machineName);
    if (match) { r.machine_id = match.id; delete r.machineName; }
  }
  // Action/Meeting: project name → project_id
  if (r.project && !r.project_id) {
    const match = (projects || []).find(p => p.name === r.project || p.id === r.project);
    if (match) { r.project_id = match.id; }
  }
  // Action: meeting id → meetingid + denormalized meeting_name
  if (r.meeting && !r.meetingid) {
    const mtg = (meetings || []).find(m => m.id === r.meeting || m.name === r.meeting);
    if (mtg) {
      r.meetingid = mtg.id;
      r.meeting_name = mtg.name || mtg.type || null;
    }
  }
  return r;
}

/* ─── Smart name matching for responsible fields ────────────────
   Action responsible values can be compound like "Mr. Umesh Kothare and Mr. A B Banerjee"
   or "Mrs. Aarti Harode/ Mrs. Khushbu Jaiswal". User names may have trailing spaces,
   "Mr." prefixes, or differ slightly. This function extracts individual name tokens
   from the responsible field and checks if any match any known user name.
*/
function responsibleMatchesUsers(responsible, userNamesLower) {
  if (!responsible || !userNamesLower.length) return false;
  const resp = responsible.toLowerCase();
  // Quick: direct contains check (fast path for common case)
  if (userNamesLower.some(n => resp.includes(n))) return true;
  // Split compound responsible into individual name parts
  const parts = resp.split(/\/|,|\band\b|&/).map(s => s.trim());
  for (const part of parts) {
    // Strip titles, parenthetical notes, department labels
    const cleaned = part
      .replace(/\b(mr|mrs|ms|dr)\.?\s*/gi, "")
      .replace(/\(.*?\)/g, "")
      .replace(/\bproduction department\b/gi, "")
      .trim();
    if (!cleaned) continue;
    // Check if cleaned name matches any user name
    if (userNamesLower.some(n => cleaned === n || n.includes(cleaned) || cleaned.includes(n))) return true;
    // Check individual words (handles "V R Kulkarni" vs "V. R. Kulkarni")
    const words = cleaned.split(/\s+/).filter(w => w.length > 2);
    if (words.some(w => userNamesLower.some(n => n.includes(w) || w.includes(n)))) return true;
  }
  return false;
}

function resolveForeignKeys(items, plants, depts, projects) {
  const pName = {}, dName = {}, prName = {};
  (plants || []).forEach(p => { pName[p.id] = p.name; });
  (depts || []).forEach(d => { dName[d.id] = d.name; });
  (projects || []).forEach(p => { prName[p.id] = p.name; });
  return (items || []).map(item => {
    const out = { ...item };
    if (out.plantId && pName[out.plantId]) out.plant = pName[out.plantId];
    if (out.deptId && dName[out.deptId]) out.dept = dName[out.deptId];
    if (out.projectId && prName[out.projectId]) out.project = prName[out.projectId];
    return out;
  });
}

/* ─── Plant scoping that tolerates user.plant being an ID OR a name ─
   resolveForeignKeys turns item.plant_id → item.plant (NAME). But a
   user's stored plant can be either a plant ID (e.g. "P2") or a name
   (e.g. "Adroit Driveshaft"). Comparing name===ID hides every meeting
   for that user, so we match on BOTH forms. ─────────────────────────── */
function plantVisible(user, item) {
  const up = user?.plant;
  if (!up || up === "All") return true;
  if (!item.plant && !item.plantId) return true;
  return item.plantId === up || item.plant === up || item.plant === "All";
}

// A meeting is accessible only to its attendees + facilitator (admins always)
function meetingAccessNames(m, mtgPresets) {
  const list = ensureArray(m.attendees || (mtgPresets?.attendeeMap?.[m.type]) || []);
  const names = list.map(a => (a || "").toString().trim().toLowerCase()).filter(Boolean);
  const fac = (m.facilitator || "").toString().trim().toLowerCase();
  if (fac) names.push(fac);
  return names;
}
function canAccessMeeting(user, m, mtgPresets) {
  if (!m || !user) return false;
  if (isUserAdmin(user)) return true;
  const up = user.plant;
  if (!up || up === "All") return true;
  if (m.plant && m.plant !== "All" && m.plant !== up) return false;
  return true;
}

function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val.trim()) {
    const trimmed = val.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {}
    }
    return trimmed.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/* ─── Weekly meeting belt ──────────────────────────────────────────
   Returns the 7 days (Mon–Sun) of the current week with, for each day:
   - hasSession: a visible meeting ran a completed session that day
   - count / done: actions created that day (dateOfAction) and how many
     are COMPLETED
   - color: green = all done, amber = partial, red = session but none
     done, null = no session / no actions (neutral)
*/
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function startOfWeekMonday(d) {
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // back to Monday
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function buildWeekBelt(meetings, actions) {
  const monday = startOfWeekMonday(new Date());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    const sessionDates = new Set();
    (meetings || []).forEach(m => (m.completedSessions || []).forEach(s => {
      if (s.date === dateStr) sessionDates.add(s.date);
    }));
    const hasSession = sessionDates.size > 0;
    const dayActions = (actions || []).filter(a => a.dateOfAction === dateStr || a.created === dateStr);
    const count = dayActions.length;
    const done = dayActions.filter(a => a.status === "COMPLETED" || a.status === "DROPPED").length;
    let color = null;
    if (hasSession || count > 0) {
      if (count > 0 && done === count) color = "green";
      else if (done > 0) color = "amber";
      else color = "red";
    }
    days.push({
      dateStr, dayName: WEEKDAY_NAMES[i], dayNum: d.getDate(),
      hasSession, count, done, color,
      isToday: dateStr === new Date().toISOString().split("T")[0],
    });
  }
  return days;
}

/* ─── usePostgresDB hook ───────────────────────────────────────────────── */
function usePostgresDB({ defaultUsers, defaultPlants, defaultDepts,
  defaultActions, defaultMeetings, defaultProjects, defaultEscMatrix, defaultPresets, defaultMachines, defaultRoles }) {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState(null);
  const [users, setUsersRaw] = useState(defaultUsers);
  const [plants, setPlantsRaw] = useState(defaultPlants);
  const [depts, setDeptsRaw] = useState(defaultDepts);
  const [actions, setActionsRaw] = useState(defaultActions);
  const [meetings, setMeetingsRaw] = useState(defaultMeetings);
  const [projects, setProjectsRaw] = useState(defaultProjects);
  const [escMatrix, setEscRaw] = useState(defaultEscMatrix);
  const [mtgPresets, setPresetsRaw] = useState(defaultPresets);
  const [machines, setMachinesRaw] = useState(defaultMachines || []);
  const [reasons, setReasonsRaw] = useState([]);
  const [persistedAudit, setPersistedAuditRaw] = useState([]);
  const [roles, setRolesRaw] = useState(defaultRoles || []);

  const fetchData = useCallback(async () => {
    try {
      const [rawP, rawD, rawU, rawA, rawM, rawPr, rawEm, rawPs, rawMc, rawRs, rawAu, rawRo] = await Promise.all([
        apiGet("/api/plants/").catch(() => []),
        apiGet("/api/departments/").catch(() => []),
        apiGet("/api/users/").catch(() => []),
        apiGet("/api/actions/").catch(() => []),
        apiGet("/api/meetings/").catch(() => []),
        apiGet("/api/projects/").catch(() => []),
        apiGet("/api/escalation/matrix").catch(() => []),
        apiGet("/api/meetings/presets").catch(() => []),
        apiGet("/api/machines/").catch(() => []),
        apiGet("/api/reasons/").catch(() => []),
        apiGet("/api/audit/").catch(() => []),
        apiGet("/api/roles/").catch(() => []),
      ]);

      const pDenorm = denormKeys(rawP);
      const dDenorm = denormKeys(rawD);
      const uDenorm = denormKeys(rawU);
      const aDenorm = denormKeys(rawA).map(a => ({ ...a, attendees: Array.isArray(a.attendees) ? a.attendees : [] }));
      const mDenorm = denormKeys(rawM).map(mt => ({ ...mt, attendees: Array.isArray(mt.attendees) ? mt.attendees : [] }));
      const prDenorm = denormKeys(rawPr);
      const emDenorm = denormKeys(rawEm);
      const mcDenorm = denormKeys(rawMc);
      const rsDenorm = denormKeys(rawRs);
      const auDenorm = denormKeys(rawAu);
      const roDenorm = denormKeys(rawRo);

      const resolvedU = resolveForeignKeys(uDenorm, pDenorm, dDenorm);
      const resolvedA = resolveForeignKeys(aDenorm, pDenorm, dDenorm);
      const resolvedM = resolveForeignKeys(mDenorm, pDenorm, dDenorm, prDenorm);
      const resolvedPr = resolveForeignKeys(prDenorm, pDenorm, dDenorm);
      const resolvedMc = resolveForeignKeys(mcDenorm, pDenorm, dDenorm);

      const psDenorm = { attendeeMap: {}, instructions: {} };
      (rawPs || []).forEach(row => {
        if (row.type) {
          psDenorm.attendeeMap[row.type] = Array.isArray(row.attendees) ? row.attendees : [];
          psDenorm.instructions[row.type] = Array.isArray(row.instructions) ? row.instructions : [];
        }
      });

      if (pDenorm.length) setPlantsRaw(pDenorm);
      if (dDenorm.length) setDeptsRaw(dDenorm);
      if (resolvedU.length) setUsersRaw(resolvedU);
      if (resolvedA.length) { setActionsRaw(resolvedA); reconcilePendingWithServer("actions", resolvedA); }
      if (resolvedM.length) { setMeetingsRaw(resolvedM); reconcilePendingWithServer("meetings", resolvedM); }
      if (resolvedPr.length) setProjectsRaw(resolvedPr);
      if (emDenorm.length) setEscRaw(emDenorm);
      if (rsDenorm.length) setReasonsRaw(rsDenorm);
      if (auDenorm.length) setPersistedAuditRaw(auDenorm);
      if (mcDenorm.length) setMachinesRaw(resolvedMc);
      if (roDenorm.length) { setRolesRaw(roDenorm); setCurrentRoles(roDenorm); }
      setPresetsRaw(psDenorm);
      setDbReady(true);
    } catch (e) {
      console.warn("API load failed, using defaults:", e.message);
      setDbError(e.message);
      setDbReady(true);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const setUsers = useCallback((fnOrVal) => { setUsersRaw(fnOrVal); }, []);
  const setPlants = useCallback((fnOrVal) => { setPlantsRaw(fnOrVal); }, []);
  const setDepts = useCallback((fnOrVal) => { setDeptsRaw(fnOrVal); }, []);
  const setActions = useCallback((fnOrVal) => { setActionsRaw(fnOrVal); }, []);
  const setMeetings = useCallback((fnOrVal) => { setMeetingsRaw(fnOrVal); }, []);
  const setProjects = useCallback((fnOrVal) => { setProjectsRaw(fnOrVal); }, []);
  const setEscMatrix = useCallback((fnOrVal) => { setEscRaw(fnOrVal); }, []);
  const setMtgPresets = useCallback((fnOrVal) => { setPresetsRaw(fnOrVal); }, []);
  const setMachines = useCallback((fnOrVal) => { setMachinesRaw(fnOrVal); }, []);
  const setReasons = useCallback((fnOrVal) => { setReasonsRaw(fnOrVal); }, []);
  const setPersistedAudit = useCallback((fnOrVal) => { setPersistedAuditRaw(fnOrVal); }, []);
  const setRoles = useCallback((fnOrVal) => { setRolesRaw(fnOrVal); }, []);

  // Sync roles to module-level for getPerms()
  useEffect(() => { setCurrentRoles(roles); }, [roles]);

  return {
    dbReady, dbError, fetchData,
    users, setUsers,
    plants, setPlants,
    depts, setDepts,
    actions, setActions,
    meetings, setMeetings,
    projects, setProjects,
    escMatrix, setEscMatrix,
    mtgPresets, setMtgPresets,
    machines, setMachines,
    reasons, setReasons,
    persistedAudit, setPersistedAudit,
    roles, setRoles,
  };
}

/* ─── Real-time polling sync ──────────────────────────────────────
   Problem: the app only loaded data once on mount, so when another user
   (e.g. N) added/edited an action, the current user (M) never saw it
   until they manually refreshed the page.

   Fix: poll the backend on a fixed interval AND immediately whenever the
   tab regains focus / becomes visible. This keeps every logged-in browser
   in sync without WebSockets. A session heartbeat is also sent so the
   backend knows the user is actively online (session management). ───── */
function useRealtimeSync({ fetchData, user, enabled = true, intervalMs = 15000 }) {
  const fetchRef = useRef(fetchData);
  useEffect(() => { fetchRef.current = fetchData; }, [fetchData]);

  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const inFlight = useRef(false);

  const isEditing = () => {
    const el = document.activeElement;
    return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
  };

  const sync = useCallback(async () => {
    if (inFlight.current || !enabled || isEditing()) return;
    inFlight.current = true;
    setSyncing(true);
    try {
      await fetchRef.current();
      setLastSync(Date.now());
    } catch (e) { /* keep previous data; will retry next tick */ }
    finally {
      inFlight.current = false;
      setSyncing(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !user) return;
    const kick = setTimeout(sync, 3000);
    const poll = setInterval(sync, intervalMs);
    const beat = setInterval(() => {
      if (API_BASE_URL && (AUTH_TOKEN || localStorage.getItem("mcs_token"))) {
        apiPost("/api/sessions/heartbeat", {}).catch(() => {});
      }
    }, 30000);
    const onVisible = () => { if (document.visibilityState === "visible") sync(); };
    const onFocus = () => sync();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(kick);
      clearInterval(poll);
      clearInterval(beat);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, user, intervalMs, sync]);

  return { lastSync, syncing, sync };
}

/* ===================== DATA LAYER ===================== */
const DEFAULT_PLANTS = [];
const DEFAULT_DEPTS = [];
const DEFAULT_USERS = [];
const MEETING_TYPES = ["Furnace Daily Review", "Daily Problem-Solving", "Daily Plant Head Review", "Weekly Plant Head", "Safety Review"];
const STATUS_LIST = ["NOT STARTED", "IN PROCESS", "COMPLETED", "DROPPED"];
// Legacy actions may have status literally saved as "PENDING CONFIRM" from
// before the pendingConfirmation flag existed. It's not in STATUS_LIST, so it
// must never be trusted as a real status — normalize it back to IN PROCESS.
const normalizeStatus = s => (s === "PENDING CONFIRM" ? "IN PROCESS" : s);
const displayStatus = a => (a.pendingConfirmation && a.status !== "COMPLETED" && a.status !== "DROPPED")
  ? "PENDING CONFIRM"
  : normalizeStatus(a.status);
const PRIORITY_LIST = ["CRITICAL", "WARNING", "NORMAL"];
const SECTIONS = ["Production", "Maintenance", "Quality", "Safety", "Electrical", "Mechanical", "Instrumentation", "Stores & Logistics", "Management", "General"];
const ATTENDEE_MAP = {
  "Furnace Daily Review": ["Anil Kumar", "Meena Joshi", "Amit Tiwari", "Sanjay Mishra"],
  "Daily Problem-Solving": ["Suresh Patel", "Ravi Gupta", "Kavita Rawat", "Neha Yadav"],
  "Safety Review": ["Amit Tiwari", "Meena Joshi", "Priya Singh", "Vijay Pandey"],
  "Daily Plant Head Review": ["Anil Kumar", "Meena Joshi", "Amit Tiwari", "Sanjay Mishra", "Vijay Pandey"],
  "Weekly Plant Head": ["Rajiv Sharma", "Anil Kumar", "Suresh Patel", "Deepak Verma", "Meena Joshi", "Ravi Gupta", "Priya Singh"],
};
const MTG_INSTRUCTIONS = {
  "Furnace Daily Review": ["Review heat-wise production vs target (MPM, Power, Mn)", "Identify deviations from the last 24 hours", "Assign owners and due dates for each gap", "Confirm previous action statuses before closing"],
  "Daily Problem-Solving": ["Present the top 3 problems from yesterday", "Use 5-Why to identify root causes", "Assign corrective actions with clear owners", "Track open actions from prior sessions"],
  "Daily Plant Head Review": ["Plant head to chair — no phones policy", "Review safety first, then production KPIs", "Each HOD presents department status in 3 minutes", "Escalate blockers that need cross-functional resolution"],
  "Weekly Plant Head": ["MD-level review of all three plants", "Compare plant performance using dashboard data", "Close completed strategic actions, escalate long-running ones", "Confirm priorities for the coming week"],
  "Safety Review": ["Start with near-miss and incident recap", "PPE compliance check results", "Assign corrective actions for each unsafe condition observed", "Set next review date before closing"],
};
const SEED_PROJECTS = [];
const SEED_MEETINGS = [];
const SEED_ACTIONS = [];
const isGuestRole = (role) => role === "Guest" || role === "Guest User";
// Resolve permissions for a user dynamically using roles hierarchy level.
const getPerms = (user) => {
  if (!user) return { canEditMeetings: false, canCreateProjects: false, canEditActions: false, canViewDashboard: false, canManageEscalations: false };
  
  // Resolve level from roles (fresh from API via module-level state) or fallback
  let level = 1;
  if (user.role === "Admin") level = 8;
  else {
    const rObj = CURRENT_ROLES.find(r => r.name === user.role);
    if (rObj && rObj.level !== undefined) level = Number(rObj.level);
    else {
      const fallbacks = { "Guest": 1, "Guest User": 1, "Supervisor": 3, "Shift Engineer": 4, "HOD": 5, "Plant Head": 6, "MD": 7, "Admin": 8 };
      level = fallbacks[user.role] ?? 1;
    }
  }

  // Base level-based permissions (reversed hierarchy: higher level = more access)
  return {
    canEditMeetings:     level >= 5,
    canCreateProjects:   level >= 5,
    canEditActions:      level >= 2,
    canViewDashboard:    level >= 2,
    canManageEscalations: level >= 7,
  };
};

const isUserAdmin = (user) => {
  if (!user) return false;
  if (user.role === "Admin") return true;
  return false;
};
const canAccessMasterSetup = (user) => isUserAdmin(user) || user?.masterAccess === true || user?.master_access === true;

// Plant-scoping helpers: non-admin users only see data from their own plant.
// user.plant may be a plant ID ("P2") or a plant name ("Adroit Driveshaft").
const scopedPlants = (user, plants) => {
  if (isUserAdmin(user) || !user?.plant || user.plant === "All") return plants;
  const up = user.plant;
  return (plants || []).filter(p => p.name === up || p.id === up);
};
const scopedDepts = (user, depts) => {
  if (isUserAdmin(user) || !user?.plant || user.plant === "All") return depts;
  const up = user.plant;
  return (depts || []).filter(d => !d.plant || d.plant === "All Plants" || d.plant === up || d.plantId === up);
};
const scopedUsers = (user, users) => {
  if (isUserAdmin(user) || !user?.plant || user.plant === "All") return users;
  const up = user.plant;
  return (users || []).filter(u => !u.plant || u.plant === "All" || u.plant === up || u.plant_id === up);
};

const SAMPLE_TRANSCRIPT_LINES = [
  "Good morning everyone. Let's start with yesterday's production numbers.",
  "Heat 42 showed MPM deviation of 0.8 tonnes below target. Root cause under review.",
  "Action: Amit Tiwari to calibrate pressure sensors on Line 3 by next Tuesday.",
  "Power consumption was 8% above benchmark in Bay 2. Neha to inspect switchboard.",
  "Safety: PPE audit pending for furnace operators. Meena to schedule by end of week.",
  "Previous action ACT-007 — flow meter FM-28 has been closed as design limitation.",
  "Crane availability in bay 3 improved to 94%. Ravi's team acknowledged.",
  "Any other business? Next meeting same time tomorrow.",
];
const todayStr = () => new Date().toISOString().split("T")[0];
const fmt = s => { if (!s) return "—"; const d = new Date(s); return isNaN(d) ? s : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); };
const todayLocal = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const isOverdue = a => { if (!a.due || a.status === "COMPLETED" || a.status === "DROPPED") return false; const due = new Date(a.due + "T23:59:59"); return due < todayLocal(); };
const daysOver = a => { if (!isOverdue(a)) return 0; const due = new Date(a.due + "T23:59:59"); return Math.floor((todayLocal() - due) / 86400000); };
const getU = (name, users = []) => (users || []).find(u => u.name === name) || { initials: (name || "?").slice(0, 2).toUpperCase(), color: "#7C80B0", name: name || "Unknown" };
const nextSN = arr => "ACT-" + String(arr.length + 1).padStart(3, "0");
// Get all superiors of a user walking up the chain
const getSuperiors = (userName, allUsers) => {
  const chain = [];
  let cur = allUsers.find(u => u.name === userName);
  while (cur && cur.superior) {
    const sup = allUsers.find(u => u.name === cur.superior);
    if (!sup || chain.find(x => x.name === sup.name)) break;
    chain.push(sup);
    cur = sup;
  }
  return chain;
};
// ── USER-BASED ESCALATION MATRIX ──────────────────────────────────────────
// When an action becomes overdue, alerts are sent to the specific user
// configured in each tier of the escalation matrix. Each tier maps a
// responsible person to a target user who gets notified.
//

const DEFAULT_ESC_MATRIX = [];

const getEscBadgeStyle = (lvl) => {
  const num = Number(lvl);
  if (num >= 5) return { bg: T.redL, color: T.red };
  if (num === 4) return { bg: "#FADBD8", color: "#C0392B" };
  if (num === 3) return { bg: "#FDEBD0", color: "#D35400" };
  if (num === 2) return { bg: "#FFF3CD", color: "#E67E22" };
  return { bg: "#FFF9E7", color: "#E69903" };
};

// Shared helper: resolve the current escalation state (if any) for a single action.
// Used by the Escalations page and the Team page (Master Setup) so the "who is
// currently escalated, and to which level/superiors" logic lives in one place.
function resolveEscalationState(action, matrix, users) {
  if (action.status === "COMPLETED" || action.status === "DROPPED" || !action.due) return null;
  const now = new Date();
  const due = new Date(action.due + "T23:59:59");
  const hrsOverdue = (now - due) / 3600000;
  if (hrsOverdue < 0) return null;

  const normP = (p) => Array.isArray(p) ? p : (typeof p === "string" && p.trim() ? p.split(",").map(x => x.trim()).filter(Boolean) : ["CRITICAL", "WARNING", "NORMAL"]);
  const activeTiers = (matrix || DEFAULT_ESC_MATRIX)
    .filter(t => t.active)
    .map(t => ({ ...t, priorities: normP(t.priorities) }));

  const respNames = (action.responsible || "").split(",").map(n => n.trim()).filter(Boolean);
  let bestResult = null;

  for (const name of respNames) {
    const matched = activeTiers
      .filter(t => (t.fromUser || "").trim() === name && hrsOverdue >= t.overdueHrs && t.priorities.includes(action.priority || "NORMAL"))
      .sort((a, b) => a.level - b.level);

    if (matched.length > 0) {
      const highestLevel = matched[matched.length - 1].level;
      if (!bestResult || highestLevel > bestResult.tier.level) {
        bestResult = {
          tier: matched[matched.length - 1],
          allMatchedTiers: matched,
          hrsOverdue,
          daysOverdue: Math.floor(hrsOverdue / 24),
          fromUser: name,
        };
      }
    }
  }

  return bestResult;
}

function runEscalation(actions, setAudit, matrix, users) {
  const normP = (p) => Array.isArray(p) ? p : (typeof p === "string" && p.trim() ? p.split(",").map(x => x.trim()).filter(Boolean) : ["CRITICAL", "WARNING", "NORMAL"]);
  const allTiers = (matrix || DEFAULT_ESC_MATRIX)
    .filter(t => t.active)
    .map(t => ({ ...t, priorities: normP(t.priorities) }));
  const byUser = {};
  allTiers.forEach(t => {
    const key = (t.fromUser || "").trim();
    if (!key) return;
    if (!byUser[key]) byUser[key] = [];
    byUser[key].push(t);
  });

  const now = new Date(), alerts = [];

  actions.forEach(a => {
    if (a.status === "COMPLETED" || a.status === "DROPPED" || !a.due) return;
    const hrs = (now - new Date(a.due + "T23:59:59")) / 3600000;
    if (hrs < 0) return;

    const respNames = (a.responsible || "").split(",").map(n => n.trim()).filter(Boolean);
    respNames.forEach(name => {
      const applicableTiers = byUser[name] || [];

      applicableTiers
        .filter(t => hrs >= t.overdueHrs && t.priorities.includes(a.priority || "NORMAL"))
        .sort((x, y) => x.level - y.level)
        .forEach(tier => {
          alerts.push({
            id: Date.now() + Math.random(),
            ts: now.toISOString(),
            sn: a.sn,
            text: a.text,
            level: tier.level,
            target: tier.targetUser || "",
            fromUser: tier.fromUser,
            targetUser: tier.targetUser,
            reason: `${Math.floor(hrs)}h overdue — ${tier.fromUser} → ${tier.targetUser} (Level ${tier.level})`,
          });
        });
    });
  });

  const seen = new Set();
  const deduped = alerts.filter(a => {
    const key = `${a.sn}_${a.level}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length) setAudit(p => {
    const existing = Array.isArray(p) ? p : [];
    const existingKeys = new Set(existing.map(e => `${e.sn}_${e.level}`));
    const fresh = deduped.filter(a => !existingKeys.has(`${a.sn}_${a.level}`));
    return [...fresh, ...existing].slice(0, 100);
  });

  if (API_BASE_URL) {
    fetch(`${API_BASE_URL}/api/escalation/email/escalate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "Authorization": `Bearer ${getAuthToken() || localStorage.getItem("mcs_token") || ""}` },
      body: JSON.stringify({})
    }).catch(e => console.warn("Escalation email failed", e));
  }
}

/* ===================== DESIGN TOKENS & CSS ===================== */
const T = { navy: "#272262", navyD: "#1A1653", amber: "#E69903", amberL: "#FEF3CD", green: "#1E8449", greenL: "#D5F5E3", red: "#C0392B", redL: "#FADBD8", slate: "#7F8C8D", border: "#E8E8F0", bg: "#F5F5FB", white: "#FFFFFF", text: "#1A1532", text2: "#636E72" };
const SC = { "IN PROCESS": { bg: "#FFF3CD", text: "#856404", dot: "#E69903" }, "NOT STARTED": { bg: "#EAE7F8", text: "#4A3F8C", dot: "#7C80B0" }, "COMPLETED": { bg: "#D5F5E3", text: "#1E6B3C", dot: "#27AE60" }, "DROPPED": { bg: "#F2F3F4", text: "#7F8C8D", dot: "#BDC3C7" }, "PENDING CONFIRM": { bg: "#FEF9E7", text: "#784212", dot: "#F39C12" } };
const PC = { "CRITICAL": { bg: "#FADBD8", text: "#922B21" }, "WARNING": { bg: "#FEF9E7", text: "#784212" }, "NORMAL": { bg: "#EBF5FB", text: "#1A5276" } };
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Sora:wght@700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:#F5F5FB;color:#1A1532;font-family:'Inter',sans-serif;font-size:14px;}
input,select,textarea{font-family:'Inter',sans-serif;font-size:13px;background:#fff;border:1.5px solid #E8E8F0;border-radius:8px;padding:8px 12px;color:#1A1532;outline:none;width:100%;transition:border-color .18s;direction:ltr;unicode-bidi:normal;color-scheme:light;}
input:focus,select:focus,textarea:focus{border-color:#272262;box-shadow:0 0 0 3px rgba(39,34,98,.08);}
input::placeholder,textarea::placeholder{color:#B2BEC3;}
input[type=date]{min-width:145px;appearance:auto;-moz-appearance:auto;-webkit-appearance:auto;}
input[type=date]::-webkit-calendar-picker-indicator{opacity:1;cursor:pointer;padding:4px;border-radius:4px;background:#fff;border:1px solid #E8E8F0;}
input[type=date]::-webkit-calendar-picker-indicator:hover{background:#F5F5FB;}
::-webkit-scrollbar{width:5px;height:5px;}::-webkit-scrollbar-thumb{background:#CBD5E0;border-radius:3px;}
.card{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 4px 16px rgba(39,34,98,.05);}
.card-hover{transition:transform .18s,box-shadow .18s;cursor:pointer;}
.card-hover:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(39,34,98,.13);}
.btn{border:none;border-radius:8px;cursor:pointer;font-family:'Inter',sans-serif;font-weight:600;font-size:13px;padding:9px 18px;display:inline-flex;align-items:center;gap:6px;transition:all .18s;white-space:nowrap;}
.btn-navy{background:#272262;color:#fff;}.btn-navy:hover{background:#1A1653;}
.btn-amber{background:#E69903;color:#fff;}.btn-amber:hover{background:#CA8500;}
.btn-green{background:#1E8449;color:#fff;}.btn-green:hover{background:#176339;}
.btn-ghost{background:transparent;color:#636E72;border:1.5px solid #E8E8F0;}.btn-ghost:hover{background:#F5F5FB;color:#1A1532;}
.btn-red{background:#C0392B;color:#fff;}.btn-red:hover{background:#A93226;}
.btn-sm{padding:6px 13px;font-size:12px;}.btn:disabled{opacity:.45;cursor:not-allowed;}
table{width:100%;border-collapse:collapse;}thead tr{background:#FAFAFE;}
th{padding:10px 14px;font-size:11px;font-weight:700;color:#636E72;letter-spacing:.5px;text-transform:uppercase;border-bottom:2px solid #E8E8F0;text-align:left;white-space:nowrap;}
td{padding:11px 14px;border-bottom:1px solid #F0F0F8;vertical-align:middle;font-size:13px;}
td.action-text{min-width:260px;max-width:420px;white-space:normal;word-break:break-word;line-height:1.4;}
tbody tr:hover td{background:#FAFAFE;}tbody tr:last-child td{border-bottom:none;}
@keyframes spin{to{transform:rotate(360deg);}}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}
@keyframes slideUp{from{opacity:0;transform:translateY(24px);}to{opacity:1;transform:none;}}
@keyframes slideInR{from{opacity:0;transform:translateX(60px);}to{opacity:1;transform:none;}}
@keyframes blink{0%,100%{opacity:1;}50%{opacity:.2;}}
@keyframes pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.04);}}
.fade-in{animation:fadeIn .3s ease;}
.overlay{position:fixed;inset:0;background:rgba(26,21,50,.5);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;}
.modal{background:#fff;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.2);max-height:90vh;overflow-y:auto;animation:slideUp .3s ease;}
.side-panel{position:fixed;top:0;right:0;height:100vh;height:100dvh;background:#fff;box-shadow:-8px 0 40px rgba(0,0,0,.12);z-index:350;overflow-y:auto;-webkit-overflow-scrolling:touch;animation:slideInR .25s ease;}
.fab{position:fixed;bottom:28px;right:28px;width:52px;height:52px;border-radius:50%;background:#272262;color:#fff;border:none;font-size:26px;cursor:pointer;box-shadow:0 6px 24px rgba(39,34,98,.35);display:flex;align-items:center;justify-content:center;z-index:200;transition:all .2s;}
.fab:hover{background:#1A1653;transform:scale(1.08);}
.drag-over{background:#EAE7F8!important;border:2px dashed #272262!important;}
@media(max-width:640px){
  .master-mobile-cards{display:block!important;}
  .master-desktop-table{display:none!important;}
}
@media(min-width:641px){
  .master-mobile-cards{display:none!important;}
  .master-desktop-table{display:block!important;}
}
.org-node-card{width:clamp(96px,26vw,140px)!important;padding:8px 10px!important;}
@media(max-width:640px){
  .org-node-card{padding:6px 8px!important;}
  .org-node-card .org-avatar{width:28px!important;height:28px!important;font-size:11px!important;}
  .org-node-card .org-name{font-size:10px!important;}
  .org-node-card .org-role{font-size:9px!important;}
}
.kanban-card{transition:transform .15s,box-shadow .15s,opacity .15s;}
.kanban-card:active{cursor:grabbing!important;}
.kanban-card.is-dragging{opacity:.45;transform:scale(.97);box-shadow:none!important;}
.kanban-card.is-lifted{transform:rotate(2deg) scale(1.04);box-shadow:0 16px 40px rgba(39,34,98,.22)!important;cursor:grabbing!important;z-index:10;}
.confirm-banner{background:linear-gradient(90deg,#FEF9E7,#FFFDE0);border:1.5px solid #E69903;border-radius:10px;padding:12px 16px;animation:pulse 2s ease-in-out infinite;}

/* ─── MOBILE HAMBURGER MENU ─── */
.mbl-menu-btn{display:none;background:none;border:none;color:#fff;font-size:22px;cursor:pointer;padding:4px 8px;z-index:400;}
.mbl-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:399;}
@media(max-width:768px){
  .mbl-menu-btn{display:flex;align-items:center;justify-content:center;}
  .mbl-overlay.show{display:block;}
  .app-sidebar{position:fixed!important;left:-260px;top:0;height:100vh;width:240px!important;z-index:401;transition:left .3s ease!important;}
  .app-sidebar.open{left:0!important;}
  .app-main{margin-left:0!important;}
  .app-content{padding:16px 12px!important;}
  .page-header-flex{flex-direction:column!important;gap:10px!important;}
  .page-header-actions{width:100%!important;justify-content:flex-start!important;flex-wrap:wrap;}
  .fab{bottom:20px;right:20px;width:48px;height:48px;font-size:22px;}
}

/* ─── RESPONSIVE GRIDS ─── */
.grid-kpi-5{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;}
.grid-kpi-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;}
.grid-2col{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
.grid-3col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;}
.grid-team-buckets{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;}
.filter-bar{display:flex;gap:12px;flex-wrap:nowrap;overflow-x:auto;align-items:center;}
@media(max-width:768px){
  .grid-kpi-5{grid-template-columns:repeat(2,1fr)!important;gap:10px!important;}
  .grid-kpi-4{grid-template-columns:repeat(2,1fr)!important;gap:10px!important;}
  .grid-2col{grid-template-columns:1fr!important;gap:14px!important;}
  .grid-3col{grid-template-columns:1fr!important;gap:14px!important;}
  .grid-team-buckets{grid-template-columns:repeat(4,1fr)!important;gap:4px!important;}
  .filter-bar{flex-wrap:wrap!important;overflow-x:visible!important;}
  .filter-bar select{width:100%!important;min-width:0!important;}
  .filter-bar input[type=text]{min-width:0!important;}
}
@media(min-width:769px) and (max-width:1024px){
  .grid-kpi-5{grid-template-columns:repeat(3,1fr)!important;}
  .grid-kpi-4{grid-template-columns:repeat(2,1fr)!important;}
}

/* ─── RESPONSIVE MODALS & PANELS ─── */
@media(max-width:768px){
  .modal{width:calc(100vw - 24px)!important;max-width:none!important;margin:12px!important;max-height:calc(100dvh - 24px)!important;border-radius:14px!important;}
  .side-panel{width:100vw!important;height:100dvh!important;border-radius:0!important;-webkit-overflow-scrolling:touch!important;}
  .overlay{padding:0!important;align-items:flex-end!important;}
}

/* ─── RESPONSIVE TABLES ─── */
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
@media(max-width:768px){
  .table-scroll table{min-width:600px;}
  td.action-text{min-width:180px!important;max-width:240px!important;font-size:12px!important;}
  th{font-size:10px!important;padding:8px 10px!important;}
  td{padding:8px 10px!important;font-size:12px!important;}
}

/* ─── LOGIN RESPONSIVE ─── */
@media(max-width:768px){
  .login-card{width:calc(100vw - 32px)!important;padding:24px 20px!important;}
}

/* ─── DASHBOARD STATUS BAR RESPONSIVE ─── */
.status-bar{display:flex;gap:0;align-items:center;}
@media(max-width:768px){
  .status-bar{flex-wrap:wrap;}
  .status-bar>div{min-width:45%;flex:1 1 45%;padding:10px 14px!important;}
}
`;
/* ===================== MICRO COMPONENTS ===================== */
function SBadge({ s }) { const c = SC[s] || { bg: "#eee", text: "#333", dot: "#aaa" }; return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, background: c.bg, color: c.text, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />{s}</span>; }
function PBadge({ p }) { const c = PC[p] || { bg: "#eee", text: "#333" }; return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", borderRadius: 20, background: c.bg, color: c.text, fontSize: 11, fontWeight: 600 }}>{p}</span>; }
function Avatar({ name, size = 30, users = [] }) { const u = getU(name, users); return <span title={name} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: "50%", background: u.color + "20", color: u.color, fontSize: size * .34, fontWeight: 700, flexShrink: 0, border: `1.5px solid ${u.color}30` }}>{u.initials}</span>; }
function Lbl({ t, req }) { return <label style={{ fontSize: 11, color: T.text2, display: "block", marginBottom: 5, fontWeight: 600, letterSpacing: .3 }}>{t}{req && <span style={{ color: T.red, marginLeft: 2 }}>*</span>}</label>; }
function HR() { return <div style={{ height: 1, background: T.border, margin: "16px 0" }} />; }
function Spin() { return <span style={{ width: 14, height: 14, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", display: "inline-block", animation: "spin .7s linear infinite" }} />; }
function Empty({ icon, title, sub }) { return <div style={{ textAlign: "center", padding: "48px 24px", color: T.text2 }}><div style={{ fontSize: 36, marginBottom: 12 }}>{icon}</div><div style={{ fontWeight: 600, fontSize: 14, color: T.text, marginBottom: 4 }}>{title}</div><div style={{ fontSize: 12 }}>{sub}</div></div>; }
function MultiUserSelect({ value, users, onChange, placeholder = "Select persons…" }) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const ref = React.useRef(null);
  const selected = (value || "").split(",").map(s => s.trim()).filter(Boolean);
  React.useEffect(() => { const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const toggle = (name) => { const next = selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name]; onChange(next.join(", ")); };
  const remove = (name) => onChange(selected.filter(n => n !== name).join(", "));
  const filtered = (users || []).filter(u => !search || (u.name || "").toLowerCase().includes(search.toLowerCase()) || (u.role || "").toLowerCase().includes(search.toLowerCase()));
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", flexWrap: "nowrap", overflowX: "auto", gap: 4, padding: "5px 8px", minHeight: 34, borderRadius: 8, border: `1.5px solid ${open ? T.navy : T.border}`, background: "#fff", cursor: "pointer", alignItems: "center" }}>
        {selected.length === 0 && <span style={{ fontSize: 12, color: T.text2 }}>{placeholder}</span>}
        {selected.map(name => (
          <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px", borderRadius: 14, background: T.navy + "12", color: T.navy, fontSize: 11, fontWeight: 600 }}>
            <Avatar name={name} size={16} users={users} />
            {name}
            <span onClick={(e) => { e.stopPropagation(); remove(name); }} style={{ cursor: "pointer", marginLeft: 2, fontSize: 13, lineHeight: 1, opacity: .6 }}>&times;</span>
          </span>
        ))}
      </div>
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "#fff", border: `1.5px solid ${T.border}`, borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,.12)", zIndex: 50, maxHeight: 220, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "6px 8px", borderBottom: `1px solid ${T.border}` }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or role…" style={{ width: "100%", fontSize: 12, padding: "5px 8px", border: `1px solid ${T.border}`, borderRadius: 6, outline: "none" }} autoFocus />
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.map(u => {
              const sel = selected.includes(u.name);
              return (
                <div key={u.id || u.name} onClick={() => toggle(u.name)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", cursor: "pointer", background: sel ? T.navy + "08" : "transparent", fontWeight: sel ? 600 : 400 }}>
                  <span style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${sel ? T.navy : T.border}`, background: sel ? T.navy : "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", flexShrink: 0 }}>{sel && "✓"}</span>
                  <Avatar name={u.name} size={20} users={users} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</div>
                    <div style={{ fontSize: 10, color: T.text2 }}>{u.role || ""}</div>
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && <div style={{ padding: "12px", fontSize: 12, color: T.text2, textAlign: "center" }}>No users found</div>}
          </div>
        </div>
      )}
    </div>
  );
}
function Chip({ label, color = "#272262" }) { return <span style={{ padding: "2px 9px", borderRadius: 20, background: color + "15", color, fontSize: 11, fontWeight: 600 }}>{label}</span>; }
function KPICard({ icon, value, label, sub, color, onClick, alert: al }) {
  return <div className="card card-hover" onClick={onClick} style={{ padding: "14px 16px", position: "relative" }}>
    {al && <span style={{ position: "absolute", top: 10, right: 10, width: 8, height: 8, borderRadius: "50%", background: T.red, animation: "blink 1.2s ease-in-out infinite" }} />}
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: color + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>{icon}</div>
      <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
    </div>
    <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{label}</div>
    {sub && <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{sub}</div>}
    {onClick && <div style={{ fontSize: 10, color: T.navy, marginTop: 6, fontWeight: 700, letterSpacing: .5, textTransform: "uppercase" }}>View →</div>}
  </div>;
}
function PageHeader({ title, sub, children }) {
  return <div className="page-header-flex" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
    <div><h1 style={{ fontFamily: "'Sora',sans-serif", fontSize: 22, fontWeight: 800, color: T.navy, lineHeight: 1.2 }}>{title}</h1>{sub && <p style={{ fontSize: 13, color: T.text2, marginTop: 4 }}>{sub}</p>}</div>
    {children && <div className="page-header-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>{children}</div>}
  </div>;
}
function Sparkbar({ pct, color }) {
  return <div style={{ background: T.border, borderRadius: 4, height: 6, overflow: "hidden", flex: 1 }}>
    <div style={{ height: "100%", borderRadius: 4, background: color, width: `${pct}%`, transition: "width .6s" }} />
  </div>;
}
/* ESC-close hook */
function useEscClose(fn) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);
  useEffect(() => {
    const h = e => { if (e.key === "Escape") fnRef.current(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);
}

/* ===================== LOGIN PAGE ===================== */
function LoginPage({ onLogin }) {
  const [u, setU] = useState(""), pw = useRef(null);
  const [errMsg, setErrMsg] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const tryLogin = async () => {
    setLoading(true); setErrMsg("");
    try {
      const res = await apiPost("/api/auth/login", { username: u.trim(), password: pw.current.value });
      const { token, user } = res;
      localStorage.setItem("mcs_token", token);
      setAuthToken(token);
      // Resolve plant/dept IDs to display names
      try {
        const plants = await apiGet("/api/plants/");
        const depts = await apiGet("/api/departments/");
        const pMap = {}; plants.forEach(p => { pMap[p.id] = p.name; });
        const dMap = {}; depts.forEach(d => { dMap[d.id] = d.name; });
        if (user.plant && pMap[user.plant]) user.plant = pMap[user.plant];
        if (user.dept && dMap[user.dept]) user.dept = dMap[user.dept];
      } catch (e) { /* keep IDs as-is */ }
      onLogin(user);
    } catch (err) {
      // Try master login as fallback
      try {
        const res = await apiPost("/api/auth/master-login", { username: u.trim(), password: pw.current.value });
        const { token, user } = res;
        localStorage.setItem("mcs_token", token);
        setAuthToken(token);
        // Master login also returns plant as an ID — resolve to name for consistency
        try {
          const plants = await apiGet("/api/plants/");
          const pMap = {}; plants.forEach(p => { pMap[p.id] = p.name; });
          if (user.plant && pMap[user.plant]) user.plant = pMap[user.plant];
        } catch (e) { /* keep as-is */ }
        onLogin(user);
      } catch (masterErr) {
        setErrMsg(err.message || "Login failed");
      }
    }
    setLoading(false);
  };
  const loginAsGuest = async () => {
    setLoading(true); setErrMsg("");
    onLogin({ id: "GUEST", name: "Guest User", username: "guest", role: "Guest User", plant: "All", dept: "Management", initials: "GU", color: "#7F8C8D" });
    setLoading(false);
  };
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(135deg,${T.navy} 0%,#3D378C 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="login-card" style={{ width: 420, background: "#fff", borderRadius: 20, padding: 36, boxShadow: "0 24px 80px rgba(0,0,0,.25)" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 22, color: T.navy, letterSpacing: 1 }}>ADROIT</div>
              <div style={{ fontSize: 9, color: T.text2, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase" }}>Industries</div>
            </div>
            <div style={{ width: 1.5, height: 36, background: T.border, borderRadius: 2 }} />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 22, color: T.amber, letterSpacing: 1 }}>SIGNET</div>
              <div style={{ fontSize: 9, color: T.text2, fontWeight: 600, letterSpacing: 2, textTransform: "uppercase" }}>Industries</div>
            </div>
          </div>
          <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 18, color: T.navy, lineHeight: 1.2 }}>Management Control System</div>
          <div style={{ fontSize: 11, color: T.text2, marginTop: 6 }}>Decentralized Work Management Platform</div>
        </div>
        <div style={{ marginBottom: 14 }}><Lbl t="Username" req /><input value={u} onChange={e => setU(e.target.value)} placeholder="Enter your username" onKeyDown={e => e.key === "Enter" && tryLogin()} /></div>
        <div style={{ marginBottom: 20 }}>
          <Lbl t="Password" req />
          <div style={{ position: "relative" }}>
            <input ref={pw} type={showPw ? "text" : "password"} placeholder="••••••••" onKeyDown={e => e.key === "Enter" && tryLogin()} style={{ paddingRight: 44 }} />
            <button onClick={() => setShowPw(p => !p)} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: T.text2, lineHeight: 1, padding: 0, display: "flex", alignItems: "center" }}>{showPw ? "🙈" : "👁"}</button>
          </div>
        </div>
        {errMsg && <div style={{ background: T.redL, color: T.red, padding: "8px 12px", borderRadius: 8, fontSize: 12, marginBottom: 14, fontWeight: 500 }}>{errMsg}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button className="btn btn-navy" style={{ width: "100%", justifyContent: "center", fontSize: 14, padding: "12px 0" }} onClick={tryLogin} disabled={loading}>
            {loading ? <><Spin /> Signing in…</> : "Sign In"}
          </button>
          <button className="btn btn-ghost" style={{ width: "100%", justifyContent: "center", fontSize: 14, padding: "12px 0", border: `1.5px solid ${T.border}`, color: T.navy }} onClick={loginAsGuest} disabled={loading}>
            🚪 Access as Guest User
          </button>
        </div>
        <div style={{ textAlign: "center", marginTop: 20, fontSize: 10, color: T.text2 }}>Powered by Adroit × Signet</div>
      </div>
    </div>
  );
}

/* ===================== SHELL ===================== */
const NAV = [{ id: 0, icon: "🏠", label: "Home" }, { id: 1, icon: "📋", label: "Work" }, { id: 2, icon: "✅", label: "Actions" }, { id: 3, icon: "📊", label: "Dashboard" }, { id: 4, icon: "🚨", label: "Escalations" }];

/* ============ NOTIFICATION SYSTEM ============ */
// Generates in-app notifications from audit, actions and user context
function useNotifications(actions, audit, user, users = []) {
  const [notifs, setNotifs] = useState([]);
  // Track dismissed IDs for this session — cleared notifications won't reappear
  const dismissedIds = useRef(new Set());
  // Track previously seen state per action so we only notify on NEW events
  const seenRef = useRef(new Map());
  const userRef = useRef(null);

  useEffect(() => {
    if (!user) return;
    // Reset baseline when a different user logs in
    if (userRef.current !== user.name) { seenRef.current = new Map(); userRef.current = user.name; }

    const newNotifs = [];
    const now = Date.now();
    const myPlant = user.plant;
    const myDept = user.dept;
    const userNameLower = (user.name || "").trim().toLowerCase();

    // Scope: my plant actions (admins with "All" plant see everything)
    const inScope = (a) => {
      if (myPlant === "All") return true;
      if (a.plant && a.plant !== myPlant) return false;
      return true;
    };

    // My subordinates (for allotment targeting)
    const subsSet = new Set();
    const collect = (name) => {
      (users || []).filter(u => u.superior === name).forEach(d => {
        if (!subsSet.has(d.name)) { subsSet.add(d.name); collect(d.name); }
      });
    };
    collect(user.name);
    const myPeople = [user.name, ...subsSet].map(n => (n || "").trim().toLowerCase()).filter(Boolean);
    const isMine = (a) => responsibleMatchesUsers(a.responsible, myPeople);

    const msgKey = (m) => (m.id != null ? String(m.id) : (m.ts || "") + "|" + (m.author || ""));

    // 1. Actions where user is mentioned in messages
    actions.forEach(a => {
      (Array.isArray(a.messages) ? a.messages : []).forEach(m => {
        if (m.text && m.text.includes("@" + user.name) && m.author !== user.name) {
          newNotifs.push({
            id: "msg_" + a.id + "_" + msgKey(m), type: "mention", icon: "💬",
            title: "Mentioned in " + a.sn, body: `${m.author} mentioned you: "${m.text.slice(0, 40)}…"`,
            ts: m.ts || now, read: false, sn: a.sn
          });
        }
      });
    });

    // 2. Actions escalated to user (target matches user role) — only within my scope
    audit.forEach(e => {
      const action = actions.find(a => a.sn === e.sn);
      if (!action || !inScope(action)) return;
      if (e.target === user.role || e.target === "All") {
        newNotifs.push({
          id: "esc_" + e.id, type: "escalation", icon: "🚨",
          title: "Action Escalated to You", body: `${action.sn} — ${(action.text || "").slice(0, 50)} (L${e.level})`,
          ts: e.ts || now, read: false, sn: action.sn
        });
      }
    });

    // 3. My actions with revised due dates (revisions > 0, and I'm responsible)
    actions.filter(a => isMine(a) && a.revisions > 0).forEach(a => {
      const lastRev = a.revisionHistory?.[a.revisionHistory.length - 1];
      if (lastRev) {
        newNotifs.push({
          id: "rev_" + a.id, type: "revision", icon: "📅",
          title: "Due Date Revised", body: `${a.sn} due date changed from ${lastRev.from} to ${lastRev.to} by ${lastRev.by}`,
          ts: lastRev.date || now, read: false, sn: a.sn
        });
      }
    });

    // 4. My overdue actions
    actions.filter(a => isMine(a) && isOverdue(a)).forEach(a => {
      newNotifs.push({
        id: "over_" + a.id, type: "overdue", icon: "⚠",
        title: "Action Overdue", body: `${a.sn} — ${(a.text || "").slice(0, 50)} was due ${fmt(a.due)}`,
        ts: a.due, read: false, sn: a.sn
      });
    });

    // 5. NEW events for actions in my plant/dept scope (delta detection)
    actions.filter(inScope).forEach(a => {
      const prev = seenRef.current.get(a.id);
      const msgs = Array.isArray(a.messages) ? a.messages : [];
      const msgKeys = new Set(msgs.map(msgKey));
      const respKey = Array.isArray(a.responsible) ? a.responsible.join("|") : (a.responsible || "");

      if (!prev) {
        // First time we see this action — seed baseline, no notification
        seenRef.current.set(a.id, { status: a.status, msgs: msgKeys, resp: respKey });
        return;
      }

      // 5a. New remark / thread
      msgs.forEach(m => {
        const k = msgKey(m);
        if (!prev.msgs.has(k) && m.author !== user.name) {
          newNotifs.push({
            id: "rem_" + a.id + "_" + k, type: "remark", icon: "💬",
            title: "New remark on " + a.sn, body: `${m.author}: ${(m.text || "").slice(0, 50)}`,
            ts: m.ts || now, read: false, sn: a.sn
          });
        }
      });

      // 5b. Status changed
      if (prev.status && prev.status !== a.status) {
        newNotifs.push({
          id: "st_" + a.id + "_" + a.status + "_" + (a.revisionHistory?.length || 0), type: "status", icon: "🔄",
          title: "Status changed · " + a.sn, body: `${prev.status} → ${a.status}`,
          ts: now, read: false, sn: a.sn
        });
      }

      // 5c. Action allotted to me / my team
      const prevResp = (prev.resp || "").split("|").map(s => s.trim().toLowerCase()).filter(Boolean);
      const newResp = respKey.split("|").map(s => s.trim().toLowerCase()).filter(Boolean);
      const allottedToMe = newResp.some(r => myPeople.includes(r)) && !prevResp.some(r => myPeople.includes(r));
      if (allottedToMe) {
        newNotifs.push({
          id: "allot_" + a.id + "_" + respKey, type: "allot", icon: "📌",
          title: "Action allotted to you", body: `${a.sn} — ${(a.text || "").slice(0, 50)} assigned to ${(a.responsible || "")}`,
          ts: now, read: false, sn: a.sn
        });
      }

      seenRef.current.set(a.id, { status: a.status, msgs: msgKeys, resp: respKey });
    });

    // Deduplicate, exclude dismissed, and limit
    const deduped = Object.values(newNotifs.reduce((acc, n) => { acc[n.id] = n; return acc; }, {}))
      .filter(n => !dismissedIds.current.has(n.id))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 50);
    setNotifs(deduped);
  }, [actions, audit, user, users]);

  const unread = notifs.filter(n => !n.read).length;
  const markAllRead = () => {
    // Add all current IDs to dismissed set so they don't come back this session
    notifs.forEach(n => dismissedIds.current.add(n.id));
    setNotifs([]);
  };
  const markRead = (id) => {
    dismissedIds.current.add(id);
    setNotifs(p => p.filter(n => n.id !== id));
  };
  return { notifs, unread, markAllRead, markRead };
}

/* Support message modal */
function SupportModal({ user, onClose }) {
  useEscClose(onClose);
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 420, padding: 28 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>💬 Application Support</h2>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>×</button>
        </div>
        {sent ? <div style={{ textAlign: "center", padding: "24px 0" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: 15, color: T.navy, marginBottom: 8 }}>Message Sent!</div>
          <div style={{ fontSize: 12, color: T.text2 }}>Admin has been notified. You'll receive a response in-app.</div>
          <button className="btn btn-navy" style={{ marginTop: 20 }} onClick={onClose}>Close</button>
        </div> : <>
          <div style={{ marginBottom: 12, fontSize: 12, color: T.text2 }}>Send a message to your system administrator for help, access requests, or issues.</div>
          <Lbl t="Your Message" req />
          <textarea value={msg} onChange={e => setMsg(e.target.value)} placeholder="Describe your issue or request…" style={{ height: 100, resize: "none", marginBottom: 16 }} />
          <div style={{ fontSize: 11, color: T.text2, marginBottom: 16 }}>Sent by: <b>{user?.name}</b> · {user?.role} · {user?.plant}</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-navy" disabled={!msg.trim()} onClick={() => { if (msg.trim()) setSent(true); }}>Send Message</button>
          </div>
        </>}
      </div>
    </div>
  );
}

/* User Profile Panel */
function UserProfilePanel({ user, users, actions, onClose, onRequestChange }) {
  useEscClose(onClose);
  const [tab, setTab] = useState("profile");
  const [photo, setPhoto] = useState(null);
  const [reqChange, setReqChange] = useState(false);
  const [reqMsg, setReqMsg] = useState("");
  const [reqSent, setReqSent] = useState(false);

  const myActions = actions.filter(a => responsibleMatchesUsers(a.responsible, [(user?.name || "").toLowerCase()]));
  const myTeam = users.filter(u => u.superior === user?.name);
  const myOpen = myActions.filter(a => a.status !== "COMPLETED" && a.status !== "DROPPED").length;
  const myOverdue = myActions.filter(isOverdue).length;
  const myDone = myActions.filter(a => a.status === "COMPLETED").length;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 340 }} onClick={onClose} />
      <div className="side-panel" style={{ width: 420, padding: 0 }}>
        {/* Header with avatar */}
        <div style={{ background: `linear-gradient(135deg,${T.navy},${T.navyD})`, padding: "24px 20px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 10, opacity: .6, letterSpacing: 1, textTransform: "uppercase" }}>My Profile</div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", borderRadius: 8, width: 28, height: 28, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ position: "relative" }}>
              {photo
                ? <img src={photo} alt="Profile" style={{ width: 64, height: 64, borderRadius: "50%", objectFit: "cover", border: "3px solid rgba(255,255,255,.3)" }} />
                : <div style={{ width: 64, height: 64, borderRadius: "50%", background: user?.color || T.amber, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 700, color: "#fff", border: "3px solid rgba(255,255,255,.3)" }}>{user?.initials || "?"}</div>
              }
              <label style={{ position: "absolute", bottom: 0, right: 0, background: T.amber, borderRadius: "50%", width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 11 }} title="Upload photo">
                📷<input type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) { const r = new FileReader(); r.onload = ev => setPhoto(ev.target.result); r.readAsDataURL(f); } }} />
              </label>
            </div>
            <div>
              <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 18, lineHeight: 1.1 }}>{user?.name}</div>
              <div style={{ fontSize: 12, opacity: .7, marginTop: 3 }}>{user?.role} · {user?.plant}</div>
              <div style={{ fontSize: 11, opacity: .5, marginTop: 2 }}>{user?.email}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, marginTop: 16, borderTop: "1px solid rgba(255,255,255,.1)", paddingTop: 14 }}>
            {[{ l: "Open", v: myOpen, c: T.amber }, { l: "Overdue", v: myOverdue, c: T.red }, { l: "Done", v: myDone, c: T.green }].map(k => (
              <div key={k.l} style={{ textAlign: "center" }}>
                <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 20, color: k.c }}>{k.v}</div>
                <div style={{ fontSize: 10, opacity: .6, marginTop: 2 }}>{k.l}</div>
              </div>
            ))}
          </div>
        </div>
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}` }}>
          {[["profile", "👤 Info"], ["team", "👥 My Team"]].map(([id, l]) => (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: "10px 0", border: "none", background: "transparent", cursor: "pointer", fontSize: 12, fontWeight: tab === id ? 700 : 400, color: tab === id ? T.navy : T.text2, borderBottom: tab === id ? `2.5px solid ${T.navy}` : "2.5px solid transparent", marginBottom: -1 }}>
              {l}
            </button>
          ))}
        </div>
        <div style={{ padding: 20, overflowY: "auto" }}>
          {tab === "profile" && <>
            <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
              {[["Full Name", user?.name], ["Role", user?.role], ["Plant", user?.plant], ["Department", user?.dept || "—"], ["Reports To", user?.superior || "Top Level"], ["Phone", user?.phone || "—"], ["Email", user?.email || "—"]].map(([l, v]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 12, color: T.text2, fontWeight: 600 }}>{l}</span>
                  <span style={{ fontSize: 12, fontWeight: 500 }}>{v}</span>
                </div>
              ))}
            </div>
            {reqChange ? <>
              <Lbl t="Request Info Change" />
              <textarea value={reqMsg} onChange={e => setReqMsg(e.target.value)} placeholder="Describe what needs to be changed (e.g., phone number, department, reporting line)…" style={{ height: 80, resize: "none", marginBottom: 10 }} />
              {reqSent ? <div style={{ color: T.green, fontSize: 12, fontWeight: 600 }}>✅ Request sent to admin!</div>
                : <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setReqChange(false); setReqMsg(""); }}>Cancel</button>
                  <button className="btn btn-navy btn-sm" disabled={!reqMsg.trim()} onClick={() => { if (reqMsg.trim()) setReqSent(true); }}>Send Request</button>
                </div>}
            </>
              : <button className="btn btn-ghost btn-sm" onClick={() => setReqChange(true)}>✏ Request Info Change</button>}
          </>}
          {tab === "team" && <>
            <div style={{ fontWeight: 600, fontSize: 13, color: T.navy, marginBottom: 12 }}>Direct Reports ({myTeam.length})</div>
            {myTeam.length === 0 ? <Empty icon="👤" title="No direct reports" sub="No one reports to you in the current org structure." /> :
              myTeam.map(u => {
                const uActions = actions.filter(a => responsibleMatchesUsers(a.responsible, [u.name.trim().toLowerCase()]));
                const uOpen = uActions.filter(a => a.status !== "COMPLETED" && a.status !== "DROPPED").length;
                const uOver = uActions.filter(isOverdue).length;
                return (
                  <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
                    <Avatar name={u.name} size={36} users={users} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{u.name}</div>
                      <div style={{ fontSize: 11, color: T.text2 }}>{u.role} · {u.plant}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: uOver > 0 ? T.red : T.text2 }}>{uOpen} open{uOver > 0 ? `, ${uOver} overdue` : ""}</div>
                    </div>
                  </div>
                );
              })
            }
          </>}
        </div>
      </div>
    </>
  );
}

/* Admin Notifications Manager */
function AdminNotifManager({ users, onClose }) {
  useEscClose(onClose);
  const [notifRules, setNotifRules] = useState([
    { id: 1, label: "Overdue reminder", trigger: "overdue", freq: "daily", target: "responsible", active: true },
    { id: 2, label: "Escalation alert", trigger: "escalation", freq: "immediate", target: "manager", active: true },
    { id: 3, label: "Due date revision", trigger: "revision", freq: "immediate", target: "responsible", active: true },
    { id: 4, label: "Weekly summary", trigger: "weekly_report", freq: "weekly", target: "all_users", active: false },
  ]);
  const toggleRule = id => setNotifRules(p => p.map(r => r.id === id ? { ...r, active: !r.active } : r));
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 500, padding: 28 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>🔔 Admin Notification Rules</h2>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>×</button>
        </div>
        <div style={{ fontSize: 12, color: T.text2, marginBottom: 16 }}>Configure system-wide notification triggers. These rules apply to all users.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {notifRules.map(r => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 10, background: T.bg, border: `1.5px solid ${r.active ? T.navy + "30" : T.border}` }}>
              <button onClick={() => toggleRule(r.id)} style={{ background: r.active ? T.green : "#e2e8f0", border: "none", borderRadius: 12, width: 42, height: 22, cursor: "pointer", transition: "all .2s", position: "relative", flexShrink: 0 }}>
                <span style={{ position: "absolute", top: 2, left: r.active ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "all .2s", display: "block" }} />
              </button>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{r.label}</div>
                <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>Frequency: {r.freq} · Target: {r.target.replace(/_/g, " ")}</div>
              </div>
              <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: r.active ? T.greenL : T.border, color: r.active ? T.green : T.text2, fontWeight: 600 }}>{r.active ? "Active" : "Paused"}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-navy" onClick={onClose}>Save & Close</button>
        </div>
      </div>
    </div>
  );
}

/* ===================== SESSIONS MANAGER MODAL ===================== */
/* Lists every device/browser currently logged in as this user, shows which
   one is "This device", and lets the user revoke any other session (or all
   others at once). Addresses the "multiple users login from different
   systems" requirement by making concurrent sessions visible & manageable. */
function SessionsManagerModal({ user, onClose }) {
  useEscClose(onClose);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    apiGet("/api/sessions/mine").then(setSessions).catch(() => setSessions([])).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const revoke = async (id) => {
    setBusy(id);
    try { await apiDelete(`/api/sessions/${id}`); load(); }
    catch (e) { alert("Could not revoke session: " + e.message); }
    finally { setBusy(null); }
  };
  const revokeOthers = async () => {
    if (!confirm("Sign out all other devices? This device stays signed in.")) return;
    setBusy("others");
    try { await apiDelete("/api/sessions/all/others"); load(); }
    catch (e) { alert("Could not revoke sessions: " + e.message); }
    finally { setBusy(null); }
  };

  const fmtAgo = (iso) => {
    if (!iso) return "—";
    const t = new Date(iso.replace(" ", "T") + (iso.includes("+") || iso.includes("Z") ? "" : "Z"));
    const s = Math.floor((Date.now() - t.getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 340 }} onClick={onClose} />
      <div className="side-panel" style={{ width: 420, padding: 0 }}>
        <div style={{ background: `linear-gradient(135deg,${T.navy},${T.navyD})`, padding: "20px 20px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 10, opacity: .6, letterSpacing: 1, textTransform: "uppercase" }}>Active Sessions</div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", borderRadius: 8, width: 28, height: 28, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
          </div>
          <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 18, lineHeight: 1.1 }}>{sessions.length} device{sessions.length !== 1 ? "s" : ""} signed in</div>
          <div style={{ fontSize: 12, opacity: .7, marginTop: 3 }}>These are all places where you are currently logged in.</div>
        </div>
        <div style={{ padding: 16, overflowY: "auto", maxHeight: "calc(100vh - 140px)" }}>
          {loading && <div style={{ padding: 24, textAlign: "center", color: T.text2 }}><Spin /> Loading sessions…</div>}
          {!loading && sessions.length === 0 && <Empty icon="🔒" title="No active sessions" sub="We couldn't find any active login sessions." />}
          {!loading && sessions.map(s => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `1.5px solid ${s.is_current ? T.green : T.border}`, borderRadius: 12, marginBottom: 10, background: s.is_current ? T.greenL : "#fff" }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: T.navy + "14", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>
                {s.device === "Mobile" ? "📱" : s.device === "Tablet" ? "📟" : "🖥️"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: T.text, display: "flex", alignItems: "center", gap: 6 }}>
                  {s.browser} · {s.device}
                  {s.is_current && <span style={{ background: T.green, color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 7px", borderRadius: 20 }}>THIS DEVICE</span>}
                </div>
                <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>
                  {s.ip ? `${s.ip} · ` : ""}active {fmtAgo(s.last_seen)}
                </div>
              </div>
              {!s.is_current && (
                <button className="btn btn-sm btn-ghost" style={{ color: T.red, borderColor: T.red + "40" }} disabled={busy === s.id} onClick={() => revoke(s.id)}>
                  {busy === s.id ? <Spin /> : "Revoke"}
                </button>
              )}
            </div>
          ))}
          {!loading && sessions.length > 1 && (
            <button className="btn btn-red" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} disabled={busy === "others"} onClick={revokeOthers}>
              {busy === "others" ? <><Spin /> Signing out others…</> : "Sign out all other devices"}
            </button>
          )}
          <div style={{ fontSize: 11, color: T.text2, marginTop: 14, lineHeight: 1.5 }}>
            Tip: if you see a session you don't recognise, revoke it and change your password. Sessions auto-expire after 7 days of inactivity.
          </div>
        </div>
      </div>
    </>
  );
}

function Shell({ children, page, setPage, user, onLogout, onQuickAdd, pendingCount, auditCount, activeMtg, onResumeActiveMtg, mtgRunning, mtgElapsed, notifications, onMarkAllRead, unreadCount, users, actions, onShowSupport, onShowProfile, onShowAdminNotifs, onShowSessions, onlineCount, lastSync, syncing }) {
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [autoStatus, setAutoStatus] = useState(_autosaveState);
  useEffect(() => subscribeAutosave(setAutoStatus), []);
  const isAdmin = isUserAdmin(user);
  const userPerms = getPerms(user);
  const canAccessPage = (id) => {
    if (id === 99) return isAdmin;
    return true;
  };
  const hms = s => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const navigatePage = (id) => { if (canAccessPage(id)) { setPage(id); setMobileMenuOpen(false); } };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg }}>
      {mobileMenuOpen && <div className="mbl-overlay show" onClick={() => setMobileMenuOpen(false)} />}
      <aside className={`app-sidebar${mobileMenuOpen ? " open" : ""}`} style={{ width: 228, background: T.navy, color: "#fff", display: "flex", flexDirection: "column", flexShrink: 0, position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ padding: "20px 18px 16px", borderBottom: "1px solid rgba(255,255,255,.1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: T.amber, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 12, flexShrink: 0 }}>MCS</div>
            <div>
              <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 11, lineHeight: 1.1 }}>Management Control System</div>
              <div style={{ fontSize: 9, color: T.amber, letterSpacing: 1.5, textTransform: "uppercase", marginTop: 2, fontWeight: 700 }}>Actions</div>
            </div>
          </div>
        </div>
        <nav style={{ padding: "14px 10px", flex: 1 }}>
          {NAV.map(n => {
            const active = page === n.id;
            const allowed = canAccessPage(n.id);
            return (
              <button key={n.id} onClick={() => navigatePage(n.id)} title={!allowed ? "Access not granted" : ""} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", borderRadius: 10, border: "none", cursor: allowed ? "pointer" : "not-allowed", marginBottom: 3, textAlign: "left", fontFamily: "'Inter',sans-serif", fontSize: 13, fontWeight: active ? 600 : 400, background: active ? "rgba(255,255,255,.15)" : "transparent", color: active ? "#fff" : allowed ? "rgba(255,255,255,.65)" : "rgba(255,255,255,.3)", transition: "all .2s", position: "relative" }}>
                <span style={{ fontSize: 16, width: 22, textAlign: "center", flexShrink: 0, opacity: allowed ? 1 : 0.4 }}>{n.icon}</span>
                <span style={{ flex: 1 }}>{n.label}</span>
                {!allowed && <span style={{ fontSize: 10, opacity: 0.5 }}>🔒</span>}
                {active && <span style={{ width: 3, height: 20, borderRadius: 2, background: T.amber, position: "absolute", right: 8 }} />}
              </button>
            );
          })}
        </nav>
        <div style={{ borderTop: "1px solid rgba(255,255,255,.1)" }}>
          {/* Notification Bell — fixed in sidebar, no overlap with content area */}
          <div style={{ padding: "8px 18px", borderBottom: "1px solid rgba(255,255,255,.08)", position: "relative" }}>
            <button onClick={() => { setShowNotifPanel(p => !p); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", border: "none", background: showNotifPanel ? "rgba(255,255,255,.12)" : "transparent", cursor: "pointer", borderRadius: 8, padding: "6px 8px", color: "rgba(255,255,255,.75)", fontSize: 12, fontFamily: "'Inter',sans-serif", position: "relative" }}>
              <span style={{ fontSize: 16, width: 22, textAlign: "center", flexShrink: 0 }}>🔔</span>
              <span style={{ flex: 1, textAlign: "left", fontWeight: 500 }}>Notifications</span>
              {unreadCount > 0 && <span style={{ background: T.red, color: "#fff", borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 700, minWidth: 18, textAlign: "center" }}>{unreadCount}</span>}
            </button>
            {showNotifPanel && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 180 }} onClick={() => setShowNotifPanel(false)} />
                <div style={{ position: "absolute", bottom: "100%", left: 10, right: 10, background: "#fff", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,.2)", padding: 0, zIndex: 190, maxHeight: 380, overflowY: "auto", animation: "slideUp .2s ease" }}>
                  <div style={{ padding: "12px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: "#fff", borderRadius: "12px 12px 0 0" }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: T.navy }}>🔔 Notifications</div>
                    {(notifications || []).length > 0 && <button onClick={e => { e.stopPropagation(); onMarkAllRead && onMarkAllRead(); }} style={{ fontSize: 10, color: T.text2, border: "none", background: "transparent", cursor: "pointer", fontWeight: 600 }}>Mark all read</button>}
                  </div>
                  {(notifications || []).length === 0
                    ? <div style={{ padding: "24px 14px", textAlign: "center", color: T.text2, fontSize: 12 }}>No notifications</div>
                    : (notifications || []).slice(0, 20).map(n => (
                      <div key={n.id} style={{ padding: "10px 14px", borderBottom: `1px solid ${T.border}`, background: n.read ? "transparent" : "#F0F0FF", display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{n.icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: n.read ? 500 : 700, fontSize: 12, color: T.text, marginBottom: 2 }}>{n.title}</div>
                          <div style={{ fontSize: 11, color: T.text2, lineHeight: 1.4, wordBreak: "break-word" }}>{n.body}</div>
                        </div>
                        {!n.read && <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.navy, flexShrink: 0, marginTop: 4 }} />}
                      </div>
                    ))
                  }
                </div>
              </>
            )}
          </div>
          {canAccessMasterSetup(user) && (
            <button onClick={() => navigatePage(99)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 18px", border: "none", cursor: "pointer", background: page === 99 ? "rgba(255,255,255,.1)" : "transparent", color: "rgba(255,255,255,.45)", fontSize: 12, fontFamily: "'Inter',sans-serif", transition: "all .2s" }}>
              <span style={{ fontSize: 14 }}>⚙</span><span>Master Setup</span>
            </button>
          )}

          <div style={{ padding: "12px 18px", position: "relative" }}>
            <button onClick={() => setShowUserMenu(p => !p)} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: user?.color || T.amber, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0, color: "#fff" }}>{user?.initials || "?"}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.name}</div>
                <div style={{ fontSize: 10, opacity: .5, color: "#fff" }}>{user?.role} · {user?.plant === "All" ? "All Plants" : user?.plant}</div>
              </div>
              <span style={{ color: "rgba(255,255,255,.4)", fontSize: 12 }}>▲</span>
            </button>
            {showUserMenu && (
              <div style={{ position: "absolute", bottom: "100%", left: 10, right: 10, background: "#fff", borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,.15)", padding: 8, zIndex: 200 }}>
                <div style={{ padding: "8px 12px", borderBottom: `1px solid ${T.border}`, marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{user?.name}</div>
                  <div style={{ fontSize: 11, color: T.text2 }}>{user?.role} — {user?.plant}</div>
                </div>
                {!isGuestRole(user?.role) && <button onClick={() => { setShowUserMenu(false); onShowProfile && onShowProfile(); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", color: T.text, fontSize: 13, fontWeight: 600, borderRadius: 8 }}>👤 My Profile</button>}
                {!isGuestRole(user?.role) && <button onClick={() => { setShowUserMenu(false); onShowSessions && onShowSessions(); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", color: T.text, fontSize: 13, fontWeight: 600, borderRadius: 8 }}>🖥️ My Sessions{onlineCount ? <span style={{ marginLeft: "auto", background: T.green, color: "#fff", borderRadius: 20, fontSize: 10, fontWeight: 700, padding: "1px 8px" }}>{onlineCount}</span> : null}</button>}
                {!isGuestRole(user?.role) && user?.role !== "Admin" && Number(page) !== 3 && Number(page) !== 4 && <button onClick={() => { setShowUserMenu(false); onShowSupport && onShowSupport(); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", color: T.navy, fontSize: 13, fontWeight: 600, borderRadius: 8 }}>💬 Get Support</button>}
                {isAdmin && Number(page) !== 3 && Number(page) !== 4 && <button onClick={() => { setShowUserMenu(false); onShowAdminNotifs && onShowAdminNotifs(); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", color: T.amber, fontSize: 13, fontWeight: 600, borderRadius: 8 }}>🔔 Notification Rules</button>}
                <button onClick={() => { setShowUserMenu(false); onLogout(); }} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", color: T.red, fontSize: 13, fontWeight: 600, borderRadius: 8 }}>🚪 Sign Out</button>
              </div>
            )}
          </div>
           {/* Background autosave status + live sync indicator */}
          <div style={{ padding: "8px 18px 14px", borderTop: "1px solid rgba(255,255,255,.1)", display: "flex", alignItems: "center", gap: 8 }}>
            {autoStatus.status === "saving" && <><span style={{ width: 8, height: 8, borderRadius: "50%", background: T.amber, animation: "blink 1s infinite" }} /><span style={{ fontSize: 10, color: "rgba(255,255,255,.6)" }}>Saving…</span></>}
            {autoStatus.status === "saved" && <><span style={{ width: 8, height: 8, borderRadius: "50%", background: T.green }} /><span style={{ fontSize: 10, color: "rgba(255,255,255,.6)" }}>All changes saved</span></>}
            {autoStatus.status === "pending" && <><span style={{ width: 8, height: 8, borderRadius: "50%", background: T.amber }} /><span style={{ fontSize: 10, color: "rgba(255,255,255,.6)" }}>Pending {autoStatus.pending} save{autoStatus.pending !== 1 ? "s" : ""}</span></>}
            {autoStatus.status === "idle" && <><span style={{ width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,.3)" }} /><span style={{ fontSize: 10, color: "rgba(255,255,255,.4)" }}>Autosave on</span></>}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "rgba(255,255,255,.5)" }} title={lastSync ? "Last synced " + new Date(lastSync).toLocaleTimeString() : "Live sync"}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: syncing ? T.amber : T.green, animation: syncing ? "blink 1s infinite" : "none" }} />
              {syncing ? "Syncing" : "Live"}
            </span>
          </div>
        </div>
      </aside>
      <main style={{ flex: 1, overflow: "hidden", minWidth: 0, position: "relative", display: "flex", flexDirection: "column", height: "100vh" }} className="app-main">

        {/* Mobile top bar */}
        <div style={{ display: "none", padding: "10px 16px", background: T.navy, color: "#fff", alignItems: "center", gap: 12 }} className="mbl-topbar">
          <button className="mbl-menu-btn" onClick={() => setMobileMenuOpen(p => !p)} style={{ display: "flex" }}>☰</button>
          <div style={{ flex: 1, fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 14, color: "#fff" }}>MCS Actions</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {userPerms.canEditActions && <button className="fab" style={{ position: "static", width: 36, height: 36, fontSize: 20 }} onClick={onQuickAdd} title="Quick add action">+</button>}
          </div>
        </div>
        <style>{`.mbl-topbar{display:none!important;}@media(max-width:768px){.mbl-topbar{display:flex!important;}.fab:not(.mbl-topbar .fab){display:none!important;}}`}</style>

        {/* Floating "Meeting Running" pill when away from Work page */}
        {activeMtg && page !== 1 && (
          <div onClick={onResumeActiveMtg} style={{ position: "sticky", top: 0, zIndex: 400, background: `linear-gradient(90deg,${T.red},#C0392B)`, color: "#fff", padding: "8px 20px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", boxShadow: "0 2px 12px rgba(0,0,0,.2)" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#fff", animation: mtgRunning ? "blink 1s infinite" : "none", flexShrink: 0 }} />
            <span style={{ fontWeight: 700, fontSize: 13 }}>Meeting in progress: {activeMtg.type}</span>
            {mtgRunning && <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 14, background: "rgba(0,0,0,.2)", padding: "2px 8px", borderRadius: 5 }}>{hms(mtgElapsed || 0)}</span>}
            <span style={{ marginLeft: "auto", background: "rgba(255,255,255,.2)", borderRadius: 6, padding: "3px 12px", fontSize: 12, fontWeight: 700 }}>↩ Return to Meeting</span>
          </div>
        )}

        <div className="app-content" style={{ padding: 28, paddingTop: 20, flex: 1, overflowY: "auto", minHeight: 0 }}>{children}</div>
      </main>
      {userPerms.canEditActions && <button className="fab" onClick={onQuickAdd} title="Quick add action">+</button>}
    </div>
  );
}

/* ===================== HOME PAGE ===================== */
/* ActionSidePanel — slide-in detail panel used across HomePage */
function ActionSidePanel({ action, onClose, onUpdate, users, plants, depts, currentUser }) {
  useEscClose(onClose);
  const [editField, setEditField] = useState(null);
  const [fieldVal, setFieldVal] = useState("");
  const [msg, setMsg] = useState("");
  const startEdit = (k, v) => { setEditField(k); setFieldVal(v || ""); };
  const commit = () => { if (onUpdate && editField) onUpdate(action.id, { [editField]: fieldVal }); setEditField(null); };
  const sendMsg = () => { if (!msg.trim()) return; const m = { id: Date.now(), author: currentUser?.name || "Unknown", text: msg.trim(), ts: new Date().toLocaleTimeString() }; onUpdate && onUpdate(action.id, { messages: [...(action.messages || []), m] }); setMsg(""); };
  const InlineField = ({ label, k, value, type = "text", opts }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginBottom: 3 }}>{label}</div>
      {editField === k
        ? <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {opts ? <select value={fieldVal} onChange={e => setFieldVal(e.target.value)} style={{ flex: 1, fontSize: 12, padding: "4px 8px" }}>{opts.map(o => <option key={o}>{o}</option>)}{value && !opts.includes(value) && <option value={value}>{value}</option>}</select>
            : <input type={type} value={fieldVal} onChange={e => setFieldVal(e.target.value)} autoFocus style={{ flex: 1, fontSize: 12, padding: "4px 8px" }} />}
          <button onClick={commit} style={{ background: T.green, color: "#fff", border: "none", borderRadius: 5, padding: "3px 8px", cursor: "pointer", fontSize: 12 }}>✓</button>
          <button onClick={() => setEditField(null)} style={{ background: T.border, color: T.text, border: "none", borderRadius: 5, padding: "3px 8px", cursor: "pointer", fontSize: 12 }}>✕</button>
        </div>
        : <div style={{ fontSize: 13, color: T.text, padding: "4px 8px", borderRadius: 6, background: T.bg, cursor: "pointer", border: `1px solid transparent`, transition: "all .15s" }} onClick={() => startEdit(k, value)}
          onMouseEnter={e => e.currentTarget.style.border = `1px solid ${T.border}`}
          onMouseLeave={e => e.currentTarget.style.border = "1px solid transparent"}>
          {value || <span style={{ color: T.text2, fontStyle: "italic" }}>—</span>}
          <span style={{ fontSize: 9, color: T.text2, marginLeft: 6 }}>✏</span>
        </div>
      }
    </div>
  );
  if (!action) return null;
  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 340 }} onClick={onClose} />
      <div className="side-panel" style={{ width: 480, padding: 0, zIndex: 341 }}>
        <div style={{ background: `linear-gradient(135deg,${T.navy},#3D378C)`, padding: "18px 22px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 10, opacity: .6, letterSpacing: 1, textTransform: "uppercase", marginBottom: 3 }}>{action.sn} · {action.src}</div>
              <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 14, fontWeight: 800, lineHeight: 1.4 }}>{action.text}</div>
            </div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: 10 }}>×</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "nowrap", overflowX: "auto" }}>
            <SBadge s={action.status} /><PBadge p={action.priority} />
            {isOverdue(action) && <span style={{ background: T.red, color: "#fff", borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>{daysOver(action)}d overdue</span>}
          </div>
        </div>
        <div style={{ padding: "16px 22px", overflowY: "auto", flex: 1 }}>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginBottom: 3 }}>Responsible</div>
            <MultiUserSelect value={action.responsible} users={(users || []).filter(u => { if (action.plant && action.plant !== "All") return !u.plant || u.plant === "All" || u.plant === action.plant; if (!isUserAdmin(user) && user?.plant && user.plant !== "All") return !u.plant || u.plant === "All" || u.plant === user.plant; return true; })} onChange={v => { const patch = { responsible: v }; const firstName = (v || "").split(",").map(s => s.trim()).filter(Boolean)[0]; if (firstName) { const u = (users || []).find(x => x.name === firstName); if (u) { if (u.plant) patch.plant = u.plant; if (u.dept) patch.section = u.dept; } } onUpdate && onUpdate(action.id, patch); }} />
          </div>
          <InlineField label="Due Date" k="due" value={action.due} type="date" />
          <InlineField label="Status" k="status" value={action.status} opts={["NOT STARTED", "IN PROCESS", "COMPLETED", "DROPPED"]} />
          <InlineField label="Priority" k="priority" value={action.priority} opts={["NORMAL", "WARNING", "CRITICAL"]} />
          <InlineField label="Remarks" k="remarks" value={action.remarks} />
          <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginBottom: 6 }}>Details</div>
          <div className="grid-2col" style={{ gap: 8, marginBottom: 14 }}>
            {[["Plant", action.plant], ["Department", action.section], ["Allocated By", action.allocatedBy], ["Date of Action", fmt(action.dateOfAction)]].map(([l, v]) => (
              <div key={l} style={{ background: T.bg, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: T.text2, textTransform: "uppercase", marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{v || "—"}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginBottom: 8 }}>Thread</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {(action.messages || []).map((m, i) => <div key={i} style={{ background: T.bg, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}><span style={{ fontWeight: 600, color: T.navy }}>{m.author}:</span> {m.text}</div>)}
            {(action.messages || []).length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic" }}>No messages yet</div>}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input value={msg} onChange={e => setMsg(e.target.value)} onKeyDown={e => { if (e.key === "Enter") sendMsg(); }} placeholder="Add a message…" style={{ flex: 1, fontSize: 12, padding: "6px 10px" }} />
            <button onClick={sendMsg} style={{ background: T.navy, color: "#fff", border: "none", borderRadius: 6, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>Send</button>
          </div>
        </div>
      </div>
    </>
  );
}

function HomePage({ actions, setActions, user, setPage, users, meetings, plants, depts, setGlobalActiveMtg, machines, projects }) {
  const now = new Date();
  const isAdmin = isUserAdmin(user);

  // Fix 3: Dashboard scope — actions assigned to me, or assigned to my subordinates, or in my department
  const getSubordinates = (name, allUsers, visited = new Set()) => {
    if (visited.has(name)) return [];
    visited.add(name);
    const directs = allUsers.filter(u => u.superior === name);
    const all = [...directs];
    directs.forEach(d => { all.push(...getSubordinates(d.name, allUsers, visited)); });
    return all;
  };
  const subs = user ? getSubordinates(user.name, users) : [];
  const subNames = subs.map(u => u.name);
  const myDept = user?.dept || "";
  // Normalize name comparisons — data may have trailing spaces/casing differences
  const userName = (user?.name || "").trim().toLowerCase();
  const subNamesLower = subNames.map(n => n.trim().toLowerCase());
  const scopedActions = isAdmin || !user?.plant || user?.plant === "All"
    ? actions
    : actions.filter(a => !a.plant || a.plant === "All" || a.plant === user?.plant);

  // My personal actions: where I am the responsible person or the allocator
  const myActions = actions.filter(a => {
    if (!userName) return false;
    return responsibleMatchesUsers(a.responsible, [userName]) || (a.allocatedBy || "").trim().toLowerCase() === userName;
  });

  const total = myActions.length;
  const comp = myActions.filter(a => a.status === "COMPLETED").length;
  const inProc = myActions.filter(a => a.status === "IN PROCESS").length;
  const notStarted = myActions.filter(a => a.status === "NOT STARTED").length;
  const over = myActions.filter(isOverdue).length;
  const crit = myActions.filter(a => a.priority === "CRITICAL" && a.status !== "COMPLETED" && a.status !== "DROPPED").length;

  // Fix 2 & 4: My open actions as Responsible or Allocator — clickable, opens side panel
  const myOwn = actions.filter(a => (responsibleMatchesUsers(a.responsible, [userName].filter(Boolean)) || (a.allocatedBy || "").trim().toLowerCase() === userName) && userName && a.status !== "COMPLETED" && a.status !== "DROPPED")
    .sort((a, b) => {
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return new Date(a.due) - new Date(b.due);
    });
  // Fix 2 extra: Unassigned actions from my allocations
  const unassigned = myActions.filter(a => (!a.responsible || a.responsible.trim() === "") && a.status !== "COMPLETED" && a.status !== "DROPPED");
  const todayStr2 = now.toISOString().split("T")[0]; // "YYYY-MM-DD"

  // ── Compute truly upcoming meetings ────────────────────────────────────────
  const getNextOccurrence = (mtg) => {
    const mtgTimeStr = mtg.time; // "HH:MM"
    if (!mtgTimeStr || !String(mtgTimeStr).includes(":")) return null;
    const [mtgH, mtgM] = String(mtgTimeStr).split(":").map(Number);
    if (isNaN(mtgH) || isNaN(mtgM)) return null;
    const today = new Date();
    const todayDateStr = today.toISOString().split("T")[0];

    // Build a Set of dates this meeting was already completed
    const completedDates = new Set((mtg.completedSessions || []).map(s => s.date));

    // Non-recurring: show only if not completed AND datetime is in future
    if (!mtg.recurring) {
      // If already completed today, don't show
      if (mtg.completedSessions && mtg.completedSessions.some(s => s.date === todayDateStr)) return null;
      const mtgDateTime = new Date(today);
      mtgDateTime.setHours(mtgH, mtgM, 0, 0);
      // If meeting time already passed today, it's not upcoming
      if (mtgDateTime < now) return null;
      return mtgDateTime;
    }

    // Recurring: find next occurrence after today ( skipping completed dates )
    let checkDate = new Date(today);
    // Start from today; if meeting time already passed today, start from tomorrow
    const nowMins = today.getHours() * 60 + today.getMinutes();
    const mtgMins = mtgH * 60 + mtgM;
    if (nowMins >= mtgMins) checkDate.setDate(checkDate.getDate() + 1);

    // Find next date not in completedDates
    const maxDaysAhead = 365; // safety cap
    for (let i = 0; i < maxDaysAhead; i++) {
      const dateStr = checkDate.toISOString().split("T")[0];
      if (!completedDates.has(dateStr)) {
        // Found a date where meeting hasn't been marked complete
        const next = new Date(checkDate);
        next.setHours(mtgH, mtgM, 0, 0);
        return next;
      }
      checkDate.setDate(checkDate.getDate() + 1);
    }
    return null; // no upcoming occurrence found within lookahead
  };

  const upcomingMeetings = (meetings || []).filter(m => canAccessMeeting(user, m, null))
    .map(m => {
      const next = getNextOccurrence(m);
      return next ? { ...m, _nextDt: next } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a._nextDt - b._nextDt)
    .slice(0, 3);

  // Fix 3: unified action update + single panel state
  const upAction = (id, patch) => {
    setActions && setActions(p => p.map(a => {
      if (a.id !== id) return a;
      if (patch.due && patch.due !== a.due) { const rev = { date: todayStr(), from: a.due, to: patch.due, by: user?.name || "Unknown" }; return { ...a, ...patch, revisions: (a.revisions || 0) + 1, revisionHistory: [...(a.revisionHistory || []), rev] }; }
      return { ...a, ...patch };
    }));
    apiUpdate("actions", id, resolveRecordIds(patch, plants, depts, machines, projects, meetings));
  };

  // State — single unified action detail panel
  const [actionPanel, setActionPanel] = useState(null);

  // State
  const [subModal, setSubModal] = useState(null);
  const [kpiDrill, setKpiDrill] = useState(null);
  const [mtgModal, setMtgModal] = useState(null); // Fix 4: meeting popup
  const [unassignedDrill, setUnassignedDrill] = useState(false);

  // Fix 6: per-bucket counts for subordinates
  const subData = subs.map(u => {
    const mine = actions.filter(a => responsibleMatchesUsers(a.responsible, [u.name.trim().toLowerCase()]) && a.status !== "COMPLETED" && a.status !== "DROPPED");
    const delayed = mine.filter(isOverdue);
    const today = mine.filter(a => !isOverdue(a) && a.due && Math.floor((new Date(a.due) - now) / 86400000) === 0);
    const soon = mine.filter(a => !isOverdue(a) && a.due && Math.floor((new Date(a.due) - now) / 86400000) > 0 && Math.floor((new Date(a.due) - now) / 86400000) <= 3);
    const later = mine.filter(a => !isOverdue(a) && a.due && Math.floor((new Date(a.due) - now) / 86400000) > 3);
    return { ...u, pending: mine.length, delayed, today, soon, later, actions: mine };
  }).filter(u => u.pending > 0);

  const greeting = now.getHours() < 12 ? "Morning" : now.getHours() < 17 ? "Afternoon" : "Evening";

  const kpiDrillData = {
    total: { title: "My Actions", rows: myActions },
    running: { title: "My In Process Actions", rows: myActions.filter(a => a.status === "IN PROCESS") },
    critical: { title: "My Critical Open Actions", rows: myActions.filter(a => a.priority === "CRITICAL" && a.status !== "COMPLETED" && a.status !== "DROPPED") },
    completed: { title: "My Completed Actions", rows: myActions.filter(a => a.status === "COMPLETED") },
    overdue: { title: "My Overdue Actions", rows: myActions.filter(isOverdue) },
  };

  // Fix 4: Meeting popup modal
  const MeetingPopup = ({ mtg, onClose, onStart, canAttend }) => (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 480, padding: 0 }} onClick={e => e.stopPropagation()}>
        <div style={{ background: `linear-gradient(135deg,${T.navy},#3D378C)`, borderRadius: "18px 18px 0 0", padding: "20px 24px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 10, opacity: .6, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Meeting Plan</div>
              <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800 }}>{mtg.type}</div>
              <div style={{ fontSize: 12, opacity: .8, marginTop: 4 }}>{mtg.plant} · {mtg.time} · {mtg.dur}min</div>
            </div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
          </div>
        </div>
        <div style={{ padding: "18px 24px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            {[["Facilitator", mtg.facilitator], ["Plant", mtg.plant], ["Time", mtg.time], ["Duration", `${mtg.dur} min`]].map(([l, v]) => (
              <div key={l} style={{ background: T.bg, borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", marginBottom: 3 }}>{l}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{v || "—"}</div>
              </div>
            ))}
          </div>
          {(mtg.guidelines || []).length > 0 && <div style={{ marginBottom: 14 }}><div style={{ fontSize: 11, fontWeight: 700, color: T.navy, marginBottom: 6 }}>📌 Meeting Guidelines</div><ol style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>{(mtg.guidelines || []).map((g, i) => <li key={i} style={{ fontSize: 12, color: T.text, lineHeight: 1.5 }}>{g}</li>)}</ol></div>}
          {(mtg.completedSessions || []).length > 0 && <div style={{ marginBottom: 14 }}><div style={{ fontSize: 11, fontWeight: 700, color: T.navy, marginBottom: 6 }}>📊 Past Sessions</div>{(mtg.completedSessions || []).map((s, i) => <div key={i} style={{ display: "flex", justifyContent: "space-between", background: T.bg, borderRadius: 6, padding: "6px 10px", fontSize: 12, marginBottom: 4 }}><span>{fmt(s.date)}</span><span style={{ fontWeight: 600 }}>{s.duration} min</span></div>)}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={onClose} className="btn btn-ghost">Close</button>
            {canAttend ? (
              <button onClick={() => { onStart && onStart(mtg); onClose(); }} className="btn btn-navy">▶ Start Meeting</button>
            ) : (
              <button className="btn btn-ghost" disabled title="Only listed attendees can start this meeting" style={{ opacity: .6, cursor: "not-allowed" }}>🔒 Locked</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="fade-in">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 12, color: T.text2, marginBottom: 4 }}>Home › Management Control System</div>
          <h1 style={{ fontFamily: "'Sora',sans-serif", fontSize: 22, fontWeight: 800, color: T.navy }}>Good {greeting}, {user && user.name ? user.name.split(" ")[0] : ""} 👋</h1>
          <div style={{ fontSize: 12, color: T.text2, marginTop: 3 }}>{now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid-kpi-5" style={{ marginBottom: 24 }}>
        {[
          { n: total, label: "Task Assigned", icon: "📋", color: T.navy, key: "total" },
          { n: unassigned.length, label: "Unassigned", icon: "❓", color: T.slate, key: "unassigned" },
          { n: inProc, label: "In Process", icon: "🏃", color: T.amber, key: "running" },
          { n: crit, label: "Critical Open", icon: "⚠", color: T.red, key: "critical" },
          { n: comp, label: "Completed", icon: "✅", color: T.green, key: "completed" },
        ].map((k, i) => (
          <div key={i} className="card card-hover" style={{ padding: 18, cursor: "pointer" }} onClick={() => k.key === "unassigned" ? setUnassignedDrill(true) : setKpiDrill(k.key)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div><div style={{ fontFamily: "'Sora',sans-serif", fontSize: 32, fontWeight: 800, color: k.color }}>{k.n}</div><div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginTop: 2 }}>{k.label}</div></div>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: k.color + "15", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{k.icon}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Row 2: Open Tasks (full width) */}
      <div style={{ marginBottom: 20 }}>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 20px", borderBottom: `1.5px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 14, color: T.navy }}>Open Tasks — I am Responsible</div>
            <button onClick={() => setPage(2)} style={{ fontSize: 12, color: T.navy, border: "none", background: "transparent", cursor: "pointer", fontWeight: 600 }}>View All →</button>
          </div>
          <table>
            <thead><tr><th>SN</th><th>Action</th><th>Status</th><th>Due On</th><th>Priority</th><th>Revisions</th></tr></thead>
            <tbody>
              {myOwn.slice(0, 8).map((a, idx) => {
                const status = normalizeStatus(a.status);
                const hasRemarks = Array.isArray(a.messages) && a.messages.length > 0;
                let rowBg = "";
                if (status === "COMPLETED") rowBg = "#D5F5E3";
                else if (status === "DROPPED") rowBg = "#F2F3F4";
                else if (isOverdue(a)) rowBg = "#FADBD8";
                else if (hasRemarks) rowBg = "#FEF3CD";
                else if (a.pendingConfirmation) rowBg = "#FEF9E7";
                return (
                <tr key={a.id || `home-own-${idx}`} style={{ cursor: "pointer", background: rowBg }} onClick={() => setActionPanel(a)}>
                  <td style={{ fontFamily: "monospace", fontSize: 11, color: T.text2, whiteSpace: "nowrap" }}>{a.sn}</td>
                  <td style={{ fontSize: 12, fontWeight: 500, whiteSpace: "normal", wordBreak: "break-word", maxWidth: 320, lineHeight: 1.4 }}>{a.text}</td>
                  <td><SBadge s={a.status} /></td>
                  <td style={{ fontSize: 12, color: isOverdue(a) ? T.red : T.text, fontWeight: isOverdue(a) ? 600 : 400, whiteSpace: "nowrap" }}>{isOverdue(a) ? `${daysOver(a)}d overdue` : fmt(a.due)}</td>
                  <td><PBadge p={a.priority} /></td>
                  <td style={{ textAlign: "center" }}>{(a.revisions || 0) > 0 ? <span style={{ fontWeight: 700, color: T.amber, fontSize: 12 }}>{a.revisions}</span> : <span style={{ color: T.text2, fontSize: 12 }}>—</span>}</td>
                </tr>
                );
              })}
              {myOwn.length === 0 && <tr><td colSpan={6}><Empty icon="🎉" title="All clear!" sub="No open actions assigned to you." /></td></tr>}
            </tbody>
          </table>
          {/* Upcoming meetings — Fix 4: clickable */}
          {upcomingMeetings.length > 0 && (
            <div style={{ padding: "12px 20px", borderTop: `1.5px solid ${T.border}`, background: T.bg }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.navy, marginBottom: 8, textTransform: "uppercase", letterSpacing: .4 }}>📅 Upcoming — click to open</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {upcomingMeetings.map((m, idx) => {
                  const isToday = m._nextDt.toISOString().split("T")[0] === todayStr2;
                  return (
                    <div key={m.id || `mtg-${idx}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer", padding: "6px 9px", borderRadius: 7, transition: "background .15s" }}
                      onClick={() => setMtgModal(m)}
                      onMouseEnter={e => e.currentTarget.style.background = T.border}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>

                      {/* Time badge */}
                      <span style={{ background: T.navy + "15", color: T.navy, borderRadius: 6, padding: "2px 8px", fontWeight: 600, minWidth: 48, textAlign: "center" }}>
                        {m.time}
                      </span>

                      {/* Meeting title */}
                      <span style={{ fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {m.name || m.type}
                      </span>

                      {/* Plant */}
                      <span style={{ fontSize: 11, color: T.text2 }}>
                        {m.plant}
                      </span>

                      {/* Date indicator (if not today) */}
                      {!isToday && <span style={{ fontSize: 10, color: T.text2, fontWeight: 600 }}>
                        {m._nextDt.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                      </span>}

                      {/* Recurring indicator */}
                      {m.recurring && <span style={{ fontSize: 10, color: T.amber, fontWeight: 700, background: T.amberL, padding: "1px 6px", borderRadius: 4 }}>🔁</span>}

                      {/* Arrow */}
                      <span style={{ fontSize: 10, color: T.navy, fontWeight: 700 }}>Open →</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Row 3: Team Pending (Fix 6) + Escalated Actions (Fix 7) */}
      <div className="grid-2col" style={{ marginBottom: 20 }}>
        {/* Fix 6: Team Pending with 4 color buckets per person */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 14, color: T.navy, marginBottom: 4 }}>Team Pending Actions</div>
          <div style={{ fontSize: 11, color: T.text2, marginBottom: 12 }}>Click any count box to see those actions</div>
          {subData.length === 0
            ? <Empty icon="✅" title="All clear!" sub={subs.length === 0 ? "No subordinates in org chart" : "All team members up to date"} />
            : <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {subData.slice(0, 6).map((u, idx) => (
                <div key={u.id || `sub-${idx}`}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <Avatar name={u.name} size={24} users={users} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{u.name}</span>
                    <span style={{ fontSize: 10, color: T.text2 }}>{u.role}</span>
                  </div>
                  <div className="grid-team-buckets">
                    {[
                      { label: "Delayed", count: u.delayed.length, bg: T.redL, border: T.red, color: T.red, actions: u.delayed, tip: "Overdue" },
                      { label: "Today", count: u.today.length, bg: "#FFF3E0", border: "#E65100", color: "#E65100", actions: u.today, tip: "Due today" },
                      { label: "Next 3d", count: u.soon.length, bg: T.amberL, border: T.amber, color: T.amber, actions: u.soon, tip: "Due in 1-3 days" },
                      { label: ">3 Days", count: u.later.length, bg: "#fff", border: T.border, color: T.text2, actions: u.later, tip: "Due after 3 days" },
                    ].map(b => (
                      <div key={b.label} style={{ background: b.bg, border: `1.5px solid ${b.border}`, borderRadius: 8, padding: "6px 8px", textAlign: "center", cursor: b.count > 0 ? "pointer" : "default", opacity: b.count === 0 ? .4 : 1, transition: "all .15s" }}
                        onClick={() => b.count > 0 && setSubModal({ user: u, bucket: b.label, actions: b.actions })}>
                        <div style={{ fontSize: 16, fontWeight: 800, color: b.color }}>{b.count}</div>
                        <div style={{ fontSize: 9, fontWeight: 600, color: b.color, marginTop: 1 }}>{b.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          }
        </div>

        {/* Fix 7: Escalated Actions Summary */}
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 14, color: T.navy }}>🚨 Escalated Actions</div>
            <button onClick={() => setPage(4)} style={{ fontSize: 11, color: T.red, border: `1px solid ${T.red}`, background: "transparent", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontWeight: 700 }}>View All →</button>
          </div>
          {myActions.filter(isOverdue).length === 0
            ? <Empty icon="✅" title="No escalations!" sub="All your actions are within threshold." />
            : <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 280, overflowY: "auto" }}>
              {myActions.filter(isOverdue).sort((a, b) => daysOver(b) - daysOver(a)).slice(0, 5).map((a, idx) => {
                const d = daysOver(a);
                const lvl = d >= 7 ? "L4" : d >= 3 ? "L3" : d >= 1 ? "L2" : "L1";
                const lvlColor = d >= 7 ? T.red : d >= 3 ? "#C0392B" : d >= 1 ? "#E67E22" : T.amber;
                return (
                  <div key={a.id || `esc-${idx}`} style={{ background: T.redL, border: `1.5px solid ${T.red}20`, borderRadius: 10, padding: "10px 14px", cursor: "pointer", display: "flex", gap: 12, alignItems: "flex-start" }} onClick={() => setActionPanel(a)}>
                    <div style={{ background: lvlColor, color: "#fff", borderRadius: 6, padding: "2px 7px", fontSize: 10, fontWeight: 800, flexShrink: 0, marginTop: 2 }}>{lvl}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.4, marginBottom: 3, color: T.text, wordBreak: "break-word" }}>{a.text}</div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 11, color: T.text2 }}>{a.responsible}</span>
                        <span style={{ fontSize: 11, color: T.red, fontWeight: 700 }}>{d}d overdue</span>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          }
        </div>
      </div>

      {/* Unified action detail panel — same as Actions page */}
      {actionPanel && <ActionDetailPanel action={actionPanel} onClose={() => setActionPanel(null)} onUpdate={(id, patch) => { upAction(id, patch); setActionPanel(p => p ? { ...p, ...patch } : p); }} user={user} users={users} allUsers={users} plants={plants} meetings={meetings} />}

      {/* Fix 6: Team sub modal */}
      {subModal && (
        <div className="overlay" onClick={() => setSubModal(null)}>
          <div className="modal" style={{ width: 620, padding: 0 }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "16px 22px", borderBottom: `1.5px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Avatar name={subModal.user.name} size={34} users={users} />
                <div>
                  <h3 style={{ fontFamily: "'Sora',sans-serif", fontSize: 14, fontWeight: 800, color: T.navy }}>{subModal.user.name}</h3>
                  <div style={{ fontSize: 11, color: T.text2 }}>{subModal.bucket} Actions · {subModal.actions.length} items</div>
                </div>
              </div>
              <button onClick={() => setSubModal(null)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>×</button>
            </div>
            <div style={{ maxHeight: "65vh", overflowY: "auto" }}>
              {subModal.actions.length === 0
                ? <Empty icon="✅" title="No actions in this bucket" sub="" />
                : <table>
                  <thead><tr><th>SN</th><th>Action</th><th>Due</th><th>Status</th><th>Priority</th></tr></thead>
                  <tbody>{subModal.actions.map((a, idx) => (
                    <tr key={a.id || `sub-act-${idx}`} style={{ cursor: "pointer" }} onClick={() => setActionPanel(a)}>
                      <td style={{ fontFamily: "monospace", fontSize: 11, color: T.text2, whiteSpace: "nowrap" }}>{a.sn}</td>
                      <td style={{ fontSize: 12, fontWeight: 500, whiteSpace: "normal", wordBreak: "break-word", maxWidth: 240, lineHeight: 1.4 }}>{a.text}</td>
                      <td style={{ fontSize: 12, color: isOverdue(a) ? T.red : T.text, fontWeight: isOverdue(a) ? 600 : 400, whiteSpace: "nowrap" }}>{isOverdue(a) ? `${daysOver(a)}d late` : fmt(a.due)}</td>
                      <td><SBadge s={a.status} /></td>
                      <td><PBadge p={a.priority} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              }
            </div>
          </div>
        </div>
      )}


      {/* KPI drill modal */}
      {kpiDrill && kpiDrillData[kpiDrill] && (
        <div className="overlay" onClick={() => setKpiDrill(null)}>
          <div className="modal" style={{ width: 700, padding: 28 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>{kpiDrillData[kpiDrill].title} <span style={{ fontSize: 12, color: T.text2, fontWeight: 400 }}>({kpiDrillData[kpiDrill].rows.length})</span></h2>
              <button onClick={() => setKpiDrill(null)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>×</button>
            </div>
            <table><thead><tr><th>SN</th><th>Action</th><th>Responsible</th><th>Status</th><th>Due</th></tr></thead>
              <tbody>{kpiDrillData[kpiDrill].rows.slice(0, 20).map((a, idx) => (
                <tr key={a.id || `drill-${idx}`} style={{ cursor: "pointer" }} onClick={() => setActionPanel(a)}>
                  <td style={{ fontFamily: "monospace", fontSize: 11, color: T.text2, whiteSpace: "nowrap" }}>{a.sn}</td>
                  <td style={{ fontSize: 12, whiteSpace: "normal", wordBreak: "break-word", maxWidth: 260, lineHeight: 1.4 }}>{a.text}</td>
                  <td style={{ fontSize: 12 }}>{a.responsible}</td>
                  <td><SBadge s={a.status} /></td>
                  <td style={{ fontSize: 12, color: isOverdue(a) ? T.red : T.text, whiteSpace: "nowrap" }}>{fmt(a.due)}</td>
                </tr>
              ))}</tbody></table>
            {kpiDrillData[kpiDrill].rows.length === 0 && <Empty icon="📭" title="No records" sub="Nothing to show." />}
            <div style={{ marginTop: 14, textAlign: "right" }}><button className="btn btn-navy btn-sm" onClick={() => { setKpiDrill(null); setPage(2); }}>Open Actions Register</button></div>
          </div>
        </div>
      )}


      {/* Unassigned drill modal */}
      {unassignedDrill && (
        <div className="overlay" onClick={() => setUnassignedDrill(false)}>
          <div className="modal" style={{ width: 680, padding: 28 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>Unassigned Actions <span style={{ fontSize: 12, color: T.text2, fontWeight: 400 }}>({unassigned.length})</span></h2>
              <button onClick={() => setUnassignedDrill(false)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>×</button>
            </div>
            {unassigned.length === 0 ? <Empty icon="✅" title="All actions have an owner" sub="" /> : <table>
              <thead><tr><th>SN</th><th>Action</th><th>Source</th><th>Status</th><th>Due</th></tr></thead>
              <tbody>{unassigned.map((a, idx) => (<tr key={a.id || `unassigned-${idx}`}><td style={{ fontFamily: "monospace", fontSize: 11, color: T.text2 }}>{a.sn}</td><td style={{ fontSize: 12, whiteSpace: "normal", wordBreak: "break-word", maxWidth: 260, lineHeight: 1.4 }}>{a.text}</td><td style={{ fontSize: 12 }}>{a.src}</td><td><SBadge s={a.status} /></td><td style={{ fontSize: 12, color: isOverdue(a) ? T.red : T.text }}>{fmt(a.due)}</td></tr>))}</tbody>
            </table>}
          </div>
        </div>
      )}

      {/* Fix 4: Meeting popup */}
      {mtgModal && (() => {
        const _att = ensureArray(mtgModal.attendees);
        const _my = (user?.name || "").trim().toLowerCase();
        const _canAttend = isUserAdmin(user) || _att.some(a => (a || "").toString().trim().toLowerCase() === _my) || (mtgModal.facilitator || "").toString().trim().toLowerCase() === _my;
        return <MeetingPopup mtg={mtgModal} canAttend={_canAttend} onClose={() => setMtgModal(null)} onStart={(m) => { setGlobalActiveMtg && setGlobalActiveMtg(m); setPage(1); }} />;
      })()}
    </div>
  );
}

/* ===================== PROJECT CHARTER MODAL ===================== */
function ProjectCharterModal({ pr, onClose, actions, meetings, user, onProjectUpdate, onActionSelect, users: allUsers }) {
  useEscClose(onClose);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState({ ...pr, milestones: [...(Array.isArray(pr.milestones) ? pr.milestones : []).map(m => ({ ...m }))], team: [...((Array.isArray(pr.team) ? pr.team : (typeof pr.team === "string" ? [pr.team] : [])) || [])], risks: pr.risks || "" });
  const canEdit = isUserAdmin(user) || (user?.name === pr.owner) || (user?.name === pr.sponsor);
  const pActions = actions.filter(a => (a.projectName || a.project) === pr.name);
  const projectMeetings = (meetings || []).filter(m => m.project === pr.name);
  const now = new Date();
  const start = new Date(pr.startDate || pr.start), end = new Date(pr.endDate || pr.end);
  const safeMilestones = Array.isArray((editMode ? draft : pr).milestones) ? (editMode ? draft : pr).milestones : [];
  const done = safeMilestones.filter(m => m.done).length;
  const total = safeMilestones.length;
  const milestonePct = total > 0 ? Math.round(done / total * 100) : 0;
  const isOverdueProject = now > end && pr.status !== "COMPLETED";
  const barColor = pr.status === "COMPLETED" ? T.green : isOverdueProject ? T.red : milestonePct >= 66 ? T.green : milestonePct >= 33 ? T.amber : T.red;
  const current = { ...(editMode ? draft : pr), milestones: safeMilestones };

  const toggleMilestone = (i) => {
    if (!editMode && !canEdit) return;
    setDraft(d => ({ ...d, milestones: d.milestones.map((m, idx) => idx === i ? { ...m, done: !m.done } : m) }));
    if (!editMode) onProjectUpdate({ ...pr, milestones: (Array.isArray(pr.milestones) ? pr.milestones : []).map((m, idx) => idx === i ? { ...m, done: !m.done } : m) });
  };
  const save = () => { onProjectUpdate(draft); setEditMode(false); };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 860, padding: 0, maxHeight: "93vh" }} onClick={e => e.stopPropagation()}>
        <div style={{ background: `linear-gradient(135deg,${T.navy},#3D378C)`, borderRadius: "18px 18px 0 0", padding: "24px 28px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 11, opacity: .6, marginBottom: 4, letterSpacing: 1, textTransform: "uppercase" }}>Project Charter</div>
              {editMode
                ? <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} style={{ fontFamily: "'Sora',sans-serif", fontSize: 22, fontWeight: 800, color: "#fff", background: "rgba(255,255,255,.15)", border: "1px solid rgba(255,255,255,.4)", borderRadius: 8, padding: "4px 10px", width: "100%", marginBottom: 6 }} />
                : <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{pr.name}</h2>}
              <div style={{ display: "flex", gap: 8, flexWrap: "nowrap", overflowX: "auto" }}>
                <span style={{ padding: "3px 10px", borderRadius: 20, background: "rgba(255,255,255,.15)", fontSize: 11, fontWeight: 600 }}>{pr.plant}</span>
                <span style={{ padding: "3px 10px", borderRadius: 20, background: pr.priority === "CRITICAL" ? T.red + "80" : pr.priority === "WARNING" ? T.amber + "80" : "rgba(255,255,255,.15)", fontSize: 11, fontWeight: 600 }}>{pr.priority}</span>
                <span style={{ padding: "3px 10px", borderRadius: 20, background: "rgba(255,255,255,.15)", fontSize: 11, fontWeight: 600 }}>{pr.status}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {canEdit && !editMode && <button onClick={() => setEditMode(true)} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>✏ Edit</button>}
              {editMode && <><button onClick={save} style={{ background: T.green, border: "none", color: "#fff", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button><button onClick={() => setEditMode(false)} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 8, padding: "6px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Cancel</button></>}
              <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>x</button>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, opacity: .85, marginBottom: 6 }}>
              <span>{fmt(pr.startDate || pr.start)}</span>
              <span style={{ fontWeight: 700, color: isOverdueProject ? "#ffaaaa" : barColor === T.green ? "#aaffcc" : "#ffd580" }}>
                {pr.status === "COMPLETED" ? "✓ Completed" : isOverdueProject ? "⚠ Overdue" : milestonePct === 100 ? "All milestones done" : `${done}/${total} milestones`}
              </span>
              <span>{fmt(pr.endDate || pr.end)}</span>
            </div>
            <div style={{ background: "rgba(255,255,255,.2)", borderRadius: 6, height: 8 }}>
              <div style={{ height: "100%", borderRadius: 6, background: barColor, width: `${milestonePct}%`, transition: "width .6s" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
              <span style={{ fontSize: 11, fontWeight: 700, opacity: .9 }}>{milestonePct}% complete</span>
            </div>
          </div>
        </div>
        <div style={{ padding: "24px 28px", overflowY: "auto", maxHeight: "calc(93vh - 180px)" }}>
          <div className="grid-3col" style={{ gap: 14, marginBottom: 20 }}>
            {[{ l: "Sponsor", k: "sponsor" }, { l: "Project Owner", k: "owner" }, { l: "Budget", k: "budget" }].map(({ l, k }) => (
              <div key={k} className="card" style={{ padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .5, marginBottom: 6 }}>{l}</div>
                {editMode ? <input value={draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} style={{ fontSize: 12, padding: "5px 8px" }} /> : <div style={{ fontWeight: 600, fontSize: 13 }}>{pr[k]}</div>}
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
            {[{ l: "🎯 Objective", k: "objective" }, { l: "🗺 Scope", k: "scope" }].map(({ l, k }) => (
              <div key={k} className="card" style={{ padding: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.navy, marginBottom: 8 }}>{l}</div>
                {editMode ? <textarea value={draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} style={{ fontSize: 12, height: 80, resize: "none" }} /> : <div style={{ fontSize: 13, lineHeight: 1.6, color: T.text }}>{pr[k]}</div>}
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.navy }}>👥 Project Team</div>
              {editMode && <select defaultValue="" onChange={e => { const v = e.target.value; if (v && !draft.team.includes(v)) setDraft(d => ({ ...d, team: [...d.team, v] })) }}>
                <option value="" disabled>+ Add member</option>
                {(allUsers || []).filter(u => !draft.team.includes(u.name)).map(u => <option key={u.id} value={u.name}>{u.name} ({u.role})</option>)}
              </select>}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "nowrap", overflowX: "auto" }}>
              {(() => {
                const rawTeam = (editMode ? draft : pr).team;
                const safeTeam = Array.isArray(rawTeam) ? rawTeam : (typeof rawTeam === "string" && rawTeam ? [rawTeam] : []);
                return <>
                  {safeTeam.map(name => (
                    <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, background: T.bg, borderRadius: 8, padding: "6px 12px", position: "relative" }}>
                      <Avatar name={name} size={28} users={allUsers || []} />
                      <div><div style={{ fontSize: 12, fontWeight: 600 }}>{name}</div><div style={{ fontSize: 10, color: T.text2 }}>{(allUsers || []).find(u => u.name === name)?.role || "Member"}</div></div>
                      {editMode && <button onClick={() => setDraft(d => ({ ...d, team: d.team.filter(n => n !== name) }))} style={{ marginLeft: 4, background: "transparent", border: "none", cursor: "pointer", color: T.red, fontSize: 14, lineHeight: 1, padding: "0 2px" }} title="Remove">×</button>}
                    </div>
                  ))}
                  {safeTeam.length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic" }}>No team members added</div>}
                </>;
              })()}
            </div>
          </div>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.navy }}>📍 Milestones</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: T.text2 }}>{done}/{current.milestones.length} complete</span>
                {editMode && <button onClick={() => setDraft(d => ({ ...d, milestones: [...d.milestones, { name: "New Milestone", due: todayStr(), done: false }] }))} style={{ fontSize: 11, background: T.navy, color: "#fff", border: "none", borderRadius: 6, padding: "3px 10px", cursor: "pointer" }}>+ Add</button>}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {current.milestones.map((m, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", borderRadius: 8, background: m.done ? T.greenL : T.bg, border: `1px solid ${m.done ? T.green + "30" : T.border}`, cursor: canEdit && !editMode ? "pointer" : "default", transition: "all .18s" }} onClick={() => canEdit && !editMode && toggleMilestone(i)}>
                  <div style={{ width: 22, height: 22, borderRadius: "50%", background: m.done ? T.green : T.border, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: `2px solid ${m.done ? T.green : T.border}`, transition: "all .2s", cursor: editMode ? "pointer" : "inherit" }} onClick={editMode ? ev => { ev.stopPropagation(); toggleMilestone(i) } : undefined}>
                    {m.done && <span style={{ color: "#fff", fontSize: 12, lineHeight: 1 }}>✓</span>}
                  </div>
                  {editMode
                    ? <input value={m.name} onChange={e => setDraft(d => ({ ...d, milestones: d.milestones.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x) }))} style={{ flex: 1, fontSize: 12, padding: "3px 8px" }} onClick={ev => ev.stopPropagation()} />
                    : <div style={{ flex: 1, fontSize: 13, fontWeight: m.done ? 400 : 500, color: m.done ? T.text2 : T.text, textDecoration: m.done ? "line-through" : "none" }}>{m.name}</div>
                  }
                  {editMode
                    ? <input type="date" value={m.due} onChange={e => setDraft(d => ({ ...d, milestones: d.milestones.map((x, idx) => idx === i ? { ...x, due: e.target.value } : x) }))} style={{ fontSize: 11, padding: "3px 6px", width: 130 }} onClick={ev => ev.stopPropagation()} />
                    : <div style={{ fontSize: 11, color: T.text2, flexShrink: 0 }}>{fmt(m.due)}</div>
                  }
                  {editMode && <button onClick={ev => { ev.stopPropagation(); setDraft(d => ({ ...d, milestones: d.milestones.filter((_, idx) => idx !== i) })) }} style={{ background: "transparent", border: "none", cursor: "pointer", color: T.red, fontSize: 16, lineHeight: 1, padding: "0 4px" }} title="Remove">×</button>}
                  {canEdit && !editMode && <span style={{ fontSize: 10, color: T.text2, opacity: .5 }}>{m.done ? "click to uncheck" : "click to check"}</span>}
                </div>
              ))}
              {current.milestones.length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic", padding: "8px 0" }}>No milestones yet — click + Add to create one</div>}
            </div>
          </div>
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.navy, marginBottom: 8 }}>⚠ Risks & Constraints</div>
            {editMode ? <textarea value={draft.risks} onChange={e => setDraft(d => ({ ...d, risks: e.target.value }))} style={{ fontSize: 12, height: 64, resize: "none" }} /> : <div style={{ fontSize: 13, lineHeight: 1.6, color: T.text }}>{pr.risks}</div>}
          </div>
          {projectMeetings.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 14 }}>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}`, fontSize: 11, fontWeight: 700, color: T.navy }}>🎙 Related Meetings ({projectMeetings.length})</div>
              <table>
                <thead><tr><th>Type</th><th>Plant</th><th>Time</th><th>Facilitator</th><th>Sessions</th></tr></thead>
                <tbody>{projectMeetings.map(m => (
                  <tr key={m.id}>
                    <td style={{ fontSize: 12, fontWeight: 500 }}>{m.type}</td>
                    <td style={{ fontSize: 12 }}>{m.plant}</td>
                    <td style={{ fontSize: 12 }}>{m.time} · {m.dur}min</td>
                    <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><Avatar name={m.facilitator} size={22} users={allUsers || []} /><span style={{ fontSize: 12 }}>{m.facilitator}</span></div></td>
                    <td style={{ fontSize: 12, color: T.text2 }}>{(m.completedSessions || []).length} done</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {pActions.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}`, fontSize: 11, fontWeight: 700, color: T.navy }}>Linked Actions ({pActions.length}) — click to open</div>
              <table>
                <thead><tr><th>#</th><th>Action</th><th>Responsible</th><th>Status</th><th>Due</th></tr></thead>
                <tbody>{pActions.map(a => (
                  <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => onActionSelect && onActionSelect(a)}>
                    <td style={{ fontFamily: "monospace", fontSize: 11, color: T.text2 }}>{a.sn}</td>
                    <td style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.text}</td>
                    <td style={{ fontSize: 12 }}>{a.responsible}</td>
                    <td><SBadge s={a.status} /></td>
                    <td style={{ fontSize: 12, color: isOverdue(a) ? T.red : T.text }}>{fmt(a.due)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===================== WORK PAGE ===================== */
function WorkPage({ plants, depts, users, onCommitFinal, actions, setActions, user, onProjectUpdate, allProjects, setProjects: setProjectsUp, allMeetings, setMeetings: setMeetingsUp, setPage, globalActiveMtg, setGlobalActiveMtg, mtgRunning, setMtgRunning, mtgElapsed, mtgTxLines, setMtgTxLines, mtgFastActions, setMtgFastActions, mtgInsights, setMtgInsights, clearMeetingState, mtgPresets, machines, reasons }) {
  // activeMtg is now global — WorkPage just reads/writes it
  const activeMtg = globalActiveMtg;
  const setActiveMtg = (m) => { setGlobalActiveMtg(m); if (m) setMtgRunning(true); };
  // Use App-level meetings so they persist across page navigation
  const meetings = allMeetings;
  const setMeetings = setMeetingsUp;
  // Projects: single source of truth from App level
  const projects = allProjects;
  const setProjects = (updater) => {
    setProjectsUp && setProjectsUp(updater);
  };
  const [charter, setCharter] = useState(null);
  const [showAddMtg, setShowAddMtg] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [charterActionSel, setCharterActionSel] = useState(null);
  const [mtgPlan, setMtgPlan] = useState(null);  // Feature 4: meeting plan view
  const [selectedBeltDay, setSelectedBeltDay] = useState(() => new Date().toISOString().split("T")[0]);  // combined Weekly Schedule: which day is drilled into

  const isAdmin = isUserAdmin(user);
  const userPerms = getPerms(user);
  // Feature 3: can create projects if admin or has permission
  const canCreateProject = isAdmin || userPerms.canCreateProjects;
  // Feature 4: can edit meetings if admin or has permission
  const canEditMeetings = isAdmin || userPerms.canEditMeetings;

  const deleteMeeting = (m) => {
    if (!window.confirm(`Delete "${m.type}" (${m.plant}, ${m.time})? This cannot be undone.`)) return;
    setMeetings(p => (p || []).filter(x => x.id !== m.id));
    apiRemove("meetings", m.id);
  };
  const deleteProject = (pr) => {
    if (!window.confirm(`Delete project "${pr.name}"? This cannot be undone.`)) return;
    setProjects(p => (p || []).filter(x => x.id !== pr.id));
    apiRemove("projects", pr.id);
  };

  const plantFilter = (item) => isUserAdmin(user) || plantVisible(user, item);
  const visibleMeetings = (meetings || []).filter(m => canAccessMeeting(user, m, mtgPresets));
  const visibleProjects = isAdmin ? (projects || []) : (projects || []).filter(p => isUserAdmin(user) || plantVisible(user, p));

  if (activeMtg) return <MeetingRoom mtg={activeMtg} plants={plants} depts={depts} users={users} onCommit={rows => { onCommitFinal(rows); }} onCloseMeeting={() => { clearMeetingState && clearMeetingState(); setPage(0); }} onBack={() => setPage(0)} prevActions={actions} relatedActions={actions.filter(a => {
          // Match by specific meeting instance (srcId) when available, else fall back to type match
          const matchesMeeting = activeMtg.id
            ? (a.srcId === activeMtg.id || (!a.srcId && a.src === activeMtg.type))
            : a.src === activeMtg.type;
          const matchesProject = activeMtg.project && (a.projectName || a.project) === activeMtg.project;
          return matchesMeeting || matchesProject;
        })} running={mtgRunning} setRunning={setMtgRunning} elapsed={mtgElapsed} txLines={mtgTxLines} setTxLines={setMtgTxLines} insights={mtgInsights} setInsights={setMtgInsights} currentUser={user} mtgPresets={mtgPresets} setActions={setActions} machines={machines} reasons={reasons} />;

  return (
    <div className="fade-in">
      <PageHeader title="Work" sub="Projects, meetings and active sessions" />
      <div className="grid-2col" style={{ gap: 24 }}>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 15, color: T.navy, display: "flex", alignItems: "center", gap: 8 }}>
              🎙 Today's Meetings
              <span style={{ background: T.navy + "15", color: T.navy, borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>{visibleMeetings.length}</span>
            </div>
            {!isGuestRole(user?.role) && <button className="btn btn-ghost btn-sm" onClick={() => setShowAddMtg(true)}>+ Schedule</button>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleMeetings.map((m, idx) => {
              const attendees = ensureArray(m.attendees || mtgPresets?.attendeeMap?.[m.type]);
              const linkedProject = (projects || []).find(p => p.name === m.project);
              const myName = (user?.name || "").trim().toLowerCase();
              const amAttendee = attendees.some(a => (a || "").toString().trim().toLowerCase() === myName);
              const amFacilitator = (m.facilitator || "").toString().trim().toLowerCase() === myName;
              const canAttend = isUserAdmin(user) || canEditMeetings || amFacilitator || (amAttendee && !isGuestRole(user?.role));
              return (
                <div key={m.id || `mtg-list-${idx}`} className="card" style={{ padding: 18 }}>
                  {m.project && linkedProject && (
                    <div style={{ background: T.navy + "08", border: `1px solid ${T.navy}20`, borderRadius: 8, padding: "6px 12px", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setCharter(linkedProject)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 14 }}>🗂</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: T.navy }}>{m.project}</span>
                      </div>
                      <span style={{ fontSize: 11, color: T.text2 }}>View Charter →</span>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                    <div style={{ background: T.navy, color: "#fff", borderRadius: 10, padding: "8px 10px", textAlign: "center", minWidth: 56, flexShrink: 0, position: "relative" }}>
                      <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800 }}>{m.time}</div>
                      <div style={{ fontSize: 9, opacity: .7, marginTop: 1 }}>{m.dur}min</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Feature 4: meeting title clickable to open plan */}
                      <div style={{ fontWeight: 700, fontSize: 14, color: T.navy, marginBottom: 3, cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }} onClick={() => setMtgPlan(m)}>{m.name || m.type}</div>
                      <div style={{ display: "flex", flexWrap: "nowrap", overflowX: "auto", gap: 6, marginBottom: 6 }}>
                        <Chip label={m.plant} color={T.navy} />
                        {m.recurring && <Chip label="Recurring" color={T.slate} />}
                        {m.scheduledDays && m.scheduledDays.length > 0 && <Chip label={m.scheduledDays.join(", ")} color={T.amber} />}
                      </div>
                      <div style={{ fontSize: 11, color: T.text2, marginBottom: 6 }}>Facilitated by <b style={{ color: T.text }}>{m.facilitator}</b></div>
                      {attendees.length > 0 && (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "nowrap", overflowX: "auto" }}>
                          <span style={{ fontSize: 10, color: T.text2 }}>Attendees:</span>
                          {attendees.slice(0, 5).map((name, i) => <Avatar key={i} name={name} size={20} users={users} />)}
                          {attendees.length > 5 && <span style={{ fontSize: 10, color: T.text2 }}>+{attendees.length - 5}</span>}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                      {/* Feature 4: View Plan button */}
                      <button className="btn btn-ghost btn-sm" onClick={() => setMtgPlan(m)}>📋 Plan</button>
                      {canAttend ? (
                        <button className="btn btn-green btn-sm" onClick={() => setActiveMtg(m)}>▶ Start</button>
                      ) : (
                        <button className="btn btn-ghost btn-sm" disabled title="Only listed attendees can start this meeting" style={{ opacity: .6, cursor: "not-allowed" }}>🔒 Locked</button>
                      )}
                      {canEditMeetings && <button className="btn btn-ghost btn-sm" style={{ color: T.red }} onClick={() => deleteMeeting(m)}>🗑 Delete</button>}
                    </div>
                  </div>
                </div>
              );
            })}
            {visibleMeetings.length === 0 && <div style={{ fontSize: 13, color: T.text2, fontStyle: "italic", padding: "24px 0", textAlign: "center" }}>No meetings yet. Click <b>+ Schedule</b> to create one.</div>}
          </div>

        </div>
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 15, color: T.navy, display: "flex", alignItems: "center", gap: 8 }}>
              🗂 Active Projects
              <span style={{ background: T.amber + "20", color: T.amber, borderRadius: 10, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>{visibleProjects.filter(p => p.status !== "COMPLETED").length}</span>
            </div>
            {/* Feature 3: Add New Project button - only for those with permission */}
            {canCreateProject && <button className="btn btn-amber btn-sm" onClick={() => setShowAddProject(true)}>+ Add Project</button>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleProjects.map((pr, idx) => {
              const start = new Date(pr.startDate || pr.start), end = new Date(pr.endDate || pr.end), now2 = new Date();
              const ms = Array.isArray(pr.milestones) ? pr.milestones : [];
              const done = ms.filter(m => m.done).length;
              const total = ms.length;
              const milestonePct = total > 0 ? Math.round(done / total * 100) : 0;
              const isOverdueProject = now2 > end && pr.status !== "COMPLETED";
              const barColor = pr.status === "COMPLETED" ? T.green : isOverdueProject ? T.red : milestonePct >= 66 ? T.green : milestonePct >= 33 ? T.amber : T.red;
              const projMeetings = (allMeetings || []).filter(m => m.project === pr.name);
              return (
                <div key={pr.id || `proj-${idx}`} className="card card-hover" style={{ padding: 18, borderLeft: `4px solid ${pr.priority === "CRITICAL" ? T.red : pr.priority === "WARNING" ? T.amber : T.navy}`, cursor: "pointer" }} onClick={() => setCharter(pr)}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: T.text }}>{pr.name}</div>
                      <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{pr.plant} · <b style={{ color: T.text }}>{pr.owner}</b></div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <PBadge p={pr.priority} />
                      {(isAdmin || user?.name === pr.owner || user?.name === pr.sponsor) && (
                        <button className="btn btn-ghost btn-sm" style={{ color: T.red, padding: "3px 8px" }} onClick={ev => { ev.stopPropagation(); deleteProject(pr); }}>🗑</button>
                      )}
                    </div>
                  </div>
                  {/* Feature 5: Milestones directly clickable/editable */}
                  <div style={{ marginBottom: 10 }}>
                    {ms.slice(0, 3).map((m, i) => {
                      const isOwner = user?.name === pr.owner || user?.name === pr.sponsor || isAdmin;
                      return (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }} onClick={ev => { ev.stopPropagation(); if (isOwner) { const updated = { ...pr, milestones: ms.map((x, idx) => idx === i ? { ...x, done: !x.done } : x) }; setProjects(p => p.map(x => x.id === updated.id ? updated : x)); onProjectUpdate(updated); } }}>
                          <span style={{ width: 16, height: 16, borderRadius: "50%", background: m.done ? T.green : T.border, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", flexShrink: 0, cursor: isOwner ? "pointer" : "default", border: `1.5px solid ${m.done ? T.green : T.border}`, transition: "all .2s" }}>{m.done ? "✓" : ""}</span>
                          <span style={{ fontSize: 11, color: m.done ? T.text2 : T.text, textDecoration: m.done ? "line-through" : "none", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</span>
                          <span style={{ fontSize: 10, color: T.text2, flexShrink: 0 }}>{fmt(m.due)}</span>
                        </div>
                      );
                    })}
                    {ms.length > 3 && <div style={{ fontSize: 10, color: T.text2, paddingLeft: 24 }}>+{ms.length - 3} more milestones</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <div style={{ background: T.border, borderRadius: 6, height: 6, flex: 1, overflow: "hidden" }}><div style={{ height: "100%", borderRadius: 6, width: `${milestonePct}%`, background: barColor, transition: "width .6s" }} /></div>
                    <span style={{ fontSize: 11, fontWeight: 700, color: barColor, minWidth: 36 }}>{milestonePct}%</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: T.text2 }}>
                    <span>{fmt(pr.startDate || pr.start)} → {fmt(pr.endDate || pr.end)}</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <span>{done}/{ms.length} milestones</span>
                      {projMeetings.length > 0 && <span>· {projMeetings.length} meeting{projMeetings.length !== 1 ? "s" : ""}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Weekly Schedule: combined belt + scheduled days, with day drill-down showing meeting details & actions ── */}
      <div style={{ marginTop: 24 }}>
        <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 15, color: T.navy, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
          📆 Weekly Schedule
        </div>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
            {buildWeekBelt(visibleMeetings, actions).map(day => {
              const beltColor = day.color === "green" ? T.green : day.color === "amber" ? T.amber : day.color === "red" ? T.red : null;
              const bg = beltColor ? beltColor + "18" : "#F5F5FB";
              const border = beltColor ? beltColor : T.border;
              const isSelected = day.dateStr === selectedBeltDay;
              return (
                <div key={day.dateStr} onClick={() => setSelectedBeltDay(day.dateStr)}
                  title={`${day.dayName} ${day.dayNum} — ${day.hasSession ? day.count + " action(s), " + day.done + " done" : "no meeting"}`}
                  style={{ flex: "1 0 0", minWidth: 64, borderRadius: 10, border: `1.5px solid ${isSelected ? T.navy : border}`, boxShadow: isSelected ? `0 0 0 2px ${T.navy}30` : "none", background: bg, padding: "10px 6px", textAlign: "center", position: "relative", cursor: "pointer", transition: "all .15s" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: day.isToday ? T.navy : T.text2, textTransform: "uppercase", letterSpacing: .3 }}>{day.dayName}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: T.text, lineHeight: 1.1, margin: "2px 0 6px" }}>{day.dayNum}</div>
                  {day.hasSession || day.count > 0 ? (
                    <>
                      <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 18, fontWeight: 800, color: beltColor || T.text2 }}>{day.count}</div>
                      <div style={{ fontSize: 9, color: T.text2, fontWeight: 600 }}>{day.done === day.count && day.count > 0 ? "All done" : day.done + " done"}</div>
                    </>
                  ) : (
                    <div style={{ fontSize: 9, color: T.text2, fontWeight: 600, marginTop: 6 }}>—</div>
                  )}
                  {beltColor && <div style={{ position: "absolute", top: 6, right: 6, width: 9, height: 9, borderRadius: "50%", background: beltColor }} />}
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 10, color: T.text2 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: T.green }} /> All completed</span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: T.amber }} /> Partial</span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: T.red }} /> None done</span>
          </div>

          {/* ── Selected day drill-down: meetings scheduled that day + actions created on each meeting ── */}
          {(() => {
            const beltDays = buildWeekBelt(visibleMeetings, actions);
            const selDay = beltDays.find(d => d.dateStr === selectedBeltDay) || beltDays.find(d => d.isToday);
            if (!selDay) return null;
            const dayMeetings = visibleMeetings.filter(m => ensureArray(m.scheduledDays).includes(selDay.dayName));
            return (
              <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.navy, marginBottom: 10 }}>
                  {selDay.dayName} {selDay.dayNum}{selDay.isToday ? " · Today" : ""} — Scheduled Meetings
                  <span style={{ marginLeft: 8, background: T.navy + "15", color: T.navy, borderRadius: 10, padding: "1px 8px", fontSize: 10, fontWeight: 700 }}>{dayMeetings.length}</span>
                </div>
                {dayMeetings.length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic" }}>No meetings scheduled on this day.</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {dayMeetings.map((m, i) => {
                    const mtgActions = (actions || []).filter(a => a.srcId ? a.srcId === m.id : a.src === m.type);
                    const doneCount = mtgActions.filter(a => a.status === "COMPLETED" || a.status === "DROPPED").length;
                    return (
                      <div key={m.id || `dm-${i}`} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 14 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "nowrap", overflowX: "auto" }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13, color: T.navy, cursor: "pointer", textDecoration: "underline", textDecorationStyle: "dotted" }} onClick={() => setMtgPlan(m)}>{m.name || m.type}</div>
                            <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{m.time} · {m.plant} · Facilitated by <b style={{ color: T.text }}>{m.facilitator}</b></div>
                          </div>
                          <div style={{ display: "flex", gap: 4, flexWrap: "nowrap", overflowX: "auto" }}>
                            {ensureArray(m.scheduledDays).map(d => <span key={d} style={{ padding: "2px 8px", borderRadius: 6, background: d === selDay.dayName ? T.navy : T.navy + "15", color: d === selDay.dayName ? "#fff" : T.navy, fontSize: 10, fontWeight: 700 }}>{d}</span>)}
                          </div>
                        </div>
                        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${T.border}` }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .3, marginBottom: 6 }}>
                            Actions created ({mtgActions.length}{mtgActions.length > 0 ? ` · ${doneCount} done` : ""})
                          </div>
                          {mtgActions.length === 0 ? (
                            <div style={{ fontSize: 11, color: T.text2, fontStyle: "italic" }}>No actions created from this meeting yet.</div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                              {mtgActions.slice(0, 4).map((a, ai) => (
                                <div key={a.id || `ma-${ai}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                                  <span style={{ fontSize: 11, color: T.text, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.sn ? `${a.sn} — ` : ""}{a.text}</span>
                                  <SBadge s={a.status} />
                                </div>
                              ))}
                              {mtgActions.length > 4 && <div style={{ fontSize: 10, color: T.text2 }}>+{mtgActions.length - 4} more</div>}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── Completed Meeting Dashboard ── */}
      <CompletedMeetingDashboard meetings={visibleMeetings} actions={actions} users={users} user={user} plants={plants} />

      {/* ── Weekly Meeting Accountability ── */}
      <WeeklyMeetingAccountability meetings={visibleMeetings} actions={actions} users={users} user={user} plants={plants} machines={machines} selectedDay={selectedBeltDay} onActionUpdate={(id, patch) => { setActions(p => p.map(a => a.id !== id ? a : { ...a, ...patch })); apiUpdate("actions", id, patch); }} />

      {charter && <ProjectCharterModal pr={charter} onClose={() => { setCharter(null); setCharterActionSel(null); }} actions={actions} meetings={meetings} user={user} users={users} onProjectUpdate={updated => { setProjects(p => p.map(x => x.id === updated.id ? updated : x)); if (charter && charter.id === updated.id) setCharter(updated); onProjectUpdate(updated); }} onActionSelect={a => setCharterActionSel(a)} />}
      {charterActionSel && <ActionDetailPanel action={charterActionSel} onClose={() => setCharterActionSel(null)} onUpdate={(id, patch) => { setActions(p => p.map(a => a.id !== id ? a : { ...a, ...patch })); apiUpdate("actions", id, patch); setCharterActionSel(p => p ? { ...p, ...patch } : p); }} user={user} users={users} allUsers={users} plants={plants} machines={machines} meetings={meetings} />}
      {showAddMtg && <AddMeetingModal plants={plants} users={users} projects={projects} onSave={m => { const mtg = { ...m, id: "M" + Date.now(), completedSessions: [] }; setMeetings(p => [...p, mtg]); apiCreate("meetings", resolveRecordIds(mtg, plants, depts, machines, projects)); setShowAddMtg(false); }} onClose={() => setShowAddMtg(false)} currentUser={user} />}
      {/* Feature 3: Add Project Modal */}
      {showAddProject && <AddProjectModal plants={plants} users={users} onSave={p => { const pName = {}; plants.forEach(pl => pName[pl.id] = pl.name); const pr = { ...p, plant: pName[p.plantId] || p.plantId, id: "PR" + Date.now(), milestones: [], risks: [], team: [], budget: p.budget ? Number(p.budget) || 0 : 0 }; setProjects(prev => [...prev, pr]); apiCreate("projects", pr); showAddProject && setShowAddProject(false); }} onClose={() => setShowAddProject(false)} currentUser={user} />}
      {/* Feature 4: Meeting Plan Side Panel */}
      {mtgPlan && <MeetingPlanPanel key={mtgPlan.id} mtg={mtgPlan} canEdit={canEditMeetings} projects={projects} users={users} plants={plants} onSave={updated => { setMeetings(p => p.map(m => m.id === updated.id ? updated : m)); setMtgPlan(updated); apiUpdate("meetings", updated.id, resolveRecordIds(updated, plants, depts, machines, projects)); }} onClose={() => setMtgPlan(null)} mtgPresets={mtgPresets} currentUser={user} />}
    </div>
  );
}

/* Feature 3: Add Project Modal */
function AddProjectModal({ plants, users, onSave, onClose, currentUser }) {
  useEscClose(onClose);
  const [f, setF] = useState({ name: "", plantId: "", owner: "", startDate: "", endDate: "", priority: "NORMAL", status: "NOT STARTED", objective: "", scope: "", budget: "", sponsor: "" });
  const up = (k, v) => setF(x => ({ ...x, [k]: v }));
  const valid = f.name && f.plantId && f.owner && f.startDate && f.endDate;
  const submit = () => { if (valid) onSave(f); };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 540, padding: 28 }} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); submit(); } }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>Create New Project</h2>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>×</button>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <div><Lbl t="Project Name" req /><input value={f.name} onChange={e => up("name", e.target.value)} placeholder="e.g. Safety Drive Q3" /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Plant" req /><select value={f.plantId} onChange={e => up("plantId", e.target.value)}><option value="">Select</option><option value="All">All</option>{scopedPlants(currentUser, plants).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
            <div><Lbl t="Priority" /><select value={f.priority} onChange={e => up("priority", e.target.value)}>{PRIORITY_LIST.map(p => <option key={p}>{p}</option>)}</select></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Owner" req /><select value={f.owner} onChange={e => up("owner", e.target.value)}><option value="">Select</option>{scopedUsers(currentUser, users).map(u => <option key={u.id} value={u.name}>{u.name}</option>)}</select></div>
            <div><Lbl t="Sponsor" /><select value={f.sponsor} onChange={e => up("sponsor", e.target.value)}><option value="">Select</option>{scopedUsers(currentUser, users).map(u => <option key={u.id} value={u.name}>{u.name}</option>)}</select></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Start Date" req /><input type="date" value={f.startDate} onChange={e => up("startDate", e.target.value)} /></div>
            <div><Lbl t="End Date" req /><input type="date" value={f.endDate} onChange={e => up("endDate", e.target.value)} /></div>
          </div>
          <div><Lbl t="Budget" /><input value={f.budget} onChange={e => up("budget", e.target.value)} placeholder="INR 0,00,000" /></div>
          <div><Lbl t="Objective" /><textarea value={f.objective} onChange={e => up("objective", e.target.value)} style={{ height: 64, resize: "none" }} /></div>
          <div><Lbl t="Scope" /><textarea value={f.scope} onChange={e => up("scope", e.target.value)} style={{ height: 64, resize: "none" }} /></div>
        </div>
        <div style={{ marginTop: 20, display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-navy" onClick={submit} disabled={!valid}>Create Project</button>
        </div>
      </div>
    </div>
  );
}

/* Feature 4: Meeting Plan Side Panel */
function MeetingPlanPanel({ mtg, canEdit, projects, users, plants, onSave, onClose, mtgPresets, currentUser }) {
  useEscClose(onClose);
  const [editMode, setEditMode] = useState(false);
  const defaultInstructions = ensureArray(mtgPresets?.instructions?.[mtg.type] || ["Follow meeting agenda", "Capture all action points", "Assign clear owners and due dates", "Confirm previous actions before closing"]);
  const defaultAttendees = ensureArray(mtgPresets?.attendeeMap?.[mtg.type]);
  const [draft, setDraft] = useState({
    ...mtg,
    name: mtg.name || mtg.type || "",
    guidelines: ensureArray(mtg.guidelines || defaultInstructions),
    attendees: ensureArray(mtg.attendees || defaultAttendees),
  });
  const up = (k, v) => setDraft(x => ({ ...x, [k]: v }));
  const guidelines = draft.guidelines;
  const attendees = draft.attendees;
  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 340 }} onClick={onClose} />
      <div className="side-panel" style={{ width: 520, padding: 0 }}>
        <div style={{ background: `linear-gradient(135deg,${T.navy},#3D378C)`, padding: "20px 24px", color: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 10, opacity: .6, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Meeting Plan</div>
              {editMode
                ? <input value={draft.name || draft.type || ""} onChange={e => up("name", e.target.value)} placeholder="Meeting name" style={{ fontFamily: "'Sora',sans-serif", fontSize: 17, fontWeight: 800, color: "#fff", background: "rgba(255,255,255,.15)", border: "1px solid rgba(255,255,255,.4)", borderRadius: 8, padding: "4px 10px", width: "100%", marginBottom: 4 }} />
                : <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 17, fontWeight: 800, marginBottom: 4 }}>{mtg.name || mtg.type}</h2>}
              <div style={{ fontSize: 12, opacity: .8 }}>{mtg.plant} · {mtg.time} · {mtg.dur}min</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {canEdit && !editMode && <button onClick={() => setEditMode(true)} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>✏ Edit</button>}
              {editMode && <><button onClick={() => { onSave(draft); setEditMode(false); }} style={{ background: T.green, border: "none", color: "#fff", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button><button onClick={() => { setDraft({ ...mtg, guidelines: mtg.guidelines || [...defaultInstructions], attendees: mtg.attendees || [...defaultAttendees] }); setEditMode(false); }} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 8, padding: "5px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Cancel</button></>}
              <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", border: "none", color: "#fff", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
            </div>
          </div>
        </div>
        <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            {[{ l: "Type", k: "type", opts: MEETING_TYPES, type: "select" }, { l: "Facilitator", k: "facilitator", type: "userselect" }, { l: "Time", k: "time", type: "time" }, { l: "Duration (min)", k: "dur", type: "number" }].map(({ l, k, opts, type }) => (
              <div key={k}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginBottom: 4 }}>{l}</div>
                {editMode
                  ? type === "select" ? <select value={draft[k]} onChange={e => up(k, e.target.value)}>{opts.map(o => <option key={o}>{o}</option>)}</select>
                    : type === "userselect" ? <select value={draft[k]} onChange={e => up(k, e.target.value)}>{scopedUsers(currentUser, users).map(u => <option key={u.id} value={u.name}>{u.name}</option>)}</select>
                      : <input type={type || "text"} value={draft[k]} onChange={e => up(k, e.target.value)} />
                  : <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{mtg[k]}</div>
                }
              </div>
            ))}
          </div>
          {editMode && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginBottom: 4 }}>Linked Project</div>
              <select value={draft.project || ""} onChange={e => up("project", e.target.value || null)}><option value="">None</option>{projects.map(p => <option key={p.id}>{p.name}</option>)}</select>
            </div>
          )}
          {(mtg.scheduledDays && mtg.scheduledDays.length > 0) || editMode ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginBottom: 4 }}>Scheduled Days</div>
              {editMode
                ? <div style={{ display: "flex", gap: 5, flexWrap: "nowrap", overflowX: "auto" }}>
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => {
                    const days = ensureArray(draft.scheduledDays || []);
                    const active = days.includes(d);
                    return <button key={d} onClick={() => up("scheduledDays", active ? days.filter(x => x !== d) : [...days, d])} style={{ padding: "4px 10px", borderRadius: 6, border: `1.5px solid ${active ? T.navy : T.border}`, background: active ? T.navy : "transparent", color: active ? "#fff" : T.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{d}</button>;
                  })}
                </div>
                : <div style={{ display: "flex", gap: 5, flexWrap: "nowrap", overflowX: "auto" }}>{ensureArray(mtg.scheduledDays || []).map(d => <span key={d} style={{ padding: "3px 10px", borderRadius: 6, background: T.navy + "15", color: T.navy, fontSize: 11, fontWeight: 600 }}>{d}</span>)}</div>
              }
            </div>
          ) : null}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.navy }}>📌 Meeting Guidelines</div>
              {editMode && <button onClick={() => up("guidelines", [...guidelines, ""])} style={{ fontSize: 11, background: T.navy, color: "#fff", border: "none", borderRadius: 6, padding: "2px 10px", cursor: "pointer" }}>+ Add</button>}
            </div>
            {editMode
              ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {guidelines.map((g, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ color: T.text2, fontSize: 12, minWidth: 18 }}>{i + 1}.</span>
                    <input value={g} onChange={e => up("guidelines", guidelines.map((x, idx) => idx === i ? e.target.value : x))} style={{ flex: 1, fontSize: 12, padding: "5px 8px" }} />
                    <button onClick={() => up("guidelines", guidelines.filter((_, idx) => idx !== i))} style={{ background: "transparent", border: "none", cursor: "pointer", color: T.red, fontSize: 16, lineHeight: 1, padding: "0 4px" }}>×</button>
                  </div>
                ))}
                {guidelines.length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic" }}>No guidelines — click + Add</div>}
              </div>
              : <ol style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 8 }}>
                {guidelines.map((s, i) => <li key={i} style={{ fontSize: 12, color: T.text, lineHeight: 1.5 }}>{s}</li>)}
                {guidelines.length === 0 && <li style={{ fontSize: 12, color: T.text2, fontStyle: "italic", listStyle: "none" }}>No guidelines added yet</li>}
              </ol>
            }
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.navy }}>👥 Expected Attendees</div>
              {editMode && <select defaultValue="" onChange={e => { const v = e.target.value; if (v && !attendees.includes(v)) up("attendees", [...attendees, v]) }}>
                <option value="" disabled>+ Add person</option>
                {scopedUsers(currentUser, users).filter(u => !attendees.includes(u.name)).map(u => <option key={u.id} value={u.name}>{u.name} ({u.role})</option>)}
              </select>}
            </div>
            <div style={{ display: "flex", flexWrap: "nowrap", overflowX: "auto", gap: 8 }}>
              {attendees.map((name, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, background: T.bg, borderRadius: 8, padding: "5px 10px" }}>
                  <Avatar name={name} size={22} users={users || []} /><span style={{ fontSize: 12 }}>{name}</span>
                  {editMode && <button onClick={() => up("attendees", attendees.filter((_, idx) => idx !== i))} style={{ background: "transparent", border: "none", cursor: "pointer", color: T.red, fontSize: 14, lineHeight: 1, padding: "0 2px", marginLeft: 2 }}>×</button>}
                </div>
              ))}
              {attendees.length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic" }}>No attendees added</div>}
            </div>
          </div>
          {(mtg.completedSessions || []).length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.navy, marginBottom: 8 }}>📊 Past Sessions</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(mtg.completedSessions || []).map((s, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", background: T.bg, borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
                    <span>{fmt(s.date)}</span><span style={{ fontWeight: 600, color: T.navy }}>{s.duration} min</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ── COMPLETED MEETING DASHBOARD ── */
function CompletedMeetingDashboard({ meetings, actions, users, user, plants }) {
  const isAdmin = isUserAdmin(user);
  const [dashFilter, setDashFilter] = useState("all");
  const [dashSearch, setDashSearch] = useState("");

  // Flatten all completed sessions with their parent meeting data
  const allSessions = (meetings || []).flatMap(m =>
    (Array.isArray(m.completedSessions) ? m.completedSessions : []).map(s => ({
      ...m,
      sessionDate: s.date,
      sessionDur: s.duration || 0,
      sessionActionCount: s.actionCount || 0,
    }))
  ).filter(s => canAccessMeeting(user, s, null));

  // Enrich sessions with actual action counts from the actions table
  const enrichedSessions = allSessions.map(s => {
    const matchedActions = (actions || []).filter(a => {
      const matchType = s.id ? (a.srcId === s.id || (!a.srcId && a.src === s.type)) : a.src === s.type;
      const matchDate = s.sessionDate ? (a.dateOfAction === s.sessionDate || a.created === s.sessionDate) : true;
      return matchType && matchDate;
    });
    return { ...s, liveActionCount: matchedActions.length, matchedActions };
  });

  // Filter & search
  const filtered = enrichedSessions
    .filter(s => {
      if (dashSearch) {
        const q = dashSearch.toLowerCase();
        return (s.type || "").toLowerCase().includes(q) || (s.plant || "").toLowerCase().includes(q) || (s.facilitator || "").toLowerCase().includes(q);
      }
      if (dashFilter === "week") {
        const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
        return s.sessionDate && new Date(s.sessionDate) >= weekAgo;
      }
      if (dashFilter === "month") {
        const monthAgo = new Date(); monthAgo.setMonth(monthAgo.getMonth() - 1);
        return s.sessionDate && new Date(s.sessionDate) >= monthAgo;
      }
      return true;
    })
    .sort((a, b) => (b.sessionDate || "").localeCompare(a.sessionDate || ""));

  // Summary stats
  const totalSessions = filtered.length;
  const totalMinutes = filtered.reduce((sum, s) => sum + (s.sessionDur || 0), 0);
  const totalActions = filtered.reduce((sum, s) => sum + (s.liveActionCount || s.sessionActionCount || 0), 0);
  const avgDuration = totalSessions > 0 ? Math.round(totalMinutes / totalSessions) : 0;
  const uniquePlants = [...new Set(filtered.map(s => s.plant).filter(Boolean))];
  const uniqueFacilitators = [...new Set(filtered.map(s => s.facilitator).filter(Boolean))];

  // Per-meeting-type breakdown
  const typeBreakdown = {};
  filtered.forEach(s => {
    if (!typeBreakdown[s.type]) typeBreakdown[s.type] = { count: 0, totalMin: 0, totalActions: 0 };
    typeBreakdown[s.type].count++;
    typeBreakdown[s.type].totalMin += s.sessionDur || 0;
    typeBreakdown[s.type].totalActions += s.liveActionCount || s.sessionActionCount || 0;
  });

  if (allSessions.length === 0) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 16, color: T.navy, display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        ✅ Completed Meeting Dashboard
        <span style={{ background: T.green + "18", color: T.green, borderRadius: 10, padding: "3px 12px", fontSize: 11, fontWeight: 700 }}>{totalSessions} sessions</span>
      </div>

      {/* KPI Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 20 }}>
        {[
          { label: "Total Sessions", value: totalSessions, icon: "📊", color: T.navy },
          { label: "Total Duration", value: totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m` : `${totalMinutes}m`, icon: "⏱", color: T.amber },
          { label: "Actions Generated", value: totalActions, icon: "⚡", color: T.green },
          { label: "Avg Duration", value: `${avgDuration}m`, icon: "📈", color: T.slate },
        ].map(k => (
          <div key={k.label} style={{ background: k.color + "08", border: `1.5px solid ${k.color}25`, borderRadius: 12, padding: "14px 16px", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 22 }}>{k.icon}</div>
            <div>
              <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 20, fontWeight: 800, color: k.color }}>{k.value}</div>
              <div style={{ fontSize: 10, color: T.text2, textTransform: "uppercase", letterSpacing: .4, marginTop: 2 }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters & Search */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "nowrap", overflowX: "auto" }}>
        <input value={dashSearch} onChange={e => setDashSearch(e.target.value)} placeholder="🔍 Search meetings…" style={{ width: 220, fontSize: 12, padding: "6px 12px", border: `1px solid ${T.border}`, borderRadius: 8, outline: "none" }} />
        {[
          { v: "all", l: "All Time" },
          { v: "week", l: "Last 7 Days" },
          { v: "month", l: "Last 30 Days" },
        ].map(o => (
          <button key={o.v} onClick={() => setDashFilter(o.v)} style={{ padding: "5px 14px", borderRadius: 8, border: `1.5px solid ${dashFilter === o.v ? T.navy : T.border}`, background: dashFilter === o.v ? T.navy : "transparent", color: dashFilter === o.v ? "#fff" : T.text, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{o.l}</button>
        ))}
        <div style={{ marginLeft: "auto", fontSize: 11, color: T.text2 }}>
          {uniquePlants.length} plant{uniquePlants.length !== 1 ? "s" : ""} · {uniqueFacilitators.length} facilitator{uniqueFacilitators.length !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Type Breakdown Cards */}
      {Object.keys(typeBreakdown).length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "nowrap", overflowX: "auto", marginBottom: 20 }}>
          {Object.entries(typeBreakdown).sort((a, b) => b[1].count - a[1].count).map(([type, data]) => (
            <div key={type} className="card" style={{ padding: "10px 16px", minWidth: 160, borderLeft: `4px solid ${T.navy}` }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: T.navy, marginBottom: 4 }}>{type}</div>
              <div style={{ fontSize: 11, color: T.text2 }}>{data.count} sessions · {data.totalMin}m · {data.totalActions} actions</div>
            </div>
          ))}
        </div>
      )}

      {/* Sessions Table */}
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.bg }}>
                <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Meeting</th>
                <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Plant</th>
                <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Facilitator</th>
                <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Date</th>
                <th style={{ textAlign: "center", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Duration</th>
                <th style={{ textAlign: "center", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Actions</th>
                <th style={{ textAlign: "center", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Attendees</th>
                <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5 }}>Project</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s, i) => {
                const attendees = ensureArray(s.attendees || []);
                return (
                  <tr key={`${s.id}_${i}`} style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "#fff" : T.bg + "60" }}>
                    <td style={{ padding: "10px 14px", fontWeight: 600, color: T.navy }}>{s.type}</td>
                    <td style={{ padding: "10px 14px" }}><Chip label={s.plant} color={T.navy} /></td>
                    <td style={{ padding: "10px 14px", color: T.text }}>{s.facilitator}</td>
                    <td style={{ padding: "10px 14px", color: T.text2 }}>{fmt(s.sessionDate)}</td>
                    <td style={{ padding: "10px 14px", textAlign: "center", fontWeight: 600 }}>{s.sessionDur}m</td>
                    <td style={{ padding: "10px 14px", textAlign: "center" }}>
                      <span style={{ background: T.green + "18", color: T.green, borderRadius: 8, padding: "2px 10px", fontWeight: 700, fontSize: 11 }}>{s.liveActionCount || s.sessionActionCount || 0}</span>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", gap: 2, flexWrap: "nowrap", overflowX: "auto" }}>
                        {attendees.slice(0, 3).map((name, j) => <Avatar key={j} name={name} size={18} users={users} />)}
                        {attendees.length > 3 && <span style={{ fontSize: 10, color: T.text2 }}>+{attendees.length - 3}</span>}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px", color: T.amber, fontWeight: 600 }}>{s.project || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding: 30, textAlign: "center", color: T.text2, fontSize: 13 }}>No completed meetings match your filters.</div>
        )}
      </div>
    </div>
  );
}

/* ===================== WEEKLY MEETING ACCOUNTABILITY ===================== */
function WeeklyMeetingAccountability({ meetings, actions, users, user, plants, machines, selectedDay, onActionUpdate }) {
  const accessibleMeetings = (meetings || []).filter(m => canAccessMeeting(user, m, null));

  const sessions = accessibleMeetings
    .flatMap(m => (Array.isArray(m.completedSessions) ? m.completedSessions : [])
      .filter(s => selectedDay ? s.date === selectedDay : true)
      .map(s => ({ ...s, meeting: m }))
    );

  const getActionsFor = (session, meeting) => (actions || []).filter(a => {
    const matchMtg = meeting.id ? a.srcId === meeting.id : (!a.srcId && a.src === meeting.type);
    const matchDate = a.dateOfAction === session.date || a.created === session.date;
    return matchMtg && matchDate;
  });

  const [sessionPopup, setSessionPopup] = useState(null);
  const [actionDetail, setActionDetail] = useState(null);

  const thStyle = { padding: "10px 14px", fontWeight: 700, color: T.text2, fontSize: 10, textTransform: "uppercase", letterSpacing: .5, whiteSpace: "nowrap", textAlign: "left" };

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 15, color: T.navy, display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        📊 Weekly Meeting Accountability
        {selectedDay && <span style={{ background: T.navy + "15", color: T.navy, borderRadius: 10, padding: "3px 12px", fontSize: 11, fontWeight: 700 }}>{selectedDay}</span>}
      </div>
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: T.bg }}>
                <th style={thStyle}>Meeting ID</th>
                <th style={thStyle}>Meeting Name</th>
                <th style={thStyle}>Meeting Attendees</th>
                <th style={thStyle}>Actions Generated</th>
                <th style={thStyle}>Facilitator Name</th>
                <th style={thStyle}>Meeting Type</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: "32px 20px", textAlign: "center", color: T.text2, fontSize: 12 }}>
                  {selectedDay ? `No meeting sessions found on ${selectedDay}.` : "Select a day from the Weekly Schedule above."}
                </td></tr>
              ) : sessions.map((s, i) => {
                const m = s.meeting;
                const mtgActions = getActionsFor(s, m);
                const attendees = ensureArray(s.attendees || []);
                return (
                  <tr key={m.id + s.date || `wma-${i}`}
                    onClick={() => setSessionPopup({ session: s, meeting: m, actions: mtgActions })}
                    style={{ borderTop: `1px solid ${T.border}`, background: i % 2 === 0 ? "#fff" : T.bg + "60", cursor: "pointer", transition: "background .15s" }}
                    onMouseEnter={e => e.currentTarget.style.background = T.navy + "08"}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#fff" : T.bg + "60"}
                  >
                    <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 11, color: T.text2 }}>{m.id || "—"}</td>
                    <td style={{ padding: "10px 14px", fontWeight: 600, color: T.navy }}>{m.name || m.type}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <div style={{ display: "flex", gap: 3, flexWrap: "nowrap", overflowX: "auto" }}>
                        {attendees.slice(0, 5).map((name, j) => <Avatar key={j} name={name} size={22} users={users} />)}
                        {attendees.length > 5 && <span style={{ fontSize: 10, color: T.text2, alignSelf: "center" }}>+{attendees.length - 5}</span>}
                        {attendees.length === 0 && <span style={{ fontSize: 11, color: T.text2 }}>—</span>}
                      </div>
                    </td>
                    <td style={{ padding: "10px 14px" }}>
                      <span style={{ background: T.green + "18", color: T.green, borderRadius: 8, padding: "2px 10px", fontWeight: 700, fontSize: 11 }}>{mtgActions.length}</span>
                    </td>
                    <td style={{ padding: "10px 14px", fontWeight: 600, fontSize: 12 }}>{s.facilitator || m.facilitator || "—"}</td>
                    <td style={{ padding: "10px 14px", color: T.text2, fontSize: 11 }}>{m.type}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Session Actions Popup ── */}
      {sessionPopup && (
        <div className="overlay" onClick={() => setSessionPopup(null)}>
          <div className="card" style={{ width: 560, maxHeight: "80vh", overflowY: "auto", padding: 28 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>{sessionPopup.meeting.name || sessionPopup.meeting.type}</div>
                <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>{sessionPopup.meeting.id} · {sessionPopup.session.date} · {sessionPopup.actions.length} action{sessionPopup.actions.length !== 1 ? "s" : ""}</div>
              </div>
              <button onClick={() => setSessionPopup(null)} style={{ background: T.navy, border: "none", cursor: "pointer", color: "#fff", borderRadius: 8, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✕</button>
            </div>
            {sessionPopup.actions.length === 0 ? (
              <div style={{ padding: "32px 20px", textAlign: "center", color: T.text2, fontSize: 13 }}>
                No actions were generated in this meeting session.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sessionPopup.actions.map((a, idx) => (
                  <div key={a.id || idx}
                    onClick={() => { setActionDetail(a); setSessionPopup(null); }}
                    style={{ background: T.bg, borderRadius: 10, padding: "12px 16px", cursor: "pointer", border: `1px solid ${T.border}`, transition: "border-color .15s" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = T.navy}
                    onMouseLeave={e => e.currentTarget.style.borderColor = T.border}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                          <span style={{ fontFamily: "monospace", fontSize: 10, color: T.text2 }}>{a.sn || a.id}</span>
                          <span style={{ fontSize: 11, padding: "1px 8px", borderRadius: 4, background: a.status === "COMPLETED" ? T.green + "18" : a.status === "IN PROCESS" ? T.amber + "18" : a.status === "DROPPED" ? T.red + "18" : T.bg, color: a.status === "COMPLETED" ? T.green : a.status === "IN PROCESS" ? T.amber : a.status === "DROPPED" ? T.red : T.text2, fontWeight: 600 }}>{a.status}</span>
                        </div>
                        <div style={{ fontWeight: 600, fontSize: 13, color: T.navy, marginBottom: 4 }}>{a.text}</div>
                        <div style={{ display: "flex", gap: 12, fontSize: 11, color: T.text2 }}>
                          <span>👤 {a.responsible || "—"}</span>
                          <span>📅 {a.due || "—"}</span>
                          {a.priority && <span style={{ color: a.priority === "CRITICAL" ? T.red : a.priority === "HIGH" ? T.amber : T.text2 }}>⚡ {a.priority}</span>}
                        </div>
                      </div>
                      <span style={{ fontSize: 16, color: T.text2, flexShrink: 0 }}>→</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Action Detail Panel ── */}
      {actionDetail && (
        <ActionDetailPanel
          action={actionDetail}
          onClose={() => setActionDetail(null)}
          onUpdate={(id, patch) => {
            setActionDetail(p => p ? { ...p, ...patch } : p);
            if (onActionUpdate) onActionUpdate(id, patch);
          }}
          user={user}
          users={users}
          allUsers={users}
          plants={plants}
          machines={machines || []}
          meetings={meetings}
        />
      )}
    </div>
  );
}

/* ADD MEETING MODAL */
function AddMeetingModal({ plants, users, projects, onSave, onClose, currentUser }) {
  useEscClose(onClose);
  const [f, setF] = useState({ name: "", type: "Custom", plant: "", time: "09:00", dur: 60, facilitator: "", recurring: false, recurrence: "daily", project: null, scheduledDays: [] });
  const [usePreset, setUsePreset] = useState(false);
  const up = (k, v) => setF(x => ({ ...x, [k]: v }));
  const FREQ_OPTS = [
    { v: "anyday", l: "Any Day", sub: "One-time meeting", icon: "📅" },
    { v: "everyday", l: "Every Day", sub: "Repeats daily", icon: "🔁" },
    { v: "selective", l: "Selective Days", sub: "Pick specific days", icon: "📆" },
  ];
  const DAY_OPTS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const freqMode = f.recurring ? (f.scheduledDays.length > 0 ? "selective" : "everyday") : "anyday";
  const setFreq = (mode) => {
    if (mode === "anyday") up("recurring", false);
    else if (mode === "everyday") { up("recurring", true); up("scheduledDays", []); }
    else { up("recurring", true); up("scheduledDays", f.scheduledDays.length ? f.scheduledDays : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]); }
  };
  const canSave = f.name.trim() && f.plant && f.facilitator && f.time && f.project;
  const submit = () => { if (canSave) onSave({ ...f, type: f.name }); };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 500, padding: 28 }} onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); submit(); } }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>Schedule New Meeting</h2>
          <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>×</button>
        </div>
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <Lbl t="Meeting Name" req />
            <input value={f.name} onChange={e => up("name", e.target.value)} placeholder="e.g. Furnace Daily Review, Safety Briefing…" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={usePreset} onChange={e => setUsePreset(e.target.checked)} id="usePreset" style={{ width: 14, cursor: "pointer" }} />
            <label htmlFor="usePreset" style={{ fontSize: 12, cursor: "pointer", color: T.text2 }}>Or choose from standard meeting types:</label>
            {usePreset && <select value={f.type} onChange={e => { up("type", e.target.value); up("name", e.target.value); }} style={{ flex: 1, fontSize: 12 }}>
              {MEETING_TYPES.map(t => <option key={t}>{t}</option>)}
            </select>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Plant" req /><select value={f.plant} onChange={e => up("plant", e.target.value)}><option value="">Select</option><option>All</option>{scopedPlants(currentUser, plants).map(p => <option key={p.id}>{p.name}</option>)}</select></div>
            <div><Lbl t="Time" req /><input type="time" value={f.time} onChange={e => up("time", e.target.value)} /></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Duration (min)" /><input type="number" value={f.dur} onChange={e => up("dur", +e.target.value)} min={15} max={360} /></div>
            <div><Lbl t="Facilitator" req /><select value={f.facilitator} onChange={e => up("facilitator", e.target.value)}><option value="">Select</option>{scopedUsers(currentUser, users).map(u => <option key={u.id} value={u.name}>{u.name}</option>)}</select></div>
          </div>
          <div>
            <Lbl t="Link to Project" req />
            <select value={f.project || ""} onChange={e => up("project", e.target.value || null)} style={{ borderColor: !f.project ? T.red : T.border }}>
              <option value="">Select project (required)…</option>
              {projects.map(p => <option key={p.id}>{p.name}</option>)}
            </select>
            {!f.project && <div style={{ fontSize: 11, color: T.red, marginTop: 3 }}>Project is required to schedule a meeting.</div>}
          </div>
          <div style={{ background: T.bg, borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.navy, marginBottom: 8 }}>Meeting Frequency</div>
            <div className="grid-3col" style={{ gap: 6 }}>
              {FREQ_OPTS.map(o => {
                const active = freqMode === o.v;
                return (
                  <button key={o.v} onClick={() => setFreq(o.v)} style={{ padding: "10px 8px", borderRadius: 8, border: `2px solid ${active ? T.navy : T.border}`, background: active ? T.navy : "#fff", color: active ? "#fff" : T.text, cursor: "pointer", textAlign: "center", transition: "all .15s" }}>
                    <div style={{ fontSize: 16, marginBottom: 4 }}>{o.icon}</div>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{o.l}</div>
                    <div style={{ fontSize: 10, opacity: .7, marginTop: 2 }}>{o.sub}</div>
                  </button>
                );
              })}
            </div>
            {freqMode === "selective" && (
              <div style={{ marginTop: 10, padding: "8px 10px", background: "#fff", borderRadius: 8, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.text2, marginBottom: 6 }}>Select days (Mon – Sat)</div>
                <div style={{ display: "flex", gap: 5, flexWrap: "nowrap", overflowX: "auto" }}>
                  {DAY_OPTS.map(d => {
                    const active = f.scheduledDays.includes(d);
                    return (
                      <button key={d} onClick={() => up("scheduledDays", active ? f.scheduledDays.filter(x => x !== d) : [...f.scheduledDays, d])} style={{ padding: "5px 10px", borderRadius: 6, border: `1.5px solid ${active ? T.navy : T.border}`, background: active ? T.navy : "transparent", color: active ? "#fff" : T.text, fontSize: 11, fontWeight: 600, cursor: "pointer", minWidth: 36 }}>
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        <div style={{ marginTop: 20, display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-navy" disabled={!canSave} style={{ opacity: canSave ? 1 : .5, cursor: canSave ? "pointer" : "not-allowed" }} onClick={submit}>Schedule</button>
        </div>
      </div>
    </div>
  );
}

/* ===================== MEETING ROOM ===================== */
function MeetingRoom({ mtg, plants, depts, users, onCommit, onCloseMeeting, onBack, prevActions, relatedActions, running, setRunning, elapsed, txLines, setTxLines, insights, setInsights, currentUser, mtgPresets, setActions, machines, reasons }) {
  // ── Defensive: default all array props to [] to prevent "Cannot read properties of undefined (reading 'filter')" ──
  const _rel = Array.isArray(relatedActions) ? relatedActions : [];
  const _tx = Array.isArray(txLines) ? txLines : [];
  const _ins = Array.isArray(insights) ? insights : [];
  const _usr = Array.isArray(users) ? users : [];
  const _plt = Array.isArray(plants) ? plants : [];
  const _dep = Array.isArray(depts) ? depts : [];
  const _rsn = Array.isArray(reasons) ? reasons : [];
  const _mch = Array.isArray(machines) ? machines : [];
  // Use safe aliases throughout; if the prop was undefined, log once for debugging
  relatedActions = _rel; txLines = _tx; insights = _ins;
  users = _usr; plants = _plt; depts = _dep; reasons = _rsn; machines = _mch;
  if (!mtg) { console.error("[MeetingRoom] mtg prop is null/undefined — aborting render"); return null; }

  const [phase, setPhase] = useState("live");
  const [selAction, setSelAction] = useState(null);
  const [mtgShowMine, setMtgShowMine] = useState(() => { try { return localStorage.getItem("mcs_mtg_showMine") === "true"; } catch { return false; } });
  const [mtgPendingSearch, setMtgPendingSearch] = useState(() => { try { return localStorage.getItem("mcs_mtg_pendingSearch") || ""; } catch { return ""; } });
  const [mtgFilters, setMtgFilters] = useState(() => { try { const s = localStorage.getItem("mcs_mtg_filters"); return s ? JSON.parse(s) : {}; } catch { return {}; } });
  const [mtgActionView, setMtgActionView] = useState(() => { try { return localStorage.getItem("mcs_mtg_actionView") || "table"; } catch { return "table"; } });
  const [exitConfirm, setExitConfirm] = useState(false);
  const [sttStatus, setSttStatus] = useState("idle"); // idle | listening | error | unsupported
  const [sttInterim, setSttInterim] = useState("");
  const [analyzingPara, setAnalyzingPara] = useState(false);
  const [sttLang, setSttLang] = useState("hi-IN"); // "en-IN" or "hi-IN" — hi-IN works better for Hinglish/Indian accents
  const [translating, setTranslating] = useState(false);
  const [apiLimitPopup, setApiLimitPopup] = useState(null); // null | "translate" | "insights"
  // Separate fail counters so translate failures don't block Gemini insights
  const translateFailRef = useRef(0);
  const analyzeFailRef = useRef(0);
  // Increased from 3 to 5 — Render cold-start can eat 2-3 timeouts before warming up
  const API_FAIL_LIMIT = 5;
  const apiFailCountRef = analyzeFailRef; // alias kept for any other usages
  useEffect(() => { try { localStorage.setItem("mcs_mtg_showMine", String(mtgShowMine)); } catch {} }, [mtgShowMine]);
  useEffect(() => { try { if (mtgPendingSearch) localStorage.setItem("mcs_mtg_pendingSearch", mtgPendingSearch); else localStorage.removeItem("mcs_mtg_pendingSearch"); } catch {} }, [mtgPendingSearch]);
  useEffect(() => { try { localStorage.setItem("mcs_mtg_filters", JSON.stringify(mtgFilters)); } catch {} }, [mtgFilters]);
  useEffect(() => { try { localStorage.setItem("mcs_mtg_actionView", mtgActionView); } catch {} }, [mtgActionView]);

  const txRef = useRef(null);
  const insightsRef = useRef(null);
  const recognitionRef = useRef(null);
  const paraBufferRef = useRef(""); // accumulates words between silences
  // 2-minute batch analysis refs
  const batchTimerRef = useRef(null);
  const lastAnalyzedCharCountRef = useRef(0); // tracks total chars of txLines already analyzed
  const [batchCountdown, setBatchCountdown] = useState(120); // seconds until next analysis
  const batchCountdownRef = useRef(null);
  const instructions = ensureArray(mtg.guidelines || mtgPresets?.instructions?.[mtg.type] || ["Follow meeting agenda", "Capture all action points", "Assign clear owners and due dates", "Confirm previous actions before closing"]);
  const attendees = ensureArray(mtg.attendees || mtgPresets?.attendeeMap?.[mtg.type]);

  // Auto-scroll transcript
  useEffect(() => { if (txRef.current) txRef.current.scrollTop = txRef.current.scrollHeight; }, [txLines, sttInterim]);
  // Auto-scroll insights
  useEffect(() => { if (insightsRef.current) insightsRef.current.scrollTop = insightsRef.current.scrollHeight; }, [insights]);

  const latestInsightsRef = useRef(insights);
  useEffect(() => { latestInsightsRef.current = insights; }, [insights]);

  // ── Smart Translate: Only translate if Hindi (Devanagari) text is detected ──
  const translateText = useCallback(async (rawTxt) => {
    if (!rawTxt || rawTxt.trim().length < 2) return rawTxt;

    // Detect if text contains Devanagari (Hindi script) — if yes, translate; if no, keep as-is
    const hasDevanagari = /[\u0900-\u097F]/.test(rawTxt);
    if (!hasDevanagari) {
      // Already in Roman/Latin script (English or Hinglish in Roman), no translation needed
      return rawTxt.trim();
    }

    // Back off if backend repeatedly unavailable (translate-specific counter)
    if (translateFailRef.current >= API_FAIL_LIMIT) {
      if (translateFailRef.current === API_FAIL_LIMIT) setApiLimitPopup("translate");
      return rawTxt.trim();
    }

    if (!API_BASE_URL) return rawTxt.trim();

    try {
      setTranslating(true);
      const res = await fetch(`${API_BASE_URL}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "Authorization": `Bearer ${getAuthToken() || localStorage.getItem("mcs_token") || ""}` },
        body: JSON.stringify({ text: rawTxt.trim(), source: "hi", target: "en" })
      });
      const data = await res.json();
      setTranslating(false);
      translateFailRef.current = 0; // reset on success
      return data.translated || rawTxt;
    } catch (e) { console.warn("Translation failed (backend offline?):", e); setTranslating(false); translateFailRef.current++; if (translateFailRef.current >= API_FAIL_LIMIT) setApiLimitPopup("translate"); return rawTxt; }
  }, [/* no deps */]);

  // ── Analyze a paragraph via backend Gemini ───────────────────────────────
  const analyzeParagraph = useCallback(async (para) => {
    if (!para || para.trim().length < 20) return;
    if (!API_BASE_URL) { console.warn("Insights skipped: VITE_API_BASE_URL not set in .env"); return; }
    // Back off only if Gemini/analyze endpoint itself is repeatedly failing
    if (analyzeFailRef.current >= API_FAIL_LIMIT) {
      if (analyzeFailRef.current === API_FAIL_LIMIT) setApiLimitPopup("insights");
      console.warn("Insights paused: backend analyze endpoint failed 3 times. Is the server running?");
      return;
    }
    setAnalyzingPara(true);
    try {
      const hasDevanagari = /[\u0900-\u097F]/.test(para);
      const source_lang = hasDevanagari ? "hi" : "en";

      const res = await fetch(`${API_BASE_URL}/api/meetings/analyze-paragraph`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "Authorization": `Bearer ${getAuthToken() || localStorage.getItem("mcs_token") || ""}` },
        body: JSON.stringify({
          paragraph: para.trim(),
          meeting_type: mtg.type,
          source_lang: source_lang
        })
      });
      const parsed = await res.json();
      analyzeFailRef.current = 0; // reset on success

      // Show error toast if backend signals a problem (e.g. Gemini returned garbage)
      if (parsed.error) {
        console.warn("AI insight warning:", parsed.error);
      }

      const insight = {
        id: Date.now(),
        para: para.trim(),
        ts: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
        actions: (parsed.actions || []).map((a, i) => ({ ...a, id: Date.now() + i, _staged: false })),
        decisions: parsed.decisions || [],
        risks: parsed.risks || [],
        keyPoints: parsed.keyPoints || []
      };
      setInsights(p => {
        const existingActionTexts = p.flatMap(ins => ensureArray(ins.actions).map(a => a.text.toLowerCase()));
        const newActions = insight.actions.filter(a => {
          const txt = a.text.toLowerCase();
          return !existingActionTexts.some(ext => txt.includes(ext) || ext.includes(txt));
        });
        insight.actions = newActions;
        if (insight.actions.length || insight.decisions.length || insight.risks.length || insight.keyPoints.length) {
          return [...p, insight];
        }
        return p;
      });
    } catch (e) {
      analyzeFailRef.current++;
      if (analyzeFailRef.current >= API_FAIL_LIMIT) setApiLimitPopup("insights");
      console.warn(`Insight analysis failed (attempt ${analyzeFailRef.current}/${API_FAIL_LIMIT}). Is the backend running at ${API_BASE_URL}?`, e);
    }
    setAnalyzingPara(false);
  }, [mtg.type, setInsights]);

  // ── Start Chrome STT ──────────────────────────────────────────────────────
  // hi-IN works better for Indian-accented speech and Hinglish (Hindi+English mix)
  const startSTT = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSttStatus("unsupported"); return; }
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = sttLang;
    r.maxAlternatives = 1;

    r.onstart = () => setSttStatus("listening");
    r.onerror = (e) => {
      if (e.error === "no-speech") return; // benign
      setSttStatus("error");
      console.warn("STT error:", e.error);
    };
    r.onend = () => {
      // Auto-restart if meeting still running
      if (recognitionRef.current && running) {
        try { recognitionRef.current.start(); } catch (ex) { }
      }
    };

    r.onresult = (e) => {
      let interimTxt = "", finalTxt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalTxt += t + " ";
        else interimTxt += t;
      }
      setSttInterim(interimTxt);

      if (finalTxt.trim()) {
        paraBufferRef.current += finalTxt;
        // Always run translateText — it internally detects script (Devanagari → translate, Roman → return as-is)
        const processTxt = async (rawTxt) => {
          const displayTxt = await translateText(rawTxt);
          return displayTxt;
        };

        // Process text through smart translation — display only, no per-paragraph analysis
        const rawPara = finalTxt.trim();
        processTxt(rawPara).then(processed => {
          setTxLines(p => {
            const last = p[p.length - 1] || "";
            const combined = last + (last ? " " : "") + processed;
            if (combined.length > 150 || /[.!?।]\s*$/.test(processed)) {
              return [...p.slice(0, -1), combined.trim(), ""];
            }
            return p.length === 0 ? [processed] : [...p.slice(0, -1), combined.trim()];
          });
        });
      }
    };

    recognitionRef.current = r;
    try { r.start(); } catch (ex) { setSttStatus("error"); }
  }, [running, analyzeParagraph, setTxLines, sttLang, translateText]);

  // ── Stop STT ──────────────────────────────────────────────────────────────
  const stopSTT = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null; // prevent auto-restart
      try { recognitionRef.current.stop(); } catch (ex) { }
      recognitionRef.current = null;
    }
    setSttStatus("idle");
    setSttInterim("");
    // Analyze any remaining buffer on stop
    if (paraBufferRef.current.trim().length > 10) {
      paraBufferRef.current = "";
    }
  }, []);



  // Latest txLines ref for interval access
  const txLinesRef = useRef(txLines);
  useEffect(() => { txLinesRef.current = txLines; }, [txLines]);

  useEffect(() => {
    if (!running) {
      // Stop batch timer when meeting paused
      clearInterval(batchTimerRef.current);
      clearInterval(batchCountdownRef.current);
      return;
    }
    // ── Reset all failure counters on every meeting start ──────────────────
    // Critical: analyzeFailRef persists for the lifetime of MeetingRoom.
    // If the backend failed 3× during a previous pause (e.g. Render cold-start),
    // insights would be permanently blocked without this reset.
    analyzeFailRef.current = 0;
    translateFailRef.current = 0;
    setApiLimitPopup(null); // clear any lingering "limit reached" popup

    // ── Wake the Render backend before the first 2-min interval fires ──────
    // Render free tier sleeps after inactivity. A fire-and-forget ping here
    // gives it ~30s to warm up before the first real analyze call.
    if (API_BASE_URL) {
      fetch(`${API_BASE_URL}/api/ping`, { method: "GET" }).catch(() => {});
    }

    // Reset countdown and analyzed char count
    setBatchCountdown(120);
    lastAnalyzedCharCountRef.current = 0;

    // Countdown every second
    batchCountdownRef.current = setInterval(() => {
      setBatchCountdown(c => {
        if (c <= 1) return 120; // reset after triggering
        return c - 1;
      });
    }, 1000);

    // Main 2-minute analysis interval
    batchTimerRef.current = setInterval(() => {
      const lines = txLinesRef.current || [];
      const fullText = lines.filter(l => l.trim()).join(" ").trim();
      const alreadyAnalyzed = lastAnalyzedCharCountRef.current;
      const newText = fullText.slice(alreadyAnalyzed).trim();
      if (newText.length >= 20) {
        analyzeParagraph(newText);
        lastAnalyzedCharCountRef.current = fullText.length;
      }
      setBatchCountdown(120); // reset countdown
    }, 120000); // 2 minutes

    return () => {
      clearInterval(batchTimerRef.current);
      clearInterval(batchCountdownRef.current);
    };
  }, [running, analyzeParagraph]);

  // When meeting stops, do one final analysis of remaining unanalyzed transcript
  useEffect(() => {
    if (!running && txLines.length > 0) {
      const fullText = txLines.filter(l => l.trim()).join(" ").trim();
      const alreadyAnalyzed = lastAnalyzedCharCountRef.current;
      const newText = fullText.slice(alreadyAnalyzed).trim();
      if (newText.length >= 20) {
        analyzeParagraph(newText);
        lastAnalyzedCharCountRef.current = fullText.length;
      }
    }
  }, [running]);// eslint-disable-line

  // Start/stop STT with meeting running state
  useEffect(() => {
    if (running) startSTT();
    else stopSTT();
    return () => stopSTT();
  }, [running]);// eslint-disable-line

  const hms = s => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const triggerManualAnalysis = () => {
    if (analyzingPara) return;
    const lines = txLinesRef.current || [];
    const fullText = lines.filter(l => l.trim()).join(" ").trim();
    const alreadyAnalyzed = lastAnalyzedCharCountRef.current;
    const newText = fullText.slice(alreadyAnalyzed).trim();
    if (newText.length >= 20) {
      analyzeParagraph(newText);
      lastAnalyzedCharCountRef.current = fullText.length;
      setBatchCountdown(120);
    }
  };

  const exportTranscript = () => {
    if (!txLines || txLines.length === 0) return;
    const text = txLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n");
    const blob = new Blob([`Meeting: ${mtg.type}\nLocation: ${mtg.plant}\nDate: ${new Date().toLocaleDateString()}\n\n--- TRANSCRIPT ---\n\n${text}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Transcript_${mtg.type.replace(/\s+/g, '_')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stopAndStage = () => {
    stopSTT();
    setRunning(false);
    // Gather all AI-suggested actions from insights
    const aiActions = (Array.isArray(insights) ? insights : []).flatMap(ins =>
      ensureArray(ins.actions).map((a, i) => ({
        id: Date.now() + Math.random(),
        text: a.text,
        responsible: a.responsible || null,
        priority: a.priority || "NORMAL",
        section: a.section || "General",
        src: mtg.type,
        srcId: mtg.id || null,
        plant: mtg.plant,
        status: "IN PROCESS",
        revisions: 0, revisionHistory: [],
        created: todayStr(), closedOn: null,
        dateOfAction: todayStr(),
        fromTranscript: true,
        fromInsights: true,
        project: mtg.project || null,
        messages: [], pendingConfirmation: false,
        due: ""
      }))
     );
    setPhase({ fromFast: [], txActions: aiActions });
  };

  // ── Stage action from insight card ───────────────────────────────────────
  const stageInsightAction = (insId, actId) => {
    setInsights(p => p.map(ins => ins.id === insId ? {
      ...ins,
      actions: ins.actions.map(a => a.id === actId ? { ...a, _staged: true } : a)
    } : ins));
  };

  if (phase !== "live") {
    const { fromFast, txActions } = phase;
    return <StagingArea staged={[...(fromFast || []), ...(txActions || [])]} mtg={mtg} plants={plants} depts={depts} users={users} txLines={txLines} onCommit={rows => { onCommit(rows); onCloseMeeting(); }} onCloseMeeting={onCloseMeeting} onBack={() => setPhase("live")} elapsedSecs={elapsed} currentUser={currentUser} />;
  }

  /* ── Paused Meeting Prompt ─────────────────────────────────────── */
  /* When meeting was stopped (running=false) but session data exists, 
     show Resume/Exit choice instead of jumping into live view */
  const hasSessionData = (elapsed || 0) > 0 || (Array.isArray(txLines) && txLines.filter(l => l.trim()).length > 0) || (Array.isArray(insights) && insights.length > 0);
  if (!running && hasSessionData && !exitConfirm) {
    const wordCount = txLines.join(" ").split(" ").filter(Boolean).length;
    const actionCount = (Array.isArray(insights) ? insights : []).reduce((n, ins) => n + ensureArray(ins.actions).length, 0);
    return (
      <div className="fade-in" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "70vh" }}>
        <div style={{ width: 520, textAlign: "center" }}>
          <div style={{ width: 80, height: 80, borderRadius: "50%", background: T.amber + "20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 36, margin: "0 auto 20px", border: `3px solid ${T.amber}40` }}>⏸</div>
          <h1 style={{ fontFamily: "'Sora',sans-serif", fontSize: 24, fontWeight: 800, color: T.navy, marginBottom: 8 }}>Meeting Paused</h1>
          <div style={{ fontSize: 14, color: T.text2, marginBottom: 24 }}>{mtg.type} · {mtg.plant}</div>

          {/* Session summary */}
          <div className="card" style={{ padding: 20, marginBottom: 24, textAlign: "left" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .5, marginBottom: 12 }}>Session Summary</div>
            <div className="grid-3col" style={{ gap: 14 }}>
              {[
                { icon: "⏱", label: "Duration", value: hms(elapsed || 0), color: T.navy },
                { icon: "📝", label: "Words Captured", value: wordCount, color: T.amber },
                { icon: "⚡", label: "Actions Found", value: actionCount, color: T.green },
              ].map(k => (
                <div key={k.label} style={{ textAlign: "center", padding: "10px 0", borderRadius: 10, background: k.color + "08", border: `1px solid ${k.color}20` }}>
                  <div style={{ fontSize: 20, marginBottom: 4 }}>{k.icon}</div>
                  <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 20, fontWeight: 800, color: k.color }}>{k.value}</div>
                  <div style={{ fontSize: 10, color: T.text2, marginTop: 2 }}>{k.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 16 }}>
            <button className="btn btn-navy" style={{ padding: "14px 32px", fontSize: 15, borderRadius: 12 }} onClick={() => setRunning(true)}>
              ▶ Resume Meeting
            </button>
            <button className="btn btn-amber" style={{ padding: "14px 32px", fontSize: 15, borderRadius: 12 }} onClick={stopAndStage}>
              ⏹ Stop & Review Actions
            </button>
          </div>

          {/* Exit option */}
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16, marginTop: 8 }}>
            <button onClick={() => { try { stopSTT(); } catch (e) { } onCloseMeeting && onCloseMeeting(); }} style={{ border: "none", background: "transparent", color: T.red, cursor: "pointer", fontSize: 12, fontWeight: 600, opacity: .7 }}>
              🚪 Exit without saving
            </button>
          </div>
        </div>
      </div>
    );
  }
  // Reset exitConfirm if we get back to running
  if (running && exitConfirm) setExitConfirm(false);

  const pendingRelated = (Array.isArray(relatedActions) ? relatedActions : [])
    .filter(a => a && a.status !== "DROPPED")
    .sort((a, b) => {
      const over_a = isOverdue(a) ? -1 : 0, over_b = isOverdue(b) ? -1 : 0;
      if (over_a !== over_b) return over_a - over_b;
      if (!a.due) return 1; if (!b.due) return -1;
      return new Date(a.due) - new Date(b.due);
    });
  const myPending = pendingRelated.filter(a => responsibleMatchesUsers(a.responsible, [(currentUser?.name || "").toLowerCase()]) || a.allocatedBy === currentUser?.name);
  const displayPending = mtgShowMine ? myPending : pendingRelated;

  const insightCount = insights.reduce((n, ins) => n + ensureArray(ins.actions).length + ensureArray(ins.decisions).length + ensureArray(ins.risks).length + ensureArray(ins.keyPoints).length, 0);

  return (
    <div className="fade-in">
      {/* API Limit Popup */}
      {apiLimitPopup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", borderRadius: 16, padding: "28px 32px", maxWidth: 400, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,.25)", textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>{apiLimitPopup === "translate" ? "🔇" : "🤖"}</div>
            <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 17, fontWeight: 800, color: T.red, marginBottom: 8 }}>
              {apiLimitPopup === "translate" ? "Translation Limit Reached" : "AI Insights Limit Reached"}
            </div>
            <div style={{ fontSize: 13, color: T.text2, lineHeight: 1.6, marginBottom: 20 }}>
              {apiLimitPopup === "translate"
                ? "The translation service failed 3 times and has been paused. Transcription will continue in the original language. Please check your backend server at"
                : "The AI insights service failed 3 times and has been paused. Transcription will continue without live insights. Please check your backend server at"}
              <br /><b style={{ color: T.navy }}>{API_BASE_URL || "localhost:8000"}</b>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
              <button className="btn btn-ghost" onClick={() => {
                if (apiLimitPopup === "translate") translateFailRef.current = 0;
                else analyzeFailRef.current = 0;
                setApiLimitPopup(null);
              }} style={{ fontSize: 13 }}>🔄 Retry</button>
              <button className="btn btn-navy" onClick={() => setApiLimitPopup(null)} style={{ fontSize: 13 }}>Dismiss</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "nowrap", overflowX: "auto", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back</button>
          <div>
            <h1 style={{ fontFamily: "'Sora',sans-serif", fontSize: 20, fontWeight: 800, color: T.navy }}>{mtg.type}</h1>
            <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>{mtg.plant} · {mtg.time} · Facilitator: <b>{mtg.facilitator}</b>{mtg.project && <> · <b style={{ color: T.amber }}>{mtg.project}</b></>}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* STT Status pill + language indicator */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 20, background: sttStatus === "listening" ? "#D5F5E3" : sttStatus === "error" ? "#FADBD8" : sttStatus === "unsupported" ? "#FEF3CD" : "#F0F0F8", fontSize: 11, fontWeight: 600, color: sttStatus === "listening" ? T.green : sttStatus === "error" ? T.red : sttStatus === "unsupported" ? T.amber : T.slate }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: sttStatus === "listening" ? "#27AE60" : sttStatus === "error" ? "#C0392B" : sttStatus === "unsupported" ? "#E69903" : "#95A5A6", animation: sttStatus === "listening" ? "blink 1s infinite" : "none", flexShrink: 0 }} />
            {sttStatus === "listening" && "🎙 Listening"}
            {sttStatus === "idle" && "⏸ Mic off"}
            {sttStatus === "error" && "⚠ Mic error"}
            {sttStatus === "unsupported" && "⚠ STT not supported"}
          </div>
          {/* Language badge */}
          <div style={{ fontSize: 10, fontWeight: 700, background: sttLang === "hi-IN" ? T.amber : "#E8E8F0", color: sttLang === "hi-IN" ? T.navy : T.text2, padding: "3px 9px", borderRadius: 12, border: `1px solid ${sttLang === "hi-IN" ? T.amber + "60" : T.border}` }}>
            {sttLang === "hi-IN" ? "🇮🇳 Hinglish Mode" : "EN Mode"}
          </div>
          {/* Language toggle — hi-IN recommended for Hinglish/Indian-accented speech */}
          <div style={{ display: "flex", background: T.border, borderRadius: 8, padding: 2, gap: 0 }}>
            <button onClick={() => { if (!running) setSttLang("en-IN"); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: running ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 700, background: sttLang === "en-IN" ? T.navy : "transparent", color: sttLang === "en-IN" ? "#fff" : T.text2, transition: "all .15s", opacity: running ? .6 : 1 }} title={running ? "Stop meeting to switch language" : "English only (pure English)"}>EN</button>
            <button onClick={() => { if (!running) setSttLang("hi-IN"); }} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: running ? "not-allowed" : "pointer", fontSize: 11, fontWeight: 700, background: sttLang === "hi-IN" ? T.navy : "transparent", color: sttLang === "hi-IN" ? "#fff" : T.text2, transition: "all .15s", opacity: running ? .6 : 1 }} title={running ? "Stop meeting to switch language" : "Hinglish: Hindi+English mix, Indian accent"}>🇮🇳 HI/EN</button>
          </div>
          {translating && <span style={{ fontSize: 10, color: T.amber, fontWeight: 600, animation: "blink 1s infinite" }}>🔄 Translating…</span>}
          <div style={{ background: running ? T.red : "#636E72", color: "#fff", borderRadius: 10, padding: "8px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#fff", flexShrink: 0, animation: running ? "blink 1s infinite" : "none" }} />
            <span style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 800, letterSpacing: 2 }}>{hms(elapsed || 0)}</span>
            {running && <span style={{ fontSize: 9, opacity: .8, fontWeight: 700, letterSpacing: 1 }}>LIVE</span>}
          </div>
          <button className="btn btn-red" style={{ fontWeight: 700 }} onClick={stopAndStage}>⏹ Stop & Review</button>
          <button onClick={() => { try { stopSTT(); } catch (e) { } onCloseMeeting && onCloseMeeting(); }} style={{ border: `1.5px solid ${T.red}`, background: "transparent", color: T.red, borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 12, fontWeight: 700 }} title="Exit meeting immediately">🚪 Exit</button>
        </div>
      </div>

      {/* Pending Actions table — clean Actions Register style ribbon */}
      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
        {/* Header bar */}
        <div style={{ padding: "12px 16px", borderBottom: `1.5px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", flexWrap: "nowrap", overflowX: "auto", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: T.navy }}>📋 {mtg.type} — Action Points</span>
            {insights.flatMap(i => ensureArray(i.actions)).length > 0 && (
              <span style={{ background: T.amber + "20", color: T.amber, border: `1px solid ${T.amber}40`, borderRadius: 10, padding: "2px 10px", fontSize: 10, fontWeight: 700 }}>
                +{insights.flatMap(i => ensureArray(i.actions)).length} from this meeting
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", overflowX: "auto" }}>
            <span style={{ fontSize: 11, color: T.text2 }}>{mtgShowMine ? myPending.length : pendingRelated.length} existing</span>
            {/* All / Mine toggle */}
            <div style={{ display: "flex", background: T.bg, borderRadius: 8, padding: 3, border: `1.5px solid ${T.border}` }}>
              <button onClick={() => setMtgShowMine(false)} style={{ padding: "4px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: !mtgShowMine ? T.navy : "transparent", color: !mtgShowMine ? "#fff" : T.text2, transition: "all .18s" }}>All</button>
              <button onClick={() => setMtgShowMine(true)} style={{ padding: "4px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: mtgShowMine ? T.navy : "transparent", color: mtgShowMine ? "#fff" : T.text2, transition: "all .18s" }}>Mine</button>
            </div>
            {/* View toggle — matches Actions Register */}
            <div style={{ display: "flex", gap: 3, borderLeft: `1px solid ${T.border}`, paddingLeft: 8 }}>
              {[
                { v: "table", icon: "☰", l: "Table" },
                { v: "board", icon: "⊞", l: "Board" },
                { v: "kanban", icon: "▦", l: "Kanban" },
                { v: "timeline", icon: "━", l: "Timeline" },
              ].map(x => (
                <button key={x.v} onClick={() => setMtgActionView(x.v)}
                  style={{ padding: "4px 11px", borderRadius: 7, border: `1.5px solid ${mtgActionView === x.v ? T.navy : T.border}`, background: mtgActionView === x.v ? T.navy : "transparent", color: mtgActionView === x.v ? "#fff" : T.text2, fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4, transition: "all .15s" }}>
                  {x.icon} {x.l}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Filter ribbon — matches Actions Register style */}
        <div className="filter-bar" style={{ padding: "10px 16px", background: "#fff", borderBottom: `1px solid ${T.border}`, alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <input
              value={mtgPendingSearch || ""}
              onChange={e => setMtgPendingSearch && setMtgPendingSearch(e.target.value)}
              placeholder="🔍 Search actions…"
              style={{ width: 180, fontSize: 12, padding: "5px 10px", border: `1px solid ${T.border}`, borderRadius: 6, outline: "none", fontFamily: "inherit" }}
            />
          </div>
          {[
            { label: "STATUS", key: "mtgStatus", opts: STATUS_LIST },
            { label: "PRIORITY", key: "mtgPriority", opts: PRIORITY_LIST },
            { label: "DEPT", key: "mtgSection", opts: scopedDepts(currentUser, depts).map(d => d.name) },
          ].map(({ label, key, opts }) => (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4 }}>{label}</span>
              <select
                value={(mtgFilters || {})[key] || ""}
                onChange={e => setMtgFilters && setMtgFilters(f => ({ ...f, [key]: e.target.value }))}
                style={{ fontSize: 12, padding: "5px 10px", border: `1px solid ${T.border}`, borderRadius: 6, background: "#fff", color: T.text, minWidth: 110, fontFamily: "inherit" }}
              >
                <option value="">{label === "STATUS" ? "All" : label === "PRIORITY" ? "All" : "All"}</option>
                {opts.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
          {(Object.values(mtgFilters || {}).some(v => v) || mtgPendingSearch) && (
            <button
              onClick={() => { setMtgFilters && setMtgFilters({}); setMtgPendingSearch && setMtgPendingSearch(""); }}
              style={{ alignSelf: "flex-end", fontSize: 12, padding: "5px 14px", background: "transparent", border: `1px solid ${T.border}`, borderRadius: 6, color: T.text2, cursor: "pointer", fontFamily: "inherit" }}
            >✕ Clear</button>
          )}
          <div style={{ marginLeft: "auto", alignSelf: "flex-end", fontSize: 12, color: T.text2, fontWeight: 500 }}>
            {pendingRelated.length}/{pendingRelated.length} shown
          </div>
        </div>
        {/* AI-identified actions from current meeting */}
        {insights.flatMap(ins => ensureArray(ins.actions)).length > 0 && (
          <div style={{ padding: "10px 18px", background: T.amber + "10", borderBottom: `1.5px solid ${T.amber}30` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.amber, marginBottom: 6, textTransform: "uppercase", letterSpacing: .4 }}>⚡ Discussed in This Meeting (AI-Identified)</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {insights.flatMap(ins => ensureArray(ins.actions)).filter((a, idx, arr) => arr.findIndex(x => x.text === a.text) === idx).map((a, i) => (
                <div key={a.id || i} style={{ display: "flex", alignItems: "flex-start", gap: 8, background: a._staged ? T.greenL : "#fff", borderRadius: 7, padding: "6px 10px", border: `1px solid ${a._staged ? T.green + "50" : T.amber + "40"}` }}>
                  <span style={{ fontSize: 11, color: T.amber, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>•</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: T.text }}>{a.text}</div>
                    {a.responsible && <div style={{ fontSize: 10, color: T.text2, marginTop: 1 }}>→ {a.responsible}</div>}
                  </div>
                  <PBadge p={a.priority || "NORMAL"} />
                  {a._staged && <span style={{ fontSize: 10, color: T.green, fontWeight: 700, whiteSpace: "nowrap" }}>✓ Staged</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {(() => {
          const filteredPending = displayPending.filter(a => {
            if (mtgPendingSearch && ![a.text, a.responsible, a.sn].join(" ").toLowerCase().includes((mtgPendingSearch || "").toLowerCase())) return false;
            if ((mtgFilters || {}).mtgStatus && a.status !== mtgFilters.mtgStatus) return false;
            if ((mtgFilters || {}).mtgPriority && a.priority !== mtgFilters.mtgPriority) return false;
            if ((mtgFilters || {}).mtgSection && a.section !== mtgFilters.mtgSection) return false;
            return true;
          });
          const mtgUpStatus = (id, status) => {
            if (!setActions) return;
            setActions(prev => prev.map(a => String(a.id) === String(id)
              ? { ...a, status, closedOn: status === "COMPLETED" ? todayStr() : null, pendingConfirmation: false }
              : a
            ));
            apiUpdate("actions", id, { status, closedOn: status === "COMPLETED" ? todayStr() : null, pendingConfirmation: false });
          };
          const mtgUpAction = (id, patch) => {
            if (!setActions) return;
            setActions(prev => prev.map(a => String(a.id) === String(id) ? { ...a, ...patch } : a));
            apiUpdate("actions", id, patch);
          };
          const canDrag = !!setActions;
          if (filteredPending.length === 0) return (
            <div style={{ padding: "14px 18px", fontSize: 12, color: T.text2 }}>No pending actions linked to this meeting type or project.</div>
          );
          if (mtgActionView === "table") return (
            <div style={{ maxHeight: 280, overflowY: "auto" }}>
              <TableView fa={filteredPending} upStatus={mtgUpStatus} setSel={a => setSelAction(a)} canEdit={canDrag} upAction={mtgUpAction} users={users} />
            </div>
          );
          if (mtgActionView === "board") return (
            <div style={{ maxHeight: 340, overflowY: "auto", padding: 12 }}>
              <BoardView fa={filteredPending} setSel={a => setSelAction(a)} users={users} />
            </div>
          );
          if (mtgActionView === "kanban") return (
            <div style={{ padding: 12, overflowX: "auto" }}>
              <KanbanView fa={filteredPending} upStatus={mtgUpStatus} canEdit={canDrag} users={users} setSel={a => setSelAction(a)} />
            </div>
          );
          if (mtgActionView === "timeline") return (
            <div style={{ maxHeight: 340, overflowY: "auto", padding: 12 }}>
              <TimelineView fa={filteredPending} />
            </div>
          );
          return null;
        })()}
      </div>

      {/* 3-col: Transcript | Insights | Guidelines */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 320px", gap: 14 }}>

        {/* Live Transcript */}
        <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: T.navy }}>🎙 Live Transcript</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button className="btn btn-ghost"
                onClick={exportTranscript}
                disabled={!txLines || txLines.length === 0}
                style={{ padding: "2px 8px", fontSize: 10, height: 22, borderColor: T.border }}>
                📥 Export
              </button>
              {analyzingPara && <span style={{ fontSize: 10, color: T.amber, fontWeight: 600, animation: "blink 1s infinite" }}>⚡ Analyzing…</span>}
              {running && sttStatus === "listening" && <span style={{ fontSize: 10, color: T.green, fontWeight: 600 }}>● REC</span>}
            </div>
          </div>
          <div ref={txRef} style={{ background: T.bg, borderRadius: 8, padding: 12, flex: 1, minHeight: 240, maxHeight: 360, overflowY: "auto", fontSize: 12, lineHeight: 2, color: "#444" }}>
            {txLines.length === 0 && !sttInterim
              ? <span style={{ color: "#B2BEC3" }}>{sttStatus === "unsupported" ? "Chrome STT not supported. Actions will be captured via AI insights." : "Microphone ready. Start speaking — transcript appears here in real time."}</span>
              : <>
                {txLines.filter(l => l.trim()).map((l, i) => (
                  <div key={i} style={{ padding: "3px 0", borderBottom: i < txLines.length - 1 ? `1px solid ${T.border}` : "", display: "flex", gap: 8 }}>
                    <span style={{ color: T.text2, fontSize: 10, flexShrink: 0, marginTop: 3 }}>{String(i + 1).padStart(2, "0")}</span>
                    <span style={{ color: l.toLowerCase().includes("action") || l.toLowerCase().includes(" to ") ? T.navy : T.text }}>{l}</span>
                  </div>
                ))}
                {sttInterim && (
                  <div style={{ padding: "3px 0", opacity: .5, fontStyle: "italic", display: "flex", gap: 8 }}>
                    <span style={{ color: T.text2, fontSize: 10, flexShrink: 0, marginTop: 3 }}>…</span>
                    <span>{sttInterim}</span>
                  </div>
                )}
              </>
            }
          </div>
          <div style={{ fontSize: 10, color: T.text2, textAlign: "center" }}>
            {txLines.filter(l => l.trim()).length} paragraphs · {txLines.join(" ").split(" ").filter(Boolean).length} words
          </div>
        </div>

        {/* AI Insights Panel */}
        <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: T.navy }}>⚡ AI Insights</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button className="btn btn-navy btn-sm"
                onClick={triggerManualAnalysis}
                disabled={analyzingPara || !running || (txLines.filter(l => l.trim()).join(" ").trim().slice(lastAnalyzedCharCountRef.current).trim().length < 20)}
                style={{ padding: "2px 8px", fontSize: 10, height: 22 }}>
                {analyzingPara ? <Spin /> : "🧠 Get Insights"}
              </button>
              {insightCount > 0 && <span style={{ background: T.navy, color: "#fff", borderRadius: 20, padding: "1px 8px", fontSize: 10, fontWeight: 700 }}>{insightCount}</span>}
              {analyzingPara && <span style={{ width: 12, height: 12, border: "2px solid #E69903", borderTopColor: "transparent", borderRadius: "50%", display: "inline-block", animation: "spin .7s linear infinite" }} />}
            </div>
          </div>
          {/* 2-min countdown bar */}
          {running && (
            <div style={{ background: T.bg, borderRadius: 8, padding: "8px 12px", border: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .5 }}>Next AI Analysis</span>
                  <span style={{ fontSize: 11, fontWeight: 800, fontFamily: "monospace", color: batchCountdown <= 10 ? T.red : batchCountdown <= 30 ? T.amber : T.navy }}>
                    {Math.floor(batchCountdown / 60)}:{String(batchCountdown % 60).padStart(2, "0")}
                  </span>
                </div>
                <div style={{ background: T.border, borderRadius: 4, height: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", borderRadius: 4, background: batchCountdown <= 10 ? T.red : batchCountdown <= 30 ? T.amber : `linear-gradient(90deg,${T.navy},${T.amber})`, width: `${((120 - batchCountdown) / 120) * 100}%`, transition: "width 1s linear" }} />
                </div>
              </div>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: batchCountdown <= 10 ? T.red + "15" : T.navy + "10", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0, animation: batchCountdown <= 10 ? "blink 1s infinite" : "none" }}>
                🧠
              </div>
            </div>
          )}
          <div ref={insightsRef} style={{ flex: 1, minHeight: 240, maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            {insights.length === 0
              ? <div style={{ textAlign: "center", padding: "32px 12px", color: T.text2 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🧠</div>
                <div style={{ fontSize: 12, fontWeight: 600 }}>AI insights appear here</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>Transcript is analyzed every <b>2 minutes</b> for action items, decisions, and risks.</div>
              </div>
              : insights.map(ins => (
                <div key={ins.id} style={{ background: T.bg, borderRadius: 10, padding: 12, border: `1px solid ${T.border}`, animation: "fadeIn .4s ease" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ fontSize: 10, color: T.text2, fontWeight: 600 }}>🕐 {ins.ts}</div>
                    <span style={{ fontSize: 9, background: T.navy + "15", color: T.navy, padding: "1px 7px", borderRadius: 10, fontWeight: 700 }}>2-min batch</span>
                  </div>
                   <div style={{ fontSize: 11, color: "#555", fontStyle: "italic", marginBottom: 8, lineHeight: 1.5, borderLeft: `2px solid ${T.amber}`, paddingLeft: 8 }}>"{(ins.para || "").slice(0, 200)}{(ins.para || "").length > 200 ? "…" : ""}"</div>
                  {ensureArray(ins.actions).length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.navy, marginBottom: 4, textTransform: "uppercase", letterSpacing: .5 }}>Actions</div>
                      {ensureArray(ins.actions).map(a => (
                        <div key={a.id} style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4, background: a._staged ? "#D5F5E3" : "#fff", borderRadius: 6, padding: "5px 8px", border: `1px solid ${a._staged ? T.green + "40" : T.border}` }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 11, fontWeight: 500, color: T.text }}>{a.text}</div>
                            {a.responsible && <div style={{ fontSize: 10, color: T.text2, marginTop: 1 }}>→ {a.responsible}</div>}
                          </div>
                          <PBadge p={a.priority || "NORMAL"} />
                          {a._staged
                            ? <span style={{ fontSize: 10, color: T.green, fontWeight: 700, whiteSpace: "nowrap" }}>✓ Staged</span>
                            : <button onClick={() => stageInsightAction(ins.id, a.id)} style={{ border: `1px solid ${T.navy}`, borderRadius: 5, background: T.navy, color: "#fff", cursor: "pointer", fontSize: 10, fontWeight: 700, padding: "2px 7px", whiteSpace: "nowrap" }}>+ Add</button>
                          }
                        </div>
                      ))}
                    </div>
                  )}
                  {ensureArray(ins.decisions).length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.green, marginBottom: 3, textTransform: "uppercase", letterSpacing: .5 }}>✅ Decisions</div>
                      {ensureArray(ins.decisions).map((d, i) => <div key={i} style={{ fontSize: 11, color: T.text, padding: "2px 0", paddingLeft: 8, borderLeft: `2px solid ${T.green}` }}>{d}</div>)}
                    </div>
                  )}
                  {ensureArray(ins.risks).length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.red, marginBottom: 3, textTransform: "uppercase", letterSpacing: .5 }}>⚠ Risks</div>
                      {ensureArray(ins.risks).map((r, i) => <div key={i} style={{ fontSize: 11, color: T.text, padding: "2px 0", paddingLeft: 8, borderLeft: `2px solid ${T.red}` }}>{r}</div>)}
                    </div>
                  )}
                  {ensureArray(ins.keyPoints).length > 0 && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: T.slate, marginBottom: 3, textTransform: "uppercase", letterSpacing: .5 }}>💡 Key Points</div>
                      {ensureArray(ins.keyPoints).map((k, i) => <div key={i} style={{ fontSize: 11, color: T.text, padding: "2px 0", paddingLeft: 8, borderLeft: `2px solid ${T.slate}` }}>{k}</div>)}
                    </div>
                  )}
                </div>
              ))
            }
          </div>
          <div style={{ fontSize: 10, color: T.text2, textAlign: "center" }}>
            {insights.length} batch{insights.length !== 1 ? "es" : ""} analyzed · {insights.reduce((n, i) => n + ensureArray(i.actions).length, 0)} actions found
          </div>
        </div>

        {/* Guidelines */}
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: T.navy, marginBottom: 8 }}>📌 Meeting Guidelines</div>
          <ol style={{ paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, margin: 0, marginBottom: 12 }}>
            {instructions.map((s, i) => <li key={i} style={{ fontSize: 12, color: T.text, lineHeight: 1.5 }}>{s}</li>)}
          </ol>
          {attendees.length > 0 && <>
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 11, color: T.navy, marginBottom: 5 }}>Expected Attendees</div>
              <div style={{ display: "flex", flexWrap: "nowrap", overflowX: "auto", gap: 5 }}>
                {attendees.map((name, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, background: T.bg, borderRadius: 6, padding: "2px 7px" }}>
                    <Avatar name={name} size={16} users={users} /><span style={{ fontSize: 11 }}>{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </>}
          {/* ── Exit Meeting Section ── */}
          <div style={{ borderTop: `1.5px solid ${T.red}30`, marginTop: 16, paddingTop: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 11, color: T.red, marginBottom: 8, textTransform: "uppercase", letterSpacing: .5 }}>🚪 Exit Meeting</div>
            <div style={{ fontSize: 11, color: T.text2, marginBottom: 10, lineHeight: 1.5 }}>Leave this meeting without saving any actions. Use <b>Stop & Review</b> above to save your work first.</div>
            <button onClick={() => { try { stopSTT(); } catch (e) { } onCloseMeeting && onCloseMeeting(); }} className="btn btn-ghost btn-sm" style={{ width: "100%", justifyContent: "center", color: T.red, borderColor: T.red + "50" }}>Exit Meeting</button>
          </div>
        </div>
      </div>

      {selAction && <ActionDetailPanel action={selAction} onClose={() => setSelAction(null)} onUpdate={() => { }} user={currentUser} users={users} allUsers={users} plants={plants} machines={machines} />}
    </div>
  );
}

/* ADD ACTION SIDE PANEL */
function AddActionPanel({ users, plants, depts, defaultPlant, defaultSrc, defaultMeeting, defaultProject, projects, meetings, onSave, onClose, currentUser, machines, reasons: reasonsProp, saving }) {
  useEscClose(onClose);
  const panelRef = React.useRef(null);
  const todayDate = todayStr();
  const [f, setF] = useState({ text: "", responsible: "", due: todayDate, section: currentUser?.dept || "General", plant: defaultPlant || (currentUser?.plant && currentUser.plant !== "All" ? currentUser.plant : ""), src: defaultSrc || "", priority: "NORMAL", remarks: "", project: defaultProject || "", meeting: defaultMeeting || "", reasonOfAction: "", machineName: "", actionPointType: "" });
  const [pendingFiles, setPendingFiles] = useState([]);
  // Meetings that the current user can see (admin sees all, others only visible plants)
  const meetingOpts = (meetings || []).filter(m => canAccessMeeting(currentUser, m, null)).map(m => ({ id: m.id, label: `${m.type}${m.plant ? " · " + m.plant : ""}${m.project ? " · " + m.project : ""}` }));
  // Derive reason suggestions from the reasons state passed in (loaded at app boot)
  const reasonSuggestions = (reasonsProp || []).map(r => r.reason || r.Reason || r.text || r.Text || Object.values(r)[0]).filter(Boolean);
  const up = (k, v) => setF(x => ({ ...x, [k]: v }));
  const machineOpts = (machines || []).filter(m => !f.plant || !m.plant || m.plant === f.plant).map(m => m.name).filter(Boolean);
  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 340 }} onClick={onClose} />
      <div className="side-panel" ref={panelRef} style={{ width: 420, padding: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>Log Action Point</h2>
          <button onClick={onClose} style={{ background: T.navy, border: "none", cursor: "pointer", fontSize: 16, color: "#fff", borderRadius: 8, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✕</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div><Lbl t="Action Point Type" req /><select value={f.actionPointType} onChange={e => up("actionPointType", e.target.value)}><option value="">Select type…</option>{["Corrective Action","Preventive Action","Improvement","Safety","Maintenance","Quality","Compliance","Other","Others"].map(t => <option key={t} value={t}>{t}</option>)}{f.actionPointType && !["Corrective Action","Preventive Action","Improvement","Safety","Maintenance","Quality","Compliance","Other","Others"].includes(f.actionPointType) && <option value={f.actionPointType}>{f.actionPointType}</option>}</select></div>
          <div><Lbl t="Action Point" req /><textarea value={f.text} onChange={e => up("text", e.target.value)} style={{ height: 72, resize: "none" }} placeholder="Describe the action…" /></div>
          {/* Attachments — uploaded on save */}
          <div>
            <Lbl t="Attachments" />
            {pendingFiles.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                {pendingFiles.map((pf, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, background: T.bg, borderRadius: 8, padding: "7px 12px", border: `1px solid ${T.border}` }}>
                    <span style={{ fontSize: 14 }}>{pf.file.type?.includes("pdf") ? "📄" : pf.file.type?.includes("image") ? "🖼" : pf.file.type?.includes("sheet") || pf.file.type?.includes("excel") ? "📊" : pf.file.type?.includes("word") || pf.file.type?.includes("document") ? "📝" : "📁"}</span>
                    <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pf.file.name}</span>
                    <button onClick={() => setPendingFiles(p => p.filter((_, i) => i !== idx))} style={{ background: "none", border: "none", cursor: "pointer", color: T.text2, fontSize: 14, padding: 2 }}>×</button>
                  </div>
                ))}
              </div>
            )}
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: `1.5px dashed ${T.border}`, cursor: "pointer", fontSize: 12, color: T.text2, background: "#fff", transition: "border-color .15s, background .15s" }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = T.navy; e.currentTarget.style.background = T.bg; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "#fff"; }}
            >
              <span style={{ fontSize: 14 }}>+</span> Attach File
              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.csv,.doc,.docx" style={{ display: "none" }} onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 5 * 1024 * 1024) { alert("File size exceeds 5 MB limit."); return; }
                setPendingFiles(p => [...p, { file }]);
                e.target.value = "";
              }} />
            </label>
          </div>
          <div><Lbl t="Responsible Person(s)" req /><MultiUserSelect value={f.responsible} users={users.filter(u => { if (f.plant && f.plant !== "All") return !u.plant || u.plant === "All" || u.plant === f.plant; if (!isUserAdmin(currentUser) && currentUser?.plant && currentUser.plant !== "All") return !u.plant || u.plant === "All" || u.plant === currentUser.plant; return true; })} onChange={v => { up("responsible", v); const firstName = (v || "").split(",").map(s => s.trim()).filter(Boolean)[0]; if (firstName) { const u = users.find(x => x.name === firstName); if (u) { if (u.plant) up("plant", u.plant); if (u.dept) up("section", u.dept); } } }} /></div>
          <div><Lbl t="Due Date" req /><input type="date" value={f.due} onChange={e => up("due", e.target.value)} /></div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Department" /><select value={f.section} onChange={e => up("section", e.target.value)}><option value="General">General</option>{scopedDepts(currentUser, depts).filter(d => !f.plant || f.plant === "All" || !d.plant || d.plant === "All Plants" || d.plant === f.plant).map(d => <option key={d.id} value={d.name}>{d.name}</option>)}{SECTIONS.filter(s => s !== "General" && !scopedDepts(currentUser, depts).filter(d => !f.plant || f.plant === "All" || !d.plant || d.plant === "All Plants" || d.plant === f.plant).find(d => d.name === s)).map(s => <option key={s}>{s}</option>)}</select></div>
            <div><Lbl t="Plant" /><select value={f.plant} onChange={e => { up("plant", e.target.value); up("section", "General"); up("machineName", ""); }}>{scopedPlants(currentUser, plants).map(p => <option key={p.id}>{p.name}</option>)}</select></div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Priority" /><select value={f.priority} onChange={e => up("priority", e.target.value)}>{PRIORITY_LIST.map(p => <option key={p}>{p}</option>)}</select></div>
            {projects && <div><Lbl t="Link to Project" /><select value={f.project} onChange={e => up("project", e.target.value)}><option value="">None</option>{projects.map(p => <option key={p.id}>{p.name}</option>)}</select></div>}
          </div>
          {(projects || meetings) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {meetings && <div><Lbl t="Link to Meeting" /><select value={f.meeting} onChange={e => {
                const mid = e.target.value;
                up("meeting", mid);
                const selMtg = (meetings || []).find(m => m.id === mid);
                if (selMtg && selMtg.project) {
                  const projMatch = (projects || []).find(p => p.name === selMtg.project);
                  up("project", projMatch ? projMatch.name : selMtg.project);
                }
              }}><option value="">None</option>{meetingOpts.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></div>}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div><Lbl t="Machine Name" /><select value={f.machineName} onChange={e => up("machineName", e.target.value)}><option value="">Select machine…</option>{machineOpts.map(m => <option key={m} value={m}>{m}</option>)}{f.machineName && !machineOpts.includes(f.machineName) && <option value={f.machineName}>{f.machineName}</option>}</select></div>
            <div><Lbl t="Remarks" /><input value={f.remarks} onChange={e => up("remarks", e.target.value)} placeholder="Optional notes…" /></div>
          </div>
        </div>
        <div style={{ marginTop: 20, display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1, justifyContent: "center" }} onClick={onClose}>Cancel</button>
          <button className="btn btn-navy" style={{ flex: 2, justifyContent: "center" }} onClick={() => {
            if (!(f.text.trim() && f.responsible && f.due)) return;
            const linkedMtg = (meetings || []).find(m => m.id === f.meeting);
            const enriched = { ...f };
            if (linkedMtg) { enriched.srcId = linkedMtg.id; enriched.src = linkedMtg.type; }
            onSave(enriched, pendingFiles);
          }} disabled={saving}>
            {saving ? <><Spin /> Saving…</> : "Save Action"}
          </button>
        </div>
      </div>
    </>
  );
}

/* STAGING AREA */
function StagingArea({ staged, mtg, plants, depts, users, txLines, onCommit, onCloseMeeting, onBack, elapsedSecs, currentUser }) {
  const [draft, setDraft] = useState(() => staged.map((r, i) => ({ ...r, stageSN: "STG-" + String(i + 1).padStart(3, "0"), status: "IN PROCESS", priority: r.priority || "NORMAL", section: r.section || "General", plant: r.plant || mtg.plant })));
  const [analyzingSmart, setAnalyzingSmart] = useState(false);
  const [smartResult, setSmartResult] = useState(null);
  const [committing, setCommitting] = useState(false);

  const up = (id, k, v) => setDraft(d => d.map(r => r.id === id ? { ...r, [k]: v } : r));
  const del = id => setDraft(d => d.filter(r => r.id !== id));
  // "valid" = has text + responsible + due — shown as ready
  const valid = draft.filter(r => r.text?.trim() && r.responsible && r.due);
  // All actions with text get committed; missing responsible/due become UNASSIGNED
  const commitAll = () => {
    if (committing) return;
    setCommitting(true);
    const all = draft.filter(r => r.text?.trim()).map((r, i) => {
      const isComplete = !!(r.responsible && r.due);
      return {
        ...r, id: String(Date.now() + i), dateOfAction: todayStr(), revisions: 0, revisionHistory: [], created: todayStr(), closedOn: null, pendingConfirmation: false,
        responsible: r.responsible || null,
        due: r.due || null,
        status: isComplete ? "IN PROCESS" : "NOT STARTED",
        allocatedBy: r.allocatedBy || null
      };
    });
    onCommit(all);
  };
  const exportTranscript = () => {
    if (!txLines || txLines.length === 0) return;
    const text = txLines.map((l, i) => `${i + 1}. ${l}`).join("\n\n");
    const blob = new Blob([`Meeting: ${mtg.type}\nLocation: ${mtg.plant}\nDate: ${new Date().toLocaleDateString()}\n\n--- TRANSCRIPT ---\n\n${text}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Transcript_${mtg.type.replace(/\s+/g, '_')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const hms = s => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const runSmartSync = async () => {
    if (!txLines || txLines.length === 0) return;
    if (!API_BASE_URL) return;
    setAnalyzingSmart(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/meetings/extract-insights`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "Authorization": `Bearer ${getAuthToken() || localStorage.getItem("mcs_token") || ""}` },
        body: JSON.stringify({
          transcript: txLines.join("\n"),
          meeting_type: mtg.type,
          plant: mtg.plant,
          previous_actions: []
        })
      });
      const data = await res.json();
      if (data.actions) {
        setSmartResult(data);
      }
    } catch (e) { console.error("Smart Sync failed", e); }
    setAnalyzingSmart(false);
  };

  const applySmartActions = () => {
    if (!smartResult) return;
    const next = smartResult.actions.map((a, i) => ({
      ...a,
      id: Date.now() + i,
      stageSN: "SMART-" + String(i + 1).padStart(3, "0"),
      status: "IN PROCESS",
      fromTranscript: true,
      fromSmart: true
    }));
    setDraft(next);
  };
  return (
    <div className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "nowrap", overflowX: "auto" }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Back to Meeting</button>
        <div>
          <h1 style={{ fontFamily: "'Sora',sans-serif", fontSize: 20, fontWeight: 800, color: T.navy }}>Review & Commit Actions</h1>
          <div style={{ fontSize: 12, color: T.text2 }}>{mtg.type} · Duration: {hms(elapsedSecs || 0)} · <b style={{ color: T.green }}>{valid.length} ready</b> · {draft.length - valid.length} incomplete (will be saved as Unassigned)</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn btn-navy" onClick={runSmartSync} disabled={analyzingSmart || !txLines?.length}>
            {analyzingSmart ? <Spin /> : "🧠 Smart Sync (Deduplicate)"}
          </button>
          <button className="btn btn-ghost" onClick={exportTranscript} disabled={!txLines || txLines.length === 0} style={{ border: `1px solid ${T.border}` }}>
            📥 Export Transcript
          </button>
          <button className="btn btn-green" onClick={commitAll} disabled={committing || draft.filter(r => r.text?.trim()).length === 0}>
            {committing ? <><Spin /> Committing…</> : <>✓ Commit {draft.filter(r => r.text?.trim()).length} Action{draft.filter(r => r.text?.trim()).length !== 1 ? "s" : ""}</>}
          </button>
        </div>
      </div>
      {/* Info banner about unassigned */}
      {draft.length > valid.length && draft.filter(r => r.text?.trim()).length > 0 && (
        <div style={{ background: "#FFF8E1", border: `1px solid ${T.amber}30`, borderRadius: 8, padding: "8px 14px", marginBottom: 14, fontSize: 12, color: "#7A5A00" }}>
          ⚠ <b>{draft.filter(r => r.text?.trim() && (!r.responsible || !r.due)).length}</b> action(s) missing responsible / due date will be committed with status <b>UNASSIGNED</b> in the action tracker.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 20 }}>
        <div className="card" style={{ padding: 20, height: "fit-content" }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: T.navy, marginBottom: 10 }}>📝 Discussed Points</div>

          {smartResult && (
            <div style={{ marginBottom: 16, padding: 12, background: T.bg, borderRadius: 10, border: `1px solid ${T.navy}30` }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: T.navy, textTransform: "uppercase", marginBottom: 8 }}>📌 Key Topics (AI)</div>
              {smartResult.topics?.map((t, idx) => (
                <div key={idx} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{t.topic}</div>
                  <div style={{ fontSize: 11, color: T.text2, lineHeight: 1.4 }}>{t.summary}</div>
                </div>
              ))}
              <button className="btn btn-navy btn-sm" style={{ width: "100%", marginTop: 8 }} onClick={applySmartActions}>
                Apply AI Deduplication
              </button>
            </div>
          )}

          <div style={{ fontSize: 12, lineHeight: 1.9, color: "#555" }}>
            {txLines.map((l, i) => <div key={i} style={{ padding: "4px 0", borderBottom: `1px solid ${T.border}`, display: "flex", gap: 8 }}><span style={{ color: T.text2, fontSize: 10, flexShrink: 0, marginTop: 2 }}>{i + 1}.</span><span style={{ color: l.toLowerCase().includes("action") ? T.navy : T.text }}>{l}</span></div>)}
            {txLines.length === 0 && <span style={{ color: "#B2BEC3" }}>No transcript available.</span>}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {draft.length === 0 && <div className="card" style={{ padding: 24 }}><Empty icon="📭" title="No actions to stage" sub="Go back and log actions during the meeting." /></div>}
          {draft.map(r => {
            const incomplete = !r.responsible || !r.due;
            return (
              <div key={r.id} className="card" style={{ padding: 18, borderLeft: `4px solid ${r.fromTranscript ? T.amber : incomplete ? T.slate : T.navy}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "center" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: T.text2 }}>{r.stageSN}</span>
                    {r.fromTranscript && <Chip label="From Transcript" color={T.amber} />}
                    {incomplete && <Chip label="Will be Unassigned" color={T.slate} />}
                  </div>
                  <button onClick={() => del(r.id)} style={{ border: "none", background: "transparent", cursor: "pointer", color: T.text2, fontSize: 18, lineHeight: 1 }}>×</button>
                </div>
                <div style={{ marginBottom: 10 }}><Lbl t="Action Point" req /><textarea value={r.text || ""} onChange={e => up(r.id, "text", e.target.value)} style={{ resize: "none", height: 52, fontSize: 12 }} /></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                  <div><Lbl t="Responsible" /><MultiUserSelect value={r.responsible || ""} users={users.filter(u => { if (r.plant && r.plant !== "All") return !u.plant || u.plant === "All" || u.plant === r.plant; if (!isUserAdmin(currentUser) && currentUser?.plant && currentUser.plant !== "All") return !u.plant || u.plant === "All" || u.plant === currentUser.plant; return true; })} onChange={v => { up(r.id, "responsible", v); const firstName = (v || "").split(",").map(s => s.trim()).filter(Boolean)[0]; if (firstName) { const u = users.find(x => x.name === firstName); if (u) { setDraft(d => d.map(a => a.id === r.id ? { ...a, plant: u.plant || a.plant, section: u.dept || a.section } : a)); } } }} placeholder="Leave Unassigned" /></div>
                  <div><Lbl t="Due Date" /><input type="date" value={r.due || ""} onChange={e => up(r.id, "due", e.target.value)} style={{ borderColor: !r.due ? T.amber : T.border }} /></div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                   <div><Lbl t="Department" /><select value={r.section || "General"} onChange={e => up(r.id, "section", e.target.value)}><option value="General">General</option>{scopedDepts(currentUser, depts).filter(d => !r.plant || r.plant === "All" || !d.plant || d.plant === "All Plants" || d.plant === r.plant).map(d => <option key={d.id} value={d.name}>{d.name}</option>)}{SECTIONS.filter(s => s !== "General" && !scopedDepts(currentUser, depts).filter(d => !r.plant || r.plant === "All" || !d.plant || d.plant === "All Plants" || d.plant === r.plant).find(d => d.name === s)).map(s => <option key={s}>{s}</option>)}</select></div>
                  <div><Lbl t="Priority" /><select value={r.priority} onChange={e => up(r.id, "priority", e.target.value)}>{PRIORITY_LIST.map(p => <option key={p}>{p}</option>)}</select></div>
                   <div><Lbl t="Plant" /><select value={r.plant || ""} onChange={e => setDraft(d => d.map(a => a.id === r.id ? { ...a, plant: e.target.value, section: "General" } : a))}>{scopedPlants(currentUser, plants).map(p => <option key={p.id}>{p.name}</option>)}</select></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ===================== ACTION DETAIL SIDE PANEL ===================== */
/* Completion workflow: assignee marks done → goes to allocatedBy + their superior for confirmation */
function ActionDetailPanel({ action, onClose, onUpdate, user, users, allUsers, plants: panelPlants, machines: panelMachines, meetings: panelMeetings }) {
  useEscClose(onClose);
  const [msgText, setMsgText] = useState("");
  const messagesEndRef = useRef(null);
  const msgs = action.messages || [];
  const revHistory = action.revisionHistory || [];
  const isPendingConfirm = action.pendingConfirmation === true;
  // Feature 6: inline edit state (track per-field editing)
  const [editingField, setEditingField] = useState(null);
  const [fieldVal, setFieldVal] = useState("");
  const [markCompleteStatus, setMarkCompleteStatus] = useState("COMPLETED");
  const [downloadingAtt, setDownloadingAtt] = useState(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const textareaRef = useRef(null);

  // Determine who can interact/confirm
  const assignee = action.responsible;
  const allocator = action.allocatedBy;
  const allocatorUser = allUsers.find(u => u.name === allocator);
  const allocatorSuperior = allocatorUser?.superior ? allUsers.find(u => u.name === allocatorUser.superior) : null;
  const isAssignee = responsibleMatchesUsers(assignee, [(user?.name || "").toLowerCase()]);
  const isAllocator = user?.name === allocator;
  const isAllocatorSuperior = user?.name === allocatorSuperior?.name;
  const isAdmin = isUserAdmin(user);
  const _hasEditPerm = isAdmin || isAllocator || (getPerms(user).canEditActions && isAssignee);
  const canConfirm = isAllocator || isAllocatorSuperior || isAdmin;
  const canMsg = _hasEditPerm || isAssignee || isAllocator;
  const canEdit = _hasEditPerm && !isPendingConfirm && action.status !== "COMPLETED" && action.status !== "DROPPED";

  const sendMsg = () => {
    if (!msgText.trim() || !canMsg) return;
    const newMsg = { id: Date.now(), author: user?.name || "Unknown", authorInitials: user?.initials || "?", authorColor: user?.color || T.slate, text: msgText.trim(), ts: new Date().toISOString() };
    onUpdate(action.id, { messages: [...msgs, newMsg] });
    setMsgText("");
  };
  const requestCompletion = () => {
    const sysMsg = { id: Date.now(), author: "System", authorInitials: "SYS", authorColor: T.navy, text: `${user?.name} has marked this action as complete and sent it for confirmation by ${allocator}${allocatorSuperior ? ` and ${allocatorSuperior.name}` : "."}`, ts: new Date().toISOString() };
    onUpdate(action.id, { status: "PENDING CONFIRM", pendingConfirmation: true, messages: [...msgs, sysMsg] });
  };
  const confirmComplete = () => {
    const sysMsg = { id: Date.now(), author: "System", authorInitials: "SYS", authorColor: T.green, text: `${user?.name} has confirmed completion. Action is now COMPLETED.`, ts: new Date().toISOString() };
    onUpdate(action.id, { status: "COMPLETED", pendingConfirmation: false, closedOn: todayStr(), messages: [...msgs, sysMsg] });
  };
  const rejectComplete = () => {
    const sysMsg = { id: Date.now(), author: "System", authorInitials: "SYS", authorColor: T.red, text: `${user?.name} has rejected the completion and reopened this action.`, ts: new Date().toISOString() };
    onUpdate(action.id, { status: "IN PROCESS", pendingConfirmation: false, messages: [...msgs, sysMsg] });
  };
  const startEdit = (field, val) => { setEditingField(field); setFieldVal(val || ""); setTimeout(() => { if (textareaRef.current) { textareaRef.current.value = val || ""; textareaRef.current.focus(); textareaRef.current.setSelectionRange((val||"").length, (val||"").length); } }, 0); };
  const commitEdit = (field) => {
    if (field === editingField) {
      // For textarea fields, read from the ref (uncontrolled) to avoid cursor-jump bug
      const actualVal = (textareaRef.current && editingField === field) ? textareaRef.current.value : fieldVal;
      const isCompletedStatus = field === "status" && actualVal === "COMPLETED";
      onUpdate(action.id, {
        [field]: actualVal,
        closedOn: isCompletedStatus ? todayStr() : action.closedOn,
        ...(isCompletedStatus ? { pendingConfirmation: false } : {})
      });
      setEditingField(null);
    }
  };
  const fmtTime = ts => { const d = new Date(ts); return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) + ", " + d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }); };

  // Inline editable field renderer
  const InlineField = ({ label, field, value, type, opts, readonly }) => {
    const isEditing = editingField === field;
    const editable = canEdit && !readonly;
    return (
      <div>
        <div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, marginBottom: 3 }}>{label}</div>
        {isEditing
          ? <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {type === "select" ? <select value={fieldVal} onChange={e => setFieldVal(e.target.value)} style={{ fontSize: 12, padding: "4px 8px", flex: 1, border: `1.5px solid ${T.navy}`, borderRadius: 8 }} autoFocus>
              {opts.map(o => <option key={o}>{o}</option>)}
            </select>
              : type === "textarea" ? <textarea ref={textareaRef} defaultValue={fieldVal} dir="ltr" style={{ flex: 1, fontSize: 12, height: 72, resize: "vertical", border: `1.5px solid ${T.navy}`, borderRadius: 8, padding: "6px 8px" }} />
                : <input type={type || "text"} value={fieldVal} onChange={e => setFieldVal(e.target.value)} style={{ flex: 1, fontSize: 12, padding: "4px 8px", border: `1.5px solid ${T.navy}`, borderRadius: 8 }} autoFocus />
            }
            <button onClick={() => commitEdit(field)} style={{ background: T.green, border: "none", color: "#fff", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>✓</button>
            <button onClick={() => setEditingField(null)} style={{ background: T.border, border: "none", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 11 }}>✕</button>
          </div>
          : <div style={{ display: "flex", alignItems: "center", gap: 6, cursor: editable ? "pointer" : "default", padding: "5px 8px", borderRadius: 6, border: editable ? `1.5px solid ${T.border}` : "1.5px solid transparent", transition: "border-color .15s, background .15s", background: "transparent" }}
            onMouseEnter={e => { if (editable) { e.currentTarget.style.background = T.bg; e.currentTarget.style.borderColor = T.navy; } }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; if (editable) e.currentTarget.style.borderColor = T.border; }}
            onClick={() => { if (editable) startEdit(field, value); }}>
            <span style={{ fontSize: 12, flex: 1 }}>{value || "—"}</span>
            {editable && <span style={{ fontSize: 10, color: T.text2, opacity: .5 }}>✏</span>}
          </div>
        }
      </div>
    );
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 405 }} onClick={onClose} />
      <div className="side-panel" style={{ width: 580, display: "flex", flexDirection: "column", zIndex: 410 }}>
        {/* Header */}
        <div style={{ padding: "20px 24px", borderBottom: `1.5px solid ${T.border}`, flexShrink: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
            <div style={{ fontFamily: "monospace", fontSize: 11, color: T.text2 }}>{action.sn}</div>
            <button onClick={onClose} style={{ background: T.navy, border: "none", cursor: "pointer", fontSize: 16, color: "#fff", borderRadius: 8, width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>✕</button>
          </div>
          <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 15, fontWeight: 800, color: T.navy, lineHeight: 1.3, marginBottom: 10 }}>{action.text}</h2>
          <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", overflowX: "auto" }}>
            <SBadge s={displayStatus(action)} /><PBadge p={action.priority} />
            {(action.projectName || action.project) && <Chip label={"🔗 " + (action.projectName || action.project)} color={T.amber} />}
            {action.srcId && (() => { const m = (panelMeetings || []).find(x => x.id === action.srcId); if (!m) return null; return <Chip label={"📅 " + m.type + (m.plant ? " · " + m.plant : "")} color={T.navy} />; })()}
          </div>
          {isPendingConfirm && (
            <div className="confirm-banner" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#7A5A00", marginBottom: 6 }}>⏳ Awaiting Completion Confirmation</div>
              <div style={{ fontSize: 11, color: "#7A5A00", marginBottom: canConfirm ? 10 : 0 }}>
                {assignee} has marked this complete. Waiting for {allocator}{allocatorSuperior ? ` or ${allocatorSuperior.name}` : ""} to confirm.
              </div>
              {canConfirm && (
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-green btn-sm" onClick={confirmComplete} style={{ flex: 1, justifyContent: "center" }}>✓ Confirm Complete</button>
                  <button className="btn btn-red btn-sm" onClick={rejectComplete} style={{ flex: 1, justifyContent: "center" }}>↩ Reopen</button>
                </div>
              )}
              {isAssignee && !canConfirm && <div style={{ fontSize: 11, color: T.text2, fontStyle: "italic" }}>You submitted this. Waiting for allocator's response.</div>}
            </div>
          )}
        </div>

        {/* Feature 6: Single scrollable page - Details + Thread + Revisions stacked */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {/* === DETAILS SECTION === */}
          <div style={{ padding: "16px 24px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.navy, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>📋 Details {canEdit && <span style={{ fontSize: 10, color: T.text2, fontWeight: 400 }}>(click any field to edit)</span>}</div>
            <div style={{ marginBottom: 12 }}>
              <InlineField label="Action Category" field="reasonOfAction" value={action.reasonOfAction} type="select" opts={["","Corrective Action","Preventive Action","Improvement","Safety","Maintenance","Quality","Compliance","Other"]} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <InlineField label="Action Point" field="text" value={action.text} type="textarea" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              {/* Read-only fields */}
              <div><div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, marginBottom: 3 }}>Date of Action</div><div style={{ fontSize: 12, padding: "3px 6px" }}>{fmt(action.dateOfAction)}</div></div>
              <div><div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, marginBottom: 3 }}>Allocated By</div><div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px" }}><Avatar name={action.allocatedBy} size={20} users={allUsers} /><span style={{ fontSize: 12 }}>{action.allocatedBy || "—"}</span></div></div>
              {/* Editable fields */}
              <InlineField label="Source" field="src" value={action.src} type="text" />
              <InlineField label="Department" field="section" value={action.section} type="select" opts={[...(panelPlants ? [] : SECTIONS), ...((panelPlants ? scopedUsers(user, allUsers || []) : []).length > 0 ? [...new Set(["General", ...scopedUsers(user, allUsers || []).map(u => u.dept).filter(Boolean)])] : SECTIONS)]} />

              <InlineField label="Plant" field="plant" value={action.plant} type="select" opts={scopedPlants(user, panelPlants || DEFAULT_PLANTS).map(p => p.name)} />
              <div>
                <div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, marginBottom: 3 }}>Responsible</div>
                <MultiUserSelect value={action.responsible} users={(allUsers || []).filter(u => { if (action.plant && action.plant !== "All") return !u.plant || u.plant === "All" || u.plant === action.plant; if (!isUserAdmin(user) && user?.plant && user.plant !== "All") return !u.plant || u.plant === "All" || u.plant === user.plant; return true; })} onChange={v => { const patch = { responsible: v }; const firstName = (v || "").split(",").map(s => s.trim()).filter(Boolean)[0]; if (firstName) { const u = (allUsers || []).find(x => x.name === firstName); if (u) { if (u.plant) patch.plant = u.plant; if (u.dept) patch.section = u.dept; } } onUpdate(action.id, patch); }} />
              </div>
              <InlineField label="Due Date" field="due" value={action.due} type="date" />
              <div><div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, marginBottom: 3 }}>Closed On</div><div style={{ fontSize: 12, padding: "3px 6px" }}>{fmt(action.closedOn)}</div></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <InlineField label="Machine Name" field="machineName" value={action.machineName} type="select" opts={(panelMachines || []).filter(m => !action.plant || !m.plant || m.plant === action.plant).map(m => m.name).filter(Boolean)} />
              <div />
            </div>
            <InlineField label="Remarks" field="remarks" value={action.remarks} type="textarea" />
            {/* Attachments Section */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 10, color: T.text2, fontWeight: 700, textTransform: "uppercase", letterSpacing: .4, marginBottom: 6 }}>📎 Attachments</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(action.attachments || []).map(att => (
                  <div key={att.id || att.filename} style={{ display: "flex", alignItems: "center", gap: 8, background: T.bg, borderRadius: 8, padding: "7px 12px", border: `1px solid ${T.border}` }}>
                    <span style={{ fontSize: 16 }}>{att.mimetype?.includes("pdf") ? "📄" : att.mimetype?.includes("image") ? "🖼" : att.mimetype?.includes("sheet") || att.mimetype?.includes("excel") || att.mimetype?.includes("csv") ? "📊" : att.mimetype?.includes("word") || att.mimetype?.includes("document") ? "📝" : "📁"}</span>
                    <span
                      onClick={async (e) => {
                        e.stopPropagation();
                        setDownloadingAtt(att.id);
                        try {
                        const resp = await fetch(`${API_BASE_URL}/api/actions/${action.id}/attachments/${att.id}`, {
                          headers: { "x-api-key": API_KEY, "Authorization": `Bearer ${AUTH_TOKEN || localStorage.getItem("mcs_token")}` },
                          });
                          if (!resp.ok) { alert("Download failed"); setDownloadingAtt(null); return; }
                          const blob = await resp.blob();
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url; a.download = att.filename;
                          document.body.appendChild(a); a.click();
                          document.body.removeChild(a);
                          URL.revokeObjectURL(url);
                        } catch (err) { alert("Download failed: " + err.message); }
                        setDownloadingAtt(null);
                      }}
                      style={{ fontSize: 12, fontWeight: 500, color: T.navy, textDecoration: "underline", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}
                    >{att.filename}{downloadingAtt === att.id && <span style={{ marginLeft: 6 }}><Spin /></span>}</span>
                    <span style={{ fontSize: 10, color: T.text2 }}>{att.size ? `${(att.size / 1024).toFixed(1)} KB` : ""}</span>
                    {canEdit && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!confirm("Remove this attachment?")) return;
                          const updated = (action.attachments || []).filter(a => a.id !== att.id);
                          onUpdate(action.id, { attachments: updated });
                        }}
                        style={{ background: "none", border: "none", cursor: "pointer", color: T.red, fontSize: 14, padding: 2 }}
                      >×</button>
                    )}
                  </div>
                ))}
              </div>
              {canEdit && (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, padding: "6px 14px", borderRadius: 8, border: `1.5px dashed ${T.border}`, cursor: uploadingFile ? "not-allowed" : "pointer", fontSize: 12, color: uploadingFile ? T.text2 : T.navy, background: uploadingFile ? T.bg : "#fff", transition: "border-color .15s, background .15s", opacity: uploadingFile ? .6 : 1 }}
                  onMouseEnter={e => { if (!uploadingFile) { e.currentTarget.style.borderColor = T.navy; e.currentTarget.style.background = T.bg; } }}
                  onMouseLeave={e => { if (!uploadingFile) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "#fff"; } }}
                >
                  {uploadingFile ? <><Spin /> Uploading…</> : <><span style={{ fontSize: 14 }}>+</span> Attach File</>}
                  <input
                    type="file"
                    accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.xlsx,.xls,.csv,.doc,.docx"
                    style={{ display: "none" }}
                    disabled={uploadingFile}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 5 * 1024 * 1024) { alert("File size exceeds 5 MB limit."); return; }
                      setUploadingFile(true);
                      try {
                        const formData = new FormData();
                        formData.append("file", file);
                        const resp = await fetch(`${API_BASE_URL}/api/actions/${action.id}/attachments`, {
                          method: "POST",
                          headers: { "x-api-key": API_KEY, "Authorization": `Bearer ${AUTH_TOKEN || localStorage.getItem("mcs_token")}` },
                          body: formData,
                        });
                        if (!resp.ok) { const err = await resp.json().catch(() => ({})); alert(err.detail || "Upload failed"); setUploadingFile(false); return; }
                        const result = await resp.json();
                        const updatedAttachments = [...(action.attachments || []), result.attachment];
                        onUpdate(action.id, { attachments: updatedAttachments });
                      } catch (err) {
                        alert("Upload failed: " + err.message);
                      }
                      setUploadingFile(false);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
            {/* Actions */}
            <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "nowrap", overflowX: "auto" }}>
              {!isGuestRole(user?.role) && !isPendingConfirm && action.status !== "COMPLETED" && action.status !== "DROPPED" && (
                <>
                  {isAssignee && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select
                        value={markCompleteStatus}
                        onChange={e => setMarkCompleteStatus(e.target.value)}
                        style={{ fontSize: 12, padding: "5px 8px", borderRadius: 8, border: `1.5px solid ${T.border}`, background: "#fff", color: T.text }}
                      >
                        <option value="COMPLETED">✅ Mark as Completed</option>
                        <option value="IN PROCESS">🔄 Mark as In Process</option>
                        <option value="NOT STARTED">⏸ Mark as Not Started</option>
                        <option value="DROPPED">🚫 Mark as Dropped</option>
                      </select>
                      <button
                        className={
                          markCompleteStatus === "DROPPED" ? "btn btn-red btn-sm" :
                          markCompleteStatus === "COMPLETED" ? "btn btn-green btn-sm" :
                          "btn btn-ghost btn-sm"
                        }
                        onClick={() => {
                          if (markCompleteStatus === "DROPPED") {
                            onUpdate(action.id, { status: "DROPPED", closedOn: todayStr(), pendingConfirmation: false });
                          } else if (markCompleteStatus === "COMPLETED") {
                            requestCompletion();
                          } else {
                            onUpdate(action.id, { status: markCompleteStatus, closedOn: null, pendingConfirmation: false });
                          }
                        }}>Confirm →</button>
                    </div>
                  )}
                  {!isAssignee && canMsg && (
                    <select value={action.status} onChange={e => onUpdate(action.id, { status: e.target.value, closedOn: e.target.value === "COMPLETED" ? todayStr() : null })} style={{ fontSize: 12, padding: "5px 8px" }}>
                      {STATUS_LIST.map(s => <option key={s}>{s}</option>)}
                    </select>
                  )}
                </>
              )}
              {(action.status === "COMPLETED" || action.status === "DROPPED") && canMsg && (
                <button className="btn btn-ghost btn-sm" onClick={() => onUpdate(action.id, { status: "IN PROCESS", closedOn: null, pendingConfirmation: false })}>↩ Reopen</button>
              )}
            </div>
          </div>

          {/* === THREAD SECTION === */}
          <div style={{ padding: "16px 24px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.navy, marginBottom: 12 }}>💬 Thread {msgs.length > 0 && <span style={{ color: T.text2, fontWeight: 400 }}>({msgs.length})</span>}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: canMsg ? 12 : 0 }}>
              {msgs.length === 0 && <div style={{ textAlign: "center", padding: "16px 0", color: T.text2, fontSize: 12 }}>No messages yet.{canMsg ? " Start the conversation below." : ""}</div>}
              {msgs.map(m => {
                const isMe = m.author === user?.name;
                const isSys = m.author === "System";
                if (isSys) return (
                  <div key={m.id} style={{ textAlign: "center", padding: "4px 12px" }}>
                    <span style={{ fontSize: 11, color: T.text2, background: T.bg, padding: "3px 10px", borderRadius: 20, display: "inline-block" }}>{m.text}</span>
                  </div>
                );
                return (
                  <div key={m.id} style={{ display: "flex", flexDirection: isMe ? "row-reverse" : "row", gap: 8, alignItems: "flex-end" }}>
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.authorColor + "20", color: m.authorColor, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0, border: `1.5px solid ${m.authorColor}30` }}>{m.authorInitials}</div>
                    <div style={{ maxWidth: "72%" }}>
                      <div style={{ fontSize: 10, color: T.text2, marginBottom: 3, textAlign: isMe ? "right" : "left" }}>{m.author}{isMe ? " (You)" : ""} · {fmtTime(m.ts)}</div>
                      <div style={{ background: isMe ? T.navy : T.bg, border: `1px solid ${isMe ? T.navy : T.border}`, borderRadius: isMe ? "12px 12px 2px 12px" : "12px 12px 12px 2px", padding: "9px 13px", fontSize: 13, lineHeight: 1.5, color: isMe ? "#fff" : T.text }}>{m.text}</div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
            {canMsg && (
              <div style={{ display: "flex", gap: 8 }}>
                <textarea value={msgText} onChange={e => setMsgText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(); } }} placeholder="Type a message… (Enter to send)" style={{ flex: 1, resize: "none", height: 52, fontSize: 12 }} />
                <button className="btn btn-navy" onClick={sendMsg} disabled={!msgText.trim()} style={{ flexShrink: 0, alignSelf: "flex-end", padding: "8px 14px" }}>Send</button>
              </div>
            )}
          </div>

          {/* === REVISIONS SECTION === */}
          <div style={{ padding: "16px 24px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.navy, marginBottom: 12 }}>📅 Revisions {revHistory.length > 0 && <span style={{ color: T.text2, fontWeight: 400 }}>({revHistory.length} changes)</span>}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div style={{ background: T.bg, borderRadius: 8, padding: "10px 14px", textAlign: "center" }}>
                <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 24, fontWeight: 800, color: T.navy }}>{action.revisions || 0}</div>
                <div style={{ fontSize: 11, color: T.text2 }}>Date Revisions</div>
              </div>
              <div style={{ background: T.bg, borderRadius: 8, padding: "10px 14px", textAlign: "center" }}>
                <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 18, fontWeight: 800, color: action.status === "COMPLETED" ? T.green : T.amber }}>{action.status}</div>
                <div style={{ fontSize: 11, color: T.text2 }}>Current Status</div>
              </div>
            </div>
            {action.closedOn && <div style={{ background: T.greenL, borderRadius: 8, padding: "8px 14px", marginBottom: 12, fontSize: 12 }}><b style={{ color: T.green }}>Completed on:</b> {fmt(action.closedOn)}</div>}
            {revHistory.length === 0 ? <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic", padding: "8px 0" }}>No date revisions yet.</div> :
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {revHistory.map((r, i) => (
                  <div key={i} style={{ background: T.amberL, borderRadius: 8, padding: "10px 14px", borderLeft: `3px solid ${T.amber}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: T.amber }}>Rev #{i + 1}</span>
                      <span style={{ fontSize: 11, color: T.text2 }}>{fmt(r.date)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: T.text }}>Due changed from <b>{fmt(r.from)}</b> to <b>{fmt(r.to)}</b></div>
                    {r.by && <div style={{ fontSize: 11, color: T.text2, marginTop: 3 }}>by {r.by}</div>}
                  </div>
                ))}
              </div>
            }
          </div>
        </div>
      </div>
    </>
  );
}

/* ===================== ACTIONS PAGE ===================== */
/* Persists last view per user in memory */
const userViewPref = {};
const userSortPref = {};  // persist sort across page changes
// Persist filters across page changes AND browser refreshes via localStorage
const FILTER_STORE_KEY = "mcs_action_filters";
const userFilterPref = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_STORE_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) { return {}; }
})();
const saveFilterPref = () => {
  try { localStorage.setItem(FILTER_STORE_KEY, JSON.stringify(userFilterPref)); } catch (e) { /* ignore */ }
};

function ActionsPage({ actions, setActions, plants, depts, users, user, projects, machines, meetings }) {
  const userKey = user?.id || "guest";
  const [view, setView] = useState(userViewPref[userKey] || "table");
  // Multi-select filters: persistent across page changes
  const isAdmin = isUserAdmin(user);
  const [filters, setFilters] = useState(userFilterPref[userKey] || { 
    plant: user?.plant && user.plant !== "All" ? [user.plant] : [], 
    section: [], 
    responsible: [], 
    status: [], priority: [], project: [], meeting: [] 
  });
  const [myActionsOnly, setMyActionsOnly] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  const [openFilter, setOpenFilter] = useState(null);
  const [dropPos, setDropPos] = useState(null);
  const [emailModal, setEmailModal] = useState(null);
  const [emailForm, setEmailForm] = useState({ responsible: "", email: "", status: "" });
  const [emailSending, setEmailSending] = useState(false);
  const canEdit = isUserAdmin(user) || getPerms(user).canEditActions;
  const allProjects = [...new Set([...(projects || []).map(p => p.name), ...actions.map(a => a.projectName || a.project)].filter(Boolean))];

  const changeView = v => { setView(v); userViewPref[userKey] = v; };

  // Scope: current user + all subordinates (recursive)
  const getSubTree = (name, allUsers, visited = new Set()) => {
    if (visited.has(name)) return [];
    visited.add(name);
    const directs = allUsers.filter(u => u.superior === name);
    const all = [name, ...directs.map(d => d.name)];
    directs.forEach(d => { all.push(...getSubTree(d.name, allUsers, visited).filter(n => !all.includes(n))); });
    return all;
  };
  const scopedNames = user ? getSubTree(user.name, users) : [];
  const userNameLower = (user?.name || "").trim().toLowerCase();
  const userPlant = user?.plant;
  const scoped = isAdmin || !userPlant || userPlant === "All"
    ? actions
    : actions.filter(a => !a.plant || a.plant === "All" || a.plant === userPlant);

  const toggleFilter = (key, val) => {
    setFiltersPersist(f => {
      const cur = f[key];
      return { ...f, [key]: cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val] };
    });
  };
  const clearFilter = (key) => setFiltersPersist(f => ({ ...f, [key]: [] }));
  const clearAll = () => { const empty = { plant: [], section: [], responsible: [], status: [], priority: [], project: [], meeting: [] }; setFilters(empty); userFilterPref[userKey] = empty; saveFilterPref(); setOpenFilter(null); setDropPos(null); };
  // Save filters to persistent store on each change
  const setFiltersPersist = (updater) => {
    setFilters(prev => { const next = typeof updater === "function" ? updater(prev) : updater; userFilterPref[userKey] = next; saveFilterPref(); return next; });
  };

  // My Actions / All Actions scoping.
  // "My Actions" = actions where THIS user is the responsible person only.
  // Actions allocated BY the user for someone else must NOT appear here.
  const displayScope = myActionsOnly
    ? scoped.filter(a => responsibleMatchesUsers(a.responsible, [userNameLower].filter(Boolean)))
    : scoped;

  const fa = displayScope.filter(a => {
    if (filters.plant.length && !filters.plant.includes("All") && !filters.plant.includes(a.plant)) return false;
    if (filters.section.length && !filters.section.includes(a.section)) return false;
    if (filters.responsible.length && !filters.responsible.includes(a.responsible)) return false;
    const aStatus = displayStatus(a);
    if (filters.status.length && !filters.status.includes(aStatus)) return false;
    if (filters.priority.length && !filters.priority.includes(a.priority)) return false;
    const aProj = a.projectName || a.project || "None";
    if (filters.project.length && !filters.project.includes(aProj)) return false;
    const aMtg = (a.srcId && (meetings || []).find(m => m.id === a.srcId)) ? (meetings.find(m => m.id === a.srcId).type) : (a.src || "None");
    if ((filters.meeting || []).length && !filters.meeting.includes(aMtg)) return false;
    if (q && ![a.text, a.responsible, a.sn, a.src, a.section].join(" ").toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const upAction = (id, patch) => {
    setActions(p => p.map(a => {
      if (String(a.id) !== String(id)) return a;
      if (patch.due && patch.due !== a.due) {
        const rev = { date: todayStr(), from: a.due, to: patch.due, by: user?.name || "Unknown" };
        return { ...a, ...patch, revisions: (a.revisions || 0) + 1, revisionHistory: [...(a.revisionHistory || []), rev] };
      }
      return { ...a, ...patch };
    }));
    apiUpdate("actions", id, resolveRecordIds(patch, plants, depts, machines, projects, meetings));
  };
  const upStatus = (id, status) => {
    if (status === "COMPLETED") {
      // If the status filter is active and doesn't include COMPLETED, add it
      // so the action stays visible in the Kanban board after being dropped.
      setFiltersPersist(f => {
        if (f.status.length > 0 && !f.status.includes("COMPLETED")) {
          return { ...f, status: [...f.status, "COMPLETED"] };
        }
        return f;
      });
    }
    upAction(id, { status, closedOn: status === "COMPLETED" ? todayStr() : null, pendingConfirmation: false });
  };
  const allSections = [...new Set(scoped.map(a => a.section))].filter(Boolean);
  const allResponsible = [...new Set(scoped.map(a => a.responsible))].filter(Boolean);
  const pendingConf = scoped.filter(a => a.pendingConfirmation && a.status !== "COMPLETED" && a.status !== "DROPPED");

  // Feature 7: Export functions
  const exportCSV = () => {
    const headers = ["SN", "Source", "Meeting", "Department", "Plant", "Date", "Action", "Responsible", "Due Date", "Status", "Priority", "Revisions"];
    const rows = fa.map(a => { const m = a.srcId && (meetings || []).find(x => x.id === a.srcId) ? (meetings.find(x => x.id === a.srcId).type + (meetings.find(x => x.id === a.srcId).plant ? " · " + meetings.find(x => x.id === a.srcId).plant : "")) : (a.src || ""); return [a.sn, a.src, m, a.section, a.plant, a.dateOfAction, `"${a.text.replace(/"/g, '""')}"`, a.responsible, a.due, a.status, a.priority, a.revisions || 0]; });
    const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a2 = document.createElement("a"); a2.href = url; a2.download = `actions-${todayStr()}.csv`; a2.click(); URL.revokeObjectURL(url);
  };
  const exportPDF = () => {
    const content = `
      <html><head><style>
        body{font-family:Arial,sans-serif;font-size:11px;padding:20px;}
        h2{color:#272262;margin-bottom:4px;}
        p{color:#636E72;font-size:10px;margin-bottom:16px;}
        table{width:100%;border-collapse:collapse;}
        th{background:#272262;color:#fff;padding:8px 10px;text-align:left;font-size:10px;}
        td{padding:7px 10px;border-bottom:1px solid #E8E8F0;font-size:10px;}
        tr:nth-child(even) td{background:#F5F5FB;}
        .status-badge{padding:2px 8px;border-radius:10px;font-weight:600;}
      </style></head><body>
      <h2>Management Control System — Actions Register</h2>
      <p>Exported on ${new Date().toLocaleDateString("en-IN")} · ${fa.length} actions</p>
      <table>
        <tr><th>SN</th><th>Action</th><th>Responsible</th><th>Due Date</th><th>Status</th><th>Priority</th><th>Plant</th><th>Meeting</th></tr>
        ${fa.map(a => { const m = a.srcId && (meetings || []).find(x => x.id === a.srcId) ? (meetings.find(x => x.id === a.srcId).type + (meetings.find(x => x.id === a.srcId).plant ? " · " + meetings.find(x => x.id === a.srcId).plant : "")) : (a.src || "—"); return `<tr><td>${a.sn}</td><td>${a.text}</td><td>${a.responsible}</td><td>${a.due || "—"}</td><td>${a.status}</td><td>${a.priority}</td><td>${a.plant}</td><td>${m}</td></tr>`; }).join("")}
      </table>
      </body></html>`;
    const w = window.open("", "_blank"); w.document.write(content); w.document.close(); w.print();
  };
  const printPage = () => window.print();

  return (
    <div className="fade-in">
      <PageHeader title="Actions Register" sub={`${isAdmin ? (myActionsOnly ? "My actions" : "Plant-wide") : "My actions"} · ${displayScope.length} actions · ${fa.length} shown`}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {/* My / All toggle */}
          {isAdmin && <div style={{ display: "flex", background: T.bg, borderRadius: 8, padding: 3, border: `1.5px solid ${T.border}` }}>
            <button onClick={() => setMyActionsOnly(false)} style={{ padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: !myActionsOnly ? T.navy : "transparent", color: !myActionsOnly ? "#fff" : T.text2, transition: "all .18s" }}>All Actions</button>
            <button onClick={() => setMyActionsOnly(true)} style={{ padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: myActionsOnly ? T.navy : "transparent", color: myActionsOnly ? "#fff" : T.text2, transition: "all .18s" }}>My Actions</button>
          </div>}
          <button className="btn btn-ghost btn-sm" onClick={exportCSV} title="Download CSV">📥 CSV</button>
          <button className="btn btn-ghost btn-sm" onClick={exportPDF} title="Download PDF">📄 PDF</button>
          <button className="btn btn-ghost btn-sm" onClick={printPage} title="Print">🖨 Print</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setEmailModal(true)} title="Email Actions" style={{ color: T.navy }}>✉ Email</button>
        </div>
      </PageHeader>

      <div className="card" style={{ padding: "14px 16px", marginBottom: 14 }}>
        <div className="filter-bar" style={{ alignItems: "flex-end", marginBottom: 10 }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Search actions…" style={{ width: 200 }} />
          {[
            { label: "Plant", key: "plant", opts: scopedPlants(user, plants).map(p => p.name).filter(n => n !== "All") },
            { label: "Department", key: "section", opts: allSections },
            { label: "Responsible", key: "responsible", opts: allResponsible },
            { label: "Status", key: "status", opts: [...STATUS_LIST, "PENDING CONFIRM"] },
            { label: "Priority", key: "priority", opts: PRIORITY_LIST },
            { label: "Project", key: "project", opts: ["None", ...allProjects] },
            { label: "Meeting", key: "meeting", opts: ["None", ...(meetings || []).map(m => m.type)] },
          ].map(({ label, key, opts }) => {
            const sel2 = filters[key];
            const isOpen = openFilter === key;
            return (
              <div key={key} style={{ position: "relative" }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: T.text2, letterSpacing: .4, textTransform: "uppercase", display: "block", marginBottom: 2 }}>{label}</span>
                <button onClick={e => { if (isOpen) { setOpenFilter(null); setDropPos(null); } else { const r = e.currentTarget.getBoundingClientRect(); setDropPos({ top: r.bottom + 4, left: r.left, width: r.width }); setOpenFilter(key); } }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", border: `1.5px solid ${sel2.length ? T.navy : T.border}`, borderRadius: 7, background: sel2.length ? "#EEF0FF" : "#fff", color: sel2.length ? T.navy : T.text, cursor: "pointer", fontSize: 12, fontWeight: 500, minWidth: 110, whiteSpace: "nowrap" }}>
                  <span style={{ flex: 1, textAlign: "left" }}>{sel2.length === 0 ? "All" : sel2.length === 1 ? sel2[0] : `${sel2.length} selected`}</span>
                  {sel2.length > 0 && <span onClick={e => { e.stopPropagation(); clearFilter(key); setDropPos(null); }} style={{ color: T.text2, fontWeight: 700, fontSize: 14, lineHeight: 1 }}>×</span>}
                  <span style={{ fontSize: 9, color: T.text2 }}>{isOpen ? "▲" : "▼"}</span>
                </button>
                {isOpen && dropPos && (
                  <div onClick={e => e.stopPropagation()} style={{ position: "fixed", top: dropPos.top, left: dropPos.left, zIndex: 600, background: "#fff", border: `1px solid ${T.border}`, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,.13)", minWidth: 190, maxHeight: 260, overflowY: "auto", padding: 6 }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: sel2.length === 0 ? 700 : 400, color: sel2.length === 0 ? T.navy : T.text, marginBottom: 2, borderBottom: `1px solid ${T.border}` }} onClick={() => clearFilter(key)}>
                      <span style={{ width: 14, height: 14, borderRadius: 3, border: `2px solid ${T.border}`, background: "transparent", display: "inline-block" }} />
                      All (clear)
                    </label>
                    {opts.map(o => (
                      <label key={o} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12, background: sel2.includes(o) ? "#EEF0FF" : "transparent", fontWeight: sel2.includes(o) ? 600 : 400 }}>
                        <input type="checkbox" checked={sel2.includes(o)} onChange={() => toggleFilter(key, o)} style={{ width: 14, height: 14, cursor: "pointer", accentColor: T.navy }} />
                        {o}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 6, alignItems: "flex-end", marginLeft: "auto" }}>
            {Object.values(filters).some(v => v.length > 0) && <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear All</button>}
            <span style={{ fontSize: 12, color: T.text2, fontWeight: 500, paddingBottom: 3 }}>{fa.length}/{scoped.length}</span>
          </div>
        </div>
        {/* Active filter chips */}
        {Object.entries(filters).some(([, v]) => v.length > 0) && (
          <div style={{ display: "flex", flexWrap: "nowrap", overflowX: "auto", gap: 6, marginBottom: 10 }}>
            {Object.entries(filters).flatMap(([key, vals]) => vals.map(v => (
              <span key={key + v} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: T.navy + "15", color: T.navy, border: `1px solid ${T.navy}30`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600 }}>
                <span style={{ opacity: .6, fontSize: 10 }}>{key}:</span> {v}
                <button onClick={() => toggleFilter(key, v)} style={{ background: "transparent", border: "none", color: T.navy, cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1, marginLeft: 2, opacity: .6 }}>×</button>
              </span>
            )))}
          </div>
        )}
        <div style={{ display: "flex", gap: 6, borderTop: `1px solid ${T.border}`, paddingTop: 10 }}>
          {[{ v: "table", icon: "☰", l: "Table" }, { v: "board", icon: "⊞", l: "Board" }, { v: "kanban", icon: "▦", l: "Kanban" }, { v: "timeline", icon: "━", l: "Timeline" }].map(x => (
            <button key={x.v} onClick={() => changeView(x.v)} style={{ padding: "5px 14px", borderRadius: 7, border: `1.5px solid ${view === x.v ? T.navy : T.border}`, background: view === x.v ? T.navy : "transparent", color: view === x.v ? "#fff" : T.text2, fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>
              {x.icon} {x.l}
            </button>
          ))}
        </div>
      </div>
      {openFilter && <div style={{ position: "fixed", inset: 0, zIndex: 599 }} onClick={() => { setOpenFilter(null); setDropPos(null); }} />}
      {view === "table" && <TableView fa={fa} upStatus={upStatus} setSel={a => { setSel(a); }} canEdit={canEdit} upAction={upAction} sortState={userSortPref[userKey]} onSortChange={s => { userSortPref[userKey] = s; }} users={users} meetings={meetings} />}
      {view === "board" && <BoardView fa={fa} setSel={setSel} users={users} />}
      {view === "kanban" && <KanbanView
  fa={fa}
  upStatus={upStatus}
  canEdit={canEdit}
  users={users}
  setSel={setSel}
  user={user}
/>}
      {view === "timeline" && <TimelineView fa={fa} />}
      {sel && <ActionDetailPanel action={sel} onClose={() => setSel(null)} onUpdate={(id, patch) => { upAction(id, patch); setSel(p => p ? { ...p, ...patch } : p); }} user={user} users={users} allUsers={users} plants={plants} machines={machines} />}
      {emailModal && (
        <div className="overlay" onClick={() => setEmailModal(null)}>
          <div className="modal" style={{ width: 420, padding: 28 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h3 style={{ fontFamily: "'Sora',sans-serif", fontSize: 15, fontWeight: 800, color: T.navy, margin: 0 }}>✉ Email Actions</h3>
              <button onClick={() => setEmailModal(null)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: T.text2 }}>×</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <Lbl t="Responsible Person" />
                <select value={emailForm.responsible} onChange={e => setEmailForm(f => ({ ...f, responsible: e.target.value }))} style={{ width: "100%" }}>
                  <option value="">Select…</option>
                  {allResponsible.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <Lbl t="Email Address" />
                <input type="email" value={emailForm.email} onChange={e => setEmailForm(f => ({ ...f, email: e.target.value }))} placeholder="name@company.com" style={{ width: "100%" }} />
              </div>
              <div>
                <Lbl t="Status Filter (optional)" />
                <select value={emailForm.status} onChange={e => setEmailForm(f => ({ ...f, status: e.target.value }))} style={{ width: "100%" }}>
                  <option value="">All statuses</option>
                  {STATUS_LIST.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <button
                disabled={!emailForm.responsible || !emailForm.email || emailSending}
                onClick={async () => {
                  setEmailSending(true);
                  try {
                    const body = { responsible: emailForm.responsible, email: emailForm.email };
                    if (emailForm.status) body.status = emailForm.status;
                    await apiPost("/api/actions/send-to-email", body);
                    setEmailModal(null);
                    setEmailForm({ responsible: "", email: "", status: "" });
                  } catch (e) {
                    alert("Failed to send email: " + e.message);
                  } finally {
                    setEmailSending(false);
                  }
                }}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: (!emailForm.responsible || !emailForm.email || emailSending) ? T.border : T.navy, color: (!emailForm.responsible || !emailForm.email || emailSending) ? T.text2 : "#fff", fontWeight: 700, fontSize: 13, cursor: (!emailForm.responsible || !emailForm.email || emailSending) ? "not-allowed" : "pointer" }}
              >
                {emailSending ? "Sending…" : "Send Email"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TableView({ fa, upStatus, setSel, canEdit, upAction, sortState, onSortChange, users, meetings }) {
  const meetingMap = {}; (meetings || []).forEach(m => { meetingMap[m.id] = m; });
  // Use externally-provided sort state if available (for persistence), else local
  const [localSortKey, setLocalSortKey] = useState(sortState?.key || "dateOfAction");
  const [localSortDir, setLocalSortDir] = useState(sortState?.dir || "desc");
  const sortKey = localSortKey, sortDir = localSortDir;
  const toggleSort = k => {
    const newKey = k, newDir = sortKey === k ? (sortDir === "asc" ? "desc" : "asc") : "asc";
    setLocalSortKey(newKey); setLocalSortDir(newDir);
    onSortChange && onSortChange({ key: newKey, dir: newDir });
  };
  const SortIcon = ({ k }) => {
    const active = sortKey === k;
    return (
      <span style={{ marginLeft: 4, opacity: active ? 1 : .3, fontSize: 10, userSelect: "none", display: "inline-flex", flexDirection: "column", lineHeight: 1, gap: 0 }}>
        <span style={{ color: active && sortDir === "asc" ? T.amber : "inherit", lineHeight: 1 }}>▲</span>
        <span style={{ color: active && sortDir === "desc" ? T.amber : "inherit", lineHeight: 1 }}>▼</span>
      </span>
    );
  };
  const TH = ({ k, label, minWidth, style = {} }) => (
    <th style={{ minWidth, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", ...style }} onClick={() => toggleSort(k)}>
      {label}<SortIcon k={k} />
    </th>
  );
  const sorted = [...fa].sort((a, b) => {
    let av = a[sortKey] ?? "", bv = b[sortKey] ?? "";
    if (sortKey === "meeting") { av = (a.srcId && meetingMap[a.srcId]) ? meetingMap[a.srcId].type : (a.src || ""); bv = (b.srcId && meetingMap[b.srcId]) ? meetingMap[b.srcId].type : (b.src || ""); }
    if (sortKey === "due" || sortKey === "dateOfAction" || sortKey === "created") {
      av = av ? new Date(av).getTime() : 0; bv = bv ? new Date(bv).getTime() : 0;
    } else if (sortKey === "revisions") { av = a.revisions || 0; bv = b.revisions || 0; }
    else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
    return sortDir === "asc" ? (av > bv ? 1 : av < bv ? -1 : 0) : (av < bv ? 1 : av > bv ? -1 : 0);
  });
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead><tr>
            <TH k="sn" label="SN" minWidth={70} />
            <TH k="src" label="Source" minWidth={150} />

            <TH k="section" label="Department" minWidth={100} />
            <TH k="plant" label="Plant" minWidth={90} />
            <TH k="dateOfAction" label="Date" minWidth={100} />
            <TH k="text" label="Action Point" minWidth={280} />
            <TH k="responsible" label="Responsible" minWidth={130} />
            <TH k="due" label="Due Date" minWidth={100} />
            <TH k="status" label="Status" minWidth={130} />
            <TH k="revisions" label="Revisions" minWidth={80} style={{ textAlign: "center" }} />
          </tr></thead>
          <tbody>
            {sorted.map((a, idx) => {
              const status = normalizeStatus(a.status);
              const hasRemarks = Array.isArray(a.messages) && a.messages.length > 0;
              let rowBg = "";
              if (status === "COMPLETED") rowBg = "#D5F5E3";
              else if (status === "DROPPED") rowBg = "#F2F3F4";
              else if (isOverdue(a)) rowBg = "#FADBD8";
              else if (hasRemarks) rowBg = "#FEF3CD";
              else if (a.pendingConfirmation) rowBg = "#FEF9E7";
              return (
              <tr key={a.id || `act-${idx}`} style={{ cursor: "pointer", background: rowBg }} onClick={() => setSel(a)}>
                <td style={{ fontFamily: "monospace", fontSize: 11, color: T.text2 }}>{a.sn}</td>
                <td style={{ fontSize: 12, maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.src}</td>

                <td style={{ fontSize: 12 }}>{a.section}</td>
                <td style={{ fontSize: 11 }}>{a.plant}</td>
                <td style={{ fontSize: 11, color: T.text2, whiteSpace: "nowrap" }}>{fmt(a.dateOfAction)}</td>
                <td style={{ minWidth: 280, maxWidth: 360 }}>
                  <div style={{ fontWeight: 500, whiteSpace: "normal", wordBreak: "break-word", fontSize: 13, lineHeight: 1.4 }}>{a.text}</div>
                  {isOverdue(a) && <div style={{ fontSize: 10, color: T.red, fontWeight: 600 }}>⚠ {daysOver(a)}d overdue</div>}
                  {a.pendingConfirmation && <div style={{ fontSize: 10, color: T.amber, fontWeight: 600 }}>⏳ {a.status}</div>}
                </td>
                <td onClick={e => e.stopPropagation()}><div style={{ display: "flex", alignItems: "center", gap: 6 }}><Avatar name={a.responsible} size={24} users={users} /><span style={{ fontSize: 12 }}>{a.responsible}</span></div></td>
                <td style={{ fontSize: 12, color: isOverdue(a) ? T.red : T.text, whiteSpace: "nowrap" }}>{fmt(a.due)}</td>
                <td onClick={e => e.stopPropagation()}><SBadge s={a.status} /></td>
                <td style={{ textAlign: "center" }}>{(a.revisions || 0) > 0 ? <span style={{ fontWeight: 700, color: T.amber, fontSize: 12 }}>{a.revisions}</span> : <span style={{ color: T.text2, fontSize: 12 }}>—</span>}</td>
              </tr>
              );
            })}
            {sorted.length === 0 && <tr><td colSpan={10}><Empty icon="📭" title="No actions found" sub="Adjust filters or add actions via Work." /></td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BoardView({ fa, setSel, users }) {
  const groups = [...new Set(fa.map(a => a.section))].filter(Boolean);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {groups.map(g => {
        const ga = fa.filter(a => a.section === g), done = ga.filter(a => a.status === "COMPLETED").length;
        return (
          <div key={g} className="card" style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "12px 18px", background: T.bg, borderBottom: `1.5px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: T.navy }}>{g}</span>
              <span style={{ fontSize: 11, color: T.text2 }}>{done}/{ga.length} completed</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12, padding: 14 }}>
              {ga.map((a, idx) => (
                <div key={a.id || `board-${idx}`} style={{ background: T.bg, borderRadius: 10, padding: 12, border: `1.5px solid ${a.pendingConfirmation ? T.amber : isOverdue(a) ? T.red : T.border}`, cursor: "pointer" }} onClick={() => setSel(a)}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, gap: 4 }}><SBadge s={normalizeStatus(a.status)} /><PBadge p={a.priority} /></div>
                  <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4, marginBottom: 8 }}>{a.text.slice(0, 70)}{a.text.length > 70 ? "…" : ""}</div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <Avatar name={a.responsible} size={22} users={users || []} />
                    <span style={{ fontSize: 10, color: isOverdue(a) ? T.red : T.text2 }}>{fmt(a.due)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KanbanView({ fa, upStatus, canEdit, users, setSel, user }) {
  const dragIdRef = useRef(null);
  const [overCol, setOverCol] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [heldId, setHeldId] = useState(null);
  const holdTimerRef = useRef(null);

  const HOLD_GLOW = {
    "IN PROCESS":  { border: "#E69903", shadow: "0 0 0 3px rgba(230,153,3,.25), 0 8px 24px rgba(230,153,3,.18)",    bg: "#FFFBEF" },
    "NOT STARTED": { border: "#7C80B0", shadow: "0 0 0 3px rgba(124,128,176,.25), 0 8px 24px rgba(124,128,176,.18)", bg: "#F4F3FB" },
    "COMPLETED":   { border: "#27AE60", shadow: "0 0 0 3px rgba(39,174,96,.25),   0 8px 24px rgba(39,174,96,.18)",   bg: "#F0FBF5" },
    "DROPPED":     { border: "#BDC3C7", shadow: "0 0 0 3px rgba(189,195,199,.25), 0 8px 24px rgba(189,195,199,.18)", bg: "#F8F9FA" },
  };

  const handleDragStart = (e, a) => {
    clearTimeout(holdTimerRef.current);
    setHeldId(null);
    dragIdRef.current = a.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(a.id));
    const ghost = e.currentTarget.cloneNode(true);
    Object.assign(ghost.style, {
      position: "fixed", top: "-1000px", left: "-1000px",
      width: e.currentTarget.offsetWidth + "px",
      transform: "rotate(2deg) scale(1.06)",
      boxShadow: "0 20px 48px rgba(39,34,98,.30)",
      borderRadius: "10px", opacity: "1",
      border: "2px solid #272262",
      background: "#fff", pointerEvents: "none",
    });
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, ghost.offsetWidth / 2, 28);
    requestAnimationFrame(() => { ghost.remove(); setDraggingId(a.id); });
  };

  const handleMouseDown = (a) => {
    if (!canEdit) return;
    holdTimerRef.current = setTimeout(() => setHeldId(a.id), 120);
  };
  const handleMouseUp = () => { clearTimeout(holdTimerRef.current); setHeldId(null); };

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
      gap: 14,
      alignItems: "start",
      width: "100%",
      paddingBottom: 100
    }}>
      {["Escalated Action", ...STATUS_LIST].map(col => {
        const isEscalatedCol = col === "Escalated Action";
        const c = isEscalatedCol ? { bg: T.redL, text: T.red, dot: T.red } : (SC[col] || { bg: "#eee", text: "#333", dot: "#aaa" });
        const glow = isEscalatedCol ? { border: T.red, shadow: "0 0 0 3px rgba(192,57,43,.25), 0 8px 24px rgba(192,57,43,.18)", bg: "#FADBD8" } : (HOLD_GLOW[col] || { border: T.navy, shadow: "0 0 0 3px rgba(39,34,98,.2), 0 8px 24px rgba(39,34,98,.15)", bg: "#F4F3FB" });
        const isDragOver = overCol === col;
        let colCards = [];
        if (isEscalatedCol) {
          colCards = fa.filter(a => isOverdue(a) && a.status !== "COMPLETED" && a.status !== "DROPPED");
        } else {
          colCards = fa.filter(a => normalizeStatus(a.status) === col);
        }

        return (
          <div key={col}
            onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (overCol !== col) setOverCol(col); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOverCol(null); }}
            onDrop={e => {
              e.preventDefault();
              if (isEscalatedCol) {
                dragIdRef.current = null;
                setOverCol(null);
                return;
              }
              const raw = e.dataTransfer.getData("text/plain");
              const id = dragIdRef.current ?? (raw !== "" ? Number(raw) : null);
              if (id != null && !isNaN(id)) upStatus(id, col);
              dragIdRef.current = null;
              setOverCol(null);
            }}
            style={{
              borderRadius: 12,
              border: isDragOver ? `2px dashed ${c.dot}` : `2px solid ${c.dot}22`,
              background: isDragOver ? c.dot + "14" : "#F7F7FC",
              transition: "background .18s, border-color .18s",
              minHeight: 220,
            }}>

            {/* Column header */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 12px 8px",
              borderBottom: `2px solid ${c.dot}33`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{
                  width: 10, height: 10, borderRadius: "50%", background: c.dot,
                  display: "inline-block", flexShrink: 0,
                  boxShadow: isDragOver ? `0 0 0 3px ${c.dot}44` : "none",
                  transition: "box-shadow .18s",
                }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: c.text, letterSpacing: .3 }}>{col}</span>
              </div>
              <span style={{ background: "#fff", color: c.text, borderRadius: 20, padding: "1px 9px", fontSize: 11, fontWeight: 700 }}>{colCards.length}</span>
            </div>

            {/* Drop indicator when dragging over an empty column */}
            {isDragOver && colCards.length === 0 && (
              <div style={{ margin: "10px 10px 0", padding: "18px 0", borderRadius: 8, border: `2px dashed ${c.dot}88`, textAlign: "center", fontSize: 12, color: c.dot, fontWeight: 600 }}>
                ⬇ Drop here
              </div>
            )}

            {/* Cards */}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 10px 10px" }}>
              {colCards.map((a, idx) => {
                const isDragging = draggingId === a.id;
                const isHeld = heldId === a.id;
                const draggable = canEdit; // pendingConfirmation does not block dragging
                return (
                  <div key={a.id || `kanban-${idx}`}
                    draggable={draggable}
                    onMouseDown={() => handleMouseDown(a)}
                    onMouseUp={handleMouseUp}
                    onMouseLeave={handleMouseUp}
                    onDragStart={e => handleDragStart(e, a)}
                    onDragEnd={e => { dragIdRef.current = null; setOverCol(null); setDraggingId(null); setHeldId(null); }}
                    onClick={() => { if (!isDragging) setSel(a); }}
                    style={{
                      background: isHeld ? glow.bg : "#fff",
                      borderRadius: 10,
                      padding: "10px 12px",
                      cursor: draggable ? (isHeld ? "grabbing" : "grab") : "default",
                      border: isHeld
                        ? `1.5px solid ${glow.border}`
                        : `1.5px solid ${a.pendingConfirmation ? T.amber : isOverdue(a) ? T.red : "transparent"}`,
                      userSelect: "none", WebkitUserSelect: "none",
                      position: "relative",
                      opacity: isDragging ? 0.3 : 1,
                      transform: isDragging ? "scale(0.95)" : isHeld ? "scale(1.025) translateY(-2px)" : "none",
                      boxShadow: isDragging ? "none" : isHeld ? glow.shadow : "0 1px 6px rgba(0,0,0,.07)",
                      transition: "opacity .15s, transform .18s, box-shadow .18s, border-color .15s, background .15s",
                      zIndex: isHeld ? 2 : 1,
                    }}>
                    {/* Hold accent stripe */}
                    {isHeld && (
                      <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 3, borderRadius: "10px 10px 0 0", background: `linear-gradient(90deg,${glow.border},${glow.border}66)` }} />
                    )}
                    <div style={{ fontSize: 11, marginBottom: 5, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: isHeld ? glow.border : T.text2, fontWeight: isHeld ? 700 : 500, transition: "color .15s" }}>{a.sn}</span>
                      <PBadge p={a.priority} />
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.45, marginBottom: 9, color: T.text, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{a.text}</div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <Avatar name={a.responsible} size={20} users={users || []} />
                      <span style={{ fontSize: 10, color: isOverdue(a) ? T.red : T.text2 }}>{fmt(a.due)}</span>
                    </div>
                    {a.pendingConfirmation && <div style={{ fontSize: 10, color: T.amber, marginTop: 5, fontWeight: 600 }}>⏳ {a.status}</div>}
                    {(a.messages || []).length > 0 && <div style={{ fontSize: 10, color: T.text2, marginTop: 4 }}>💬 {a.messages.length}</div>}
                  </div>
                );
              })}
              {/* Empty column drop zone when not dragging over */}
              {colCards.length === 0 && !isDragOver && (
                <div style={{ textAlign: "center", padding: "24px 0", fontSize: 12, color: c.dot, opacity: .35, border: `2px dashed ${c.dot}44`, borderRadius: 8 }}>
                  Empty
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TimelineView({ fa }) {
  const sorted = [...fa].filter(a => a.due).sort((a, b) => new Date(a.due) - new Date(b.due));
  if (sorted.length === 0) return <div className="card" style={{ padding: 24 }}><Empty icon="📅" title="No actions with due dates" sub="Add due dates to see timeline." /></div>;
  const minD = new Date(sorted[0].due), maxD = new Date(sorted[sorted.length - 1].due);
  const range = Math.max(1, (maxD - minD) / 86400000);
  const pct = d => Math.round((new Date(d) - minD) / 86400000 / range * 100);
  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 15, color: T.navy, marginBottom: 20 }}>Timeline — Sorted by Due Date</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.text2, marginBottom: 6 }}><span>{fmt(sorted[0].due)}</span><span style={{ color: T.red, fontWeight: 600 }}>Today</span><span>{fmt(sorted[sorted.length - 1].due)}</span></div>
      <div style={{ position: "relative", background: T.border, height: 2, borderRadius: 2, marginBottom: 20 }}>
        <div style={{ position: "absolute", left: `${pct(todayStr())}%`, top: -4, width: 2, height: 10, background: T.red, borderRadius: 2 }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {sorted.map(a => {
          const p = pct(a.due);
          const c = isOverdue(a) ? T.red : a.status === "COMPLETED" ? T.green : T.amber;
          return (
            <div key={a.id} style={{ display: "grid", gridTemplateColumns: "130px 1fr 110px", gap: 12, alignItems: "center" }}>
              <div style={{ fontSize: 11, color: T.text2, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.responsible?.split(" ")[0]}</div>
              <div style={{ position: "relative", height: 22 }}>
                <div style={{ position: "absolute", left: `${Math.min(p, 90)}%`, top: 0, background: c, borderRadius: 6, padding: "2px 8px", fontSize: 10, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.sn}: {a.text.slice(0, 28)}{a.text.length > 28 ? "…" : ""}
                </div>
              </div>
              <div style={{ fontSize: 10, color: c, fontWeight: 600 }}>{fmt(a.due)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ===================== DASHBOARD ===================== */
function DashboardPage({ actions, plants, depts, users, audit, user, meetings, onViewEscalations, refreshData, setActions: setActionsUp }) {
  const [drill, setDrill] = useState(null);
  const [deptDrill, setDeptDrill] = useState(null);
  const [mtgDrill, setMtgDrill] = useState(false);
  const [actionDetail, setActionDetail] = useState(null);
  const [plantF, setPlantF] = useState("All");
  const [deptF, setDeptF] = useState("All");
  useEscClose(useCallback(() => { setDrill(null); setDeptDrill(null); setMtgDrill(false); }, []));

  const allPlants = plants ? plants.map(p => p.name) : [...new Set(actions.map(a => a.plant))];
  // Only Admin / MD see everyone's actions on the dashboard. Everyone else
  // (including Plant Head) only sees actions where they are responsible —
  // matches the same scoping already used on the Actions Register page.
  const isDashAdmin = isUserAdmin(user);
  const userNameLower = (user?.name || "").trim().toLowerCase();
  let fa = isDashAdmin
    ? actions
    : actions.filter(a => responsibleMatchesUsers(a.responsible, [userNameLower].filter(Boolean)) || (a.allocatedBy || "").trim().toLowerCase() === userNameLower);
  if (plantF !== "All") fa = fa.filter(a => a.plant === plantF);
  if (deptF !== "All") fa = fa.filter(a => String(a.section ?? "").toLowerCase().trim() === String(deptF ?? "").toLowerCase().trim() || String(a.dept ?? "").toLowerCase().trim() === String(deptF ?? "").toLowerCase().trim());

  const total = fa.length, comp = fa.filter(a => a.status === "COMPLETED").length, ip = fa.filter(a => normalizeStatus(a.status) === "IN PROCESS").length;
  const ns = fa.filter(a => a.status === "NOT STARTED").length, drop = fa.filter(a => a.status === "DROPPED").length;
  const over = fa.filter(isOverdue).length, crit = fa.filter(a => a.priority === "CRITICAL" && a.status !== "COMPLETED" && a.status !== "DROPPED").length;
  const pendingConf = fa.filter(a => a.pendingConfirmation).length;
  const revs = fa.reduce((s, a) => s + (Number(a.revisions) || 0), 0);
  // On-time rate: for each completed action, 100 if closedOn<=due, else 0; then average
  const onT = comp > 0 ? Math.round(fa.filter(a => a.status === "COMPLETED").reduce((sum, a) => {
    if (!a.due || !a.closedOn) return sum + 0;
    return sum + (new Date(a.closedOn) <= new Date(a.due) ? 100 : 0);
  }, 0) / comp) : 0;
  // Non-admins only ever see their own department on the heat map, regardless
  // of the department filter dropdown.
  const deptScopedDepts = isDashAdmin ? depts : depts.filter(d => String(d.name ?? "").toLowerCase().trim() === String(user?.dept ?? "").toLowerCase().trim());
  const visibleDepts = deptF !== "All" ? deptScopedDepts.filter(d => String(d.name ?? "").toLowerCase().trim() === String(deptF ?? "").toLowerCase().trim()) : (plantF !== "All" ? deptScopedDepts.filter(d => (users || []).some(u => u.plant === plantF && u.dept === d.name) || fa.some(a => String(a.section ?? "").toLowerCase().trim() === String(d.name ?? "").toLowerCase().trim())) : deptScopedDepts);

  // Build heat map rows: merge dept master + unique section values from actual actions
  // This ensures actions always appear even if section doesn't match any dept name
  const heatmapRows = visibleDepts.map(d => ({ id: d.id, name: d.name, head: d.head, icon: d.icon || "🏭", fromDept: true }));

  const scopedMeetings = isDashAdmin ? (meetings || []) : (meetings || []).filter(m => canAccessMeeting(user, m, null));
  const allSessions = scopedMeetings.flatMap(m => (Array.isArray(m.completedSessions) ? m.completedSessions : []).map(s => ({ ...s, type: m.type, plant: m.plant })));
  const totalMtgMins = allSessions.reduce((s, x) => s + (x.duration || 0), 0);
  // Deduplicate audit for badge (keep highest level per action SN) — scoped to
  // the same action set (fa) the user is allowed to see, not the global audit log.
  const faSnSet = new Set(fa.map(a => a.sn));
  const scopedAudit = isDashAdmin ? (audit || []) : (audit || []).filter(e => faSnSet.has(e.sn));
  const dedupedAuditBadge = Object.values(
    scopedAudit.reduce((acc, e) => {
      if (!acc[e.sn] || e.level > acc[e.sn].level) acc[e.sn] = e;
      return acc;
    }, {})
  );

  return (
    <div className="fade-in">
      <PageHeader title="Dashboard" sub="Live accountability snapshot">
        <div className="filter-bar" style={{ gap: 10, alignItems: "flex-end" }}>
          {refreshData && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4 }}>&nbsp;</span>
              <button className="btn btn-ghost" onClick={refreshData} style={{ border: `1px solid ${T.border}`, background: "#fff", fontSize: 13, padding: "6px 14px" }}>🔄 Refresh</button>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4 }}>Plant</span>
            <select value={plantF} onChange={e => setPlantF(e.target.value)} style={{ padding: "6px 10px" }}>
              <option value="All">All Plants</option>{scopedPlants(user, plants).map(p => <option key={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4 }}>Department</span>
            <select value={deptF} onChange={e => setDeptF(e.target.value)} style={{ padding: "6px 10px" }}>
              <option value="All">All Departments</option>{scopedDepts(user, depts).map(d => <option key={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>
      </PageHeader>

      <div className="grid-kpi-4" style={{ marginBottom: 12 }}>
        <KPICard icon="✅" value={total} label="Total Actions" sub="All records" color={T.navy} onClick={() => setDrill("aging")} />
        <KPICard icon="⚠" value={over} label="Overdue" sub="Need attention" color={T.red} alert={over > 0} onClick={() => setDrill("overdue")} />
        <KPICard icon="🔴" value={crit} label="Critical Open" sub="Unresolved" color={T.red} alert={crit > 0} onClick={() => setDrill("critical")} />
        <KPICard icon="🎯" value={`${onT}%`} label="On-Time Rate" sub="Completed on schedule" color={onT >= 80 ? T.green : T.amber} onClick={() => setDrill("ontime")} />
      </div>
      <div className="grid-kpi-4" style={{ marginBottom: 20 }}>
        <KPICard icon="📅" value={revs} label="Date Revisions" sub="Scope creep tracker" color={revs > 5 ? T.amber : T.slate} onClick={() => setDrill("revisions")} />
        <KPICard icon="🚨" value={dedupedAuditBadge.length} label="Escalated Actions" sub="View all →" color={T.red} alert={dedupedAuditBadge.length > 0} onClick={() => setDrill("escalated")} />
        <KPICard icon="⏳" value={pendingConf} label="Pending Confirm" sub="Awaiting approval" color={T.amber} alert={pendingConf > 0} onClick={() => setDrill("pending")} />
        <div className="card card-hover" onClick={() => setMtgDrill(true)} style={{ padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: T.navy + "18", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 }}>🎙</div>
            <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 24, fontWeight: 800, color: T.navy, lineHeight: 1 }}>{totalMtgMins}<span style={{ fontSize: 12, fontWeight: 400, color: T.text2, marginLeft: 2 }}>min</span></div>
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>Meetings Ran</div>
          <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{allSessions.length} sessions · click to see</div>
        </div>
      </div>

      <div className="card status-bar" style={{ padding: "14px 24px", marginBottom: 20, gap: 0, alignItems: "center" }}>
        {[{ s: "NOT STARTED", n: ns }, { s: "IN PROCESS", n: ip }, { s: "COMPLETED", n: comp }, { s: "DROPPED", n: drop }].map((k, i, arr) => (
          <div key={k.s} onClick={() => setDrill(k.s.toLowerCase().replace(/ /g, "_"))} style={{ flex: 1, padding: "0 18px", borderRight: i < arr.length - 1 ? `1.5px solid ${T.border}` : "none", cursor: "pointer" }}>
            <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 22, fontWeight: 700, color: SC[k.s]?.dot || T.slate }}>{k.n}</div>
            <div style={{ marginTop: 5 }}><SBadge s={k.s} /></div>
          </div>
        ))}
        <div style={{ flex: 1.8, padding: "0 18px", borderLeft: `1.5px solid ${T.border}` }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.text2, marginBottom: 6, letterSpacing: .5, textTransform: "uppercase" }}>Completion</div>
          <div style={{ background: T.border, borderRadius: 6, height: 10, overflow: "hidden" }}><div style={{ height: "100%", borderRadius: 6, background: `linear-gradient(90deg,${T.green},${T.amber})`, width: `${total ? Math.round(comp / total * 100) : 0}%`, transition: "width .6s" }} /></div>
          <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>{total ? Math.round(comp / total * 100) : 0}% complete</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 20 }}>
        <div style={{ padding: "14px 20px", borderBottom: `1.5px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 14, color: T.navy }}>Department Accountability Heat Map</div><div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>Health = Red if any critical open, Amber if any overdue, else Green. Completion % = closed / total actions.</div></div>
          <div style={{ display: "flex", gap: 14, fontSize: 11, color: T.text2 }}>
            {[{ c: T.red, l: "Critical" }, { c: T.amber, l: "Overdue" }, { c: T.green, l: "On track" }].map(x => (
              <span key={x.l} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: x.c, display: "inline-block" }} />{x.l}</span>
            ))}
          </div>
        </div>
        <table>
          <thead><tr><th>Department</th><th style={{ textAlign: "center" }}>Total</th><th style={{ textAlign: "center" }}>Open</th><th style={{ textAlign: "center" }}>Critical</th><th style={{ textAlign: "center" }}>Overdue</th><th>Completion</th><th style={{ textAlign: "center" }}>Health</th></tr></thead>
          <tbody>{heatmapRows.map(d => {
            const dname = String(d.name ?? "").toLowerCase().trim();
            const da = fa.filter(a => {
              const sec = String(a.section ?? "").toLowerCase().trim();
              const dept = String(a.dept ?? "").toLowerCase().trim();
              return sec === dname || dept === dname;
            });
            const open = da.filter(a => a.status !== "COMPLETED" && a.status !== "DROPPED").length;
            const c = da.filter(a => a.priority === "CRITICAL" && a.status !== "COMPLETED" && a.status !== "DROPPED").length;
            const o = da.filter(isOverdue).length;
            const dn = da.filter(a => a.status === "COMPLETED").length;
            const r = da.length ? Math.round(dn / da.length * 100) : 0;
            const health = da.length === 0 ? "nodata" : c > 0 ? "red" : o > 0 ? "amber" : "green";
            const hc = health === "red" ? T.red : health === "amber" ? T.amber : health === "nodata" ? T.slate : T.green;
            const hb = health === "red" ? T.redL : health === "amber" ? T.amberL : health === "nodata" ? "#F0F0F8" : T.greenL;
            return (
              <tr key={d.id} style={{ cursor: "pointer" }} onClick={() => setDeptDrill(d)}>
                <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: hc, flexShrink: 0 }} /><span style={{ fontSize: 18 }}>{d.icon}</span><div><div style={{ fontWeight: 600, fontSize: 13 }}>{d.name}</div><div style={{ fontSize: 11, color: T.text2 }}>{d.head && d.head !== "—" ? `HOD: ${d.head}` : d.fromDept ? "" : "Section"}</div></div></div></td>
                <td style={{ textAlign: "center" }}><span style={{ fontFamily: "'Sora',sans-serif", fontWeight: 700, fontSize: 14, color: T.navy }}>{da.length}</span></td>
                <td style={{ textAlign: "center", fontWeight: 600, color: open > 0 ? T.amber : T.green }}>{open}</td>
                <td style={{ textAlign: "center", fontWeight: 700, color: c > 0 ? T.red : T.text2 }}>{c}</td>
                <td style={{ textAlign: "center", fontWeight: 700, color: o > 0 ? T.red : T.text2 }}>{o}</td>
                <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Sparkbar pct={r} color={r >= 80 ? T.green : r >= 50 ? T.amber : T.red} /><span style={{ fontSize: 12, fontWeight: 700, color: r >= 80 ? T.green : r >= 50 ? T.amber : T.red, minWidth: 30 }}>{r}%</span></div></td>
                <td style={{ textAlign: "center" }}><span style={{ padding: "3px 10px", borderRadius: 20, background: hb, color: hc, fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{health}</span></td>
              </tr>
            );
          })}
          {heatmapRows.length === 0 && (
            <tr><td colSpan={7} style={{ textAlign: "center", padding: "28px 0", color: T.text2, fontSize: 13 }}>No departments or actions found for this filter.</td></tr>
          )}
          </tbody>
        </table>
      </div>

      <div className="grid-2col">
        {/* Feature 8: Clickable Critical & Overdue with slide-in panel */}
        <div className="card card-hover" style={{ padding: 20, cursor: "pointer" }} onClick={() => setDrill("criticalOverdue")}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: T.navy }}>Critical and Overdue</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ background: T.redL, color: T.red, padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{fa.filter(a => (a.priority === "CRITICAL" || isOverdue(a)) && a.status !== "COMPLETED" && a.status !== "DROPPED").length}</span>
              <span style={{ fontSize: 11, color: T.navy, fontWeight: 700 }}>View All →</span>
            </div>
          </div>
          {fa.filter(a => (a.priority === "CRITICAL" || isOverdue(a)) && a.status !== "COMPLETED" && a.status !== "DROPPED").length === 0
            ? <Empty icon="✅" title="All clear" sub="No critical or overdue issues." />
            : fa.filter(a => (a.priority === "CRITICAL" || isOverdue(a)) && a.status !== "COMPLETED" && a.status !== "DROPPED").slice(0, 4).map(a => (
              <div key={a.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: `1px solid ${T.border}`, alignItems: "flex-start" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: a.priority === "CRITICAL" ? T.red : T.amber, marginTop: 4, flexShrink: 0 }} />
                <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.4 }}>{a.text.slice(0, 55)}{a.text.length > 55 ? "…" : ""}</div><div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{a.section} · {isOverdue(a) ? <span style={{ color: T.red, fontWeight: 600 }}>{daysOver(a)}d late</span> : fmt(a.due)}</div></div>
                <Avatar name={a.responsible} size={24} users={users} />
              </div>
            ))
          }
        </div>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: T.navy }}>Escalation Alerts</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ background: T.redL, color: T.red, padding: "3px 9px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{dedupedAuditBadge.length} logged</span>
              <button onClick={() => onViewEscalations && onViewEscalations()} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 11, color: T.navy, fontWeight: 700, padding: 0 }}>View All →</button>
            </div>
          </div>
          {audit.length === 0
            ? <Empty icon="🔇" title="No escalations" sub="All within thresholds." />
            : audit.slice(0, 5).map(e => (
              <div key={e.id} style={{ display: "flex", gap: 10, padding: "10px 0", borderBottom: `1px solid ${T.border}`, alignItems: "flex-start" }}>
                <span style={{ padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 700, flexShrink: 0, background: getEscBadgeStyle(e.level).bg, color: getEscBadgeStyle(e.level).color }}>L{e.level}</span>
                <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 500 }}>{e.text.slice(0, 55)}{e.text.length > 55 ? "…" : ""}</div><div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{e.target} · {e.reason}</div></div>
              </div>
            ))
          }
        </div>
      </div>

      {/* Feature 8: Critical/Overdue slide-in side panel */}
      {drill === "criticalOverdue" && (() => {
        const critOverdue = fa.filter(a => (a.priority === "CRITICAL" || isOverdue(a)) && a.status !== "COMPLETED" && a.status !== "DROPPED").sort((a, b) => daysOver(b) - daysOver(a));
        return (
          <>
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 340 }} onClick={() => setDrill(null)} />
            <div className="side-panel" style={{ width: 480, padding: 0, zIndex: 355 }}>
              <div style={{ background: `linear-gradient(135deg,${T.red},#E74C3C)`, padding: "20px 24px", color: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 10, opacity: .7, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Dashboard Alert</div>
                    <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 18, fontWeight: 800, marginBottom: 4 }}>Critical & Overdue</h2>
                    <div style={{ fontSize: 12, opacity: .8 }}>{critOverdue.length} items requiring immediate attention</div>
                  </div>
                  <button onClick={() => setDrill(null)} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                </div>
              </div>
              <div style={{ overflowY: "auto", flex: 1, padding: 20 }}>
                {critOverdue.length === 0 ? <Empty icon="✅" title="All clear!" sub="No critical or overdue actions." /> :
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {critOverdue.map(a => (
                      <div key={a.id} style={{ background: T.bg, borderRadius: 10, padding: "14px 16px", border: `1.5px solid ${a.priority === "CRITICAL" ? T.red : T.amber}30`, cursor: "pointer", transition: "transform .15s" }} onClick={() => { setDrill(null); setActionDetail(a); }} onMouseEnter={e => e.currentTarget.style.transform = "translateY(-1px)"} onMouseLeave={e => e.currentTarget.style.transform = "none"}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                          <span style={{ fontFamily: "monospace", fontSize: 10, color: T.text2 }}>{a.sn}</span>
                          <div style={{ display: "flex", gap: 6 }}><SBadge s={a.status} /><PBadge p={a.priority} /></div>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, lineHeight: 1.4 }}>{a.text}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <Avatar name={a.responsible} size={22} users={users} />
                            <span style={{ fontSize: 12, color: T.text2 }}>{a.responsible}</span>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 700, color: isOverdue(a) ? T.red : T.amber }}>{isOverdue(a) ? `${daysOver(a)}d overdue` : fmt(a.due)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                }
              </div>
            </div>
          </>
        );
      })()}

      {drill && drill !== "criticalOverdue" && (() => {
        const drillData = {
          overdue: { title: "Overdue Actions", icon: "⚠", color: T.red, rows: fa.filter(isOverdue).sort((a, b) => daysOver(b) - daysOver(a)) },
          critical: { title: "Critical Open Actions", icon: "🔴", color: T.red, rows: fa.filter(a => a.priority === "CRITICAL" && a.status !== "COMPLETED" && a.status !== "DROPPED") },
          ontime: { title: "On-Time Closure", icon: "🎯", color: T.green, rows: fa.filter(a => a.status === "COMPLETED") },
          revisions: { title: "Date Revision Actions", icon: "📅", color: T.amber, rows: fa.filter(a => a.revisions > 0).sort((a, b) => b.revisions - a.revisions) },
          pending: { title: "Pending Confirmation", icon: "⏳", color: T.amber, rows: fa.filter(a => a.pendingConfirmation) },
          aging: { title: "All Actions — Aging View", icon: "📊", color: T.navy, rows: fa },
          not_started: { title: "Not Started Actions", icon: "⭕", color: T.slate, rows: fa.filter(a => a.status === "NOT STARTED") },
          in_process: { title: "In Process Actions", icon: "🔄", color: T.amber, rows: fa.filter(a => normalizeStatus(a.status) === "IN PROCESS") },
          dropped: { title: "Dropped Actions", icon: "🚫", color: T.text2, rows: fa.filter(a => a.status === "DROPPED") },
          escalated: { title: "Escalated Actions", icon: "🚨", color: T.red, rows: fa.filter(a => audit.find(e => e.sn === a.sn)) },
        };
        const d = drillData[drill];
        if (!d) return null;
        return (
          <>
            <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.3)", zIndex: 340 }} onClick={() => setDrill(null)} />
            <div className="side-panel" style={{ width: 520, padding: 0, zIndex: 355 }}>
              <div style={{ background: `linear-gradient(135deg,${d.color},${d.color}CC)`, padding: "20px 24px", color: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 10, opacity: .7, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Dashboard Drill-Down</div>
                    <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 18, fontWeight: 800, marginBottom: 4 }}>{d.icon} {d.title}</h2>
                    <div style={{ fontSize: 12, opacity: .8 }}>{d.rows.length} action{d.rows.length !== 1 ? "s" : ""}</div>
                  </div>
                  <button onClick={() => setDrill(null)} style={{ background: "rgba(255,255,255,.2)", border: "none", color: "#fff", borderRadius: 8, width: 32, height: 32, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                </div>
              </div>
              <div style={{ overflowY: "auto", flex: 1, padding: 20 }}>
                {d.rows.length === 0 ? <Empty icon="📭" title="No records" sub="Nothing to show for this filter." /> :
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {d.rows.slice(0, 30).map(a => (
                      <div key={a.id} style={{ background: T.bg, borderRadius: 10, padding: "12px 14px", border: `1.5px solid ${isOverdue(a) ? T.red + "40" : T.border}`, cursor: "pointer", transition: "transform .15s" }} onClick={() => { setDrill(null); setActionDetail(a); }} onMouseEnter={e => e.currentTarget.style.transform = "translateY(-1px)"} onMouseLeave={e => e.currentTarget.style.transform = "none"}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                          <span style={{ fontFamily: "monospace", fontSize: 10, color: T.text2 }}>{a.sn}</span>
                          <div style={{ display: "flex", gap: 5 }}><SBadge s={displayStatus(a)} /><PBadge p={a.priority} /></div>
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, lineHeight: 1.4 }}>{a.text}</div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <Avatar name={a.responsible} size={22} users={users} />
                            <span style={{ fontSize: 12, color: T.text2 }}>{a.responsible || "Unassigned"}</span>
                          </div>
                          <div style={{ display: "flex", gap: 8, fontSize: 11, color: T.text2 }}>
                            {drill === "revisions" && <span style={{ fontWeight: 700, color: T.amber }}>{a.revisions} revision{a.revisions !== 1 ? "s" : ""}</span>}
                            {drill === "escalated" && <span style={{ fontWeight: 700, color: T.red }}>L{Math.max(...(audit.filter(e => e.sn === a.sn).map(e => e.level || 1)))} escalated</span>}
                            <span style={{ color: isOverdue(a) ? T.red : T.text2, fontWeight: isOverdue(a) ? 700 : 400 }}>{isOverdue(a) ? `${daysOver(a)}d overdue` : fmt(a.due)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                }
              </div>
            </div>
          </>
        );
      })()}

      {mtgDrill && (
        <div className="overlay" onClick={() => setMtgDrill(false)}>
          <div className="modal" style={{ width: 620, padding: 28 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 18, fontWeight: 800, color: T.navy }}>Meeting Duration Summary</h2>
              <button onClick={() => setMtgDrill(false)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>x</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 20 }}>
              {[{ l: "Total Sessions", v: allSessions.length, c: T.navy }, { l: "Total Minutes", v: totalMtgMins, c: T.amber }, { l: "Avg Duration", v: allSessions.length ? Math.round(totalMtgMins / allSessions.length) + "min" : "—", c: T.green }].map(k => (
                <div key={k.l} style={{ textAlign: "center", background: T.bg, borderRadius: 10, padding: "16px 8px" }}>
                  <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 28, fontWeight: 800, color: k.c }}>{k.v}</div>
                  <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>{k.l}</div>
                </div>
              ))}
            </div>
            {scopedMeetings.map(m => {
              const sessions = m.completedSessions || [];
              const totalMin = sessions.reduce((s, x) => s + (x.duration || 0), 0);
              return (
                <div key={m.id} style={{ padding: "12px 0", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div><div style={{ fontWeight: 600, fontSize: 13 }}>{m.name || m.type}</div><div style={{ fontSize: 11, color: T.text2 }}>{m.plant} · {m.project && <span style={{ color: T.amber }}>📎 {m.project}</span>}</div></div>
                    <div style={{ textAlign: "right" }}><div style={{ fontFamily: "'Sora',sans-serif", fontSize: 18, fontWeight: 700, color: T.navy }}>{totalMin}min</div><div style={{ fontSize: 10, color: T.text2 }}>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</div></div>
                  </div>
                  {sessions.length > 0 && <div style={{ display: "flex", gap: 8, flexWrap: "nowrap", overflowX: "auto" }}>{sessions.map((s, i) => <div key={i} style={{ background: T.bg, borderRadius: 6, padding: "4px 10px", fontSize: 11 }}>{fmt(s.date)} — <b>{s.duration}min</b></div>)}</div>}
                  {sessions.length === 0 && <div style={{ fontSize: 11, color: T.text2, fontStyle: "italic" }}>No sessions recorded yet</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {deptDrill && (() => {
        const da = fa.filter(a => String(a.section ?? "").toLowerCase().trim() === String(deptDrill.name ?? "").toLowerCase().trim() || String(a.dept ?? "").toLowerCase().trim() === String(deptDrill.name ?? "").toLowerCase().trim());
        const dopen = da.filter(a => a.status !== "COMPLETED" && a.status !== "DROPPED").length;
        const dover = da.filter(isOverdue).length, ddone = da.filter(a => a.status === "COMPLETED").length;
        return (
          <div className="overlay" onClick={() => setDeptDrill(null)}>
            <div className="modal" style={{ width: 660, padding: 28 }} onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}><span style={{ fontSize: 28 }}>{deptDrill.icon}</span><div><h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 17, fontWeight: 800, color: T.navy }}>{deptDrill.name}</h2><div style={{ fontSize: 12, color: T.text2 }}>HOD: {deptDrill.head}</div></div></div>
                <button onClick={() => setDeptDrill(null)} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2 }}>x</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, margin: "14px 0" }}>
                {[{ l: "Total", v: da.length, c: T.navy }, { l: "Open", v: dopen, c: T.amber }, { l: "Overdue", v: dover, c: T.red }, { l: "Done", v: ddone, c: T.green }].map(k => (
                  <div key={k.l} style={{ textAlign: "center", background: T.bg, borderRadius: 8, padding: "12px 8px" }}>
                    <div style={{ fontFamily: "'Sora',sans-serif", fontSize: 26, fontWeight: 800, color: k.c }}>{k.v}</div>
                    <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{k.l}</div>
                  </div>
                ))}
              </div>
              <table><thead><tr><th>SN</th><th>Action</th><th>Reason</th><th>Responsible</th><th>Status</th><th>Due</th></tr></thead>
                <tbody>{da.map(a => (
                  <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => { setActionDetail(a); setDeptDrill(null); }} onMouseEnter={e => { Array.from(e.currentTarget.cells).forEach(c => c.style.background = "#FAFAFE"); }} onMouseLeave={e => { Array.from(e.currentTarget.cells).forEach(c => c.style.background = ""); }}><td style={{ fontFamily: "monospace", fontSize: 11, color: T.text2 }}>{a.sn}</td><td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{a.text}</td><td style={{ maxWidth: 140, fontSize: 11, color: T.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.reasonOfAction || "—"}</td><td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><Avatar name={a.responsible} size={22} users={users} /><span style={{ fontSize: 12 }}>{a.responsible?.split(" ")[0]}</span></div></td><td><SBadge s={a.status} /></td><td style={{ fontSize: 12, color: isOverdue(a) ? T.red : T.text }}>{fmt(a.due)}</td></tr>
                ))}</tbody></table>
              {da.length > 0 && <div style={{ fontSize: 11, color: T.text2, marginTop: 8, fontStyle: "italic" }}>💡 Click any row to open and edit the action</div>}
            </div>
          </div>
        );
      })()}
      {actionDetail && <ActionDetailPanel action={actionDetail} onClose={() => setActionDetail(null)} onUpdate={(id, patch) => { if (setActionsUp) setActionsUp(p => p.map(a => a.id !== id ? a : { ...a, ...patch })); setActionDetail(p => p ? { ...p, ...patch } : p); }} user={user} users={users} allUsers={users} plants={plants} meetings={meetings} />}
    </div>
  );
}



/* ===================== MASTER SETUP ===================== */
/* ===================== ESCALATION MATRIX TAB ===================== */
function EscMatrixTab({ escMatrix, setEscMatrix, onSave, isAdmin, canModify, users = [], roles = [] }) {
  const PRIORITIES = ["CRITICAL", "WARNING", "NORMAL"];
  const USER_NAMES = (users || []).map(u => u.name).filter(Boolean);
  const METHODS = ["In-App", "In-App + Email", "Email Only", "SMS + Email"];
  const [editRow, setEditRow] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [userFilter, setUserFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [syncingMatrix, setSyncingMatrix] = useState(false);
  const [matrixSyncMsg, setMatrixSyncMsg] = useState("");
  const upDraft = (k, v) => setEditDraft(d => ({ ...d, [k]: v }));

  const checkCanModify = (rowId) => isAdmin || (canModify && canModify("escMatrix", rowId));

  const normPriorities = (p) => {
    if (Array.isArray(p)) return p;
    if (typeof p === "string" && p.trim()) return p.split(",").map(x => x.trim()).filter(Boolean);
    return ["CRITICAL", "WARNING", "NORMAL"];
  };
  const startEdit = (tier) => { setEditRow(tier.id); setEditDraft({ ...tier, priorities: normPriorities(tier.priorities) }); };
  const saveEdit = () => {
    const finalDraft = { ...editDraft };
    if (finalDraft.fromUser && finalDraft.targetUser && !finalDraft.label?.trim()) {
      finalDraft.label = `Level ${finalDraft.level} — ${finalDraft.fromUser} → ${finalDraft.targetUser}`;
    }
    setEscMatrix(m => m.map(t => t.id === editRow ? finalDraft : t));
    apiUpdate("escalation/matrix", editRow, finalDraft);
    setEditRow(null); setEditDraft(null);
  };
  const cancelEdit = () => { setEditRow(null); setEditDraft(null); };
  const addTier = () => {
    const matrix = escMatrix || DEFAULT_ESC_MATRIX;
    const maxLvl = Math.max(...matrix.map(t => t.level), 0);
    const newTier = {
      id: "E" + crypto.randomUUID().slice(0, 8),
      level: maxLvl + 1,
      fromUser: "",
      targetUser: "",
      label: "",
      overdueDays: maxLvl * 3 + 3,
      overdueHrs: (maxLvl * 3 + 3) * 24,
      notifyMethod: "In-App + Email",
      priorities: ["CRITICAL"],
      applicableTo: "All",
      color: T.slate,
      active: true,
      description: "",
    };
    setEscMatrix(m => [...m, newTier]);
    apiCreate("escalation/matrix", newTier);
    setEditRow(newTier.id); setEditDraft({ ...newTier, priorities: [...newTier.priorities] });
  };
  const deleteTier = (id) => { setEscMatrix(m => m.filter(t => t.id !== id)); apiRemove("escalation/matrix", id); };
  const toggleActive = (id) => setEscMatrix(m => {
    const t = m.find(x => x.id === id);
    const nextActive = !t?.active;
    apiUpdate("escalation/matrix", id, { active: nextActive });
    return m.map(x => x.id === id ? { ...x, active: nextActive } : x);
  });

  const allMatrix = (escMatrix || DEFAULT_ESC_MATRIX)
    .map(t => ({ ...t, priorities: normPriorities(t.priorities) }));

  const matrix = allMatrix
    .filter(t => !userFilter || (t.fromUser || "") === userFilter)
    .filter(t => !levelFilter || t.level === Number(levelFilter))
    .sort((a, b) => a.level - b.level || (a.fromUser || "").localeCompare(b.fromUser || ""));

  const usersInUse = [...new Set(allMatrix.filter(t => t.active).map(t => t.fromUser).filter(Boolean))].sort();
  const chainByUser = {};
  usersInUse.forEach(u => {
    chainByUser[u] = allMatrix
      .filter(t => t.active && t.fromUser === u)
      .sort((a, b) => a.level - b.level);
  });

  return (
    <div>
      <div className="card" style={{ padding: "18px 22px", marginBottom: 14, background: `linear-gradient(135deg,${T.navy},#3D378C)`, color: "#fff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 16, marginBottom: 4 }}>🚨 User-Wise Escalation Matrix</div>
            <div style={{ fontSize: 12, opacity: .8 }}>When an action goes overdue, alerts are sent to the specific user configured in each tier.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "nowrap", overflowX: "auto" }}>
            {onSave && <SectionSaveButton onSave={onSave} />}
            <button
              onClick={async () => {
                setSyncingMatrix(true); setMatrixSyncMsg("");
                try { await apiPost("/api/escalation/sync-matrix-to-sheet", {}); setMatrixSyncMsg("Synced!"); }
                catch (e) { setMatrixSyncMsg("Failed"); }
                setSyncingMatrix(false);
                setTimeout(() => setMatrixSyncMsg(""), 3000);
              }}
              disabled={syncingMatrix}
              style={{ background: "rgba(255,255,255,.2)", border: "1px solid rgba(255,255,255,.3)", color: "#fff", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700, opacity: syncingMatrix ? 0.6 : 1 }}>
              {syncingMatrix ? "Syncing…" : matrixSyncMsg || "📊 Sync to Sheets"}
            </button>
            {(isAdmin || onSave) && <button onClick={addTier} style={{ background: "rgba(255,255,255,.2)", border: "1px solid rgba(255,255,255,.3)", color: "#fff", borderRadius: 8, padding: "7px 16px", cursor: "pointer", fontSize: 12, fontWeight: 700 }}>+ Add Tier</button>}
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: "16px 22px", marginBottom: 14, overflow: "hidden" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.text2, marginBottom: 12, textTransform: "uppercase", letterSpacing: .5 }}>Escalation Chains by Responsible Person</div>
        {usersInUse.length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic" }}>No active tiers defined.</div>}
        {usersInUse.map(userName => {
          const chain = chainByUser[userName];
          return (
            <div key={userName} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, overflowX: "auto", paddingBottom: 4 }}>
              <div style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: T.navy, background: T.bg, padding: "5px 10px", borderRadius: 6, minWidth: 110 }}>{userName}</div>
              <div style={{ fontSize: 14, color: T.text2, flexShrink: 0 }}>→</div>
              {chain.map((t, i, arr) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                  <div style={{ textAlign: "center", minWidth: 90 }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: t.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 11, margin: "0 auto 4px", boxShadow: `0 0 0 2px ${t.color}30` }}>L{t.level}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: T.text }}>{t.targetUser || "—"}</div>
                    <div style={{ fontSize: 9, color: T.text2, marginTop: 1 }}>+{t.overdueDays}d</div>
                  </div>
                  {i < arr.length - 1 && <div style={{ fontSize: 12, color: T.text2, margin: "0 4px", flexShrink: 0 }}>→</div>}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="card" style={{ padding: 12, marginBottom: 14, display: "flex", gap: 10, flexWrap: "nowrap", overflowX: "auto", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: T.text2, textTransform: "uppercase", letterSpacing: .4 }}>Filter:</span>
        <select value={userFilter} onChange={e => setUserFilter(e.target.value)} style={{ width: 180, padding: "6px 10px" }}>
          <option value="">All Responsible Users</option>
          {USER_NAMES.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <select value={levelFilter} onChange={e => setLevelFilter(e.target.value)} style={{ width: 130, padding: "6px 10px" }}>
          <option value="">All Levels</option>
          <option value="1">Level 1</option>
          <option value="2">Level 2</option>
          <option value="3">Level 3</option>
          <option value="4">Level 4</option>
          <option value="5">Level 5+</option>
        </select>
        {(userFilter || levelFilter) && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setUserFilter(""); setLevelFilter(""); }} style={{ padding: "6px 10px" }}>Clear</button>
        )}
        <span style={{ fontSize: 11, color: T.text2, marginLeft: "auto" }}>Showing {matrix.length} of {allMatrix.length} tiers</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {matrix.map(tier => {
          const isEditing = editRow === tier.id;
          const editable = checkCanModify(tier.id);
          return (
            <div key={tier.id} className="card" style={{ padding: 0, overflow: "hidden", opacity: tier.active ? 1 : .55, border: `1.5px solid ${isEditing ? tier.color : T.border}`, transition: "all .2s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: isEditing ? `1px solid ${T.border}` : "none", background: isEditing ? T.bg : "transparent" }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: tier.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14, flexShrink: 0 }}>L{tier.level}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{tier.label || `Level ${tier.level}`}</div>
                  <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>{tier.description || "No description"}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {editable && (
                    <button onClick={() => toggleActive(tier.id)} title={tier.active ? "Disable" : "Enable"} style={{ background: tier.active ? T.green : "#e2e8f0", border: "none", borderRadius: 12, width: 42, height: 22, cursor: "pointer", transition: "all .2s", position: "relative", flexShrink: 0 }}>
                      <span style={{ position: "absolute", top: 2, left: tier.active ? 22 : 2, width: 18, height: 18, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "all .2s", display: "block" }} />
                    </button>
                  )}
                  {editable && <span style={{ fontSize: 10, color: tier.active ? T.green : T.text2, fontWeight: 600, minWidth: 36 }}>{tier.active ? "ON" : "OFF"}</span>}
                  {!isEditing && editable && <button onClick={() => startEdit(tier)} style={{ fontSize: 11, background: T.navy, color: "#fff", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>Edit</button>}
                  {!isEditing && editable && <button onClick={() => deleteTier(tier.id)} style={{ fontSize: 11, background: "transparent", color: T.red, border: `1px solid ${T.red}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600 }}>Delete</button>}
                  {isEditing && <button onClick={saveEdit} style={{ fontSize: 11, background: T.green, color: "#fff", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 600 }}>Save</button>}
                  {isEditing && <button onClick={cancelEdit} style={{ fontSize: 11, background: "transparent", color: T.text2, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600 }}>Cancel</button>}
                </div>
              </div>
              {!isEditing && (
                <div style={{ display: "flex", gap: 10, padding: "10px 18px", flexWrap: "nowrap", overflowX: "auto", alignItems: "center" }}>
                  <span style={{ fontSize: 11, background: T.bg, borderRadius: 6, padding: "4px 10px", color: T.text }}><b>Responsible:</b> {tier.fromUser || "—"}</span>
                  <span style={{ fontSize: 14, color: T.text2 }}>→</span>
                  <span style={{ fontSize: 11, background: T.bg, borderRadius: 6, padding: "4px 10px", color: T.text }}><b>Notify:</b> {tier.targetUser || "—"}</span>
                  <span style={{ fontSize: 11, background: T.bg, borderRadius: 6, padding: "4px 10px", color: T.text }}><b>Trigger:</b> {tier.overdueDays === 0 ? "On due date" : `${tier.overdueDays} day${tier.overdueDays !== 1 ? "s" : ""} overdue`}</span>
                  <span style={{ fontSize: 11, background: T.bg, borderRadius: 6, padding: "4px 10px", color: T.text }}><b>Notify via:</b> {tier.notifyMethod}</span>
                  <div style={{ display: "flex", gap: 4, flexWrap: "nowrap", overflowX: "auto" }}>
                    {tier.priorities.map(p => <span key={p} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 10, fontWeight: 700, background: p === "CRITICAL" ? T.redL : p === "WARNING" ? T.amberL : "#E8F4F8", color: p === "CRITICAL" ? T.red : p === "WARNING" ? T.amber : "#1A6B8A" }}>{p}</span>)}
                  </div>
                </div>
              )}
              {isEditing && editDraft && (
                <div className="grid-3col" style={{ padding: "16px 18px", gap: 12 }}>
                  <div style={{ gridColumn: "1/-1" }}><Lbl t="Tier Label (auto-built if left blank)" /><input value={editDraft.label || ""} onChange={e => upDraft("label", e.target.value)} placeholder={`Level ${editDraft.level} — ${editDraft.fromUser || "From"} → ${editDraft.targetUser || "To"}`} /></div>
                  <div style={{ gridColumn: "1/-1" }}><Lbl t="Description" /><input value={editDraft.description || ""} onChange={e => upDraft("description", e.target.value)} placeholder="Brief explanation of this escalation level" /></div>
                  <div>
                    <Lbl t="Responsible Person (from)" req />
                    <select value={editDraft.fromUser || ""} onChange={e => upDraft("fromUser", e.target.value)}>
                      <option value="">— select —</option>
                      {USER_NAMES.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <Lbl t="Escalate To (notify)" req />
                    <select value={editDraft.targetUser || ""} onChange={e => upDraft("targetUser", e.target.value)}>
                      <option value="">— select —</option>
                      {USER_NAMES.map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <Lbl t="Level" req />
                    <input type="number" min={1} max={10} value={editDraft.level} onChange={e => upDraft("level", +e.target.value)} />
                  </div>
                  <div>
                    <Lbl t="Overdue Days (trigger)" req />
                    <input type="number" min={0} max={365} value={editDraft.overdueDays} onChange={e => { const d = +e.target.value; upDraft("overdueDays", d); upDraft("overdueHrs", d * 24); }} />
                    <div style={{ fontSize: 10, color: T.text2, marginTop: 3 }}>0 = triggers on due date</div>
                  </div>
                  <div>
                    <Lbl t="Notification Method" />
                    <select value={editDraft.notifyMethod} onChange={e => upDraft("notifyMethod", e.target.value)}>
                      {METHODS.map(m => <option key={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <Lbl t="Badge Color" />
                    <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "nowrap", overflowX: "auto" }}>
                      {["#E69903", "#E67E22", "#D35400", "#C0392B", "#7B241C", "#1E8449", "#272262", "#7F8C8D"].map(c => (
                        <button key={c} onClick={() => upDraft("color", c)} style={{ width: 24, height: 24, borderRadius: "50%", background: c, border: editDraft.color === c ? "3px solid #000" : "3px solid transparent", cursor: "pointer", padding: 0, outline: "none" }} />
                      ))}
                    </div>
                  </div>
                  <div>
                    <Lbl t="Applies to Priorities" />
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      {PRIORITIES.map(p => (
                        <label key={p} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 12 }}>
                          <input type="checkbox" checked={editDraft.priorities.includes(p)} onChange={e => { const arr = e.target.checked ? [...editDraft.priorities, p] : editDraft.priorities.filter(x => x !== p); upDraft("priorities", arr); }} style={{ width: 14, cursor: "pointer" }} />
                          <span style={{ color: p === "CRITICAL" ? T.red : p === "WARNING" ? T.amber : T.text, fontWeight: 600 }}>{p}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ gridColumn: "1/-1", display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: T.amberL, borderRadius: 8 }}>
                    <span style={{ fontSize: 13 }}>⚠</span>
                    <span style={{ fontSize: 12, color: "#7A4500" }}>Changes take effect on the next escalation run. Active actions already escalated won't be re-triggered.</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {matrix.length === 0 && <div className="card" style={{ padding: 32, textAlign: "center", color: T.text2 }}>No escalation tiers match the current filter. Click <b>+ Add Tier</b> to create one.</div>}
      </div>
    </div>
  );
}


/* ── Reusable Save-to-Server button ──────────────────────────────────── */
function SectionSaveButton({ label = "💾 Save to Server", onSave }) {
  const [status, setStatus] = useState("idle");
  const [errMsg, setErrMsg] = useState(null);
  const handleSave = async () => {
    setStatus("saving");
    setErrMsg(null);
    try { await onSave(); setStatus("saved"); }
    catch (e) { setStatus("error"); setErrMsg(e.message); console.error("Save failed:", e); }
    setTimeout(() => setStatus("idle"), 2500);
  };
  const col = status === "saved" ? T.green : status === "error" ? T.red : T.navy;
  const lbl = status === "saving" ? "Saving…" : status === "saved" ? "✓ Saved!" : status === "error" ? "⚠ Failed" : label;
  return <>
    <button onClick={handleSave} disabled={status === "saving"}
      style={{ padding: "8px 16px", borderRadius: 8, border: "none", cursor: status === "saving" ? "not-allowed" : "pointer", background: col, color: "#fff", fontWeight: 700, fontSize: 13, opacity: status === "saving" ? 0.7 : 1, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", flexShrink: 0 }}>
      {status === "saving" && <span style={{ width: 13, height: 13, border: "2px solid rgba(255,255,255,.5)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block", animation: "spin .7s linear infinite" }} />}
      {lbl}
    </button>
    {errMsg && <span style={{ fontSize: 11, color: T.red, maxWidth: 260 }}>{errMsg}</span>}
  </>;
}

/* ── Team Page (Master Setup) ──────────────────────────────────────────────
   Shows every team member with their plant/dept/role/superior and how many
   of their actions are currently escalated. Admin, the team member's direct
   superior, or the target user named in the escalation tier can close it
   right here. */
function TeamPage({ users, actions, escMatrix, plants, depts, user, isAdmin, setActions }) {
  const [search, setSearch] = useState("");
  const [plantFilter, setPlantFilter] = useState("");
  const [expanded, setExpanded] = useState(null);

  const escByUser = {};
  (actions || []).forEach(a => {
    const state = resolveEscalationState(a, escMatrix, users);
    if (!state) return;
    const names = (a.responsible || "").split(",").map(n => n.trim()).filter(Boolean);
    if (!names.length) {
      const key = "—Unassigned";
      if (!escByUser[key]) escByUser[key] = [];
      escByUser[key].push({ action: a, ...state });
      return;
    }
    names.forEach(name => {
      if (!escByUser[name]) escByUser[name] = [];
      escByUser[name].push({ action: a, ...state, fromUser: name });
    });
  });

  const canCloseEscalation = (member, escState) => {
    if (!user) return false;
    if (isAdmin) return true;
    if (member?.superior && member.superior === user.name) return true;
    if (escState?.tier?.targetUser && escState.tier.targetUser === user.name) return true;
    return false;
  };

  const closeEscalatedAction = (actionId, status) => {
    setActions(p => p.map(a => a.id === actionId ? { ...a, status, closedOn: status === "COMPLETED" ? todayStr() : null, closedBy: user?.name || "", pendingConfirmation: false } : a));
    apiUpdate("actions", actionId, { status, closedOn: status === "COMPLETED" ? todayStr() : null, closedBy: user?.name || "", pendingConfirmation: false });
  };

  const filteredUsers = (users || [])
    .filter(u => !plantFilter || u.plant === plantFilter || u.plant === "All")
    .filter(u => !search || u.name.toLowerCase().includes(search.toLowerCase()) || (u.role || "").toLowerCase().includes(search.toLowerCase()) || (u.dept || "").toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (escByUser[b.name]?.length || 0) - (escByUser[a.name]?.length || 0) || a.name.localeCompare(b.name));

  const totalEscalated = Object.values(escByUser).reduce((sum, arr) => sum + arr.length, 0);
  const membersWithEsc = Object.keys(escByUser).filter(k => k !== "—Unassigned" && escByUser[k].length > 0).length;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 18 }}>
        <KPICard icon="👥" value={(users || []).length} label="Team Members" sub="Registered across all plants" color={T.navy} />
        <KPICard icon="🚨" value={totalEscalated} label="Escalated Actions" sub="Currently overdue past a tier threshold" color={T.red} alert={totalEscalated > 0} />
        <KPICard icon="⚠️" value={membersWithEsc} label="Members With Escalations" sub="Team mates who need attention" color={T.amber} />
      </div>

      <div className="card filter-bar" style={{ padding: 12, marginBottom: 16, alignItems: "center" }}>
        <input type="text" placeholder="Search by name, role, dept…" value={search} onChange={e => setSearch(e.target.value)} style={{ flex: 1, minWidth: 200, padding: "8px 12px" }} />
        <select value={plantFilter} onChange={e => setPlantFilter(e.target.value)} style={{ width: 170 }}>
          <option value="">All Plants</option>
          {scopedPlants(user, plants).map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {filteredUsers.map(m => {
          const mine = escByUser[m.name] || [];
          const isOpen = expanded === m.id;
          return (
            <div key={m.id} className="card" style={{ padding: 0, overflow: "hidden", border: mine.length > 0 ? `1.5px solid ${T.red}40` : "" }}>
              <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, cursor: mine.length > 0 ? "pointer" : "default" }} onClick={() => mine.length > 0 && setExpanded(isOpen ? null : m.id)}>
                <Avatar name={m.name} size={36} users={users} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: T.text }}>{m.name}</div>
                  <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>
                    {m.role} · {m.plant}{m.dept ? " · " + m.dept : ""}{m.superior ? " · Reports to " + m.superior : ""}
                  </div>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 12px", borderRadius: 20, background: mine.length > 0 ? T.redL : T.bg, color: mine.length > 0 ? T.red : T.text2 }}>
                  {mine.length} escalated
                </span>
                {mine.length > 0 && <span style={{ fontSize: 12, color: T.text2 }}>{isOpen ? "▲" : "▼"}</span>}
              </div>
              {isOpen && mine.length > 0 && (
                <div style={{ borderTop: `1px solid ${T.border}`, background: T.bg }}>
                  {mine.sort((a, b) => b.tier.level - a.tier.level).map(item => {
                    const a = item.action, canClose = canCloseEscalation(m, item);
                    return (
                      <div key={a.id} style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", flexWrap: "nowrap", overflowX: "auto", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                            <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 11, background: "#fff", padding: "2px 6px", borderRadius: 4 }}>{a.sn}</span>
                            <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, fontWeight: 700, background: item.tier.color + "20", color: item.tier.color }}>Level {item.tier.level} → {item.tier.targetUser || "—"}</span>
                            <span style={{ fontSize: 11, color: T.red, fontWeight: 600 }}>⚠️ {item.daysOverdue}d overdue</span>
                          </div>
                          <div style={{ fontSize: 12, color: T.text }}>{a.text}</div>
                        </div>
                        {canClose ? (
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button className="btn btn-green btn-sm" onClick={() => closeEscalatedAction(a.id, "COMPLETED")}>✓ Resolve</button>
                            <button className="btn btn-ghost btn-sm" style={{ color: T.red }} onClick={() => closeEscalatedAction(a.id, "DROPPED")}>Drop</button>
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: T.text2, fontStyle: "italic", flexShrink: 0 }}>Only {item.tier.targetUser || "the target user"}, {m.superior || "their superior"}, or Admin can close this</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {filteredUsers.length === 0 && <Empty icon="👥" title="No team members" sub="Add users under the Users tab to see them here." />}
      </div>
    </div>
  );
}

/* ===================== ESCALATIONS PAGE ===================== */
function EscalationsPage({ actions, setActions, audit, users, escMatrix, plants, depts, user }) {
  const [activeTab, setActiveTab] = useState("active");
  const [search, setSearch] = useState("");
  const [plantFilter, setPlantFilter] = useState("");
  const [deptFilter, setDeptFilter] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [selectedAction, setSelectedAction] = useState(null);
  // Only Admin / MD get to see the whole org's escalations (and the Total/Mine
  // toggle). Everyone else is locked to their own — matches Dashboard scoping.
  const isEscAdmin = isUserAdmin(user);
  const [showOnlyMine, setShowOnlyMine] = useState(true);
  const userNameLower = (user?.name || "").toLowerCase();

  const getActionEscalationState = (action, matrix) => resolveEscalationState(action, matrix, users);

  const scopedActions = isEscAdmin ? actions : actions.filter(a => responsibleMatchesUsers(a.responsible, [userNameLower]) || (a.allocatedBy || "").trim().toLowerCase() === userNameLower);
  const scopedAudit = isEscAdmin ? audit : audit.filter(log => {
    const action = actions.find(a => a.sn === log.sn);
    return action && (responsibleMatchesUsers(action.responsible, [userNameLower]) || (action.allocatedBy || "").trim().toLowerCase() === userNameLower);
  });

  const activeEscalations = scopedActions.map(a => {
    const escState = getActionEscalationState(a, escMatrix);
    return escState ? { action: a, ...escState } : null;
  }).filter(Boolean);

  const effectiveShowOnlyMine = isEscAdmin ? showOnlyMine : true;

  const filteredActive = activeEscalations.filter(item => {
    const a = item.action;
    const matchesSearch = a.sn.toLowerCase().includes(search.toLowerCase()) ||
      a.text.toLowerCase().includes(search.toLowerCase()) ||
      (a.responsible || "").toLowerCase().includes(search.toLowerCase());
    const matchesPlant = !plantFilter || a.plant === plantFilter;
    const matchesDept = !deptFilter || a.dept === deptFilter;
    const matchesTier = !tierFilter || String(item.tier.level) === tierFilter;
    const matchesMine = !effectiveShowOnlyMine || responsibleMatchesUsers(a.responsible, [userNameLower]);
    return matchesSearch && matchesPlant && matchesDept && matchesTier && matchesMine;
  });

  const filteredHistory = scopedAudit.filter(log => {
    const matchesSearch = log.sn.toLowerCase().includes(search.toLowerCase()) ||
      log.text.toLowerCase().includes(search.toLowerCase()) ||
      (log.reason || "").toLowerCase().includes(search.toLowerCase());
    const matchesTier = !tierFilter || String(log.level) === tierFilter;
    const action = actions.find(a => a.sn === log.sn);
    const matchesMine = !effectiveShowOnlyMine || (action && responsibleMatchesUsers(action.responsible, [userNameLower]));
    return matchesSearch && matchesTier && matchesMine;
  });

  const highestLevel = activeEscalations.length > 0
    ? Math.max(...activeEscalations.map(e => e.tier.level))
    : 0;

  return (
    <div className="fade-in" style={{ padding: "0 24px 24px", overflowY: "auto", flex: 1, height: "100%" }}>
      <PageHeader title="Escalation Control Center" sub="Monitor overdue actions, review escalation alerts, and resolve blockers." />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 16, marginBottom: 24 }}>
        <KPICard icon="🚨" value={activeEscalations.length} label="Active Escalations" sub="Actions currently unresolved beyond due dates" color={T.red} alert={activeEscalations.length > 0} />
        <KPICard icon="⚠️" value={highestLevel > 0 ? `Level ${highestLevel}` : "None"} label="Highest Active Level" sub={highestLevel > 0 ? "Requires management attention" : "No active escalations"} color={highestLevel > 0 ? T.amber : T.green} />
        <KPICard icon="📋" value={scopedAudit.length} label="Total Escalation Triggers" sub="Logged history of escalation events" color={T.slate} />
      </div>

      <div className="card filter-bar" style={{ padding: 16, marginBottom: 20, background: "#fff" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <input type="text" placeholder="Search by SN, text, owner, reason..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: "100%", padding: "8px 12px" }} />
        </div>
        <div style={{ width: 150 }}>
          <select value={plantFilter} onChange={e => setPlantFilter(e.target.value)}>
            <option value="">All Plants</option>
            {scopedPlants(user, plants).map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select>
        </div>
        <div style={{ width: 160 }}>
          <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
            <option value="">All Departments</option>
            {scopedDepts(user, depts).map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </div>
        <div style={{ width: 140 }}>
          <select value={tierFilter} onChange={e => setTierFilter(e.target.value)}>
            <option value="">All Levels</option>
            {[1, 2, 3, 4].map(l => <option key={l} value={String(l)}>Level {l}</option>)}
          </select>
        </div>
        {(search || plantFilter || deptFilter || tierFilter || (isEscAdmin && !showOnlyMine)) && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setSearch(""); setPlantFilter(""); setDeptFilter(""); setTierFilter(""); setShowOnlyMine(true); }} style={{ padding: "8px 12px" }}>Reset</button>
        )}
        {isEscAdmin && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexWrap: "nowrap", overflowX: "auto" }}>
            <button onClick={() => setShowOnlyMine(false)}
              style={{
                padding: "6px 12px",
                borderRadius: 20,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                background: !showOnlyMine ? T.navy : T.bg,
                color: !showOnlyMine ? "#fff" : T.text2,
                transition: "all .2s"
              }}>
              Total ({activeEscalations.length})
            </button>
            <button onClick={() => setShowOnlyMine(true)}
              style={{
                padding: "6px 12px",
                borderRadius: 20,
                border: "none",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 600,
                background: showOnlyMine ? T.navy : T.bg,
                color: showOnlyMine ? "#fff" : T.text2,
                transition: "all .2s"
              }}>
              My Escalations ({activeEscalations.filter(e => responsibleMatchesUsers(e.action.responsible, [userNameLower])).length})
            </button>
          </div>
        )}
      </div>

      <div style={{ borderBottom: `2px solid ${T.border}`, marginBottom: 20, display: "flex", gap: 0 }}>
        <button onClick={() => setActiveTab("active")} style={{ padding: "10px 18px", border: "none", cursor: "pointer", background: "transparent", fontSize: 13, fontWeight: activeTab === "active" ? 700 : 400, color: activeTab === "active" ? T.navy : T.text2, borderBottom: activeTab === "active" ? `3px solid ${T.navy}` : "3px solid transparent", transition: "all .2s" }}>
          🚨 Active Escalations ({filteredActive.length})
        </button>
        <button onClick={() => setActiveTab("history")} style={{ padding: "10px 18px", border: "none", cursor: "pointer", background: "transparent", fontSize: 13, fontWeight: activeTab === "history" ? 700 : 400, color: activeTab === "history" ? T.navy : T.text2, borderBottom: activeTab === "history" ? `3px solid ${T.navy}` : "3px solid transparent", transition: "all .2s" }}>
          📜 Alert Log History ({filteredHistory.length})
        </button>
      </div>

      {activeTab === "active" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filteredActive.map(item => {
            const a = item.action;
            const tColor = item.tier.color || T.red;
            return (
              <div key={a.id} className="card card-hover" onClick={() => setSelectedAction(a)} style={{ padding: "16px 20px", display: "flex", flexWrap: "nowrap", overflowX: "auto", justifyContent: "space-between", alignItems: "center", gap: 16, borderLeft: `5px solid ${tColor}` }}>
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 12, background: T.bg, padding: "2px 6px", borderRadius: 4, color: T.text }}>{a.sn}</span>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, fontWeight: 700, background: tColor + "20", color: tColor }}>Level {item.tier.level} — {item.tier.label}</span>
                    <span style={{ fontSize: 11, color: T.red, fontWeight: 600 }}>⚠️ {item.daysOverdue}d Overdue</span>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: T.text, marginBottom: 8 }}>{a.text}</div>
                  <div style={{ display: "flex", gap: 12, flexWrap: "nowrap", overflowX: "auto", fontSize: 11, color: T.text2 }}>
                    <span>🏭 <b>Plant:</b> {a.plant}</span>
                    <span>🗂 <b>Dept:</b> {a.dept || "—"}</span>
                    {a.machine && <span>⚙ <b>Machine:</b> {a.machine}</span>}
                    <span>📅 <b>Due Date:</b> {fmt(a.due)}</span>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11, color: T.text2, marginBottom: 2 }}>Responsible</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Avatar name={a.responsible} size={24} users={users} />
                      <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{a.responsible}</span>
                    </div>
                  </div>
                  <div style={{ borderLeft: `1px solid ${T.border}`, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ fontSize: 11, color: T.text2 }}>Escalation Path</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: T.navy }}>👤 {item.tier.targetUser || "—"}</div>
                    <div style={{ fontSize: 10, background: T.bg, padding: "2px 6px", borderRadius: 4, color: T.text2 }}>📢 {item.tier.notifyMethod}</div>
                  </div>
                </div>
              </div>
            );
          })}
          {filteredActive.length === 0 && (
            <Empty icon="☀️" title="All Clear" sub="No active escalations. All tasks are within their due thresholds." />
          )}
        </div>
      )}

      {activeTab === "history" && (
        <div className="card" style={{ padding: "20px 24px", background: "#fff" }}>
          {filteredHistory.map((log, i) => (
            <div key={log.id} style={{ display: "flex", gap: 16, position: "relative", paddingBottom: i < filteredHistory.length - 1 ? 24 : 0 }}>
              {i < filteredHistory.length - 1 && (
                <div style={{ position: "absolute", left: 15, top: 32, bottom: 0, width: 2, background: T.border }} />
              )}
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: getEscBadgeStyle(log.level).bg, color: getEscBadgeStyle(log.level).color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, zIndex: 2, flexShrink: 0 }}>
                L{log.level}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "nowrap", overflowX: "auto", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: T.text }}>Escalation Alert for <span style={{ fontFamily: "monospace", color: T.navy }}>{log.sn}</span></span>
                  <span style={{ fontSize: 11, color: T.text2 }}>{new Date(log.ts).toLocaleString("en-IN")}</span>
                </div>
                <div style={{ fontSize: 13, color: T.text, marginBottom: 6, lineHeight: 1.4 }}>{log.text}</div>
                <div style={{ display: "flex", gap: 12, flexWrap: "nowrap", overflowX: "auto", fontSize: 11, color: T.text2 }}>
                  <span>📢 <b>Target Notified:</b> {log.target}</span>
                  <span>🔍 <b>Reason:</b> {log.reason}</span>
                </div>
              </div>
            </div>
          ))}
          {filteredHistory.length === 0 && (
            <Empty icon="📋" title="Log Empty" sub="No escalation history logged yet." />
          )}
        </div>
      )}

      {selectedAction && (
        <ActionDetailPanel
          action={selectedAction}
          onClose={() => setSelectedAction(null)}
          onUpdate={(id, patch) => {
            setActions(p => p.map(a => a.id === id ? { ...a, ...patch } : a));
            setSelectedAction(p => p ? { ...p, ...patch } : p);
    apiUpdate("actions", id, resolveRecordIds(patch, plants, depts, machines, projects, meetings));
          }}
          user={user}
          users={users}
          allUsers={users}
          plants={plants}
        />
      )}
    </div>
  );
}

function MasterPage({ user, plants, setPlants, depts, setDepts, users, setUsers, escMatrix, setEscMatrix, mtgPresets, setMtgPresets, machines, setMachines, refreshMaster, roles = [], setRoles, actions, setActions }) {
  const isAdmin = isUserAdmin(user);
  const isMasterOnly = !isAdmin && (user?.masterAccess === true || user?.master_access === true);
  const myPlant = user?.plant;

  const mPlants = isMasterOnly ? plants.filter(p => p.name === myPlant) : plants;
  const mDepts = isMasterOnly ? depts.filter(d => d.plant === myPlant || d.plant === "All Plants") : depts;
  const mUsers = isMasterOnly ? users.filter(u => u.plant === myPlant) : users;
  const mMachines = isMasterOnly ? (machines || []).filter(m => m.plant === myPlant) : machines;
  const mEscMatrix = isMasterOnly ? (escMatrix || []).filter(e => !e.plant || e.plant === myPlant) : escMatrix;
  const [tab, setTab] = useState("users");
  const [userFilterPlant, setUserFilterPlant] = useState(() => { try { return localStorage.getItem("mcs_master_userFilterPlant") || "All"; } catch { return "All"; } });
  const [userFilterRole, setUserFilterRole] = useState(() => { try { return localStorage.getItem("mcs_master_userFilterRole") || "All"; } catch { return "All"; } });
  const [userFilterDept, setUserFilterDept] = useState(() => { try { return localStorage.getItem("mcs_master_userFilterDept") || "All"; } catch { return "All"; } });
  const [userSearch, setUserSearch] = useState("");
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [mcSaveStatus, setMcSaveStatus] = useState(null);
  const [plantSaveStatus, setPlantSaveStatus] = useState(null);
  const [deptSaveStatus, setDeptSaveStatus] = useState(null);
  const COLORS = ["#272262", "#5B56A6", "#E69903", "#7C80B0", "#1E8449", "#C0392B"];
  useEffect(() => { try { localStorage.setItem("mcs_master_userFilterPlant", userFilterPlant); } catch {} }, [userFilterPlant]);
  useEffect(() => { try { localStorage.setItem("mcs_master_userFilterRole", userFilterRole); } catch {} }, [userFilterRole]);
  useEffect(() => { try { localStorage.setItem("mcs_master_userFilterDept", userFilterDept); } catch {} }, [userFilterDept]);
  
  const initialIds = useRef(null);
  if (!initialIds.current && users.length > 0) {
    initialIds.current = {
      users: new Set(users.map(x => x.id)),
      plants: new Set(plants.map(x => x.id)),
      depts: new Set(depts.map(x => x.id)),
      machines: new Set((machines || []).map(x => x.id)),
      roles: new Set(roles.map(x => x.id)),
      escMatrix: new Set((escMatrix || []).map(x => x.id)),
    };
  }

  const canModify = (tabKey, rowId) => {
    if (isAdmin) return true;
    if (isMasterOnly) return true;
    if (!initialIds.current || !initialIds.current[tabKey]) return false;
    return !initialIds.current[tabKey].has(rowId);
  };

  const openAdd = t => {
    setModal({ type: t, mode: "add" });
    setForm({});
    setMcSaveStatus(null); setPlantSaveStatus(null); setDeptSaveStatus(null);
  };
  const openEdit = (t, d) => { setModal({ type: t, mode: "edit" }); setForm({ ...d, masterAccess: d.master_access || d.masterAccess || false }); setMcSaveStatus(null); setPlantSaveStatus(null); setDeptSaveStatus(null); };
  const close = () => { setModal(null); setForm({}); setMcSaveStatus(null); setPlantSaveStatus(null); setDeptSaveStatus(null); };
  useEscClose(close);
  const saveUser = () => {
    if (!form.name || !form.role || !form.plant) return;
    if (modal.mode !== "edit" && !isGuestRole(form.role) && (!form.username || !form.password)) return;
    const { _showPw, ...cleanForm } = form;
    const pMap = {}; plants.forEach(p => { pMap[p.name] = p.id; });
    const dMap = {}; depts.forEach(d => { dMap[d.name] = d.id; });
    const u = {
      ...cleanForm,
      username: isGuestRole(form.role) ? (form.username || "guest") : form.username,
      password: isGuestRole(form.role) ? (form.password || "") : form.password,
      id: cleanForm.id || "U" + String(Date.now()).slice(-6),
      initials: cleanForm.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      color: cleanForm.color || COLORS[users.length % 6],
      plantId: pMap[cleanForm.plant] || cleanForm.plantId || null,
      deptId: dMap[cleanForm.dept] || cleanForm.deptId || null,
      master_access: cleanForm.masterAccess === true,
    };
    if (modal.mode === "edit") { setUsers(p => p.map(x => x.id === u.id ? u : x)); apiUpdate("users", u.id, u); } else { setUsers(p => [...p, u]); apiCreate("users", u); } close();
  };
  const ALL_TABS = [["users", "👥 Users"], ["plants", "🏭 Plants"], ["depts", "🗂 Depts"], ["machines", "⚙ Machines"], ["roles", "🎭 Roles"], ["team", "🧑‍🤝‍🧑 Team"], ["escmatrix", "🚨 Escalation"], ["presets", "🎙 Presets"]];
  const TABS = isMasterOnly ? ALL_TABS.filter(([id]) => ["users", "machines", "escmatrix", "presets", "depts"].includes(id)) : ALL_TABS;

  const BULK_ENDPOINTS = {
    "Users": "/api/users/bulk",
    "Plants": "/api/plants/bulk",
    "Departments": "/api/departments/bulk",
    "Machines": "/api/machines/bulk",
    "Roles": "/api/roles/bulk",
    "EscalationMatrix": "/api/escalation/matrix/bulk",
    "MeetingPresets": "/api/meetings/presets/bulk",
  };
  const saveToAPI = async (tab, rows) => {
    const cleaned = (Array.isArray(rows) ? rows : []).filter(r => Object.keys(r).length > 0);
    if (cleaned.length === 0) throw new Error("Nothing to save — add at least one entry first");
    const endpoint = BULK_ENDPOINTS[tab];
    if (!endpoint) throw new Error(`No bulk endpoint for ${tab}`);
    // Build name → ID maps for plant/dept
    const pInv = {}; plants.forEach(p => { pInv[p.name] = p.id; });
    const dInv = {}; depts.forEach(d => { dInv[d.name] = d.id; });
    const mapped = cleaned.map(r => {
      const out = normKeys(r);
      if (r.plant && pInv[r.plant] && !out.plant_id) out.plant_id = pInv[r.plant];
      if (r.dept && dInv[r.dept] && !out.dept_id) out.dept_id = dInv[r.dept];
      if (out.plant_id === "") out.plant_id = null;
      if (out.dept_id === "") out.dept_id = null;
      return out;
    });
    console.log("saveToAPI", tab, endpoint, "rows:", rows.length, "mapped:", mapped.length);
    await apiPost(endpoint, mapped);
    const keyMap = {
      "Users": "users", "Plants": "plants", "Departments": "depts",
      "Machines": "machines", "Roles": "roles", "EscalationMatrix": "escMatrix"
    };
    const key = keyMap[tab];
    if (key && initialIds.current && initialIds.current[key]) {
      rows.forEach(r => { if (r.id) initialIds.current[key].add(r.id); });
    }
  };


  /* ── Section header with Save button ── */
  const SectionHeader = ({ title, sub, onSave, addLabel, onAdd }) => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "nowrap", overflowX: "auto", gap: 10, marginBottom: 16 }}>

      <div>
        <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 15, color: T.navy }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "nowrap", overflowX: "auto" }}>
        {onAdd && <button className="btn btn-amber btn-sm" onClick={onAdd}>{addLabel || "+ Add"}</button>}
        {onSave && <SectionSaveButton onSave={onSave} />}
      </div>
    </div>
  );

  return (
    <div className="fade-in">
      <PageHeader title="Master Setup" sub={isMasterOnly ? `Manage ${myPlant} — plant-scoped access` : "Admin only — manage organisation structure"} />

      {/* Scrollable tab bar */}
      <div style={{ borderBottom: `2px solid ${T.border}`, marginBottom: 20, overflowX: "auto", display: "flex", gap: 0, WebkitOverflowScrolling: "touch" }}>
        {TABS.map(([id, l]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ padding: "9px 14px", border: "none", cursor: "pointer", background: "transparent", fontSize: 12, fontWeight: tab === id ? 700 : 400, color: tab === id ? T.navy : T.text2, borderBottom: tab === id ? `3px solid ${T.navy}` : "3px solid transparent", marginBottom: -2, transition: "all .2s", whiteSpace: "nowrap", flexShrink: 0 }}>
            {l}
          </button>
        ))}
      </div>

      {/* ── USERS ── */}
      {tab === "users" && <>
        <SectionHeader
          title="Users"
          sub={isMasterOnly ? `Users in ${myPlant}` : "All system users and their login credentials"}
          onAdd={() => openAdd("users")}
          onSave={() => saveToAPI("Users", mUsers)}
        />
        {(() => {
          const uPlants = Array.from(new Set(mUsers.map(u => u.plant).filter(Boolean))).sort();
          const uRoles = Array.from(new Set(mUsers.map(u => u.role).filter(Boolean))).sort();
          const uDepts = Array.from(new Set(mUsers.map(u => u.dept).filter(Boolean))).sort();
          const filteredUsers = mUsers.filter(u =>
            (userFilterPlant === "All" || u.plant === userFilterPlant) &&
            (userFilterRole === "All" || u.role === userFilterRole) &&
            (userFilterDept === "All" || u.dept === userFilterDept) &&
            (!userSearch || (u.name || "").toLowerCase().includes(userSearch.toLowerCase()) ||
             (u.username || "").toLowerCase().includes(userSearch.toLowerCase()) ||
             (u.dept || "").toLowerCase().includes(userSearch.toLowerCase()) ||
             (u.plant || "").toLowerCase().includes(userSearch.toLowerCase()) ||
             (u.role || "").toLowerCase().includes(userSearch.toLowerCase()))
          );
          return (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "nowrap", overflowX: "auto", marginBottom: 14 }}>
                <input
                  type="text"
                  placeholder="Search users..."
                  value={userSearch}
                  onChange={e => setUserSearch(e.target.value)}
                  style={{ fontSize: 12, padding: "6px 10px", flex: 1, minWidth: 180 }}
                />
                <select value={userFilterPlant} onChange={e => setUserFilterPlant(e.target.value)} style={{ fontSize: 12, padding: "6px 10px", minWidth: 140 }}>
                  <option value="All">All Plants</option>
                  {uPlants.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <select value={userFilterRole} onChange={e => setUserFilterRole(e.target.value)} style={{ fontSize: 12, padding: "6px 10px", minWidth: 140 }}>
                  <option value="All">All Roles</option>
                  {uRoles.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <select value={userFilterDept} onChange={e => setUserFilterDept(e.target.value)} style={{ fontSize: 12, padding: "6px 10px", minWidth: 140 }}>
                  <option value="All">All Depts</option>
                  {uDepts.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                {(userFilterPlant !== "All" || userFilterRole !== "All" || userFilterDept !== "All" || userSearch) &&
                  <button className="btn btn-ghost btn-sm" onClick={() => { setUserFilterPlant("All"); setUserFilterRole("All"); setUserFilterDept("All"); setUserSearch(""); }}>Clear</button>}
                <span style={{ fontSize: 11, color: T.text2, marginLeft: "auto" }}>{filteredUsers.length} of {users.length} users</span>
              </div>
              {/* Mobile card list */}
              <div style={{ display: "none" }} className="master-mobile-cards">
                {filteredUsers.map(u => (
                  <div key={u.id} className="card" style={{ padding: 14, marginBottom: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                      <Avatar name={u.name} size={38} users={users} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>{u.name}</div>
                        <div style={{ fontSize: 11, color: T.text2 }}>{u.role} · {u.plant}</div>
                      </div>
                      {canModify("users", u.id) && <button className="btn btn-ghost btn-sm" onClick={() => openEdit("users", u)}>Edit</button>}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 12 }}>
                      <div><span style={{ color: T.text2 }}>Dept: </span>{u.dept || "—"}</div>
                      <div><span style={{ color: T.text2 }}>Superior: </span>{u.superior || "Top"}</div>
                      <div><span style={{ color: T.text2 }}>Phone: </span>{u.phone || "—"}</div>
                    </div>
                    {canModify("users", u.id) && <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                      <button className="btn btn-ghost btn-sm" style={{ color: T.red }} onClick={() => { if (window.confirm(`Remove "${u.name}"?`)) { setUsers(p => p.filter(x => x.id !== u.id)); apiRemove("users", u.id); } }}>✕ Remove</button>
                    </div>}
                  </div>
                ))}
                {filteredUsers.length === 0 && <Empty icon="👥" title="No users" sub={users.length === 0 ? "Click + Add to create the first user." : "No users match these filters."} />}
              </div>
              {/* Desktop table */}
              <div className="card master-desktop-table" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ minWidth: 700 }}><thead><tr><th>User</th><th>Role</th><th>Plant</th><th>Dept</th><th>Master</th><th>Superior</th><th>Phone</th><th></th></tr></thead>
                    <tbody>{filteredUsers.map(u => <tr key={u.id}>
                      <td><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Avatar name={u.name} size={32} users={users} /><div style={{ fontWeight: 600 }}>{u.name}</div></div></td>
                      <td><span style={{ padding: "3px 9px", borderRadius: 20, background: T.navy + "15", color: T.navy, fontSize: 11, fontWeight: 600 }}>{u.role}</span></td>
                      <td style={{ fontSize: 12 }}>{u.plant}</td>
                      <td style={{ fontSize: 12 }}>{u.dept || "—"}</td>
                      <td style={{ fontSize: 12 }}>{u.master_access ? "✅" : "—"}</td>
                      <td style={{ fontSize: 12, color: T.text2 }}>{u.superior || "—"}</td>
                      <td style={{ fontSize: 12, color: T.text2 }}>{u.phone || "—"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {canModify("users", u.id) && <button className="btn btn-ghost btn-sm" onClick={() => openEdit("users", u)}>Edit</button>}
                        {canModify("users", u.id) && <button className="btn btn-ghost btn-sm" style={{ color: T.red, marginLeft: 4 }} onClick={() => { if (window.confirm(`Remove "${u.name}" from the system?`)) { setUsers(p => p.filter(x => x.id !== u.id)); apiRemove("users", u.id); } }}>✕</button>}
                      </td>
                    </tr>)}
                    {filteredUsers.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", padding: 24, color: T.text2, fontSize: 12 }}>No users match these filters.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          );
        })()}
      </>}

      {/* ── PLANTS ── */}
      {tab === "plants" && <>
        <SectionHeader title="Plants" sub="Manufacturing plant locations" onAdd={isMasterOnly ? null : () => openAdd("plants")} onSave={isMasterOnly ? null : () => saveToAPI("Plants", plants)} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 14 }}>
          {mPlants.map(p => <div key={p.id} className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 26 }}>🏭</span>{canModify("plants", p.id) && <div><button className="btn btn-ghost btn-sm" onClick={() => openEdit("plants", p)}>Edit</button><button className="btn btn-ghost btn-sm" style={{ color: T.red, marginLeft: 4 }} onClick={() => { if (window.confirm(`Remove plant "${p.name}"?`)) { setPlants(prev => prev.filter(x => x.id !== p.id)); apiRemove("plants", p.id); } }}>✕</button></div>}</div>
            <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 14, color: T.navy }}>{p.name}</div>
            <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>{p.location}</div>
            {p.head && <><HR /><div style={{ fontSize: 12 }}>Head: <b>{p.head}</b></div></>}
          </div>)}
          {mPlants.length === 0 && <Empty icon="🏭" title="No plants" sub="Click + Add to register a plant." />}
        </div>
      </>}

      {/* ── DEPARTMENTS ── */}
      {tab === "depts" && <>
        <SectionHeader title="Departments" sub={isMasterOnly ? `Departments in ${myPlant}` : "Sections within each plant"} onAdd={() => openAdd("depts")} onSave={() => saveToAPI("Departments", mDepts)} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 14 }}>
          {(mDepts || []).map(d => <div key={d.id} className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 26 }}>{d.icon || "🗂"}</span>{canModify("depts", d.id) && <div><button className="btn btn-ghost btn-sm" onClick={() => openEdit("depts", d)}>Edit</button><button className="btn btn-ghost btn-sm" style={{ color: T.red, marginLeft: 4 }} onClick={() => { if (window.confirm(`Remove department "${d.name}"?`)) { setDepts(prev => prev.filter(x => x.id !== d.id)); apiRemove("departments", d.id); } }}>✕</button></div>}</div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{d.name}</div>
            {d.head && <div style={{ fontSize: 12, color: T.text2, marginTop: 2 }}>HOD: {d.head}</div>}
            {d.plant && <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>Plant: {d.plant}</div>}
          </div>)}
          {mDepts.length === 0 && <Empty icon="🗂" title="No departments" sub="Click + Add to create a department." />}
        </div>
      </>}

      {/* ── MACHINES ── */}
      {tab === "machines" && <>
        <SectionHeader title="Machines" sub={isMasterOnly ? `Machines in ${myPlant}` : "Registered equipment across all plants"} onAdd={() => openAdd("machines")} onSave={() => saveToAPI("Machines", (mMachines || []))} />
        {/* Mobile cards */}
        <div style={{ display: "none" }} className="master-mobile-cards">
          {(mMachines || []).map(m => (
            <div key={m.id} className="card" style={{ padding: 14, marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{m.name}</div>
                  <div style={{ fontSize: 12, color: T.text2, marginTop: 3 }}>{m.type || "—"} · {m.plant || "—"}</div>
                  <div style={{ fontSize: 11, color: T.text2, marginTop: 2 }}>Dept: {m.dept || "—"} · Asset: {m.assetNo || "—"}</div>
                </div>
                {canModify("machines", m.id) && <div style={{ display: "flex", gap: 6 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => openEdit("machines", m)}>Edit</button>
                  <button className="btn btn-ghost btn-sm" style={{ color: T.red }} onClick={() => { setMachines(p => p.filter(x => x.id !== m.id)); apiRemove("machines", m.id); }}>✕</button>
                </div>}
              </div>
            </div>
          ))}
          {(!mMachines || mMachines.length === 0) && <Empty icon="⚙" title="No machines" sub="Click + Add to register a machine." />}
        </div>
        {/* Desktop table */}
        <div className="card master-desktop-table" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ minWidth: 560 }}><thead><tr><th>Machine</th><th>Plant</th><th>Dept</th><th>Type</th><th>Asset No.</th><th></th></tr></thead>
              <tbody>
                {(mMachines || []).map(m => <tr key={m.id}>
                  <td style={{ fontWeight: 600 }}>{m.name}</td>
                  <td style={{ fontSize: 12 }}>{m.plant || "—"}</td>
                  <td style={{ fontSize: 12 }}>{m.dept || "—"}</td>
                  <td style={{ fontSize: 12, color: T.text2 }}>{m.type || "—"}</td>
                  <td style={{ fontSize: 12, color: T.text2 }}>{m.assetNo || "—"}</td>
                  <td>
                    {canModify("machines", m.id) && <button className="btn btn-ghost btn-sm" onClick={() => openEdit("machines", m)}>Edit</button>}
                    {canModify("machines", m.id) && <button className="btn btn-ghost btn-sm" style={{ color: T.red, marginLeft: 4 }} onClick={() => { setMachines(p => p.filter(x => x.id !== m.id)); apiRemove("machines", m.id); }}>✕</button>}
                  </td>
                </tr>)}
                {(!mMachines || mMachines.length === 0) && <tr><td colSpan={6} style={{ textAlign: "center", padding: 24, color: T.text2, fontSize: 12 }}>No machines added yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </>}

      {/* ── ROLES ── */}
      {tab === "roles" && <>
        <SectionHeader title="Roles" sub="System roles and access levels" onAdd={isAdmin ? () => openAdd("roles") : null} onSave={isAdmin ? () => saveToAPI("Roles", roles) : null} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 14 }}>
          {roles.map(r => <div key={r.id} className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 26 }}>🎭</span>
              {canModify("roles", r.id) && <div>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit("roles", r)}>Edit</button>
                <button className="btn btn-ghost btn-sm" style={{ color: T.red, marginLeft: 4 }} onClick={() => { if (window.confirm(`Remove role "${r.name}"?`)) { setRoles(prev => prev.filter(x => x.id !== r.id)); apiRemove("roles", r.id); } }}>✕</button>
              </div>}
            </div>
            <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 14, color: T.navy }}>{r.name}</div>
            <div style={{ fontSize: 12, color: T.text2, marginTop: 4 }}>Level: <b>{r.level ?? "—"}</b></div>
          </div>)}
          {roles.length === 0 && <Empty icon="🎭" title="No roles" sub="Click + Add to register a role." />}
        </div>
      </>}

      {/* ── TEAM ── */}
      {tab === "team" && <TeamPage users={users} actions={actions} escMatrix={escMatrix} plants={plants} depts={depts} user={user} isAdmin={isAdmin} setActions={setActions} />}

      {/* ── ESCALATION MATRIX ── */}
      {tab === "escmatrix" && <EscMatrixTab escMatrix={mEscMatrix || []} setEscMatrix={setEscMatrix} onSave={() => saveToAPI("EscalationMatrix", mEscMatrix || [])} isAdmin={isAdmin} canModify={canModify} users={mUsers} roles={roles} />}

      {/* ── MEETING PRESETS ── */}
      {tab === "presets" && <div className="card" style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "nowrap", overflowX: "auto", gap: 10, marginBottom: 16 }}>
          <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 15, color: T.navy }}>Meeting Presets</div>
          <SectionSaveButton onSave={() => {
            const allTypes = Array.from(new Set([...Object.keys(mtgPresets.attendeeMap || {}), ...Object.keys(mtgPresets.instructions || {})]));
            const rows = allTypes.map(t => ({ type: t, attendees: ensureArray((mtgPresets.attendeeMap || {})[t]), instructions: ensureArray((mtgPresets.instructions || {})[t]) }));
            return saveToAPI("MeetingPresets", rows);
          }} />
        </div>
        <div style={{ display: "grid", gap: 16 }}>
          {MEETING_TYPES.map(type => (
            <div key={type} className="card" style={{ padding: 16, background: T.bg }}>
              <div style={{ fontWeight: 700, color: T.navy, marginBottom: 10, fontSize: 14 }}>{type}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 16 }}>
                <div>
                  <Lbl t="Default Attendees" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 180, overflowY: "auto", padding: "8px 10px", background: "#fff", border: `1px solid ${T.border}`, borderRadius: 8 }}>
                    {mUsers.length === 0 && <div style={{ fontSize: 12, color: T.text2, fontStyle: "italic", padding: "4px 0" }}>No users added yet.</div>}
                    {mUsers.map(u => (
                      <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, cursor: "pointer", padding: "5px 4px", borderRadius: 5, transition: "background .1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = T.bg}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <input type="checkbox"
                          checked={ensureArray(mtgPresets?.attendeeMap?.[type]).includes(u.name)}
                          onChange={e => {
                            const cur = ensureArray(mtgPresets?.attendeeMap?.[type]);
                            const next = e.target.checked ? [...cur, u.name] : cur.filter(n => n !== u.name);
                            setMtgPresets(prev => ({ ...prev, attendeeMap: { ...prev.attendeeMap, [type]: next } }));
                          }}
                          style={{ width: 15, height: 15, flexShrink: 0, cursor: "pointer", accentColor: T.navy }} />
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <div style={{ width: 24, height: 24, borderRadius: "50%", background: u.color || T.navy, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{u.initials || (u.name || "?").slice(0, 2).toUpperCase()}</div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</div>
                            <div style={{ fontSize: 10, color: T.text2 }}>{u.role}</div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: T.text2, marginTop: 5 }}>{ensureArray(mtgPresets?.attendeeMap?.[type]).length} selected</div>
                </div>
                <div>
                  <Lbl t="Guidelines / Instructions (one per line)" />
                  <textarea value={ensureArray(mtgPresets?.instructions?.[type]).join("\n")}
                    disabled={!isAdmin}
                    onChange={e => { const next = e.target.value.split("\n").filter(l => l.trim() !== ""); setMtgPresets(prev => ({ ...prev, instructions: { ...prev.instructions, [type]: next } })); }}
                    style={{ fontSize: 12, height: 160, resize: "vertical", cursor: isAdmin ? "auto" : "not-allowed" }} />
                  <div style={{ fontSize: 11, color: T.text2, marginTop: 5 }}>{ensureArray(mtgPresets?.instructions?.[type]).length} guideline{ensureArray(mtgPresets?.instructions?.[type]).length !== 1 ? "s" : ""}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>}

      {/* ── MODALS (responsive width) ── */}
      {modal && (
        <div className="overlay" onClick={close}>
          <div className="modal" style={{ width: "min(520px, calc(100vw - 32px))", padding: "24px 20px" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ fontFamily: "'Sora',sans-serif", fontSize: 16, fontWeight: 800, color: T.navy }}>
                {modal.mode === "add" ? "Add" : "Edit"} {modal.type === "users" ? "User" : modal.type === "plants" ? "Plant" : modal.type === "machines" ? "Machine" : modal.type === "roles" ? "Role" : "Department"}
              </h2>
              <button onClick={close} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 22, color: T.text2, lineHeight: 1, padding: 0 }}>×</button>
            </div>
            {modal.type === "users" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
              <div style={{ gridColumn: "1/-1" }}><Lbl t="Full Name" req /><input value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
              <div style={{ gridColumn: "1/-1" }}><Lbl t="Username" req={!isGuestRole(form.role)} /><input value={form.username || ""} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="Login username" /></div>
              <div><Lbl t="Role" req /><select value={form.role || ""} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}><option value="">Select</option>{roles.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}</select></div>
              <div><Lbl t="Plant" req /><select value={form.plant || ""} onChange={e => setForm(f => ({ ...f, plant: e.target.value, dept: "" }))}><option value="">Select</option>{plants.map(p => <option key={p.id}>{p.name}</option>)}</select></div>
              <div><Lbl t="Dept" /><select value={form.dept || ""} onChange={e => setForm(f => ({ ...f, dept: e.target.value }))}><option value="">Select</option>{depts.filter(d => !form.plant || !d.plant || d.plant === "All Plants" || d.plant === form.plant).map(d => <option key={d.id}>{d.name}</option>)}</select></div>
              <div><Lbl t="Superior (Reports To)" /><select value={form.superior || ""} onChange={e => setForm(f => ({ ...f, superior: e.target.value }))}><option value="">None (Top level)</option>{users.filter(u => u.id !== form.id).map(u => <option key={u.id} value={u.name}>{u.name} ({u.role})</option>)}</select></div>
              <div style={{ gridColumn: "1/-1" }}><Lbl t="Phone Number" /><input value={form.phone || ""} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+91-98000-00000" /></div>
              <div style={{ gridColumn: "1/-1" }}><Lbl t="Email Address" /><input type="email" value={form.email || ""} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="name@company.com" /></div>
              {isAdmin && <label style={{ gridColumn: "1/-1", display: "flex", alignItems: "center", gap: 10, fontSize: 12, cursor: "pointer", padding: "6px 0" }}>
                <input type="checkbox" checked={form.masterAccess === true} onChange={e => setForm(f => ({ ...f, masterAccess: e.target.checked }))} style={{ width: 16, height: 16, accentColor: T.navy }} />
                <span>Allow Master Setup access (plant-scoped)</span>
              </label>}
              {modal.mode !== "edit" && (
                <div style={{ gridColumn: "1/-1" }}>
                  <Lbl t="Password" req={!isGuestRole(form.role)} />
                  <div style={{ position: "relative" }}>
                    <input type={form._showPw ? "text" : "password"} value={form.password || ""} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Set login password" style={{ paddingRight: 44 }} />
                    <button type="button" onClick={() => setForm(f => ({ ...f, _showPw: !f._showPw }))} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: T.text2, lineHeight: 1, padding: 0, display: "flex", alignItems: "center" }}>{form._showPw ? "🙈" : "👁"}</button>
                  </div>
                </div>
              )}
              <div style={{ gridColumn: "1/-1", display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn btn-ghost" onClick={close}>Cancel</button><button className="btn btn-navy" onClick={saveUser}>Save</button></div>
            </div>}
            {modal.type === "roles" && <div style={{ display: "grid", gap: 12 }}>
              <div><Lbl t="Role Name" req /><input value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Enter role name" /></div>
              <div><Lbl t="Hierarchy Level" req /><input type="number" min={1} value={form.level || ""} onChange={e => setForm(f => ({ ...f, level: e.target.value === "" ? "" : parseInt(e.target.value, 10) }))} placeholder="e.g. 1 (Highest) to 8 (Lowest)" /></div>
              <div style={{ gridColumn: "1/-1", display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" onClick={close}>Cancel</button>
                  <button className="btn btn-navy" onClick={() => {
                  if (!form.name || form.level === undefined || form.level === "") return;
                  const r = { ...form, id: form.id || "R" + String(Date.now()).slice(-6) };
                  if (modal.mode === "edit") {
                    setRoles(prev => prev.map(x => x.id === r.id ? r : x));
                    apiUpdate("roles", r.id, r);
                  } else {
                    setRoles(prev => [...prev, r]);
                    apiCreate("roles", r);
                  }
                  close();
                }}>Save</button>
              </div>
            </div>}
            {modal.type === "plants" && <div style={{ display: "grid", gap: 12 }}>
              <div><Lbl t="Plant Name" req /><input value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
              <div><Lbl t="Location" /><input value={form.location || ""} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} /></div>
              {plantSaveStatus && plantSaveStatus !== "saving" && plantSaveStatus !== "ok" && (
                <div style={{ padding: "8px 12px", background: "#FEF3CD", border: "1px solid #F5C842", borderRadius: 8, fontSize: 12, color: "#7D4E00" }}>
                  ⚠ Save failed: {plantSaveStatus}. Data kept locally — use "Save to Server" to retry.
                </div>
              )}
              {plantSaveStatus === "ok" && (
                <div style={{ padding: "8px 12px", background: "#D4EDDA", border: "1px solid #28A745", borderRadius: 8, fontSize: 12, color: "#155724" }}>
                  ✓ Saved successfully.
                </div>
              )}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn btn-ghost" onClick={close}>Cancel</button><button className="btn btn-navy" disabled={plantSaveStatus === "saving"} onClick={async () => { if (!form.name) return; setPlantSaveStatus("saving"); try { const p = { ...form, id: form.id || "P" + String(Date.now()).slice(-6) }; const updated = modal.mode === "edit" ? plants.map(x => x.id === p.id ? p : x) : [...plants, p]; setPlants(updated); await saveToAPI("Plants", updated); setPlantSaveStatus("ok"); setTimeout(() => { setPlantSaveStatus(null); close(); }, 800); } catch (err) { setPlantSaveStatus(err.message || "Unknown error"); } }}>{plantSaveStatus === "saving" ? "Saving…" : "Save"}</button></div>
            </div>}
            {modal.type === "depts" && <div style={{ display: "grid", gap: 12 }}>
              <div><Lbl t="Dept Name" req /><input value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
              <div><Lbl t="Plant" /><select value={form.plant || ""} onChange={e => setForm(f => ({ ...f, plant: e.target.value }))}><option value="">All Plants</option>{plants.map(p => <option key={p.id}>{p.name}</option>)}</select></div>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 10 }}>
                <div><Lbl t="Icon" /><input value={form.icon || ""} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} /></div>
              </div>
              {deptSaveStatus && deptSaveStatus !== "saving" && deptSaveStatus !== "ok" && (
                <div style={{ padding: "8px 12px", background: "#FEF3CD", border: "1px solid #F5C842", borderRadius: 8, fontSize: 12, color: "#7D4E00" }}>
                  ⚠ Save failed: {deptSaveStatus}. Data kept locally — use "Save to Server" to retry.
                </div>
              )}
              {deptSaveStatus === "ok" && (
                <div style={{ padding: "8px 12px", background: "#D4EDDA", border: "1px solid #28A745", borderRadius: 8, fontSize: 12, color: "#155724" }}>
                  ✓ Saved successfully.
                </div>
              )}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn btn-ghost" onClick={close}>Cancel</button><button className="btn btn-navy" disabled={deptSaveStatus === "saving"} onClick={async () => { if (!form.name) return; setDeptSaveStatus("saving"); try { const pMap = {}; plants.forEach(p => { pMap[p.name] = p.id; }); const d = { ...form, id: form.id || "D" + String(Date.now()).slice(-6), icon: form.icon || "🔹", plantId: pMap[form.plant] || form.plantId || null }; const updated = modal.mode === "edit" ? depts.map(x => x.id === d.id ? d : x) : [...depts, d]; setDepts(updated); await saveToAPI("Departments", updated); setDeptSaveStatus("ok"); setTimeout(() => { setDeptSaveStatus(null); close(); }, 800); } catch (err) { setDeptSaveStatus(err.message || "Unknown error"); } }}>{deptSaveStatus === "saving" ? "Saving…" : "Save"}</button></div>
            </div>}
            {modal.type === "machines" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
              <div style={{ gridColumn: "1/-1" }}><Lbl t="Machine Name" req /><input value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Furnace Line 1" /></div>
              <div><Lbl t="Plant" /><select value={form.plant || ""} onChange={e => setForm(f => ({ ...f, plant: e.target.value, dept: "" }))}><option value="">Select plant…</option>{plants.map(p => <option key={p.id}>{p.name}</option>)}</select></div>
              <div><Lbl t="Department" /><select value={form.dept || ""} onChange={e => setForm(f => ({ ...f, dept: e.target.value }))}><option value="">Select dept…</option>{depts.filter(d => !form.plant || form.plant === "All Plants" || !d.plant || d.plant === "All Plants" || d.plant === form.plant).map(d => <option key={d.id}>{d.name}</option>)}</select></div>
              <div><Lbl t="Machine Type" /><input value={form.type || ""} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} placeholder="e.g. Furnace, Crane, Press" /></div>
              <div><Lbl t="Asset No." /><input value={form.assetNo || ""} onChange={e => setForm(f => ({ ...f, assetNo: e.target.value }))} placeholder="e.g. AST-001" /></div>
              {mcSaveStatus && mcSaveStatus !== "saving" && mcSaveStatus !== "ok" && (
                <div style={{ gridColumn: "1/-1", padding: "8px 12px", background: "#FEF3CD", border: "1px solid #F5C842", borderRadius: 8, fontSize: 12, color: "#7D4E00" }}>
                  ⚠ Save failed: {mcSaveStatus}. Machine saved locally — use "Save to Server" button to retry.
                </div>
              )}
              {mcSaveStatus === "ok" && (
                <div style={{ gridColumn: "1/-1", padding: "8px 12px", background: "#D4EDDA", border: "1px solid #28A745", borderRadius: 8, fontSize: 12, color: "#155724" }}>
                  ✓ Saved successfully.
                </div>
              )}
              <div style={{ gridColumn: "1/-1", display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" onClick={close}>Cancel</button>
                <button className="btn btn-navy" disabled={mcSaveStatus === "saving"} onClick={async () => {
                  if (!form.name) return;
                  const mc = { ...form, id: form.id || "MC" + String(Date.now()).slice(-6) };
                  const pMap = {}; plants.forEach(p => { pMap[p.name] = p.id; });
                  const dMap = {}; depts.forEach(d => { dMap[d.name] = d.id; });
                  mc.plantId = pMap[form.plant] || form.plantId || null;
                  mc.deptId = dMap[form.dept] || form.deptId || null;
                  const updated = modal.mode === "edit"
                    ? (machines || []).map(x => x.id === mc.id ? mc : x)
                    : [...(machines || []), mc];
                  setMachines(updated);
                  setMcSaveStatus("saving");
                  try {
                    await saveToAPI("Machines", updated);
                    setMcSaveStatus("ok");
                    setTimeout(() => { setMcSaveStatus(null); close(); }, 800);
                  } catch (err) {
                    console.error("Machine save failed:", err);
                    setMcSaveStatus(err.message || "Unknown error");
                  }
                }}>{mcSaveStatus === "saving" ? "Saving…" : "Save"}</button>
              </div>
            </div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ===================== API BRIDGE ===================== */
/* Minimal REST-like API bridge — exposes actions data via a global object
   that external apps can read/write via postMessage or window.MCS_API.
   Usage:
     window.MCS_API.getActions()         → all current actions
     window.MCS_API.getAction(id)        → specific action
     window.MCS_API.updateAction(id, patch) → update an action
     window.MCS_API.addAction(action)    → add a new action
   
   Via postMessage (iframe integration):
     window.postMessage({type:"MCS_GET_ACTIONS"},"*")
     → response: {type:"MCS_ACTIONS_RESULT",data:[...]}
   
   This satisfies requirement #6 — API/MCP integration option.
*/
function useAPIBridge(actions, setActions, projects, plants, depts, machines) {
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; }, [actions]);

  useEffect(() => {
    // Expose global API
          window.MCS_API = {
            version: "1.0.0",
            getActions: () => actionsRef.current,
            getAction: (id) => actionsRef.current.find(a => a.id === id || a.sn === id),
            updateAction: (id, patch) => { setActions(p => p.map(a => a.id === id ? { ...a, ...patch } : a)); apiUpdate("actions", id, patch); },
            addAction: async (action) => {
              const localId = String(Date.now());
              const n = { ...action, id: localId, created: todayStr(), revisionHistory: [], messages: [], pendingConfirmation: false };
              const resolved = resolveRecordIds(n, plants, depts, machines, projects, meetings);
              setActions(p => [...p, resolved]);
              try {
                const saved = await apiCreate("actions", resolved);
                if (saved && saved.id) setActions(p => p.map(x => x.id === localId ? { ...x, id: saved.id, sn: saved.sn || x.sn } : x));
              } catch (e) { setActions(p => p.filter(x => x.id !== localId)); }
            },
            getProjects: () => projects,
          };
    // postMessage bridge
    const handler = (e) => {
      if (!e.data || typeof e.data !== "object") return;
      switch (e.data.type) {
        case "MCS_GET_ACTIONS":
          e.source?.postMessage({ type: "MCS_ACTIONS_RESULT", data: actionsRef.current, ok: true }, "*");
          break;
        case "MCS_GET_ACTION":
          e.source?.postMessage({ type: "MCS_ACTION_RESULT", data: actionsRef.current.find(a => a.id === e.data.id), ok: true }, "*");
          break;
        case "MCS_UPDATE_ACTION":
          setActions(p => p.map(a => a.id === e.data.id ? { ...a, ...e.data.patch } : a));
          apiUpdate("actions", e.data.id, e.data.patch).catch(err => {
            setActions(p => p.map(a => a.id === e.data.id ? { ...a } : a));
          });
          e.source?.postMessage({ type: "MCS_UPDATE_OK", id: e.data.id, ok: true }, "*");
          break;
        case "MCS_ADD_ACTION": {
          const localId = String(Date.now());
          const newA = { ...e.data.action, id: localId, created: todayStr(), revisionHistory: [], messages: [], pendingConfirmation: false };
          const resolved = resolveRecordIds(newA, plants, depts, machines, projects, meetings);
          setActions(p => [...p, resolved]);
          apiCreate("actions", resolved).then(saved => {
            if (saved && saved.id) setActions(p => p.map(x => x.id === localId ? { ...x, id: saved.id, sn: saved.sn || x.sn } : x));
          }).catch(() => { setActions(p => p.filter(x => x.id !== localId)); });
          e.source?.postMessage({ type: "MCS_ADD_OK", action: resolved, ok: true }, "*");
          break;
        }
        case "MCS_GET_PROJECTS":
          e.source?.postMessage({ type: "MCS_PROJECTS_RESULT", data: projects, ok: true }, "*");
          break;
        default: break;
      }
    };
    window.addEventListener("message", handler);
    return () => { window.removeEventListener("message", handler); delete window.MCS_API; };
  }, [setActions, projects, plants, depts, machines]);
}

/* ===================== ERROR BOUNDARY ===================== */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, errorInfo) {
    console.error("[MCS ErrorBoundary] CRASH:", error?.message, "\nStack:", error?.stack, "\nComponent Stack:", errorInfo?.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#F5F5FB", padding: 20, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h1 style={{ fontFamily: "'Sora',sans-serif", fontSize: 20, color: "#272262", marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#636E72", fontSize: 13, maxWidth: 400, marginBottom: 20, lineHeight: 1.5 }}>{this.state.error?.message || "An unexpected error occurred."}</p>
          <button className="btn btn-navy" onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}>Reload Application</button>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ===================== ROOT APP ===================== */
export default function App() {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem("mcs_session_user");
      return saved ? JSON.parse(saved) : null;
    } catch (e) { return null; }
  });
  const [audit, setAudit] = useState([]);
  const [page, setPage] = useState(() => {
    const saved = localStorage.getItem("mcs_session_page");
    return saved ? parseInt(saved, 10) || 0 : 0;
  });
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickSaving, setQuickSaving] = useState(false);

  // ── Postgres live database ──
  const {
    dbReady, dbError, fetchData,
    users, setUsers,
    plants, setPlants,
    depts, setDepts,
    actions, setActions,
    meetings, setMeetings,
    projects, setProjects,
    escMatrix, setEscMatrix,
    mtgPresets, setMtgPresets,
    machines, setMachines,
    reasons, setReasons,
    persistedAudit, setPersistedAudit,
    roles, setRoles,
  } = usePostgresDB({
    defaultUsers: DEFAULT_USERS,
    defaultPlants: DEFAULT_PLANTS,
    defaultDepts: DEFAULT_DEPTS,
    defaultActions: SEED_ACTIONS,
    defaultMeetings: SEED_MEETINGS,
    defaultProjects: SEED_PROJECTS,
    defaultEscMatrix: DEFAULT_ESC_MATRIX,
    defaultPresets: { attendeeMap: ATTENDEE_MAP, instructions: MTG_INSTRUCTIONS },
    defaultMachines: [],
    defaultRoles: [
      { id: "R1", name: "Guest User", level: 1 },
      { id: "R3", name: "Supervisor", level: 3 },
      { id: "R4", name: "Shift Engineer", level: 4 },
      { id: "R5", name: "HOD", level: 5 },
      { id: "R6", name: "Plant Head", level: 6 },
      { id: "R7", name: "MD", level: 7 },
      { id: "R8", name: "Admin", level: 8 }
    ]
  });

  // Global active meeting — persists across page navigation + browser refresh
  const [globalActiveMtg, setGlobalActiveMtg] = useState(() => {
    try { const s = localStorage.getItem("mcs_mtg_active"); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [mtgRunning, setMtgRunning] = useState(() => {
    try { return localStorage.getItem("mcs_mtg_running") === "true"; } catch { return false; }
  });
  const [mtgElapsed, setMtgElapsed] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem("mcs_mtg_elapsed") || "0", 10);
      const savedTs = parseInt(localStorage.getItem("mcs_mtg_timestamp") || "0", 10);
      // If meeting was running, add elapsed wall-clock time since last save
      const running = localStorage.getItem("mcs_mtg_running") === "true";
      if (running && savedTs > 0) {
        const diff = Math.floor((Date.now() - savedTs) / 1000);
        return saved + diff;
      }
      return saved;
    } catch { return 0; }
  });
  const [mtgTxLines, setMtgTxLines] = useState(() => {
    try { const s = localStorage.getItem("mcs_mtg_txlines"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [mtgFastActions, setMtgFastActions] = useState(() => {
    try { const s = localStorage.getItem("mcs_mtg_fastactions"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [mtgInsights, setMtgInsights] = useState(() => {
    try { const s = localStorage.getItem("mcs_mtg_insights"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const mtgTxLineNo = useRef(0);
  const mtgTimerRef = useRef(null);
  const mtgTxRef = useRef(null);

  // Global 401 → force logout
  useEffect(() => {
    setOnAuthExpired(() => {
      localStorage.removeItem("mcs_token");
      setUser(null);
      setPage(0);
    });
    return () => setOnAuthExpired(null);
  }, []);

  // Persist session
  useEffect(() => {
    if (user) localStorage.setItem("mcs_session_user", JSON.stringify(user));
    else localStorage.removeItem("mcs_session_user");
  }, [user]);
  useEffect(() => {
    localStorage.setItem("mcs_session_page", page);
  }, [page]);

  // Persist meeting room state to localStorage so it survives browser refresh
  useEffect(() => {
    if (globalActiveMtg) localStorage.setItem("mcs_mtg_active", JSON.stringify(globalActiveMtg));
    else localStorage.removeItem("mcs_mtg_active");
  }, [globalActiveMtg]);
  useEffect(() => {
    localStorage.setItem("mcs_mtg_running", String(mtgRunning));
  }, [mtgRunning]);
  useEffect(() => {
    localStorage.setItem("mcs_mtg_elapsed", String(mtgElapsed));
    localStorage.setItem("mcs_mtg_timestamp", String(Date.now()));
  }, [mtgElapsed]);
  useEffect(() => {
    if (mtgTxLines.length > 0) localStorage.setItem("mcs_mtg_txlines", JSON.stringify(mtgTxLines));
    else localStorage.removeItem("mcs_mtg_txlines");
  }, [mtgTxLines]);
  useEffect(() => {
    if (mtgFastActions.length > 0) localStorage.setItem("mcs_mtg_fastactions", JSON.stringify(mtgFastActions));
    else localStorage.removeItem("mcs_mtg_fastactions");
  }, [mtgFastActions]);
  useEffect(() => {
    if (mtgInsights.length > 0) localStorage.setItem("mcs_mtg_insights", JSON.stringify(mtgInsights));
    else localStorage.removeItem("mcs_mtg_insights");
  }, [mtgInsights]);

  // Seed in-memory audit from persisted audit data on first load.
  // Dependency is intentionally dbReady only — running on persistedAudit would create a sync loop.
  useEffect(() => {
    if (dbReady && Array.isArray(persistedAudit) && persistedAudit.length > 0) {
      // Deduplicate on read — handles stale duplicate rows written before this fix
      const seen = new Set();
      const deduped = persistedAudit.filter(e => {
        const key = `${e.sn}_${e.level}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setAudit(deduped);
    }
  }, [dbReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global timer only — transcript now driven by real STT inside MeetingRoom
  useEffect(() => {
    if (mtgRunning && globalActiveMtg) {
      mtgTimerRef.current = setInterval(() => setMtgElapsed(e => e + 1), 1000);
    } else {
      clearInterval(mtgTimerRef.current);
    }
    return () => clearInterval(mtgTimerRef.current);
  }, [mtgRunning, globalActiveMtg]);

  // ── Background Autosave ──
  // 1) Periodically flush any pending (failed) saves to the backend.
  // 2) Periodically snapshot core collections to localStorage as a backup.
  useEffect(() => {
    const flushTimer = setInterval(() => { flushPendingSaves(); }, 15000);
    const snapTimer = setInterval(() => {
      snapshotLocal({ actions, meetings, projects, machines });
      if (pendingOps.size === 0) { _autosaveState = { ..._autosaveState, status: "saved", lastSaved: Date.now() }; emitAutosave(); }
    }, 30000);
    // flush once shortly after load to recover anything queued
    const kick = setTimeout(() => flushPendingSaves(), 4000);
    return () => { clearInterval(flushTimer); clearInterval(snapTimer); clearTimeout(kick); };
  }, [actions, meetings, projects, machines]);

  // ── Live meeting draft autosave ──
  // While a meeting is actively running, push the live transcript / fast
  // actions / insights to the backend so an in-progress meeting is never lost
  // if the tab crashes or is closed before the final commit.
  useEffect(() => {
    if (!mtgRunning || !globalActiveMtg || !globalActiveMtg.id) return;
    const draftTimer = setInterval(() => {
      const draft = {
        txLines: mtgTxLines || [],
        fastActions: mtgFastActions || [],
        insights: mtgInsights || [],
        elapsed: mtgElapsed || 0,
        ts: Date.now(),
      };
      apiUpdate("meetings", globalActiveMtg.id, { live_draft: draft }, { track: false })
        .then(() => { _autosaveState = { ..._autosaveState, status: "saved", lastSaved: Date.now() }; emitAutosave(); })
        .catch(() => { /* will retry next tick */ });
    }, 15000);
    return () => clearInterval(draftTimer);
  }, [mtgRunning, globalActiveMtg, mtgTxLines, mtgFastActions, mtgInsights, mtgElapsed]);

  // Reset meeting state when meeting ends
  const clearMeetingState = () => {
    setGlobalActiveMtg(null); setMtgRunning(false); setMtgElapsed(0);
    setMtgTxLines([]); setMtgFastActions([]); setMtgInsights([]); mtgTxLineNo.current = 0;
    ["mcs_mtg_active","mcs_mtg_running","mcs_mtg_elapsed","mcs_mtg_timestamp","mcs_mtg_txlines","mcs_mtg_fastactions","mcs_mtg_insights"].forEach(k => localStorage.removeItem(k));
  };

  useAPIBridge(actions, setActions, projects, plants, depts, machines);

  // Real-time polling: keep this browser in sync with other users' changes
  const { lastSync, syncing } = useRealtimeSync({ fetchData, user, enabled: !!user });

  useEffect(() => {
    const t = setTimeout(() => runEscalation(actions, (updater) => {
      setAudit(updater);
      // Persist audit, deduplicating by SN+level to prevent
      // duplicate rows accumulating across sessions / re-runs.
      setPersistedAudit(prev => {
        const current = Array.isArray(prev) ? prev : [];
        const updated = typeof updater === "function" ? updater(current) : updater;
        const seen = new Set();
        return updated.filter(e => {
          const key = `${e.sn}_${e.level}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, 100);
      });
    }, escMatrix, users), 1500);
    return () => clearTimeout(t);
  }, [actions]);

  const committingRef = useRef(false);
  const [committing, setCommitting] = useState(false);
  const commitFinal = rows => {
    if (committingRef.current) return;
    committingRef.current = true;
    setCommitting(true);
    const localIds = [];
    const resolvedRows = rows.map((r, i) => {
      const localId = String(Date.now() + i);
      localIds.push(localId);
      const base = { ...r, id: localId, messages: r.messages || [], revisionHistory: r.revisionHistory || [], pendingConfirmation: false, allocatedBy: r.allocatedBy || user?.name || "" };
      return resolveRecordIds(base, plants, depts, machines, projects, meetings);
    });
    setActions(p => [...p, ...resolvedRows]);
    Promise.all(
      resolvedRows.map(async (r, i) => {
        try {
          const saved = await apiCreate("actions", r);
          if (saved && saved.id) {
            setActions(p => p.map(x => x.id === localIds[i] ? { ...x, id: saved.id, sn: saved.sn || x.sn } : x));
          }
        } catch (e) {
          setActions(p => p.filter(x => x.id !== localIds[i]));
          setDbError("Failed to save action: " + e.message);
          setTimeout(() => setDbError(null), 5000);
        }
      })
    ).finally(() => {
      committingRef.current = false;
      setCommitting(false);
      fetchData();
    });
    if (globalActiveMtg && globalActiveMtg.id) {
      const sessionEntry = { date: todayStr(), duration: mtgElapsed || 0, actionCount: rows.length, attendees: ensureArray(globalActiveMtg.attendees || []), facilitator: globalActiveMtg.facilitator || "" };
      setMeetings(p => (p || []).map(m => m.id === globalActiveMtg.id ? { ...m, completedSessions: [...ensureArray(m.completedSessions), sessionEntry] } : m));
      // Persist the completed session AND clear the live draft in one update.
      apiUpdate("meetings", globalActiveMtg.id, { completedSessions: [...ensureArray(globalActiveMtg.completedSessions), sessionEntry], live_draft: {} }, { track: false });
    }
  };
  const updateAction = async (id, patch) => {
    setActions(p => p.map(a => {
      if (a.id !== id) return a;
      if (patch.due && patch.due !== a.due) {
        const rev = { date: todayStr(), from: a.due, to: patch.due, by: user?.name || "Unknown" };
        return { ...a, ...patch, revisions: (a.revisions || 0) + 1, revisionHistory: [...(a.revisionHistory || []), rev] };
      }
      return { ...a, ...patch };
    }));
    try {
      const saved = await apiUpdate("actions", id, resolveRecordIds(patch, plants, depts, machines, projects, meetings));
      if (saved && saved.id) {
        setActions(p => p.map(a => a.id === id ? { ...a, version: saved.version, revisions: saved.revisions } : a));
      }
    } catch (e) {
      setDbError("Failed to update action: " + e.message);
      setTimeout(() => setDbError(null), 5000);
      fetchData();
    }
  };

  // Sidebar Actions badge = open (non-completed, non-dropped) actions in user's plant scope
  const pendingForMe = actions.filter(a => {
    if (a.status === "COMPLETED" || a.status === "DROPPED") return false;
    if (isUserAdmin(user) || user?.plant === "All") return true;
    return !a.plant || a.plant === user?.plant;
  }).length;

  // Notification system
  const { notifs, unread: unreadNotifs, markAllRead, markRead } = useNotifications(actions, audit, user, users);

  // UI modals/panels
  const [showSupport, setShowSupport] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showAdminNotifs, setShowAdminNotifs] = useState(false);

  // Active-session count (for the "My Sessions" badge in the user menu)
  const [onlineCount, setOnlineCount] = useState(0);
  useEffect(() => {
    if (!user) { setOnlineCount(0); return; }
    const loadCount = () => {
      apiGet("/api/sessions/mine").then(s => setOnlineCount(Array.isArray(s) ? s.length : 0)).catch(() => {});
    };
    loadCount();
    const t = setInterval(loadCount, 60000);
    return () => clearInterval(t);
  }, [user]);

  // Loading screen while data loads
  if (!dbReady) return (
    <ErrorBoundary>
      <style>{CSS}</style>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: `linear-gradient(135deg,${T.navy} 0%,#3D378C 100%)`, gap: 16 }}>
        <div style={{ fontFamily: "'Sora',sans-serif", fontWeight: 800, fontSize: 22, color: "#fff" }}>Management Control System</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "rgba(255,255,255,.7)", fontSize: 13 }}>
          <span style={{ width: 18, height: 18, border: "2px solid rgba(255,255,255,.5)", borderTopColor: "#fff", borderRadius: "50%", display: "inline-block", animation: "spin .7s linear infinite" }} />
          Loading data from server…
        </div>
        {dbError && <div style={{ fontSize: 11, color: "#FEF3CD", marginTop: 4 }}>⚠ {dbError}</div>}
      </div>
    </ErrorBoundary>
  );

  if (!user) return (<ErrorBoundary><style>{CSS}</style><LoginPage onLogin={acc => { setUser(acc); setPage(0); }} /></ErrorBoundary>);

  return (
    <ErrorBoundary>
      <style>{CSS}</style>
      <Shell page={page} setPage={setPage} user={user} onLogout={() => { try { apiPost("/api/auth/logout", {}).catch(() => {}); } finally { setUser(null); setPage(0); clearMeetingState(); } }} onQuickAdd={() => setShowQuickAdd(true)} pendingCount={pendingForMe} auditCount={audit.length} activeMtg={globalActiveMtg} onResumeActiveMtg={() => setPage(1)} mtgRunning={mtgRunning} mtgElapsed={mtgElapsed} notifications={notifs} unreadCount={unreadNotifs} onMarkAllRead={markAllRead} users={users} actions={actions} onShowSupport={() => setShowSupport(true)} onShowProfile={() => setShowProfile(true)} onShowAdminNotifs={() => setShowAdminNotifs(true)} onShowSessions={() => setShowSessions(true)} onlineCount={onlineCount} lastSync={lastSync} syncing={syncing}>
        {page === 0 && <HomePage actions={actions} setActions={setActions} user={user} setPage={setPage} users={users} meetings={meetings} plants={plants} depts={depts} setGlobalActiveMtg={m => { setGlobalActiveMtg(m); setMtgRunning(true); }} machines={machines} projects={projects} />}
        {page === 1 && <WorkPage plants={plants} depts={depts} users={users} onCommitFinal={rows => { commitFinal(rows); clearMeetingState(); }} actions={actions} setActions={setActions} user={user} onProjectUpdate={updated => { setProjects(p => p.map(x => x.id === updated.id ? updated : x)); apiUpdate("projects", updated.id, updated); }} allProjects={projects} setProjects={setProjects} allMeetings={meetings} setMeetings={setMeetings} setPage={setPage} globalActiveMtg={globalActiveMtg} setGlobalActiveMtg={m => { setGlobalActiveMtg(m); if (m) setMtgRunning(true); }} mtgRunning={mtgRunning} setMtgRunning={setMtgRunning} mtgElapsed={mtgElapsed} mtgTxLines={mtgTxLines} setMtgTxLines={setMtgTxLines} mtgFastActions={mtgFastActions} setMtgFastActions={setMtgFastActions} mtgInsights={mtgInsights} setMtgInsights={setMtgInsights} clearMeetingState={clearMeetingState} mtgPresets={mtgPresets} machines={machines} reasons={reasons} />}
        {page === 2 && <ActionsPage actions={actions} setActions={setActions} plants={plants} depts={depts} users={users} user={user} projects={projects} machines={machines} meetings={meetings} />}
        {page === 3 && <DashboardPage actions={actions} plants={plants} depts={depts} users={users} audit={audit} user={user} meetings={meetings} onViewEscalations={() => setPage(4)} refreshData={fetchData} setActions={setActions} />}
        {page === 4 && <EscalationsPage actions={actions} setActions={setActions} audit={audit} users={users} escMatrix={escMatrix} plants={plants} depts={depts} user={user} />}
        {page === 99 && canAccessMasterSetup(user) && <MasterPage user={user} plants={plants} setPlants={setPlants} depts={depts} setDepts={setDepts} users={users} setUsers={setUsers} escMatrix={escMatrix} setEscMatrix={setEscMatrix} mtgPresets={mtgPresets} setMtgPresets={setMtgPresets} machines={machines} setMachines={setMachines} refreshMaster={fetchData} roles={roles} setRoles={setRoles} actions={actions} setActions={setActions} />}
      </Shell>
      {dbError && (
        <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 9999, background: "#FEF3CD", border: "1px solid #F5C842", borderRadius: 10, padding: "10px 20px", fontSize: 12, color: "#7D4E00", boxShadow: "0 4px 20px rgba(0,0,0,.15)", maxWidth: "90vw", textAlign: "center" }}>
          ⚠ {dbError}
        </div>
      )}
      {showSupport && <SupportModal user={user} onClose={() => setShowSupport(false)} />}
      {showProfile && <UserProfilePanel user={user} users={users} actions={actions} onClose={() => setShowProfile(false)} />}
      {showSessions && <SessionsManagerModal user={user} onClose={() => setShowSessions(false)} />}
      {showAdminNotifs && isUserAdmin(user) && <AdminNotifManager users={users} onClose={() => setShowAdminNotifs(false)} />}
      {showQuickAdd && (
        <AddActionPanel
          users={users} plants={plants} depts={depts}
          defaultPlant={user?.plant === "All" ? "" : user?.plant}
          defaultSrc="Quick Add"
          projects={projects}
          meetings={meetings}
          machines={machines}
          reasons={reasons}
          currentUser={user}
          saving={quickSaving}
          onSave={async (a, files) => {
            if (committingRef.current) return;
            committingRef.current = true;
            setQuickSaving(true);
            const localId = String(Date.now());
            const newAction = { ...a, id: localId, dateOfAction: todayStr(), revisions: 0, revisionHistory: [], created: todayStr(), closedOn: null, status: "IN PROCESS", messages: [], pendingConfirmation: false, allocatedBy: user?.name || "" };
            const resolved = resolveRecordIds(newAction, plants, depts, machines, projects, meetings);
            setActions(p => [...p, resolved]);
            try {
              const saved = await apiCreate("actions", resolved);
              if (saved && saved.id) {
                setActions(p => p.map(x => x.id === localId ? { ...x, id: saved.id, sn: saved.sn || x.sn } : x));
                // Upload pending files to the saved action
                if (files && files.length > 0) {
                  const failed = [];
                  for (const pf of files) {
                    try {
                      const formData = new FormData();
                      formData.append("file", pf.file);
                      const resp = await fetch(`${API_BASE_URL}/api/actions/${saved.id}/attachments`, {
                        method: "POST",
                        headers: { "x-api-key": API_KEY, "Authorization": `Bearer ${AUTH_TOKEN || localStorage.getItem("mcs_token")}` },
                        body: formData,
                      });
                      if (!resp.ok) failed.push(pf.file.name);
                    } catch (err) { failed.push(pf.file.name); }
                  }
                  if (failed.length > 0) {
                    setDbError(`Upload failed for: ${failed.join(", ")}. Action was saved without attachments.`);
                    setTimeout(() => setDbError(null), 6000);
                  }
                }
              }
              fetchData();
            } catch (e) {
              setActions(p => p.filter(x => x.id !== localId));
              setDbError("Failed to save action: " + e.message);
              setTimeout(() => setDbError(null), 5000);
            } finally {
              committingRef.current = false;
              setQuickSaving(false);
            }
            setShowQuickAdd(false);
          }}
          onClose={() => setShowQuickAdd(false)}
        />
      )}
    </ErrorBoundary>
  );
}
