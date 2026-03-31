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

function activeSessionToday(state, dayKey) {
  return openSessionsForDay(state, dayKey).find((s) => isToday(s.startedAt));
}

function closeStaleSessions(state, dayKey) {
  for (const s of state.sessions) {
    if (!s.completed && s.dayKey === dayKey && !isToday(s.startedAt)) {
      s.completed = true;
      s.finishedAt = Date.now();
    }
  }
}

function startWorkout(state, day) {
  closeStaleSessions(state, day.dayKey);
  const session = {
    id: uid(),
    startedAt: Date.now(),
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
  if (name === "session" && rest[0]) return { name: "session", sessionId: rest[0] };
  if (name === "history") return { name: "history" };
  return { name: "train" };
}

function render() {
  route = parseRoute();
  const app = document.getElementById("app");
  const trainTab = route.name === "train" || route.name === "day" || route.name === "exercise";
  const histTab = route.name === "history" || route.name === "session";

  let header = "";
  let main = "";

  if (route.name === "train") {
    header = "<h1>Train</h1>";
    if (!state.programDays.length) {
      main = `<div class="empty"><strong>No program loaded</strong>Open over HTTP(S) so bundled_program.json can load, or refresh.</div>`;
    } else {
      main = `<div class="card-list">${state.programDays
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(
          (d) => `
        <a class="card" href="#day/${encodeURIComponent(d.dayKey)}">
          <h2>${escapeHtml(d.dayKey)}</h2>
          <p>${escapeHtml(d.dayTitle)}</p>
        </a>`
        )
        .join("")}</div>`;
    }
  } else if (route.name === "day") {
    const day = getDay(state, route.dayKey);
    if (!day) {
      header = "<h1>Train</h1>";
      main = `<div class="empty">Day not found.</div><a class="back-link" href="#train">← Back</a>`;
    } else {
      header = `<h1>${escapeHtml(day.dayKey)}</h1>`;
      const active = activeSessionToday(state, day.dayKey);
      let body = "";
      if (!active) {
        body = `
          <div class="toolbar" style="justify-content:flex-start">
            <button type="button" class="btn btn-primary" data-action="start">Start workout</button>
          </div>
          <p class="muted">Begins today’s session for this day. Older unfinished sessions are closed automatically.</p>`;
      } else {
        body = `
          <div class="toolbar">
            <button type="button" class="btn btn-ghost" data-action="finish">Finish workout</button>
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
        <div class="section-title">Logged sets</div>
        <div class="card">${rows || `<p class="muted" style="margin:8px 0">No sets yet.</p>`}</div>
        <div class="form-row">
          <input type="number" inputmode="numeric" id="inp-reps" placeholder="Reps" min="1" step="1" />
          <input type="number" inputmode="decimal" id="inp-weight" placeholder="Weight (lb)" min="0" step="0.5" />
        </div>
        <button type="button" class="btn btn-primary stack" style="width:100%;margin-top:12px" data-action="add-set">Add set</button>
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
          <p class="meta" style="margin-top:8px">${new Date(s.startedAt).toLocaleString()}</p>
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
      <a href="#history" class="${histTab ? "active" : ""}"><span class="icon">⟲</span>History</a>
    </nav>
  `;

  wireHandlers();
}

function wireHandlers() {
  document.querySelector("[data-action='start']")?.addEventListener("click", () => {
    const day = getDay(state, route.dayKey);
    if (day) startWorkout(state, day);
    render();
  });
  document.querySelector("[data-action='finish']")?.addEventListener("click", () => {
    const active = activeSessionToday(state, route.dayKey);
    if (active) finishWorkout(state, active.id);
    render();
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
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

init();
