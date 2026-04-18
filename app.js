const STORAGE_KEY = "hypertrophy_pwa_v1";

function uid() {
  return crypto.randomUUID();
}

function todayStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function isToday(ts) {
  return todayStart(ts) === todayStart(Date.now());
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    return {
      programDays: s.programDays ?? [],
      sessions: s.sessions ?? [],
    };
  } catch {
    return defaultState();
  }
}

function defaultState() {
  return { programDays: [], sessions: [] };
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function loadBundledProgram() {
  try {
    const r = await fetch("./bundled_program.json", { cache: "no-store" });
    if (!r.ok) throw new Error("fetch");
    return await r.json();
  } catch {
    const el = document.getElementById("program-embed");
    if (el) {
      try {
        return JSON.parse(el.textContent);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function seedProgramFromJson(data, state) {
  if (!data?.days?.length) return;
  state.programDays = data.days.map((d, di) => ({
    dayKey: d.dayKey,
    dayTitle: d.dayTitle,
    sortOrder: di,
    lines: (d.lines || []).map((l, li) => ({
      id: `${di}-${li}`,
      sortOrder: li,
      category: l.category,
      exerciseName: l.exerciseName,
      prescribedSets: l.prescribedSets,
      prescribedRepRange: l.prescribedRepRange,
    })),
  }));
  saveState(state);
}

function getDay(state, dayKey) {
  return state.programDays.find((d) => d.dayKey === dayKey);
}

function openSessionsForDay(state, dayKey) {
  return state.sessions.filter((s) => !s.completed && s.dayKey === dayKey);
}

function activeSessionAny(state) {
  return [...state.sessions].reverse().find((s) => !s.completed) || null;
}

function activeSessionToday(state, dayKey) {
  return openSessionsForDay(state, dayKey).find((s) => isToday(s.startedAt));
}

function closeStaleSessions(state, dayKey) {
  for (const s of [...state.sessions]) {
    if (!s.completed && s.dayKey === dayKey && !isToday(s.startedAt)) {
      // If nothing was logged, discard instead of saving empty history.
      if (!s.sets?.length) {
        state.sessions = state.sessions.filter((x) => x.id !== s.id);
      } else {
        s.completed = true;
        s.finishedAt = Date.now();
      }
    }
  }
}

function startWorkout(state, day, startedAt) {
  const other = activeSessionAny(state);
  if (other && other.dayKey !== day.dayKey) return null;
  closeStaleSessions(state, day.dayKey);
  const session = {
    id: uid(),
    startedAt: startedAt ?? Date.now(),
    dayKey: day.dayKey,
    dayTitleSnapshot: day.dayTitle,
    completed: false,
    sets: [],
  };
  state.sessions.push(session);
  saveState(state);
  return session;
}

function finishWorkout(state, sessionId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) {
    // Don't save empty workouts into history/progress.
    if (!s.sets?.length) {
      state.sessions = state.sessions.filter((x) => x.id !== s.id);
      saveState(state);
      return;
    }
    s.completed = true;
    s.finishedAt = Date.now();
    saveState(state);
  }
}

function setsForLine(session, lineId) {
  return session.sets
    .filter((x) => x.programLineId === lineId)
    .sort((a, b) => a.setIndex - b.setIndex);
}

function addSet(state, sessionId, line, reps, weightLb) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  const existing = setsForLine(s, line.id);
  const next = (existing.map((x) => x.setIndex).reduce((a, b) => Math.max(a, b), 0) || 0) + 1;
  s.sets.push({
    id: uid(),
    programLineId: line.id,
    exerciseNameSnapshot: line.exerciseName,
    setIndex: next,
    reps,
    weightLb,
  });
  saveState(state);
}

function deleteSet(state, sessionId, setId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return;
  s.sets = s.sets.filter((x) => x.id !== setId);
  saveState(state);
}

function formatWeight(w) {
  return Number.isInteger(w) ? String(w) : w.toFixed(1);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function parseRepRange(txt) {
  if (!txt) return null;
  const s = String(txt)
    .trim()
    .replace(/[–—]/g, "-")
    .replace(/[^\d\-]/g, "");
  const m = s.match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  if (!lo || !hi) return null;
  return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
}

function estimate1RM(weight, reps) {
  const w = Number(weight);
  const r = Number(reps);
  if (!w || w <= 0 || !r || r <= 0) return null;
  const rr = clamp(r, 1, 12);
  // Epley: 1RM = w * (1 + reps/30), clamped to reasonable rep counts.
  return w * (1 + rr / 30);
}

/** Inverse Epley (same model as estimate1RM): working weight for a target rep count. */
function workingWeightFrom1RM(oneRmLb, reps) {
  const om = Number(oneRmLb);
  const r = clamp(Number(reps), 1, 12);
  if (!om || om <= 0 || !r) return null;
  return om / (1 + r / 30);
}

/** Per calendar day: best est. 1RM from logged sets + mean weight (sets with weight &gt; 0). */
function exerciseChartPoints(state, exerciseName) {
  const name = String(exerciseName || "");
  const byDay = new Map();

  for (const s of state.sessions) {
    if (!sessionIncludedForWeightMetrics(s)) continue;
    const rows = (s.sets || []).filter((r) => r.exerciseNameSnapshot === name);
    if (!rows.length) continue;
    const d = todayStart(s.startedAt);
    const cell = byDay.get(d) || { best1: null, sumW: 0, countW: 0 };
    for (const row of rows) {
      const w = Number(row.weightLb);
      if (w > 0) {
        cell.sumW += w;
        cell.countW += 1;
        const est = estimate1RM(w, row.reps);
        if (est != null && (!cell.best1 || est > cell.best1)) cell.best1 = est;
      }
    }
    byDay.set(d, cell);
  }

  return [...byDay.entries()]
    .map(([ts, v]) => ({
      ts,
      est1rm: v.best1,
      avgWeight: v.countW > 0 ? v.sumW / v.countW : null,
    }))
    .filter((p) => p.est1rm != null || p.avgWeight != null)
    .sort((a, b) => a.ts - b.ts);
}

function exerciseHistoryPoints(state, exerciseName) {
  return exerciseChartPoints(state, exerciseName)
    .filter((p) => p.est1rm != null)
    .map((p) => ({ ts: p.ts, est1rm: p.est1rm }));
}

function allExerciseNames(state) {
  const set = new Set();
  for (const s of state.sessions) {
    for (const row of s.sets || []) set.add(row.exerciseNameSnapshot);
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function sessionIncludedForWeightMetrics(s) {
  return s.completed || isToday(s.startedAt);
}

function exerciseLoggedWeights(state, exerciseName) {
  const name = String(exerciseName || "");
  const weights = [];
  for (const s of state.sessions) {
    if (!sessionIncludedForWeightMetrics(s)) continue;
    for (const row of s.sets || []) {
      if (row.exerciseNameSnapshot !== name) continue;
      const w = Number(row.weightLb);
      if (w > 0) weights.push(w);
    }
  }
  return weights;
}

function avgWeightExercise(state, exerciseName) {
  const w = exerciseLoggedWeights(state, exerciseName);
  if (!w.length) return null;
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/** Most recent completed session that logged this exercise; mean weight of those sets. */
function lastFinishedWorkoutWeightAvg(state, exerciseName) {
  const name = String(exerciseName || "");
  const sessions = [...state.sessions].filter((s) => s.completed).sort((a, b) => b.startedAt - a.startedAt);
  for (const s of sessions) {
    const rows = (s.sets || []).filter((r) => r.exerciseNameSnapshot === name && Number(r.weightLb) > 0);
    if (!rows.length) continue;
    const avg = rows.reduce((a, r) => a + r.weightLb, 0) / rows.length;
    return { avg, startedAt: s.startedAt };
  }
  return null;
}

function formatAvgLb(x) {
  if (x == null) return "—";
  const n = Math.round(x * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)} lb`;
}

function trendPct(points) {
  if (!points || points.length < 2) return null;
  const a = points[Math.max(0, points.length - 4)]?.est1rm;
  const b = points[points.length - 1]?.est1rm;
  if (!a || !b) return null;
  return ((b - a) / a) * 100;
}

const CHART_AVG_COLOR = "#7dd3fc";

function svgLineChart(points, { width = 520, height = 176, pad = 12 } = {}) {
  if (!points?.length) return "";
  const pts = points.slice(-12);
  const values = [];
  for (const p of pts) {
    if (p.est1rm != null) values.push(p.est1rm);
    if (p.avgWeight != null) values.push(p.avgWeight);
  }
  if (!values.length) return "";
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const span = Math.max(1e-6, maxY - minY);
  const w = width;
  const h = height;
  const x0 = pad;
  const y0 = pad + 18;
  const x1 = w - pad;
  const y1 = h - pad - 22;

  const xAt = (i) => x0 + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (x1 - x0));
  const yAt = (v) => y1 - ((v - minY) / span) * (y1 - y0);

  function pathFor(key) {
    let d = "";
    let penUp = true;
    for (let i = 0; i < pts.length; i++) {
      const v = pts[i][key];
      if (v == null || !Number.isFinite(v)) {
        penUp = true;
        continue;
      }
      const x = xAt(i);
      const y = yAt(v);
      d += penUp ? `M${x.toFixed(1)},${y.toFixed(1)}` : `L${x.toFixed(1)},${y.toFixed(1)}`;
      penUp = false;
    }
    return d;
  }

  function dotsFor(key, fill) {
    return pts
      .map((p, i) => {
        const v = p[key];
        if (v == null || !Number.isFinite(v)) return "";
        const x = xAt(i);
        const y = yAt(v);
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="${fill}" opacity="0.95"></circle>`;
      })
      .join("");
  }

  const d1 = pathFor("est1rm");
  const d2 = pathFor("avgWeight");
  const last = pts[pts.length - 1];
  const last1 = last.est1rm != null ? `${Math.round(last.est1rm)} lb 1RM` : "";
  const last2 = last.avgWeight != null ? `${formatWeight(last.avgWeight)} lb avg` : "";
  const summary = [last1, last2].filter(Boolean).join(" · ");

  return `
    <svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Estimated 1RM and average weight over time">
      <rect x="0" y="0" width="${w}" height="${h}" rx="12" fill="color-mix(in srgb, var(--surface) 86%, transparent)" stroke="var(--surface2)"></rect>
      <text x="${pad}" y="${pad + 12}" fill="var(--muted)" font-size="10">
        <tspan fill="var(--accent)" font-weight="650">1RM</tspan>
        <tspan fill="var(--muted)"> · </tspan>
        <tspan fill="${CHART_AVG_COLOR}" font-weight="650">Avg weight</tspan>
      </text>
      ${d1 ? `<path d="${d1}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
      ${d2 ? `<path d="${d2}" fill="none" stroke="${CHART_AVG_COLOR}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
      ${dotsFor("est1rm", "var(--accent)")}
      ${dotsFor("avgWeight", CHART_AVG_COLOR)}
      <text x="${pad}" y="${y0 - 4}" fill="var(--muted)" font-size="11">${escapeHtml(summary || "—")}</text>
      <text x="${pad}" y="${h - 8}" fill="var(--muted)" font-size="11">${escapeHtml(
        new Date(last.ts).toLocaleDateString()
      )}</text>
    </svg>
  `;
}

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

/**
 * Bottom nav: Lucide icons (ISC) — one family, 24×24, 2px strokes.
 * https://lucide.dev — renders consistently on iOS Safari when styled via CSS.
 */
function tabIcon(children) {
  return `<span class="tab-ico" aria-hidden="true"><svg class="tab-svg" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><g class="tab-svg-inner">${children}</g></svg></span>`;
}

/* activity — single stroke, reads clearly at tab-bar size (Lucide) */
const TAB_ICON_TRAIN = `
  <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />
`;
const TAB_ICON_PROGRESS = `
  <path d="M3 3v16a2 2 0 0 0 2 2h16" />
  <path d="M18 17V9" />
  <path d="M13 17V5" />
  <path d="M8 17v-3" />
`;
const TAB_ICON_HISTORY = `
  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
  <path d="M3 3v5h5" />
  <path d="M12 7v5l4 2" />
`;
const TAB_ICON_SETTINGS = `
  <line x1="21" x2="14" y1="4" y2="4" />
  <line x1="10" x2="3" y1="4" y2="4" />
  <line x1="21" x2="12" y1="12" y2="12" />
  <line x1="8" x2="3" y1="12" y2="12" />
  <line x1="21" x2="16" y1="20" y2="20" />
  <line x1="12" x2="3" y1="20" y2="20" />
  <line x1="14" x2="14" y1="2" y2="6" />
  <line x1="8" x2="8" y1="10" y2="14" />
  <line x1="16" x2="16" y1="18" y2="22" />
`;

let state = loadState();
let route = parseRoute();
let ui = {
  resetOpen: false,
  importConfirmOpen: false,
  importPayload: null,
  calcOpen: false,
  faceOpen: false,
  programConfirmOpen: false,
  programImportData: null,
};

/** Face proportion tool (Progress tab): image + landmark points in canvas pixels */
let faceUi = { img: null, points: [] };

function parseRoute() {
  const h = (location.hash || "#train").slice(1);
  const [name, ...rest] = h.split("/").map(decodeURIComponent);
  if (name === "day" && rest[0]) return { name: "day", dayKey: rest[0] };
  if (name === "exercise" && rest[0] && rest[1])
    return { name: "exercise", dayKey: rest[0], lineId: rest[1] };
  if (name === "progress") {
    if (rest[0]) return { name: "progress-ex", exerciseName: rest[0] };
    return { name: "progress" };
  }
  if (name === "session" && rest[0]) return { name: "session", sessionId: rest[0] };
  if (name === "history") return { name: "history" };
  if (name === "settings") return { name: "settings" };
  return { name: "train" };
}

function routeKey(r) {
  if (!r || typeof r !== "object") return "";
  if (r.name === "day") return `day:${r.dayKey}`;
  if (r.name === "exercise") return `exercise:${r.dayKey}:${r.lineId}`;
  if (r.name === "progress-ex") return `progress-ex:${r.exerciseName}`;
  if (r.name === "session") return `session:${r.sessionId}`;
  return r.name;
}

function normalizeProgramFile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const days = raw.days ?? raw.program?.days;
  if (!Array.isArray(days) || days.length === 0) return null;
  const out = [];
  for (const d of days) {
    if (!d || typeof d !== "object") return null;
    const dayKey = String(d.dayKey || "").trim();
    if (!dayKey) return null;
    const dayTitle = String(d.dayTitle != null ? d.dayTitle : dayKey);
    const linesIn = Array.isArray(d.lines) ? d.lines : [];
    const lines = linesIn
      .map((l) => {
        if (!l || typeof l !== "object") return null;
        const exerciseName = String(l.exerciseName || "").trim();
        if (!exerciseName) return null;
        return {
          category: String(l.category != null ? l.category : "Main"),
          exerciseName,
          prescribedSets: String(l.prescribedSets != null ? l.prescribedSets : "3"),
          prescribedRepRange: String(l.prescribedRepRange != null ? l.prescribedRepRange : "8–12"),
        };
      })
      .filter(Boolean);
    if (!lines.length) return null;
    out.push({ dayKey, dayTitle, lines });
  }
  return { days: out };
}

function normalizeImportedState(raw) {
  let o = raw;
  if (o && typeof o === "object" && o.data && typeof o.data === "object") o = o.data;
  if (!o || typeof o !== "object") return null;
  if (!Array.isArray(o.sessions)) return null;
  const programDays = Array.isArray(o.programDays) ? o.programDays : [];
  const sessions = o.sessions
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      id: typeof s.id === "string" ? s.id : uid(),
      startedAt: Number(s.startedAt) || Date.now(),
      dayKey: String(s.dayKey ?? ""),
      dayTitleSnapshot: String(s.dayTitleSnapshot ?? s.dayKey ?? ""),
      completed: Boolean(s.completed),
      finishedAt: s.finishedAt != null ? Number(s.finishedAt) : undefined,
      sets: Array.isArray(s.sets)
        ? s.sets
            .filter((r) => r && typeof r === "object")
            .map((r) => ({
              id: typeof r.id === "string" ? r.id : uid(),
              programLineId: String(r.programLineId ?? ""),
              exerciseNameSnapshot: String(r.exerciseNameSnapshot ?? ""),
              setIndex: Number(r.setIndex) || 1,
              reps: Number(r.reps) || 0,
              weightLb: Number(r.weightLb) || 0,
            }))
        : [],
    }));
  return { programDays, sessions };
}

