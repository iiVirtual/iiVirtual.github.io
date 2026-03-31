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

function exerciseHistoryPoints(state, exerciseName) {
  const out = [];
  const name = String(exerciseName || "");
  for (const s of state.sessions) {
    if (!s.completed && !isToday(s.startedAt)) continue;
    let best = null;
    for (const row of s.sets || []) {
      if (row.exerciseNameSnapshot !== name) continue;
      const est = estimate1RM(row.weightLb, row.reps);
      if (!est) continue;
      if (!best || est > best) best = est;
    }
    if (best) out.push({ ts: s.startedAt, est1rm: best });
  }
  out.sort((a, b) => a.ts - b.ts);
  // De-dupe by day (keep best).
  const byDay = new Map();
  for (const p of out) {
    const d = todayStart(p.ts);
    const cur = byDay.get(d);
    if (!cur || p.est1rm > cur.est1rm) byDay.set(d, { ts: d, est1rm: p.est1rm });
  }
  return [...byDay.values()].sort((a, b) => a.ts - b.ts);
}

function allExerciseNames(state) {
  const set = new Set();
  for (const s of state.sessions) {
    for (const row of s.sets || []) set.add(row.exerciseNameSnapshot);
  }
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function trendPct(points) {
  if (!points || points.length < 2) return null;
  const a = points[Math.max(0, points.length - 4)]?.est1rm;
  const b = points[points.length - 1]?.est1rm;
  if (!a || !b) return null;
  return ((b - a) / a) * 100;
}

function svgLineChart(points, { width = 520, height = 160, pad = 12 } = {}) {
  if (!points?.length) return "";
  const pts = points.slice(-12);
  const minY = Math.min(...pts.map((p) => p.est1rm));
  const maxY = Math.max(...pts.map((p) => p.est1rm));
  const span = Math.max(1e-6, maxY - minY);
  const w = width;
  const h = height;
  const x0 = pad;
  const y0 = pad;
  const x1 = w - pad;
  const y1 = h - pad;

  const xy = pts.map((p, i) => {
    const x = x0 + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (x1 - x0));
    const y = y1 - ((p.est1rm - minY) / span) * (y1 - y0);
    return { x, y, p };
  });
  const d = xy
    .map((q, i) => `${i === 0 ? "M" : "L"}${q.x.toFixed(1)},${q.y.toFixed(1)}`)
    .join(" ");
  const dots = xy
    .map(
      (q) =>
        `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="3.2" fill="var(--accent)" opacity="0.95"></circle>`
    )
    .join("");
  const last = pts[pts.length - 1];
  const label = `${Math.round(last.est1rm)} lb est. 1RM`;
  return `
    <svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Estimated 1RM over time">
      <rect x="0" y="0" width="${w}" height="${h}" rx="12" fill="color-mix(in srgb, var(--surface) 86%, transparent)" stroke="var(--surface2)"></rect>
      <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>
      ${dots}
      <text x="${pad}" y="${pad + 14}" fill="var(--muted)" font-size="12">${escapeHtml(label)}</text>
      <text x="${pad}" y="${h - pad}" fill="var(--muted)" font-size="11">${escapeHtml(
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

let state = loadState();
let route = parseRoute();

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
  return { name: "train" };
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
  const last = points?.[points.length - 1];
  if (!last) return null;

  // Use most recent session sets for this exercise if available.
  const name = line.exerciseName;
  const recentSession = [...state.sessions].sort((a, b) => b.startedAt - a.startedAt).find((s) =>
    (s.sets || []).some((r) => r.exerciseNameSnapshot === name)
  );
  const rows = (recentSession?.sets || []).filter((r) => r.exerciseNameSnapshot === name);
  if (!rows.length) return null;

  // Find the heaviest weight that still hit the top of the rep range.
  const winners = rows.filter((r) => r.reps >= rr.hi && r.weightLb > 0);
  const best = winners.sort((a, b) => b.weightLb - a.weightLb)[0];
  if (!best) return `Aim to hit ${rr.hi} reps on at least one set before increasing weight.`;

  const nm = `${name}`.toLowerCase();
  const step = /(squat|deadlift|rdl|hip thrust|leg press)/.test(nm) ? 10 : 5;
  return `You’ve hit ${rr.hi}+ reps. Next time, try +${step} lb (keep reps ≥ ${rr.lo}).`;
}

function render() {
  route = parseRoute();
  const app = document.getElementById("app");
  const trainTab = route.name === "train" || route.name === "day" || route.name === "exercise";
  const histTab = route.name === "history" || route.name === "session";
  const progTab = route.name === "progress" || route.name === "progress-ex";

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
          ${points.length ? `<a class="btn btn-ghost" style="width:100%" href="#progress/${encodeURIComponent(
            line.exerciseName
          )}">View chart</a>` : `<div class="muted" style="font-size:0.85rem">Log a few sets to see progression.</div>`}
        </div>
        ${sugg ? `<div class="section-title">Suggestion</div><div class="card"><p class="muted" style="margin:0">${escapeHtml(
          sugg
        )}</p></div>` : ""}
        <div class="section-title">Logged sets</div>
        <div class="card">${rows || `<p class="muted" style="margin:8px 0">No sets yet.</p>`}</div>
        <div class="form-row">
          <input type="number" inputmode="numeric" id="inp-reps" placeholder="Reps" min="1" step="1" />
          <input type="number" inputmode="decimal" id="inp-weight" placeholder="Weight (lb)" min="0" step="0.5" />
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
    header = "<h1>Progress</h1>";
    const names = allExerciseNames(state);
    if (!names.length) {
      main = `<div class="empty"><strong>No data yet</strong>Log sets to see progression charts.</div>`;
    } else {
      const items = names
        .map((n) => {
          const pts = exerciseHistoryPoints(state, n);
          const last = pts[pts.length - 1]?.est1rm;
          const t = trendPct(pts);
          return `
            <a class="card" href="#progress/${encodeURIComponent(n)}">
              <h2>${escapeHtml(n)}</h2>
              <p>${last ? `Est. 1RM ${Math.round(last)} lb` : "—"}${
                t == null ? "" : ` · ${t >= 0 ? "+" : ""}${t.toFixed(1)}%`
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
    const pts = exerciseHistoryPoints(state, name);
    if (!pts.length) {
      main = `<div class="empty">No data for this exercise yet.</div><a class="back-link" href="#progress">← Progress</a>`;
    } else {
      const best = Math.max(...pts.map((p) => p.est1rm));
      const t = trendPct(pts);
      main = `
        <a class="back-link" href="#progress">← Progress</a>
        <div class="section-title">${escapeHtml(name)}</div>
        <div class="card stack">
          <div class="kv">
            <div>
              <div class="k">Best est. 1RM</div>
              <div class="v">${Math.round(best)} lb</div>
            </div>
            <div style="text-align:right">
              <div class="k">Trend</div>
              <div class="v">${t == null ? "—" : `${t >= 0 ? "+" : ""}${t.toFixed(1)}%`}</div>
            </div>
          </div>
          ${svgLineChart(pts)}
          <p class="muted" style="margin:0;font-size:0.85rem">Based on your logged sets using an estimated 1RM model.</p>
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
  }

  app.innerHTML = `
    <header class="top">${header}</header>
    <main>${main}</main>
    <nav class="tabs">
      <a href="#train" class="${trainTab ? "active" : ""}"><span class="icon">◆</span>Train</a>
      <a href="#progress" class="${progTab ? "active" : ""}"><span class="icon">▦</span>Progress</a>
      <a href="#history" class="${histTab ? "active" : ""}"><span class="icon">⟲</span>History</a>
    </nav>
  `;

  wireHandlers();
}

function wireHandlers() {
  document.querySelector("[data-action='reset']")?.addEventListener("click", async () => {
    const ok = confirm("Reset all data on this device? This clears your program + history.");
    if (!ok) return;
    await resetAllData();
    location.hash = "#train";
    render();
    setTimeout(() => location.reload(), 50);
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
    if (!reps || reps < 1 || !weightLb || weightLb <= 0) return;
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
  window.addEventListener("hashchange", render);
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