function exportLiftingData() {
  const payload = {
    app: "hypertrophy-pwa",
    version: 1,
    exportedAt: new Date().toISOString(),
    programDays: state.programDays,
    sessions: state.sessions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hypertrophy-lifting-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function resetAllData() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}

  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}

  state = defaultState();
  saveState(state);
}

let restTimer = { until: 0, durationSec: 0, label: "" };
let restTicker = 0;

let workoutTicker = 0;

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  const hh = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${m}:${ss}`;
}

function ensureWorkoutTimer(startedAt) {
  if (workoutTicker) clearInterval(workoutTicker);
  workoutTicker = setInterval(() => {
    const el = document.getElementById("workout-elapsed");
    if (!el) return;
    el.textContent = formatElapsed(Date.now() - startedAt);
  }, 250);
}

function stopWorkoutTimer() {
  if (workoutTicker) clearInterval(workoutTicker);
  workoutTicker = 0;
}

function restSecondsLeft() {
  if (!restTimer.until) return 0;
  return Math.max(0, Math.ceil((restTimer.until - Date.now()) / 1000));
}

function inferRestSeconds(line) {
  const name = `${line?.exerciseName || ""}`.toLowerCase();
  const cat = `${line?.category || ""}`.toLowerCase();
  if (/(squat|deadlift|rdl|hip thrust|bench|press|row)/.test(name)) return 150;
  if (/(main)/.test(cat)) return 150;
  if (/(secondary)/.test(cat)) return 120;
  if (/(isolation|superset|arms|delts|calves|core)/.test(cat)) return 75;
  return 90;
}

function startRestTimer(line, seconds) {
  const s = clamp(Number(seconds) || inferRestSeconds(line), 60, 180);
  restTimer = { until: Date.now() + s * 1000, durationSec: s, label: line?.exerciseName || "Rest" };
  if (restTicker) clearInterval(restTicker);
  restTicker = setInterval(() => {
    if (restSecondsLeft() <= 0) {
      clearInterval(restTicker);
      restTicker = 0;
      render();
      return;
    }
    const el = document.getElementById("rest-left");
    if (el) el.textContent = `${restSecondsLeft()}s`;
  }, 250);
}

function stopRestTimer() {
  restTimer = { until: 0, durationSec: 0, label: "" };
  if (restTicker) clearInterval(restTicker);
  restTicker = 0;
}

function suggestProgression(line, points) {
  const rr = parseRepRange(line?.prescribedRepRange);
  if (!rr) return null;
  if (!points?.length) return null;

  const name = line.exerciseName;
  const recentSession = [...state.sessions]
    .sort((a, b) => b.startedAt - a.startedAt)
    .find(
      (s) =>
        sessionIncludedForWeightMetrics(s) && (s.sets || []).some((r) => r.exerciseNameSnapshot === name)
    );
  const rows = (recentSession?.sets || []).filter((r) => r.exerciseNameSnapshot === name && r.weightLb > 0);
  if (!rows.length) return null;

  const nm = `${name}`.toLowerCase();
  const step = /(squat|deadlift|rdl|hip thrust|leg press)/.test(nm) ? 10 : 5;

  const atOrAboveLo = rows.filter((r) => r.reps >= rr.lo);
  const basePool = atOrAboveLo.length ? atOrAboveLo : rows;
  const baseMax = Math.max(...basePool.map((r) => r.weightLb));
  const baseAvg = basePool.reduce((a, r) => a + r.weightLb, 0) / basePool.length;

  const hitTop = rows.some((r) => r.reps >= rr.hi);
  const topTier = rows.filter((r) => r.reps >= rr.hi && r.weightLb > 0);
  const weightAtTop = topTier.length ? Math.max(...topTier.map((r) => r.weightLb)) : null;

  const roundSuggest = (lb) => Math.round(lb * 2) / 2;

  if (hitTop && weightAtTop != null) {
    const suggested = roundSuggest(weightAtTop + step);
    return `Suggested working weight: ${formatWeight(suggested)} lb (last session you hit ${rr.hi}+ reps at ${formatWeight(
      weightAtTop
    )} lb).`;
  }

  const suggestedHold = roundSuggest(baseMax);
  const allBelowLo = rows.every((r) => r.reps < rr.lo);
  if (allBelowLo) {
    return `Suggested working weight: ${formatWeight(suggestedHold)} lb — reps were under ${rr.lo}; same load and push for ${rr.lo}–${rr.hi}, or reduce slightly if form breaks down.`;
  }

  return `Suggested working weight: ${formatWeight(suggestedHold)} lb — hold here until you reach ${rr.hi}+ reps on at least one set, then the target will move up.`;
}

function render() {
  const prevRouteKey = routeKey(route);
  route = parseRoute();
  const sameRoute = prevRouteKey === routeKey(route);
  const scrollY = sameRoute ? window.scrollY : 0;
  const app = document.getElementById("app");
  const trainTab = route.name === "train" || route.name === "day" || route.name === "exercise";
  const histTab = route.name === "history" || route.name === "session";
  const progTab = route.name === "progress" || route.name === "progress-ex";
  const settingsTab = route.name === "settings";

  if (route.name !== "progress") {
    ui.calcOpen = false;
    ui.faceOpen = false;
    faceUi = { img: null, points: [] };
  }

  if (route.name !== "day") stopWorkoutTimer();

  let header = "";
  let main = "";

  if (route.name === "train") {
    header = "<h1>Train</h1>";
    if (!state.programDays.length) {
      main = `
        <div class="toolbar" style="justify-content:flex-start">
          <button type="button" class="btn btn-danger" data-action="reset">Reset data</button>
        </div>
        <div class="empty"><strong>No program loaded</strong>Open over HTTP(S) so bundled_program.json can load, or refresh.</div>
      `;
    } else {
      const activeAny = activeSessionAny(state);
      const banner = activeAny
        ? `<div class="card stack" style="margin-bottom:10px">
            <div class="kv">
              <div>
                <div class="k">Workout in progress</div>
                <div class="v">${escapeHtml(activeAny.dayKey)}</div>
              </div>
              <div style="text-align:right">
                <a class="btn btn-ghost" href="#day/${encodeURIComponent(activeAny.dayKey)}">Resume</a>
              </div>
            </div>
          </div>`
        : "";
      main = `
        <div class="toolbar" style="justify-content:space-between">
          <div></div>
          <button type="button" class="btn btn-danger" data-action="reset">Reset data</button>
        </div>
        ${banner}
        <div class="card-list">${state.programDays
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map(
            (d) => `
          <a class="card" href="#day/${encodeURIComponent(d.dayKey)}">
            <h2>${escapeHtml(d.dayKey)}</h2>
            <p>${escapeHtml(d.dayTitle)}</p>
          </a>`
          )
          .join("")}</div>
      `;
    }
  } else if (route.name === "day") {
    const day = getDay(state, route.dayKey);
    if (!day) {
      header = "<h1>Train</h1>";
      main = `<div class="empty">Day not found.</div><a class="back-link" href="#train">← Back</a>`;
    } else {
      header = `<h1>${escapeHtml(day.dayKey)}</h1>`;
      const active = activeSessionToday(state, day.dayKey);
      const activeAny = activeSessionAny(state);
      const locked = activeAny && activeAny.dayKey !== day.dayKey;
      if (active?.startedAt) ensureWorkoutTimer(active.startedAt);
      else stopWorkoutTimer();
      let body = "";
      if (!active) {
        body = locked
          ? `
          <div class="card stack" style="margin-top:10px">
            <div class="kv">
              <div>
                <div class="k">Workout already running</div>
                <div class="v">${escapeHtml(activeAny.dayKey)}</div>
              </div>
              <div style="text-align:right">
                <a class="btn btn-primary" href="#day/${encodeURIComponent(activeAny.dayKey)}">Go to active</a>
              </div>
            </div>
            <p class="muted" style="margin:0">Finish the active workout before starting another day.</p>
          </div>
          <p class="muted">Begins today’s session for this day. Older unfinished sessions are closed automatically.</p>`
          : `
          <div class="toolbar" style="justify-content:flex-start">
            <button type="button" class="btn btn-primary" data-action="start">Start workout</button>
          </div>
          <p class="muted">Begins today’s session for this day. Older unfinished sessions are closed automatically.</p>`;
      } else {
        body = `
          <div class="toolbar">
            <button type="button" class="btn btn-ghost" data-action="finish">Finish workout</button>
          </div>
          <div class="card stack" style="margin-bottom:10px">
            <div class="kv">
              <div>
                <div class="k">Workout timer</div>
                <div class="v"><span id="workout-elapsed">${escapeHtml(
                  formatElapsed(Date.now() - active.startedAt)
                )}</span></div>
              </div>
              <div style="text-align:right" class="muted">${escapeHtml(new Date(active.startedAt).toLocaleTimeString())}</div>
            </div>
          </div>
          <div class="section-title">Exercises</div>
          <div class="card-list">
            ${day.lines
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((line) => {
                const n = setsForLine(active, line.id).length;
                return `
              <a class="card" href="#exercise/${encodeURIComponent(day.dayKey)}/${encodeURIComponent(line.id)}">
                <h2>${escapeHtml(line.exerciseName)}</h2>
                <p>${escapeHtml(line.category)} · Target ${escapeHtml(line.prescribedSets)} × ${escapeHtml(
                  line.prescribedRepRange
                )} reps</p>
                <p class="meta" style="margin-top:6px;color:var(--accent)">${n} set(s) logged</p>
              </a>`;
              })
              .join("")}
          </div>`;
      }
      main = `<a class="back-link" href="#train">← Days</a>${body}`;
    }
  } else if (route.name === "exercise") {
    const day = getDay(state, route.dayKey);
    const line = day?.lines.find((l) => l.id === route.lineId);
    const session = day ? activeSessionToday(state, day.dayKey) : null;
    if (!day || !line || !session) {
      header = "<h1>Log</h1>";
      main = `<div class="empty">Start a workout from the day screen first.</div><a class="back-link" href="#day/${encodeURIComponent(
        route.dayKey
      )}">← Back</a>`;
    } else {
      header = `<h1>${escapeHtml(line.exerciseName)}</h1>`;
      const points = exerciseHistoryPoints(state, line.exerciseName);
      const best1rm = points.length ? Math.max(...points.map((p) => p.est1rm)) : null;
      const t = trendPct(points);
      const avgW = avgWeightExercise(state, line.exerciseName);
      const lastW = lastFinishedWorkoutWeightAvg(state, line.exerciseName);
      const sugg = suggestProgression(line, points);
      const restLeft = restSecondsLeft();
      const rows = setsForLine(session, line.id)
        .map(
          (x) => `
        <div class="set-row" data-set-id="${escapeHtml(x.id)}">
          <span class="set-num">Set ${x.setIndex}</span>
          <span style="flex:1">${x.reps} reps @ ${formatWeight(x.weightLb)} lb</span>
          <button type="button" class="btn btn-ghost" style="min-height:40px;padding:0 12px;font-size:0.8rem" data-del-set="${escapeHtml(
            x.id
          )}">Remove</button>
        </div>`
        )
        .join("");
      main = `
        <a class="back-link" href="#day/${encodeURIComponent(day.dayKey)}">← ${escapeHtml(day.dayKey)}</a>
        <div class="section-title">Program</div>
        <div class="card" style="margin-bottom:8px">
          <p class="muted" style="margin:0">Target sets: <strong style="color:var(--text)">${escapeHtml(
            line.prescribedSets
          )}</strong></p>
          <p class="muted" style="margin:8px 0 0">Target reps: <strong style="color:var(--text)">${escapeHtml(
            line.prescribedRepRange
          )}</strong></p>
        </div>
        <div class="section-title">Performance</div>
        <div class="card stack">
          <div class="kv">
            <div>
              <div class="k">Estimated 1RM</div>
              <div class="v">${best1rm ? `${Math.round(best1rm)} lb` : "—"}</div>
            </div>
            <div style="text-align:right">
              <div class="k">Trend</div>
              <div class="v">${t == null ? "—" : `${t >= 0 ? "+" : ""}${t.toFixed(1)}%`}</div>
            </div>
          </div>
          <div class="kv">
            <div>
              <div class="k">Avg weight</div>
              <div class="v">${escapeHtml(formatAvgLb(avgW))}</div>
            </div>
            <div style="text-align:right">
              <div class="k">Last workout</div>
              <div class="v">${
                lastW
                  ? `${escapeHtml(formatAvgLb(lastW.avg))}`
                  : "—"
              }</div>
              ${
                lastW
                  ? `<div class="muted" style="font-size:0.72rem;margin-top:4px">${escapeHtml(
                      new Date(lastW.startedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    )}</div>`
                  : ""
              }
            </div>
          </div>
          ${points.length ? `<a class="btn btn-ghost" style="width:100%" href="#progress/${encodeURIComponent(
            line.exerciseName
          )}">View chart</a>` : `<div class="muted" style="font-size:0.85rem">Log a few sets to see progression.</div>`}
        </div>
        ${sugg ? `<div class="section-title">Suggested weight</div><div class="card"><p class="muted" style="margin:0">${escapeHtml(
          sugg
        )}</p></div>` : ""}
        <div class="section-title">Logged sets</div>
        <div class="card">${rows || `<p class="muted" style="margin:8px 0">No sets yet.</p>`}</div>
        <div class="form-row">
          <input type="number" inputmode="numeric" id="inp-reps" placeholder="Reps" min="1" step="1" />
          <input type="number" inputmode="decimal" id="inp-weight" placeholder="Weight (lb)" min="0" step="0.5" title="Enter 0 for bodyweight" />
        </div>
        <div class="toolbar" style="justify-content:space-between;margin-top:12px">
          <button type="button" class="btn btn-primary" style="flex:1" data-action="add-set">Add set</button>
          <button type="button" class="btn btn-ghost" style="flex:1" data-action="repeat-set" ${
            setsForLine(session, line.id).length ? "" : "disabled"
          }>Repeat last</button>
        </div>
        <div class="card stack" style="margin-top:10px">
          <div class="kv">
            <div>
              <div class="k">Rest timer</div>
              <div class="v"><span id="rest-left">${restLeft ? `${restLeft}s` : "—"}</span></div>
            </div>
            <div style="text-align:right" class="muted" id="rest-hint">${
              restLeft ? "Running" : `${inferRestSeconds(line)}s default`
            }</div>
          </div>
          <div class="toolbar" style="justify-content:space-between;margin:0">
            <button type="button" class="btn btn-ghost" data-action="rest-start">Start</button>
            <button type="button" class="btn btn-ghost" data-action="rest-stop">Stop</button>
          </div>
        </div>
      `;
    }
  } else if (route.name === "progress") {
    header = `
      <div class="header-row">
        <h1>Progress</h1>
        <div class="header-actions">
          <button type="button" class="btn btn-ghost header-tool-btn" data-action="face-menu" aria-haspopup="dialog" title="Face proportions">Face</button>
          <button type="button" class="btn btn-ghost header-tool-btn" data-action="calc-menu" aria-haspopup="dialog">Calc</button>
        </div>
      </div>`;
    const names = allExerciseNames(state);
    if (!names.length) {
      main = `<div class="empty"><strong>No data yet</strong>Log sets to see progression charts.</div>`;
    } else {
      const items = names
        .map((n) => {
          const pts = exerciseHistoryPoints(state, n);
          const last = pts[pts.length - 1]?.est1rm;
          const t = trendPct(pts);
          const avgW = avgWeightExercise(state, n);
          const lastW = lastFinishedWorkoutWeightAvg(state, n);
          return `
            <a class="card" href="#progress/${encodeURIComponent(n)}">
              <h2>${escapeHtml(n)}</h2>
              <p>${last ? `Est. 1RM ${Math.round(last)} lb` : "—"}${
                t == null ? "" : ` · ${t >= 0 ? "+" : ""}${t.toFixed(1)}%`
              }</p>
              <p class="meta" style="margin-top:8px;line-height:1.45">Avg weight (logged sets): <strong style="color:var(--text)">${escapeHtml(
                formatAvgLb(avgW)
              )}</strong>${
                lastW
                  ? ` · Last workout: <strong style="color:var(--text)">${escapeHtml(
                      formatAvgLb(lastW.avg)
                    )}</strong> <span class="muted">(${escapeHtml(
                      new Date(lastW.startedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })
                    )})</span>`
                  : ""
              }</p>
            </a>
          `;
        })
        .join("");
      main = `<div class="card-list">${items}</div>`;
    }
  } else if (route.name === "progress-ex") {
    header = "<h1>Progress</h1>";
    const name = route.exerciseName;
    const chartPts = exerciseChartPoints(state, name);
    const pts = exerciseHistoryPoints(state, name);
    if (!chartPts.length) {
      main = `<div class="empty">No data for this exercise yet.</div><a class="back-link" href="#progress">← Progress</a>`;
    } else {
      const best = pts.length ? Math.max(...pts.map((p) => p.est1rm)) : null;
      const t = trendPct(pts);
      const avgW = avgWeightExercise(state, name);
      const lastW = lastFinishedWorkoutWeightAvg(state, name);
      main = `
        <a class="back-link" href="#progress">← Progress</a>
        <div class="section-title">${escapeHtml(name)}</div>
        <div class="card stack">
          <div class="kv">
            <div>
              <div class="k">Best est. 1RM</div>
              <div class="v">${best != null ? `${Math.round(best)} lb` : "—"}</div>
            </div>
            <div style="text-align:right">
              <div class="k">Trend</div>
              <div class="v">${t == null ? "—" : `${t >= 0 ? "+" : ""}${t.toFixed(1)}%`}</div>
            </div>
          </div>
          <div class="kv">
            <div>
              <div class="k">Avg weight</div>
              <div class="v">${escapeHtml(formatAvgLb(avgW))}</div>
            </div>
            <div style="text-align:right">
              <div class="k">Last workout</div>
              <div class="v">${lastW ? escapeHtml(formatAvgLb(lastW.avg)) : "—"}</div>
              ${
                lastW
                  ? `<div class="muted" style="font-size:0.72rem;margin-top:4px">${escapeHtml(
                      new Date(lastW.startedAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    )}</div>`
                  : ""
              }
            </div>
          </div>
          ${svgLineChart(chartPts)}
          <p class="muted" style="margin:0;font-size:0.85rem">Orange: estimated 1RM (Epley). Cyan: average weight logged that day.</p>
        </div>
      `;
    }
  } else if (route.name === "history") {
    header = "<h1>History</h1>";
    const done = state.sessions.filter((s) => s.completed).sort((a, b) => b.startedAt - a.startedAt);
    if (!done.length)
      main = `<div class="empty"><strong>No completed workouts</strong>Finish a workout from Train to see it here.</div>`;
    else {
      main = `<div class="card-list">${done
        .map(
          (s) => `
        <a class="card" href="#session/${encodeURIComponent(s.id)}">
          <h2>${escapeHtml(s.dayKey)}</h2>
          <p>${escapeHtml(s.dayTitleSnapshot)}</p>
          <p class="meta" style="margin-top:8px">${new Date(s.startedAt).toLocaleString()}${
            s.finishedAt ? ` · ${escapeHtml(formatElapsed(s.finishedAt - s.startedAt))}` : ""
          }</p>
        </a>`
        )
        .join("")}</div>`;
    }
  } else if (route.name === "session") {
    const s = state.sessions.find((x) => x.id === route.sessionId);
    header = "<h1>Workout</h1>";
    if (!s) main = `<div class="empty">Not found.</div><a class="back-link" href="#history">← History</a>`;
    else {
      const groups = {};
      const order = [];
      for (const row of [...s.sets].sort((a, b) => {
        if (a.exerciseNameSnapshot !== b.exerciseNameSnapshot)
          return a.exerciseNameSnapshot.localeCompare(b.exerciseNameSnapshot);
        return a.setIndex - b.setIndex;
      })) {
        const k = row.exerciseNameSnapshot;
        if (!groups[k]) {
          groups[k] = [];
          order.push(k);
        }
        groups[k].push(row);
      }
      main = `
        <a class="back-link" href="#history">← History</a>
        <div class="card stack">
          <p class="muted" style="margin:0">Day: <strong style="color:var(--text)">${escapeHtml(s.dayKey)}</strong></p>
          <p class="muted" style="margin:0">Started: ${new Date(s.startedAt).toLocaleString()}</p>
          ${
            s.finishedAt
              ? `<p class="muted" style="margin:0">Duration: <strong style="color:var(--text)">${escapeHtml(
                  formatElapsed(s.finishedAt - s.startedAt)
                )}</strong></p>`
              : ""
          }
        </div>
        ${order
          .map(
            (name) => `
          <div class="section-title">${escapeHtml(name)}</div>
          <div class="card">
            ${groups[name]
              .sort((a, b) => a.setIndex - b.setIndex)
              .map(
                (x) => `
              <div class="set-row">
                <span class="set-num">Set ${x.setIndex}</span>
                <span>${x.reps} reps @ ${formatWeight(x.weightLb)} lb</span>
              </div>`
              )
              .join("")}
          </div>`
          )
          .join("")}
      `;
    }
  } else if (route.name === "settings") {
    header = "<h1>Settings</h1>";
    main = `
      <p class="muted" style="margin:0 0 16px">Export or import your program and logged workouts — the same data used for <strong style="color:var(--text)">Progress</strong> and <strong style="color:var(--text)">History</strong>.</p>
      <div class="card stack">
        <div>
          <div class="section-title" style="margin-top:0">Program</div>
          <p class="muted" style="margin:0 0 10px">Edit <code class="code-tag">program_template.json</code> (or start from the bundled program), then import. Workout history is kept; exercise line IDs are regenerated.</p>
          <a class="btn btn-ghost stack" style="width:100%;text-align:center;margin-bottom:10px" href="./program_template.json" download="program_template.json">Download program template</a>
          <input type="file" id="import-program-file" accept="application/json,.json" style="display:none" />
          <button type="button" class="btn btn-primary" style="width:100%" data-action="import-program-pick">Import program</button>
        </div>
        <div>
          <div class="section-title">Export</div>
          <p class="muted" style="margin:0 0 10px">Save a JSON backup to your device or cloud.</p>
          <button type="button" class="btn btn-primary" style="width:100%" data-action="export-data">Export lifting data</button>
        </div>
        <div>
          <div class="section-title">Import</div>
          <p class="muted" style="margin:0 0 10px">Choose a file from Export. This replaces data on this device.</p>
          <input type="file" id="import-file" accept="application/json,.json" style="display:none" />
          <button type="button" class="btn btn-ghost" style="width:100%" data-action="import-pick">Import lifting data</button>
        </div>
      </div>
    `;
  }

  const modal = ui.resetOpen
    ? `
      <div class="modal-backdrop" data-action="reset-close" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm reset">
          <div class="section-title" style="margin:0 0 10px">Are you sure?</div>
          <p class="muted" style="margin:0 0 14px">This clears your program + history on this device.</p>
          <div class="toolbar" style="justify-content:flex-end;margin:0">
            <button type="button" class="btn btn-ghost" data-action="reset-no">No</button>
            <button type="button" class="btn btn-danger" data-action="reset-yes">Yes, reset</button>
          </div>
        </div>
      </div>
    `
    : "";

  const importModal =
    ui.importConfirmOpen && ui.importPayload
      ? `
      <div class="modal-backdrop" data-action="import-close" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm import">
          <div class="section-title" style="margin:0 0 10px">Replace all data?</div>
          <p class="muted" style="margin:0 0 14px">Import will overwrite your program and workout history on this device. This cannot be undone.</p>
          <div class="toolbar" style="justify-content:flex-end;margin:0">
            <button type="button" class="btn btn-ghost" data-action="import-no">No</button>
            <button type="button" class="btn btn-primary" data-action="import-yes">Yes, import</button>
          </div>
        </div>
      </div>
    `
      : "";

  const programModal =
    ui.programConfirmOpen && ui.programImportData
      ? `
      <div class="modal-backdrop" data-action="program-close" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm program import">
          <div class="section-title" style="margin:0 0 10px">Replace program?</div>
          <p class="muted" style="margin:0 0 14px">Your workout history stays. Today’s in-progress workout may not match the new exercises until you finish or start fresh.</p>
          <div class="toolbar" style="justify-content:flex-end;margin:0">
            <button type="button" class="btn btn-ghost" data-action="program-no">No</button>
            <button type="button" class="btn btn-primary" data-action="program-yes">Yes, import program</button>
          </div>
        </div>
      </div>
    `
      : "";

  const faceModal = ui.faceOpen
    ? `
      <div class="modal-backdrop" data-action="face-close" role="presentation">
        <div class="modal face-modal" role="dialog" aria-modal="true" aria-label="Face proportions">
          <div class="section-title" style="margin:0 0 8px">Face proportions</div>
          <p class="muted" style="margin:0 0 12px">Load a selfie, then tap the image to place numbered points. Segment lengths are in <strong style="color:var(--text)">pixels</strong> — compare photos taken at similar distance. Ratios are compared to φ ≈ 1.618.</p>
          <div class="toolbar" style="justify-content:flex-start;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <input type="file" id="face-file-cam" accept="image/*" capture="user" style="display:none" />
            <input type="file" id="face-file" accept="image/*" style="display:none" />
            <button type="button" class="btn btn-primary header-tool-btn" data-action="face-camera">Camera</button>
            <button type="button" class="btn btn-ghost header-tool-btn" data-action="face-library">Library</button>
            <button type="button" class="btn btn-ghost header-tool-btn" data-action="face-clear">Clear points</button>
            <button type="button" class="btn btn-ghost header-tool-btn" data-action="face-undo">Undo</button>
          </div>
          <div class="face-canvas-wrap">
            <canvas id="face-canvas" width="400" height="300"></canvas>
          </div>
          <div id="face-measures" class="muted" style="margin-top:12px;font-size:0.85rem;line-height:1.5"></div>
          <button type="button" class="btn btn-ghost" style="width:100%;margin-top:14px" data-action="face-dismiss">Close</button>
        </div>
      </div>
    `
    : "";

  const calcModal = ui.calcOpen
    ? `
      <div class="modal-backdrop" data-action="calc-close" role="presentation">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Working weight from 1RM">
          <div class="section-title" style="margin:0 0 10px">Working weight</div>
          <p class="muted" style="margin:0 0 14px">Uses the same Epley-based model as your estimated 1RM. Reps are capped at 1–12 for the formula.</p>
          <label class="muted" style="display:block;margin-bottom:6px;font-size:0.8rem">Estimated 1RM (lb)</label>
          <input type="number" inputmode="decimal" id="calc-1rm" class="calc-input" placeholder="e.g. 225" min="0" step="0.5" />
          <label class="muted" style="display:block;margin:12px 0 6px;font-size:0.8rem">Rep range</label>
          <div class="form-row" style="margin-top:0">
            <input type="number" inputmode="numeric" id="calc-rep-lo" class="calc-input" placeholder="Low" min="1" max="30" step="1" />
            <input type="number" inputmode="numeric" id="calc-rep-hi" class="calc-input" placeholder="High" min="1" max="30" step="1" />
          </div>
          <button type="button" class="btn btn-primary stack" style="width:100%;margin-top:14px" data-action="calc-run">Calculate</button>
          <div id="calc-out" class="calc-out muted" style="margin-top:14px"></div>
          <div class="toolbar" style="justify-content:flex-end;margin:16px 0 0">
            <button type="button" class="btn btn-ghost" data-action="calc-dismiss">Close</button>
          </div>
        </div>
      </div>
    `
    : "";

  app.innerHTML = `
    <header class="top">${header}</header>
    <main>${main}</main>
    <nav class="tabs">
      <a href="#train" class="${trainTab ? "active" : ""}">${tabIcon(TAB_ICON_TRAIN)}<span class="tab-label">Train</span></a>
      <a href="#progress" class="${progTab ? "active" : ""}">${tabIcon(TAB_ICON_PROGRESS)}<span class="tab-label">Progress</span></a>
      <a href="#history" class="${histTab ? "active" : ""}">${tabIcon(TAB_ICON_HISTORY)}<span class="tab-label">History</span></a>
      <a href="#settings" class="${settingsTab ? "active" : ""}">${tabIcon(TAB_ICON_SETTINGS)}<span class="tab-label">Settings</span></a>
    </nav>
    ${modal}
    ${importModal}
    ${programModal}
    ${faceModal}
    ${calcModal}
  `;

  wireHandlers();
  if (sameRoute) {
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollY);
    });
  } else {
    window.scrollTo(0, 0);
  }
  if (ui.faceOpen) {
    requestAnimationFrame(() => initFaceTool());
  }
}

const PHI = 1.6180339887;

function distPx(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function updateFaceMeasures() {
  const el = document.getElementById("face-measures");
  if (!el) return;
  const pts = faceUi.points;
  if (!faceUi.img) {
    el.innerHTML = "";
    return;
  }
  if (pts.length < 2) {
    el.innerHTML =
      pts.length === 0
        ? "<p style=\"margin:0\">Tap the image to place numbered points.</p>"
        : "<p style=\"margin:0\">Add another point to measure a segment.</p>";
    return;
  }
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    segs.push({ a: i + 1, b: i + 2, d: distPx(pts[i], pts[i + 1]) });
  }
  let html = `<div class="section-title" style="margin:0 0 6px">Segments (px)</div>`;
  segs.forEach((s) => {
    html += `<div>Points ${s.a} → ${s.b}: <strong style="color:var(--text)">${s.d.toFixed(1)} px</strong></div>`;
  });
  if (segs.length >= 2) {
    const r = segs[0].d / segs[1].d;
    html += `<div style="margin-top:10px">Ratio (seg 1 ÷ seg 2): <strong style="color:var(--text)">${r.toFixed(
      3
    )}</strong> · φ ≈ ${PHI.toFixed(3)} · |Δφ| ${Math.abs(r - PHI).toFixed(3)}</div>`;
  }
  if (segs.length >= 3) {
    const r2 = segs[0].d / segs[2].d;
    html += `<div style="margin-top:6px">Seg 1 ÷ seg 3: <strong style="color:var(--text)">${r2.toFixed(3)}</strong></div>`;
  }
  if (segs.length >= 4) {
    const r3 = segs[0].d / segs[3].d;
    html += `<div style="margin-top:6px">Seg 1 ÷ seg 4: <strong style="color:var(--text)">${r3.toFixed(3)}</strong></div>`;
  }
  el.innerHTML = html;
}

function drawFaceCanvas() {
  const canvas = document.getElementById("face-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!faceUi.img) {
    canvas.width = 400;
    canvas.height = 220;
    ctx.fillStyle = "#1f1f24";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#a1a1aa";
    ctx.font = "14px system-ui,sans-serif";
    ctx.fillText("Choose Camera or Library", 16, 110);
    const hel = document.getElementById("face-measures");
    if (hel)
      hel.innerHTML =
        "<p style=\"margin:0\" class=\"muted\">Load a photo, then tap the image to place points.</p>";
    return;
  }
  const img = faceUi.img;
  const MAX_W = 560;
  const scale = Math.min(1, MAX_W / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(img, 0, 0, w, h);
  for (let i = 1; i < faceUi.points.length; i++) {
    const a = faceUi.points[i - 1];
    const b = faceUi.points[i];
    ctx.beginPath();
    ctx.strokeStyle = "rgba(234,88,12,0.55)";
    ctx.lineWidth = 2;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  faceUi.points.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ea580c";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px system-ui,sans-serif";
    ctx.fillText(String(i + 1), p.x + 8, p.y - 8);
  });
  updateFaceMeasures();
}

function faceCanvasPointer(ev) {
  if (!faceUi.img || !ui.faceOpen) return;
  const canvas = document.getElementById("face-canvas");
  if (!canvas || ev.target !== canvas) return;
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  const x = (ev.clientX - rect.left) * sx;
  const y = (ev.clientY - rect.top) * sy;
  faceUi.points.push({ x, y });
  drawFaceCanvas();
}

function loadFaceFromFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      faceUi.img = img;
      faceUi.points = [];
      drawFaceCanvas();
    };
    img.src = String(reader.result || "");
  };
  reader.readAsDataURL(file);
}

function initFaceTool() {
  drawFaceCanvas();
}

function runRmCalc() {
  const out = document.getElementById("calc-out");
  if (!out) return;
  const oneRm = parseFloat(document.getElementById("calc-1rm")?.value || "");
  let lo = parseInt(document.getElementById("calc-rep-lo")?.value || "", 10);
  let hi = parseInt(document.getElementById("calc-rep-hi")?.value || "", 10);
  if (!oneRm || oneRm <= 0) {
    out.innerHTML = "<strong style=\"color:var(--text)\">Enter a 1RM.</strong>";
    return;
  }
  if (!lo || lo < 1) {
    out.innerHTML = "<strong style=\"color:var(--text)\">Enter at least the low rep count.</strong>";
    return;
  }
  if (!hi || hi < 1) hi = lo;
  if (lo > hi) [lo, hi] = [hi, lo];
  const wLo = workingWeightFrom1RM(oneRm, lo);
  const wHi = workingWeightFrom1RM(oneRm, hi);
  const mid = Math.round((lo + hi) / 2);
  const wMid = workingWeightFrom1RM(oneRm, mid);
  if (wLo == null || wHi == null) {
    out.textContent = "Could not compute.";
    return;
  }
  const fmt = (w) => `${formatWeight(w)} lb`;
  if (lo === hi) {
    out.innerHTML = `At <strong style="color:var(--text)">${lo}</strong> reps: <strong style="color:var(--text)">${fmt(
      wLo
    )}</strong>`;
  } else {
    out.innerHTML = `
      <div style="line-height:1.5">
        <div><strong style="color:var(--text)">${lo}</strong> reps → <strong style="color:var(--text)">${fmt(wLo)}</strong></div>
        <div><strong style="color:var(--text)">${mid}</strong> reps → <strong style="color:var(--text)">${fmt(wMid)}</strong></div>
        <div><strong style="color:var(--text)">${hi}</strong> reps → <strong style="color:var(--text)">${fmt(wHi)}</strong></div>
      </div>`;
  }
}

function wireHandlers() {
  document.querySelector("[data-action='face-menu']")?.addEventListener("click", () => {
    ui.calcOpen = false;
    ui.faceOpen = true;
    render();
  });
  document.querySelector("[data-action='face-close']")?.addEventListener("click", (e) => {
    if (e.target !== e.currentTarget) return;
    ui.faceOpen = false;
    render();
  });
  document.querySelector("[data-action='face-dismiss']")?.addEventListener("click", () => {
    ui.faceOpen = false;
    render();
  });
  document.querySelector("[data-action='face-camera']")?.addEventListener("click", () => {
    document.getElementById("face-file-cam")?.click();
  });
  document.querySelector("[data-action='face-library']")?.addEventListener("click", () => {
    document.getElementById("face-file")?.click();
  });
  document.querySelector("[data-action='face-clear']")?.addEventListener("click", () => {
    faceUi.points = [];
    drawFaceCanvas();
  });
  document.querySelector("[data-action='face-undo']")?.addEventListener("click", () => {
    faceUi.points.pop();
    drawFaceCanvas();
  });

  document.querySelector("[data-action='calc-menu']")?.addEventListener("click", () => {
    ui.faceOpen = false;
    ui.calcOpen = true;
    render();
    requestAnimationFrame(() => document.getElementById("calc-1rm")?.focus());
  });
  document.querySelector("[data-action='calc-close']")?.addEventListener("click", (e) => {
    if (e.target !== e.currentTarget) return;
    ui.calcOpen = false;
    render();
  });
  document.querySelector("[data-action='calc-dismiss']")?.addEventListener("click", () => {
    ui.calcOpen = false;
    render();
  });
  document.querySelector("[data-action='calc-run']")?.addEventListener("click", () => {
    runRmCalc();
  });

  document.querySelector("[data-action='reset']")?.addEventListener("click", () => {
    ui.resetOpen = true;
    render();
  });
  document.querySelector("[data-action='reset-close']")?.addEventListener("click", (e) => {
    // Only close when tapping outside the dialog.
    if (e.target !== e.currentTarget) return;
    ui.resetOpen = false;
    render();
  });
  document.querySelector("[data-action='reset-no']")?.addEventListener("click", () => {
    ui.resetOpen = false;
    render();
  });
  document.querySelector("[data-action='reset-yes']")?.addEventListener("click", async () => {
    ui.resetOpen = false;
    render();
    await resetAllData();
    location.hash = "#train";
    setTimeout(() => location.reload(), 50);
  });

  document.querySelector("[data-action='export-data']")?.addEventListener("click", () => {
    exportLiftingData();
  });
  document.querySelector("[data-action='import-pick']")?.addEventListener("click", () => {
    document.getElementById("import-file")?.click();
  });
  document.querySelector("[data-action='import-program-pick']")?.addEventListener("click", () => {
    document.getElementById("import-program-file")?.click();
  });

  document.querySelector("[data-action='import-close']")?.addEventListener("click", (e) => {
    if (e.target !== e.currentTarget) return;
    ui.importConfirmOpen = false;
    ui.importPayload = null;
    render();
  });
  document.querySelector("[data-action='import-no']")?.addEventListener("click", () => {
    ui.importConfirmOpen = false;
    ui.importPayload = null;
    render();
  });
  document.querySelector("[data-action='import-yes']")?.addEventListener("click", () => {
    if (!ui.importPayload) return;
    state = ui.importPayload;
    saveState(state);
    ui.importConfirmOpen = false;
    ui.importPayload = null;
    location.hash = "#progress";
    render();
  });

  document.querySelector("[data-action='program-close']")?.addEventListener("click", (e) => {
    if (e.target !== e.currentTarget) return;
    ui.programConfirmOpen = false;
    ui.programImportData = null;
    render();
  });
  document.querySelector("[data-action='program-no']")?.addEventListener("click", () => {
    ui.programConfirmOpen = false;
    ui.programImportData = null;
    render();
  });
  document.querySelector("[data-action='program-yes']")?.addEventListener("click", () => {
    if (!ui.programImportData?.days?.length) return;
    seedProgramFromJson(ui.programImportData, state);
    ui.programConfirmOpen = false;
    ui.programImportData = null;
    location.hash = "#train";
    render();
  });

  document.querySelector("[data-action='start']")?.addEventListener("click", () => {
    const day = getDay(state, route.dayKey);
    if (!day) return;
    const other = activeSessionAny(state);
    if (other && other.dayKey !== day.dayKey) {
      alert(`Finish your active workout (${other.dayKey}) first.`);
      location.hash = `#day/${encodeURIComponent(other.dayKey)}`;
      render();
      return;
    }
    startWorkout(state, day);
    render();
  });
  document.querySelector("[data-action='finish']")?.addEventListener("click", () => {
    const active = activeSessionToday(state, route.dayKey);
    if (active) finishWorkout(state, active.id);
    location.hash = "#train";
  });
  document.querySelector("[data-action='add-set']")?.addEventListener("click", () => {
    const day = getDay(state, route.dayKey);
    const line = day?.lines.find((l) => l.id === route.lineId);
    const session = day ? activeSessionToday(state, day.dayKey) : null;
    const repsEl = document.getElementById("inp-reps");
    const wEl = document.getElementById("inp-weight");
    if (!line || !session || !repsEl || !wEl) return;
    const reps = parseInt(repsEl.value, 10);
    const weightLb = parseFloat(wEl.value);
    if (!reps || reps < 1) return;
    if (!Number.isFinite(weightLb) || weightLb < 0) return;
    addSet(state, session.id, line, reps, weightLb);
    repsEl.value = "";
    wEl.value = "";
    startRestTimer(line);
    render();
  });
  document.querySelector("[data-action='repeat-set']")?.addEventListener("click", () => {
    const day = getDay(state, route.dayKey);
    const line = day?.lines.find((l) => l.id === route.lineId);
    const session = day ? activeSessionToday(state, day.dayKey) : null;
    if (!line || !session) return;
    const prev = setsForLine(session, line.id).slice(-1)[0];
    if (!prev) return;
    addSet(state, session.id, line, prev.reps, prev.weightLb);
    startRestTimer(line);
    render();
  });
  document.querySelector("[data-action='rest-start']")?.addEventListener("click", () => {
    const day = getDay(state, route.dayKey);
    const line = day?.lines.find((l) => l.id === route.lineId);
    if (!line) return;
    startRestTimer(line);
    render();
  });
  document.querySelector("[data-action='rest-stop']")?.addEventListener("click", () => {
    stopRestTimer();
    render();
  });
  document.querySelectorAll("[data-del-set]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.getAttribute("data-del-set");
      const session = activeSessionToday(state, route.dayKey);
      if (session && id) deleteSet(state, session.id, id);
      render();
    });
  });
}

function init() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.addEventListener("hashchange", render);
  if (!window.__hypertrophyImportListener) {
    window.__hypertrophyImportListener = true;
    document.addEventListener("change", (e) => {
      const t = e.target;
      if (!t) return;
      const f = t.files?.[0];
      if (t.id === "import-file") {
        t.value = "";
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result || ""));
            const normalized = normalizeImportedState(parsed);
            if (!normalized) {
              alert("That file doesn’t look like a valid Hypertrophy export.");
              return;
            }
            ui.importPayload = normalized;
            ui.importConfirmOpen = true;
            render();
          } catch {
            alert("Could not read that file as JSON.");
          }
        };
        reader.readAsText(f);
        return;
      }
      if (t.id === "import-program-file") {
        t.value = "";
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result || ""));
            const normalized = normalizeProgramFile(parsed);
            if (!normalized) {
              alert(
                "That file isn’t a valid program. Use program_template.json: a \"days\" array with dayKey, dayTitle, and lines (exerciseName required per line)."
              );
              return;
            }
            ui.programImportData = normalized;
            ui.programConfirmOpen = true;
            render();
          } catch {
            alert("Could not read that file as JSON.");
          }
        };
        reader.readAsText(f);
        return;
      }
      if (t.id === "face-file" || t.id === "face-file-cam") {
        t.value = "";
        if (!f) return;
        loadFaceFromFile(f);
      }
    });
  }
  if (!window.__faceCanvasPointer) {
    window.__faceCanvasPointer = true;
    document.addEventListener("pointerdown", (e) => {
      if (e.target?.id !== "face-canvas") return;
      faceCanvasPointer(e);
    });
  }
  render();

  loadBundledProgram().then((json) => {
    if (json?.days?.length && !state.programDays.length) {
      seedProgramFromJson(json, state);
    }
    render();
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Ensure users pick up new app.js/styles/sw changes promptly.
    location.reload();
  });
  navigator.serviceWorker
    .register("./sw-v6.js", { updateViaCache: "none" })
    .then((reg) => reg.update().catch(() => {}))
    .catch(() => {});
}

init();
