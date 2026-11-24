"use strict";
/* HSK Trainer: offline PWA. Content lives in content/*.json, audio in audio/, pictures in pics/.
   Attempts, recordings and progress are stored in IndexedDB on the device. */

/* ================= small helpers ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const zhCount = t => (String(t).match(/[一-鿿]/g) || []).length;
const punCount = t => (String(t).match(/[，。？！、；：“”‘’（）《》…—,.?!;:]/g) || []).length;
const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const dayKey = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
const LET = ["A", "B", "C", "D", "E"];
const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
const EXAM = new Date(2026, 11, 13);

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2600); }
function openSheet(html) { $("#sheetIn").innerHTML = html; $("#sheet").classList.add("on"); $("#scrim").classList.add("on"); }
function closeSheet() { $("#sheet").classList.remove("on"); $("#scrim").classList.remove("on"); }

/* ================= IndexedDB ================= */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("hsk-trainer", 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("attempts", { keyPath: "id" }); d.createObjectStore("blobs", { keyPath: "id" }); d.createObjectStore("kv", { keyPath: "k" }); };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode), s = t.objectStore(store); let out;
      const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  put: (store, v) => DB.tx(store, "readwrite", s => s.put(v)),
  get: (store, k) => DB.tx(store, "readonly", s => s.get(k)),
  all: store => DB.tx(store, "readonly", s => s.getAll()),
  del: (store, k) => DB.tx(store, "readwrite", s => s.delete(k)),
};
const KV = {};
async function kvLoad() { (await DB.all("kv")).forEach(r => { KV[r.k] = r.v; }); }
function kv(k, d) { return k in KV ? KV[k] : d; }
function kvSet(k, v) { KV[k] = v; return DB.put("kv", { k, v }).catch(() => {}); }

/* ================= content ================= */
const C = {};
let DICT = null, LEVELS = null;
async function loadJSON(p) { const r = await fetch(p); if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }
async function loadDict() {
  if (DICT) return;
  [DICT, LEVELS] = await Promise.all([loadJSON("content/dict.json"), LEVELS ? LEVELS : loadJSON("content/levels.json")]);
}

/* ================= state ================= */
const S = { order: null, w: null, sp: null, book: null };
let tickTimer = null;
function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }
const player = new Audio(); player.preload = "auto";
function playSrc(src, onEnd) {
  try {
    player.pause(); player.src = src; player.preservesPitch = true; player.webkitPreservesPitch = true;
    player.playbackRate = kv("rate", 0.9); player.onended = onEnd || null;
    const p = player.play(); if (p) p.catch(() => toast("Tap play again to start audio"));
  } catch (e) { }
}

/* ================= routing ================= */
const SCREENS = [["today", "今天", "Command center"], ["order", "排序", "Paragraph ordering"], ["write", "写作", "Writing"], ["speak", "口语", "Speaking"], ["read", "阅读", "Reading"], ["export", "导出", "Saved attempts"], ["setup", "设置", "Setup & status"]];
const route = () => { const h = location.hash.slice(1); return SCREENS.some(s => s[0] === h) ? h : "today"; };
function go(s) { if (location.hash === "#" + s) render(); else location.hash = s; }
window.addEventListener("hashchange", () => { closeSheet(); stopTick(); stopRecording(true); player.pause(); render(); window.scrollTo(0, 0); });

function topBar(title, meta) {
  return `<header class="top wrap"><div class="top-in ${route() === "write" || route() === "read" || route() === "today" || route() === "export" ? "wide" : "col"}" style="width:100%">
    <button class="menu press" data-act="menu" aria-label="Open menu">${MENU}<span class="han">${title}</span></button>
    <span class="meta">${meta || ""} ${offlineBadge()}</span></div></header>`;
}
let CACHED = null;
function offlineBadge() { if (CACHED === null) return ""; return CACHED > 0 ? `<span class="badge">· Offline ready ✓ ${CACHED} files</span>` : `<span class="badge warn">· Not cached yet</span>`; }

function render() {
  const s = route();
  const html = ({ today: vToday, order: vOrder, write: vWrite, speak: vSpeak, read: vRead, export: vExport, setup: vSetup })[s]();
  $("#app").innerHTML = html;
  after[s] && after[s]();
}
const after = {};

/* ================= command center ================= */
const TASKS = [
  { id: "or", t: "排序 · paragraph ordering", s: "2 passages", m: 15, go: "order" },
  { id: "wr", t: "写作 · one task + rewrite", s: "Alternate HSK 4 / HSK 5", m: 25, go: "write" },
  { id: "sp", t: "口语 · 3 tasks with redo", s: "Record, review, try again", m: 25, go: "speak" },
  { id: "sh", t: "Shadowing", s: "Play a passage, speak along at 0.8×", m: 10, go: "speak" },
  { id: "rd", t: "阅读", s: "Any shelf, tap words to look up", m: 15, go: "read" },
  { id: "bk", t: "Back up to Files", s: "Keeps your work safe", m: 1, go: "export" },
];
function today() { return kv("day:" + dayKey(), {}); }
function markDone(id, on = true) { const d = today(); d[id] = on; kvSet("day:" + dayKey(), d); }
function ring(p, isToday) { const r = 18, c = 2 * Math.PI * r; return `<svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--sunk)" stroke-width="5"/><circle cx="22" cy="22" r="${r}" fill="none" stroke="${p >= 1 ? "var(--accent)" : isToday ? "var(--ink)" : "var(--faint)"}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${c * Math.min(1, p)} ${c}" transform="rotate(-90 22 22)"/></svg>`; }
let ATT = [];
async function refreshAttempts() { ATT = await DB.all("attempts"); }
const TYPE_LABEL = { open: "Openers", link: "Linking words 然而/此外", ref: "Back-references 这/该/其", time: "Time order 后来/如今", gen: "General → specific / 总之", qa: "Question → answer", cause: "Cause → effect 因此" };
function vToday() {
  const d = today(), done = TASKS.filter(t => d[t.id]), mins = done.reduce((a, t) => a + t.m, 0), total = TASKS.reduce((a, t) => a + t.m, 0);
  const start = new Date(kv("tripStart", dayKey()) + "T00:00:00");
  const days = Array.from({ length: 6 }, (_, i) => { const x = new Date(start); x.setDate(x.getDate() + i); const k = dayKey(x); const dd = kv("day:" + k, {}); return { k, label: x.toLocaleDateString("en", { weekday: "short" }), p: TASKS.filter(t => dd[t.id]).length / TASKS.length }; });
  const todayIdx = days.findIndex(x => x.k === dayKey());
  let streak = 0; { const x = new Date(); for (let i = 0; i < 400; i++) { const dd = kv("day:" + dayKey(x), {}); if (Object.values(dd).some(Boolean)) streak++; else if (i > 0) break; x.setDate(x.getDate() - 1); } }
  const tripMins = days.reduce((a, x) => { const dd = kv("day:" + x.k, {}); return a + TASKS.filter(t => dd[t.id]).reduce((b, t) => b + t.m, 0); }, 0);
  const err = kv("errorlog", {});
  const weak = Object.entries(err).filter(([, v]) => v[1] >= 2).map(([k, v]) => [k, v[0] / v[1], v]).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const unexp = ATT.filter(a => !a.exported && a.type !== "ordering");
  const recs = ATT.reduce((a, x) => a + (x.takes ? x.takes.length : 0), 0);
  const dleft = Math.ceil((EXAM - new Date(new Date().toDateString())) / 864e5);
  const lb = kv("lastBackup", null);
  const hour = new Date().getHours(), greet = hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening.";
  return topBar("今天", todayIdx >= 0 ? `Offline day ${todayIdx + 1} of 6` : "") + `<main class="page wrap"><div class="wide">
   <div class="hello"><div><h1>${greet} ${done.length === TASKS.length ? "All done today." : "Keep the streak going."}</h1><div class="muted">HSK 4 + HSK 5 · 13 Dec · Apex</div></div><div class="count"><b>${Math.max(0, dleft)}</b><span>days to the test</span></div></div>
   <div class="cc"><section>
     <div class="h">Today's checklist <span>${done.length} of ${TASKS.length} · ${mins} / ${total} min</span></div>
     <div class="bar"><i style="transform:scaleX(${done.length / TASKS.length})"></i></div>
     ${TASKS.map(t => `<div class="task ${d[t.id] ? "done" : ""}"><button class="tick ${d[t.id] ? "on" : ""}" data-act="tick" data-id="${t.id}" aria-label="Toggle ${esc(t.t)}">${TICK}</button><div class="t han">${t.t}<span>${t.s} · ${t.m} min</span></div>${d[t.id] ? `<span class="muted small">done</span>` : `<button class="go press" data-go="${t.go}">Start</button>`}</div>`).join("")}
     <p class="muted small" style="margin-top:14px">Items tick themselves when you finish them in each module. Day 6: do one full timed run of each level.</p>
   </section><aside class="side">
     <div><div class="h">6 offline days</div><div class="days">${days.map((x, i) => `<div class="dayc ${i === todayIdx ? "today" : ""}">${ring(x.p, i === todayIdx)}${x.label}</div>`).join("")}</div></div>
     <div class="stats"><div><b>${streak}</b><span>day streak</span></div><div><b>${tripMins}</b><span>minutes this trip</span></div><div><b>${ATT.length}</b><span>attempts</span></div></div>
     <div><div class="h">Weak spots <span>from your ordering mistakes</span></div><div class="weak">
       ${weak.length ? weak.map(([k, r, v]) => `<div><span>${esc(TYPE_LABEL[k] || k)}</span><span class="tr"><i style="width:${Math.round(r * 100)}%"></i></span><span class="v">${v[0]}/${v[1]}</span></div>`).join("") : `<p class="muted small" style="margin:0">Do a few ordering passages and your weakest clue types will show here.</p>`}</div>
       ${weak.length ? `<button class="quiet press" data-go="order" data-mode="weak" style="padding-left:0;margin-top:6px">Practise weak spots →</button>` : ""}</div>
     <div class="vault"><div style="display:flex;justify-content:space-between;align-items:baseline"><b>Saved on this iPad</b><span class="badge">● stored offline</span></div>
       <p>${unexp.length} attempts waiting to export · ${recs} recordings in total. ${lb ? "Last backup: " + new Date(lb).toLocaleString("en", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "No backup yet."}</p>
       <div class="chips"><button class="chip press" data-act="backup">Back up to Files</button><button class="chip press" data-go="export">Export queue</button></div></div>
   </aside></div></div></main>`;
}

/* ================= ordering ================= */
const ORDER_MODES = [["first", "1 · First paragraph?"], ["next", "2 · What comes next?"], ["full", "3 · Full order"], ["exam", "4 · Exam (timed)"], ["weak", "Weak spots"]];
function pickOrderItem(mode) {
  const items = C.ordering.items, seen = kv("orderSeen", {});
  let pool = items;
  if (mode === "weak") {
    const err = kv("errorlog", {});
    const worst = Object.entries(err).filter(([, v]) => v[1] >= 2).sort((a, b) => b[1][0] / b[1][1] - a[1][0] / a[1][1])[0];
    if (worst) pool = items.slice().sort((a, b) => b.paras.filter(p => p.type === worst[0]).length - a.paras.filter(p => p.type === worst[0]).length).slice(0, 6);
  }
  const level = kv("orderLevel", "all");
  if (level !== "all") pool = pool.filter(i => String(i.level) === level) || pool;
  if (!pool.length) pool = items;
  pool = pool.slice().sort((a, b) => (seen[a.id] || 0) - (seen[b.id] || 0));
  const least = seen[pool[0].id] || 0;
  const cands = pool.filter(i => (seen[i.id] || 0) === least);
  return cands[Math.floor(Math.random() * cands.length)];
}
function newOrder(mode) {
  mode = mode || (S.order && S.order.mode) || kv("orderMode", "full");
  const item = pickOrderItem(mode);
  const perm = shuffle([0, 1, 2, 3, 4]); // perm[letterIndex] = para index
  const given = Math.floor(Math.random() * 4);
  S.order = { mode, item, perm, slots: [null, null, null, null, null], checked: false, pick: null, given, left: mode === "exam" ? 300 : null, startedAt: Date.now() };
}
function letterOf(paraIdx) { return LET[S.order.perm.indexOf(paraIdx)]; }
function clueHTML(p, on) { let t = esc(p.t); if (on) (p.clue || []).forEach(c => { t = t.replace(esc(c), `<mark class="clue">${esc(c)}</mark>`); }); return t; }
function whyHTML(p) { const [zh, en] = (p.why || "").split("|"); return `<b class="han">${esc(zh)}</b> ${esc(en || "")}`; }
function vOrder() {
  if (!C.ordering) return topBar("排序") + `<main class="page wrap col"><p>Loading…</p></main>`;
  if (!S.order) newOrder();
  const o = S.order, it = o.item;
  const modes = `<div class="chips" style="margin:8px 0 6px">${ORDER_MODES.map(([k, l]) => `<button class="chip press" aria-pressed="${o.mode === k}" data-act="omode" data-mode="${k}">${l}</button>`).join("")}</div>
   <div class="chips" style="margin-bottom:6px">${[["all", "HSK 4 + 5"], ["4", "HSK 4"], ["5", "HSK 5"]].map(([k, l]) => `<button class="chip press" aria-pressed="${kv("orderLevel", "all") === k}" data-act="olevel" data-level="${k}" style="font-size:12.5px;padding:5px 10px">${l}</button>`).join("")}</div>`;
  const head = `<h1 class="han">${esc(it.title)}</h1><p class="lede">HSK ${it.level} · ${esc(it.genre)} · ${{ first: "Which paragraph opens the text?", next: "Which paragraph comes right after this one?", full: "Put A–E in order. Tap a paragraph to place it in the next empty slot; tap a slot to clear it.", exam: "Put A–E in order. 5 minutes per passage, like the real test.", weak: "Full order, chosen for the clue type you miss most." }[o.mode]}</p>`;
  let body = "";
  if (o.mode === "first" || o.mode === "next") {
    const target = o.mode === "first" ? 0 : o.given + 1;
    const opts = LET.map((L, li) => ({ L, pi: o.perm[li] })).filter(x => o.mode === "first" || x.pi !== o.given);
    body = (o.mode === "next" ? `<div class="given">${clueHTML(it.paras[o.given], o.checked)}</div><div class="h">Which comes next?</div>` : "") +
      `<div class="paras">${opts.map(({ L, pi }) => { const p = it.paras[pi]; let cls = ""; if (o.checked) cls = pi === target ? "right" : (o.pick === pi ? "wrong" : ""); return `<button class="para press ${cls}" data-act="opick" data-pi="${pi}"><span class="L">${L}</span><span>${clueHTML(p, o.checked && (pi === target || o.pick === pi))}${o.checked && (pi === target || o.pick === pi) ? `<div class="why" style="margin-top:6px">${whyHTML(p)}</div>` : ""}</span></button>`; }).join("")}</div>
      ${o.checked ? `<div style="display:flex;gap:10px;margin-top:20px"><button class="btn press" data-act="onext">Next →</button><button class="btn ghost press" data-act="oread">Read it in order</button></div>` : ""}`;
  } else {
    const used = o.slots.filter(Boolean), res = o.checked ? o.slots.map((L, i) => L && o.perm[LET.indexOf(L)] === i) : [];
    body = `<div class="paras">${LET.map((L, li) => { const pi = o.perm[li], p = it.paras[pi]; return `<button class="para press ${!o.checked && used.includes(L) ? "used" : ""}" data-act="opara" data-l="${L}"><span class="L">${L}</span><span>${clueHTML(p, o.checked)}${o.checked ? `<div class="why" style="margin-top:6px">${pi + 1}. ${whyHTML(p)}</div>` : ""}</span></button>`; }).join("")}</div>
     <div style="height:90px"></div>
     <div class="strip"><div class="strip-in">${o.slots.map((L, i) => `<button class="slot press ${L ? "filled" : ""} ${o.checked ? (res[i] ? "ok" : "no") : ""}" data-act="oslot" data-i="${i}" aria-label="Slot ${i + 1}">${L || ""}<small>${i + 1}</small></button>`).join("")}
      ${o.checked ? `<button class="btn press" data-act="onext">Next →</button>` : `<button class="btn press" data-act="ocheck" ${o.slots.includes(null) ? "disabled" : ""}>Check</button>`}</div></div>`;
  }
  return topBar("排序", o.mode === "exam" && !o.checked ? `<span class="timer" id="otime">${fmt(o.left)}</span>` : `${Object.keys(kv("orderSeen", {})).length}/${C.ordering.items.length} passages tried`) + `<main class="page wrap"><div class="col">${modes}${head}${body}</div></main>`;
}
after.order = () => {
  const o = S.order; if (!o || o.mode !== "exam" || o.checked) return;
  stopTick(); tickTimer = setInterval(() => { o.left--; const el = $("#otime"); if (el) el.textContent = fmt(o.left); if (o.left <= 0) { stopTick(); checkOrder(); } }, 1000);
};
function logClues(results) { // results: [{type, ok}]
  const err = kv("errorlog", {});
  results.forEach(({ type, ok }) => { const v = err[type] || [0, 0]; v[1]++; if (!ok) v[0]++; err[type] = v; });
  kvSet("errorlog", err);
}
function finishOrderItem(score, max) {
  const o = S.order, seen = kv("orderSeen", {}); seen[o.item.id] = (seen[o.item.id] || 0) + 1; kvSet("orderSeen", seen);
  const n = (kv("orderToday:" + dayKey(), 0)) + 1; kvSet("orderToday:" + dayKey(), n); if (n >= 2) markDone("or");
  DB.put("attempts", { id: "o-" + Date.now(), type: "ordering", task: o.mode, itemId: o.item.id, title: o.item.title, at: Date.now(), score, max, slots: o.slots, exported: false }).then(refreshAttempts);
}
function checkOrder() {
  const o = S.order; if (o.checked) return; stopTick(); o.checked = true;
  const res = o.slots.map((L, i) => ({ type: o.item.paras[i].type, ok: !!L && o.perm[LET.indexOf(L)] === i }));
  logClues(res); finishOrderItem(res.filter(r => r.ok).length, 5);
  render();
  const n = res.filter(r => r.ok).length;
  const correct = [0, 1, 2, 3, 4].map(i => letterOf(i)).join(" → ");
  openSheet(`<h2>${n} of 5 in the right place</h2><p class="muted" style="margin:0 0 14px">Correct order: <b>${correct}</b>. Clue words are now highlighted, with a reason under each paragraph.</p>
    ${res.filter(r => !r.ok).length ? `<p style="margin:0 0 14px">Missed clue types: ${[...new Set(res.filter(r => !r.ok).map(r => TYPE_LABEL[r.type] || r.type))].map(esc).join(", ")}. Logged to your weak spots.</p>` : `<p style="margin:0 0 14px">Clean run. 很好！</p>`}
    <div style="display:flex;gap:10px"><button class="btn press" data-act="closesheet">Review the clues</button><button class="btn ghost press" data-act="onext">Next passage</button></div>`);
}

/* ================= writing ================= */
const W_TASKS = ["h4p1", "h4p2", "h5p1", "h5p2"];
function wItems(task) {
  const w = C.writing;
  if (task === "h4p1") return w.h4p1.map(x => ({ id: x.id, word: x.word, scene: x.scene, models: [x.model] }));
  if (task === "h4p2") return w.h4p2.map(x => ({ id: x.id, topic: x.topic, models: [x.model] }));
  const ids = Object.keys(C.picsets).sort();
  if (task === "h5p1") return ids.map(n => ({ id: "w51-" + n, pic: n, models: w.h5p1_models[n] ? [w.h5p1_models[n]] : [], panels: C.picsets[n].panels, cast: C.picsets[n].cast }));
  return ids.map(n => ({ id: "w52-" + n, pic: n, topic: C.picsets[n].essay, models: w.h5p2_models[n] ? [w.h5p2_models[n]] : [] }))
    .sort((a, b) => b.models.length - a.models.length);
}
function newWrite(task, idx) {
  task = task || kv("wTask", "h5p1"); const items = wItems(task);
  const done = kv("wDone", {});
  if (idx == null) { idx = items.findIndex(x => !done[x.id]); if (idx < 0) idx = 0; }
  S.w = { task, idx, item: items[idx], text: "", draft1: null, submitted: false, self: [false, false, false, false, false], startedAt: Date.now(), left: null, attemptId: null };
}
const STRUCTS = [["把", /把/], ["被", /被/], ["连…都/也", /连.{1,12}[都也]/], ["不但…而且", /不但.{1,20}(而且|还|也)/], ["不仅…还", /不仅.{1,20}(还|而且|也)/], ["虽然…但是", /虽然.{1,25}(但是|可是|却)/], ["只要…就", /只要.{1,15}就/], ["即使…也", /即使.{1,15}也/], ["一边…一边", /一边.{1,10}一边/], ["越来越", /越来越/], ["与其…不如", /与其.{1,20}不如/], ["对…来说", /对.{1,10}来说/], ["之所以…是因为", /之所以.{1,20}是因为/], ["无论…都", /无论.{1,15}都/]];
const CONNECTORS = ["然后", "而且", "所以", "但是", "可是", "因为", "总之", "于是", "后来", "最后", "因此", "不过", "首先", "其次", "另外", "此外", "总的来说", "没想到", "终于", "然而", "比如"];
function segment(t) {
  const out = []; let i = 0;
  while (i < t.length) {
    if (!/[一-鿿]/.test(t[i])) { i++; continue; }
    let L = 1; for (let n = Math.min(4, t.length - i); n > 1; n--) { const w = t.substr(i, n); if ((LEVELS && LEVELS[w]) || (DICT && DICT[w])) { L = n; break; } }
    out.push(t.substr(i, L)); i += L;
  }
  return out;
}
function runChecks(text) {
  const w = S.w, def = C.writing.tasks[w.task], n = zhCount(text), rows = [];
  rows.push({ k: "Length", v: `${n} characters (target ${def.target[0]}${def.target[1] ? "–" + def.target[1] : "+"})${n < def.target[0] ? " · under" : n > def.target[1] ? " · over" : " · within"}`, warn: n < def.target[0] });
  if (w.task === "h4p1") rows.push({ k: "Required word", v: text.includes(w.item.word) ? `${w.item.word} ✓` : `${w.item.word} not used`, warn: !text.includes(w.item.word) });
  if (w.task !== "h4p1") { const cs = CONNECTORS.filter(c => text.includes(c)); rows.push({ k: "Connectors", v: `${cs.length}${cs.length ? " (" + cs.join("、") + ")" : ""}${cs.length < 3 ? " · aim for 3+" : ""}`, warn: cs.length < 3 }); }
  const used = STRUCTS.filter(s => s[1].test(text)).map(s => s[0]);
  rows.push({ k: "Structures", v: used.length ? used.join("、") : "none found", warn: w.task !== "h4p1" && used.length < 2, extra: "Try: " + STRUCTS.filter(s => !used.includes(s[0])).slice(0, 2).map(s => s[0]).join(" or ") });
  const warns = [];
  if (/非常很|很非常|太.{0,2}很|很太/.test(text)) warns.push("Two degree words together (非常很). Keep one.");
  if (/虽然/.test(text) && !/虽然.{1,25}(但是|可是|却)/.test(text)) warns.push("虽然 with no 但是 / 可是 / 却 after it.");
  if (/不但/.test(text) && !/不但.{1,20}(而且|还|也)/.test(text)) warns.push("不但 with no 而且 / 还 / 也.");
  if (/连/.test(text) && !/连.{1,12}[都也]/.test(text)) warns.push("连 with no 都 / 也.");
  if (/即使/.test(text) && !/即使.{1,15}也/.test(text)) warns.push("即使 with no 也.");
  if (/(认真|仔细|高兴|慢慢|努力|安静)的(走|说|学|看|做|写|跑|吃|笑)/.test(text)) warns.push("Adjective + 的 + verb: should it be 地? (认真地学习)");
  if (/(做|说|写|跑|唱|跳|吃|学|走|来|长|过)的(很|非常|太|特别|不)/.test(text)) warns.push("Verb + 的 + 很: should it be 得? (做得很好)");
  if (/[,.?!;:](?!\d)/.test(text) && /[一-鿿]/.test(text)) warns.push("English punctuation found. Use Chinese ，。？！");
  if (text.trim() && !/[。！？”」]$/.test(text.trim())) warns.push("No Chinese full stop at the end.");
  if (text.split(/[，。？！；：]/).some(s => zhCount(s) > 40)) warns.push("A very long stretch (40+ characters) with no punctuation.");
  if (DICT || LEVELS) {
    const words = segment(text), counts = {};
    words.filter(x => x.length > 1).forEach(x => { counts[x] = (counts[x] || 0) + 1; });
    const rep = Object.entries(counts).filter(([, c]) => c >= 4).map(([k]) => k);
    if (rep.length) warns.push("Repeated 4+ times: " + rep.join("、") + ". Vary your wording.");
  }
  return { rows, warns };
}
function levelProfile(text) {
  if (!LEVELS) return null;
  const words = segment(text); if (!words.length) return null;
  const b = { low: 0, l4: 0, l5: 0, hi: 0 }, mid = new Set();
  words.forEach(w => { const l = LEVELS[w]; if (!l) b.hi++; else if (l <= 3) b.low++; else if (l === 4) { b.l4++; if (w.length > 1) mid.add(w); } else if (l === 5) { b.l5++; if (w.length > 1) mid.add(w); } else b.hi++; });
  const tot = words.length, pc = x => Math.round(x / tot * 100);
  return { low: pc(b.low), l4: pc(b.l4), l5: pc(b.l5), hi: pc(b.hi), words: [...mid].slice(0, 8) };
}
function vWrite() {
  if (!C.writing) return topBar("写作") + `<main class="page wrap col"><p>Loading…</p></main>`;
  if (!S.w) newWrite();
  const w = S.w, def = C.writing.tasks[w.task], it = w.item, items = wItems(w.task);
  const tabs = `<div class="chips" style="margin:8px 0 4px">${W_TASKS.map(k => `<button class="chip press" aria-pressed="${w.task === k}" data-act="wtask" data-task="${k}">${C.writing.tasks[k].label} · ${C.writing.tasks[k].title}</button>`).join("")}</div>`;
  let left = "", prompt = "";
  if (it.pic) left = `<div class="pic"><img src="pics/${it.pic}.jpg" alt="Picture set ${it.pic}"></div>`;
  else if (it.word) left = `<div class="scene"><div class="muted small" style="text-align:center">Use this word</div><div class="w">${esc(it.word)}</div><p class="muted" style="text-align:center;margin:0">Picture: ${esc(it.scene)}</p></div>`;
  else left = `<div class="scene"><div class="muted small" style="text-align:center">Topic</div><div class="w" style="font-size:34px">${esc(it.topic)}</div></div>`;
  if (w.task === "h5p2") prompt = `<p class="han" style="font-size:19px;margin:0 0 6px">${esc(it.topic)}</p>`;
  if (w.task === "h5p2") left = `<div class="scene"><div class="muted small">Essay topic</div><p class="han" style="font-size:22px;line-height:1.6;margin:8px 0 0">${esc(it.topic)}</p></div>`;
  const hint = it.panels && it.panels[0] ? `<details style="margin:10px 0"><summary class="small" style="cursor:pointer;font-weight:600">Hint: what happens in each picture</summary><ol class="small muted" style="padding-left:18px;margin:6px 0 0">${it.panels.map(p => `<li>${esc(p)}</li>`).join("")}</ol></details>` : "";
  return topBar("写作", `${def.label} · ${w.idx + 1}/${items.length} ${w.left != null ? `· <span class="timer" id="wtime">${fmt(w.left)}</span>` : ""}`) + `<main class="page wrap"><div class="wide">${tabs}
    <h1 style="font-size:22px">${esc(def.title)}</h1><p class="lede han" style="font-size:16px;margin-bottom:16px">${esc(def.instr)}</p>
    <div class="split"><div>${left}${hint}</div><div>
      ${w.draft1 != null ? `<div class="h">First draft</div><div class="draft1">${esc(w.draft1)}</div><div class="h">Write it again</div>` : ""}
      <textarea class="editor" id="wtext" lang="zh-CN" aria-label="Your answer" placeholder="开始写…" ${w.task === "h4p1" ? 'style="min-height:22vh"' : ""}>${esc(w.text)}</textarea>
      <div class="count-row"><span id="wcount">${zhCount(w.text)} characters · ${punCount(w.text)} punctuation</span><span>${def.target[0]}+</span></div>
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap"><button class="btn press" style="flex:1" data-act="wcheck">Check my writing</button>
       <button class="btn ghost press" data-act="wtimer">${w.left != null ? "Stop timer" : "Timer " + def.minutes + ":00"}</button><button class="btn ghost press" data-act="wnext">Next prompt</button></div>
    </div></div></div></main>`;
}
after.write = () => {
  const ta = $("#wtext"); if (!ta) return;
  ta.addEventListener("input", () => { S.w.text = ta.value; $("#wcount").textContent = zhCount(ta.value) + " characters · " + punCount(ta.value) + " punctuation"; });
  if (S.w.left != null) { stopTick(); tickTimer = setInterval(() => { S.w.left--; const el = $("#wtime"); if (el) el.textContent = fmt(S.w.left); if (S.w.left === 0) toast("Time's up. Finish your sentence and check it."); }, 1000); }
};
async function writeCheck() {
  const w = S.w; if (!zhCount(w.text)) { toast("Write something first"); return; }
  try { await loadDict(); } catch (e) { }
  const { rows, warns } = runChecks(w.text), prof = levelProfile(w.text);
  const drafts = (w.draft1 != null ? [w.draft1] : []).concat([w.text]);
  if (!w.attemptId) w.attemptId = "w-" + Date.now();
  const rec = { id: w.attemptId, type: "writing", task: w.task, itemId: w.item.id, prompt: w.item.topic || w.item.word || ("picture set " + w.item.pic), at: Date.now(), drafts, checks: rows.map(r => r.k + ": " + r.v).concat(warns.map(x => "Check: " + x)), self: w.self, exported: false };
  await DB.put("attempts", rec); await refreshAttempts();
  const done = kv("wDone", {}); done[w.item.id] = true; kvSet("wDone", done); markDone("wr");
  const model = w.item.models[0];
  openSheet(`<h2>Things to look at</h2><p class="muted" style="margin:0 0 12px">Not a score. Fix what you agree with, then write it again. Saved to your export queue.</p>
    ${rows.map(r => `<div class="check-row ${r.warn ? "warn" : ""}"><span>${r.k}</span><span class="v han">${esc(r.v)}${r.extra ? `<br><span class="muted small">${esc(r.extra)}</span>` : ""}</span></div>`).join("")}
    ${prof ? `<div class="check-row" style="display:block"><div style="display:flex;justify-content:space-between"><span>Level profile</span><span class="muted small">${prof.words.length ? "HSK 4–5 words: " + prof.words.map(esc).join("、") : "No HSK 4–5 words yet"}</span></div><div class="profile"><i style="width:${prof.low}%;background:var(--faint)"></i><i style="width:${prof.l4}%;background:#4a7fb0"></i><i style="width:${prof.l5}%;background:var(--accent)"></i><i style="width:${prof.hi}%;background:#c49a3a"></i></div><div class="plegend"><span style="--c:var(--faint)">HSK 1–3 ${prof.low}%</span><span style="--c:#4a7fb0">HSK 4 ${prof.l4}%</span><span style="--c:var(--accent)">HSK 5 ${prof.l5}%</span><span style="--c:#c49a3a">HSK 6+ / other ${prof.hi}%</span></div></div>` : ""}
    ${warns.map(x => `<div class="check-row warn"><span>Check this</span><span class="v">${esc(x)}</span></div>`).join("")}
    <h2 style="font-size:17px;margin:22px 0 8px">Model answer</h2>
    ${model ? `<p class="model">${esc(model)}</p>` : `<p class="muted">No model for this prompt yet. It's on the list for when you're back online; Claude will mark your draft from the export.</p>`}
    <h2 style="font-size:17px;margin:22px 0 4px">Self-check</h2><div class="selfcheck">${["Task fully answered", "Logical order", "3+ connectors", "2+ HSK 4–5 structures", "No unclear sentences"].map((t, i) => `<button data-act="wself" data-i="${i}"><span class="tick ${w.self[i] ? "on" : ""}">${TICK}</span>${t}</button>`).join("")}</div>
    <div style="display:flex;gap:10px;margin-top:20px;flex-wrap:wrap"><button class="btn press" data-act="wagain">Write it again</button><button class="btn ghost press" data-act="wnext">Next prompt</button></div>`);
}

/* ================= speaking ================= */
const SP_TASKS = [
  ["h4p1", "HSK 4 · Part 1", "Listen and repeat", "repeat"], ["h4p2", "HSK 4 · Part 2", "Describe the pictures", "picture"], ["h4p3", "HSK 4 · Part 3", "Answer a question", "question"],
  ["h5p1", "HSK 5 · Part 1", "Listen and retell", "retell"], ["h5p2", "HSK 5 · Part 2", "Pictures → a story", "picture"], ["h5p3", "HSK 5 · Part 3", "Answer an opinion question", "question"]];
const SP_TIME = { h4p1: [0, 45, false], h4p2: [60, 90, false], h4p3: [120, 90, false], h5p1: [0, 90, true], h5p2: [180, 120, true], h5p3: [210, 150, true] };
function spItems(task) {
  if (task === "h4p2" || task === "h5p2") return Object.keys(C.writing.h5p1_models).sort().map(n => ({ id: "pic-" + n, pic: n, model: C.writing.h5p1_models[n], modelAudio: "audio/pic-" + n + ".mp3" }));
  return C.speaking.items.filter(x => x.task === task).map(x => ({ ...x, audio: "audio/" + x.id + ".mp3", modelAudio: x.model ? "audio/" + x.id + "-model.mp3" : null }));
}
function newSpeak(task, idx) {
  task = task || kv("spTask", "h5p1"); const items = spItems(task), done = kv("spDone", {});
  if (idx == null) { idx = items.findIndex(x => !done[task + x.id]); if (idx < 0) idx = 0; }
  const kind = SP_TASKS.find(t => t[0] === task)[3];
  S.sp = { task, kind, idx, item: items[idx], phase: kind === "repeat" || kind === "retell" ? "listen" : "prep", left: SP_TIME[task][0], takes: [], dict: "", reveal: false, self: [false, false, false, false, false], attemptId: "s-" + Date.now() };
}
let rec = null;
async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast("Recording isn't supported here. Use the timer and Voice Memos."); return false; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || "";
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined), chunks = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec = { mr, stream, chunks, start: Date.now(), type: mr.mimeType || type || "audio/mp4" };
    mr.start(1000); return true;
  } catch (e) { toast("Microphone blocked. Allow it in Settings → Safari → Microphone."); return false; }
}
function stopRecording(discard) {
  return new Promise(res => {
    if (!rec) return res(null);
    const r = rec; rec = null;
    r.mr.onstop = () => { r.stream.getTracks().forEach(t => t.stop()); res(discard ? null : { blob: new Blob(r.chunks, { type: r.type }), dur: (Date.now() - r.start) / 1000 }); };
    try { r.mr.stop(); } catch (e) { r.stream.getTracks().forEach(t => t.stop()); res(null); }
  });
}
async function spBeginAnswer() {
  const sp = S.sp; stopTick(); player.pause();
  sp.phase = "answer"; sp.left = SP_TIME[sp.task][1]; sp.recOK = await startRecording(); render();
  tickTimer = setInterval(() => { sp.left--; const el = $("#sptime"); if (el) { el.textContent = fmt(sp.left); if (sp.left <= 15) el.classList.add("low"); } if (sp.left <= 0) spFinish(); }, 1000);
}
function spBeginPrep() { const sp = S.sp; stopTick(); sp.phase = "prep"; sp.left = SP_TIME[sp.task][0]; sp.prepStarted = false; render(); }
function startPrepTimer() {
  const sp = S.sp; if (sp.prepStarted) return; sp.prepStarted = true;
  if (sp.kind === "question" && sp.item.audio) playSrc(sp.item.audio);
  stopTick(); tickTimer = setInterval(() => { sp.left--; const el = $("#sptime"); if (el) el.textContent = fmt(sp.left); if (sp.left <= 0) spBeginAnswer(); }, 1000);
}
async function spFinish() {
  stopTick(); const sp = S.sp, r = await stopRecording(false);
  const take = { n: sp.takes.length + 1, at: Date.now(), dur: r ? r.dur : SP_TIME[sp.task][1] - sp.left };
  if (r && r.blob.size) { take.blobId = sp.attemptId + "-t" + take.n; await DB.put("blobs", { id: take.blobId, blob: r.blob, type: r.blob.type, size: r.blob.size }); take.size = r.blob.size; }
  sp.takes.push(take); sp.phase = "review";
  await spSave(); const d = kv("spDone", {}); d[sp.task + sp.item.id] = true; kvSet("spDone", d);
  const n = kv("spToday:" + dayKey(), 0) + 1; kvSet("spToday:" + dayKey(), n); if (n >= 3) markDone("sp");
  render();
}
function keyHits(t) { return (S.sp.item.keys || []).map(([, re]) => new RegExp(re).test(t)); }
function matchPct(target, said) {
  const a = [...target.replace(/[^一-鿿]/g, "")], b = [...said.replace(/[^一-鿿]/g, "")]; if (!a.length) return { pct: 0, html: "" };
  const m = a.length, n = b.length, dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hit = new Array(m).fill(false); let i = 0, j = 0; while (i < m && j < n) { if (a[i] === b[j]) { hit[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return { pct: Math.round(hit.filter(Boolean).length / m * 100), html: a.map((c, k) => hit[k] ? esc(c) : `<span class="x">${esc(c)}</span>`).join("") };
}
async function spSave() {
  const sp = S.sp, hits = keyHits(sp.dict);
  await DB.put("attempts", { id: sp.attemptId, type: "speaking", task: sp.task, itemId: sp.item.id, prompt: sp.item.text || ("picture set " + sp.item.pic), at: Date.now(), takes: sp.takes.map(t => ({ n: t.n, at: t.at, dur: Math.round(t.dur), blobId: t.blobId || null, size: t.size || 0 })), transcript: sp.dict, keyPoints: sp.item.keys ? hits.filter(Boolean).length + "/" + hits.length : null, self: sp.self, exported: false });
  await refreshAttempts();
}
function vSpeak() {
  if (!C.speaking) return topBar("口语") + `<main class="page wrap col"><p>Loading…</p></main>`;
  if (!S.sp) newSpeak();
  const sp = S.sp, it = sp.item, task = SP_TASKS.find(t => t[0] === sp.task), [prep, ans, verified] = SP_TIME[sp.task], items = spItems(sp.task);
  const steps = (sp.kind === "repeat" || sp.kind === "retell" ? [["listen", "Listen"], ["answer", "Answer"], ["review", "Review"]] : [["prep", "Prepare"], ["answer", "Answer"], ["review", "Review"]]);
  const si = steps.findIndex(s => s[0] === sp.phase);
  const head = `<button class="pill press" data-act="sptask"><b>${task[1]}</b>${task[2]} · ${prep ? "prep " + fmt(prep) + " · " : ""}answer ${fmt(ans)}${verified ? "" : " (check)"} ▾</button>
   <div class="steps">${steps.map(([k, l], i) => `<span class="${i === si ? "on" : i < si ? "done" : ""}">${i < si ? "✓ " : ""}${l}</span>`).join("")}</div>`;
  const rate = kv("rate", 0.9);
  const speed = `<div class="chips" style="justify-content:center;align-items:center"><span class="muted small">Speed</span>${[0.8, 0.9, 1].map(r => `<button class="chip press" aria-pressed="${rate === r}" data-act="rate" data-r="${r}" style="font-size:12.5px;padding:5px 10px">${r === 1 ? "1.0× exam" : r + "×"}</button>`).join("")}</div>`;
  let body = "";
  if (sp.phase === "listen") body = `<div class="stage"><h2>${sp.kind === "retell" ? "Listen once, then retell it in your own words." : "Listen, then repeat it as closely as you can."}</h2><p>It plays once, like the exam. The text stays hidden until you've answered. Recording starts when it ends.</p>
    <button class="ring press" data-act="spplay">▶ Play</button>${speed}<button class="quiet press" data-act="spanswer">Skip to answer →</button></div>`;
  if (sp.phase === "prep") body = `<div class="stage">${it.pic ? `<img src="pics/${it.pic}.jpg" alt="Picture set ${it.pic}" style="max-width:min(520px,100%);border-radius:14px">` : `<div class="question">${esc(it.text)}</div>`}
    <p>${it.pic ? (sp.task === "h5p2" ? "Tell the story: who, where, what happened, how it ended." : "Describe what you see: the scene, the people, what they're doing.") : "Plan: view → reason 1 + example → reason 2 → closing line."}</p>
    <div class="big-time" id="sptime">${fmt(sp.left)}</div><div class="muted small">preparation</div>
    <div style="display:flex;gap:10px">${it.audio ? `<button class="btn ghost press" data-act="spq">▶ Hear the question</button>` : ""}<button class="btn press" data-act="spanswer">Start answering now</button></div></div>`;
  if (sp.phase === "intro") body = "";
  if (sp.phase === "answer") body = `<div class="stage">${it.pic ? `<img src="pics/${it.pic}.jpg" alt="" style="max-width:min(360px,80%);border-radius:12px">` : sp.kind === "question" ? `<div class="question" style="font-size:20px">${esc(it.text)}</div>` : ""}
    <p>${sp.recOK ? "Recording · stops by itself at 0:00" : "Not recording (no microphone). Speak anyway; the timer still runs."}</p>
    <div class="big-time ${sp.left <= 15 ? "low" : ""}" id="sptime">${fmt(sp.left)}</div><button class="ring ${sp.recOK ? "rec" : ""} press" data-act="spstop">Stop</button></div>`;
  if (sp.phase === "review") {
    const hits = keyHits(sp.dict), last = sp.takes[sp.takes.length - 1], cpm = last && last.dur > 5 ? Math.round(zhCount(sp.dict) / (last.dur / 60)) : 0;
    const mp = sp.kind === "repeat" && sp.dict ? matchPct(it.text, sp.dict) : null;
    const showText = it.text && sp.kind !== "question";
    body = `<div class="review"><section>
      <div class="h">Your takes <span>kept on this iPad</span></div>
      ${sp.takes.map(t => `<div class="take"><button class="pl press" data-act="spplaytake" data-n="${t.n}" ${t.blobId ? "" : "disabled"} aria-label="Play take ${t.n}">▶</button><div><b style="font-size:15px">Take ${t.n}</b><div class="meta">${fmt(t.dur)}${t.blobId ? "" : " · no recording"}</div></div><span class="meta">${new Date(t.at).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}</span></div>`).join("")}
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap"><button class="btn press" data-act="spagain">Try again · take ${sp.takes.length + 1}</button>${sp.takes.filter(t => t.blobId).length > 1 ? `<button class="btn ghost press" data-act="spboth">Play takes back to back</button>` : ""}</div>
      ${showText ? `<div class="h" style="margin-top:28px">Passage <button class="quiet press" data-act="spreveal" style="padding:0">${sp.reveal ? "Hide" : "Show"}</button></div><p class="han ${sp.reveal ? "" : "hidden-text"}" style="font-size:18px;line-height:1.85;margin:0">${esc(it.text)}</p>` : ""}
      ${it.pic ? `<img src="pics/${it.pic}.jpg" alt="" style="margin-top:22px;border-radius:12px;max-width:360px">` : ""}
      ${it.model ? `<details style="margin-top:22px"><summary style="cursor:pointer;font-weight:600">Model answer</summary><p class="model" style="font-size:17px">${esc(it.model)}</p>${it.modelAudio ? `<button class="quiet press" data-act="spmodel" style="padding-left:0">▶ Listen to it</button>` : ""}</details>` : ""}
    </section><section>
      <div class="h">Dictation check <span>tap the keyboard mic, say it again</span></div>
      <textarea class="dict" id="spdict" lang="zh-CN" aria-label="Dictated transcript" placeholder="🎤 Use the Chinese keyboard's mic and say your answer again">${esc(sp.dict)}</textarea>
      <div class="nums">${it.keys ? `<div><b id="spkp">${hits.filter(Boolean).length}/${hits.length}</b><span>key points</span></div>` : ""}<div><b id="spcpm">${cpm}</b><span>characters / min</span></div>${sp.kind === "repeat" ? `<div><b id="spmatch">${mp ? mp.pct + "%" : "–"}</b><span>match</span></div>` : ""}</div>
      ${it.keys ? `<div class="kp" id="spkps" style="margin-top:12px">${it.keys.map(([k], i) => `<div><span class="${hits[i] ? "y" : "n"}">${hits[i] ? "✓" : "–"}</span><span class="han">${esc(k)}</span></div>`).join("")}</div>` : ""}
      ${sp.kind === "repeat" ? `<div class="diff" id="spdiff" style="margin-top:12px">${mp ? mp.html : ""}</div>` : ""}
      <p class="muted small" style="margin-top:12px">If dictation understood you, an examiner will.</p>
      <div class="h" style="margin-top:22px">Self-check</div>
      <div class="selfcheck">${["Finished in time", "No long silences", "Followed the structure", "2+ connectors", "Gave an example / the point"].map((t, i) => `<button data-act="spself" data-i="${i}"><span class="tick ${sp.self[i] ? "on" : ""}">${TICK}</span>${t}</button>`).join("")}</div>
      <button class="btn ghost press" data-act="spnext" style="margin-top:18px">Next ${task[2].toLowerCase()} →</button>
    </section></div>`;
  }
  return topBar("口语", `${sp.idx + 1} of ${items.length}`) + `<main class="page wrap"><div class="wide">${head}${body}</div></main>`;
}
after.speak = () => {
  if (S.sp && S.sp.phase === "prep" && !tickTimer) { S.sp.prepStarted = false; startPrepTimer(); }
  const ta = $("#spdict"); if (!ta) return;
  const upd = () => {
    const sp = S.sp; sp.dict = ta.value; const hits = keyHits(ta.value), last = sp.takes[sp.takes.length - 1];
    if ($("#spkp")) $("#spkp").textContent = hits.filter(Boolean).length + "/" + hits.length;
    if ($("#spcpm")) $("#spcpm").textContent = last && last.dur > 5 ? Math.round(zhCount(ta.value) / (last.dur / 60)) : 0;
    document.querySelectorAll("#spkps div span:first-child").forEach((s, i) => { s.className = hits[i] ? "y" : "n"; s.textContent = hits[i] ? "✓" : "–"; });
    if (sp.kind === "repeat") { const m = matchPct(sp.item.text, ta.value); $("#spmatch").textContent = ta.value ? m.pct + "%" : "–"; $("#spdiff").innerHTML = ta.value ? m.html : ""; }
  };
  ta.addEventListener("input", upd); ta.addEventListener("blur", () => spSave());
};
let takeURLs = [];
async function playTake(n, then) {
  const t = S.sp.takes.find(x => x.n === n); if (!t || !t.blobId) return;
  const row = await DB.get("blobs", t.blobId); if (!row) { toast("Recording not found"); return; }
  const url = URL.createObjectURL(row.blob); takeURLs.push(url);
  player.pause(); player.src = url; player.playbackRate = 1; player.onended = then || null; player.play().catch(() => { });
}

/* ================= reading ================= */
const SPINE = ["#2f5d50", "#6b4f3a", "#4f6b3a", "#3a4f6b", "#5b3a5a", "#55524a", "#3d4a47", "#6b3a3a"];
function books() {
  const graded = C.ordering.items.map((it, i) => ({ id: it.id, title: it.title, author: "HSK " + it.level + " · " + it.genre, shelf: "graded", paras: it.paras.map(p => p.t), color: SPINE[(i + 3) % SPINE.length] }));
  const sanwen = C.reading.books.map((b, i) => ({ ...b, author: b.author + " · " + b.year, color: SPINE[i % SPINE.length] }));
  return { graded, sanwen, all: graded.concat(sanwen) };
}
function spinesHTML(list, cur) { return list.map(b => `<button class="spine press" style="background:${b.color}" data-act="book" data-id="${b.id}" aria-current="${b.id === cur}"><span class="ti">${esc(b.title)}</span><span class="au">${esc(b.author.split(" · ")[0])}</span></button>`).join(""); }
function vRead() {
  if (!C.reading) return topBar("阅读") + `<main class="page wrap col"><p>Loading…</p></main>`;
  const B = books();
  if (!S.book) return topBar("阅读", "Tap a book") + `<main class="page wrap"><div class="wide"><h1>书架</h1>
    <div class="h" style="margin-top:22px">散文 · public domain · above HSK 5</div><div class="spines">${spinesHTML(B.sanwen)}</div>
    <div class="h" style="margin-top:14px">现代文 · graded HSK 4–5 (the 排序 passages, in order)</div><div class="spines">${spinesHTML(B.graded)}</div>
    <p class="muted small">Tap any character in a text to look it up. Dictionary: CC-CEDICT (CC BY-SA 4.0, MDBG). 散文 texts from Wikisource.</p></div></main>`;
  const b = B.all.find(x => x.id === S.book);
  return topBar("阅读", esc(b.title) + " · tap a word") + `<main class="page wrap"><div class="wide"><button class="quiet press" data-act="shelf" style="padding-left:0">← Shelf</button>
    <div class="spines compact">${spinesHTML(b.shelf === "graded" ? B.graded : B.sanwen, b.id)}</div>
    <article class="article"><h1>${esc(b.title)}</h1><div class="by">${esc(b.author)}${b.shelf === "graded" ? "" : " · above HSK 5"}</div>
    ${b.paras.map((p, pi) => `<p>${[...p].map((c, ci) => /[一-鿿]/.test(c) ? `<span class="c" data-p="${pi}" data-i="${ci}">${c}</span>` : esc(c)).join("")}</p>`).join("")}
    <div class="end">— 完 —</div></article></div></main>`;
}
async function lookupAt(pi, ci) {
  try { await loadDict(); } catch (e) { toast("Dictionary not available"); return; }
  const b = books().all.find(x => x.id === S.book), p = b.paras[pi];
  let word = p[ci], entry = DICT[word];
  for (let n = Math.min(6, p.length - ci); n > 1; n--) { const w = p.substr(ci, n); if (DICT[w]) { word = w; entry = DICT[w]; break; } }
  document.querySelectorAll(".article .c.on").forEach(x => x.classList.remove("on"));
  for (let k = 0; k < word.length; k++) { const el = document.querySelector(`.article .c[data-p="${pi}"][data-i="${ci + k}"]`); if (el) el.classList.add("on"); }
  const saved = kv("savedWords", []), lvl = LEVELS && LEVELS[word];
  const pop = $("#pop");
  pop.innerHTML = `<span class="w">${esc(word)}</span>${lvl ? `<span class="p">HSK ${lvl}</span>` : ""}${(entry || ["|no entry"]).map(e => { const [py, m] = e.split("|"); return `<div class="m"><b>${esc(py)}</b> ${esc(m)}</div>`; }).join("")}
    <button class="add press" data-act="saveword" data-w="${esc(word)}">${saved.some(s => s.w === word) ? "Saved to review ✓" : "+ Add to review"}</button>`;
  pop.classList.add("on"); clearTimeout(lookupAt._t); lookupAt._t = setTimeout(() => pop.classList.remove("on"), 6000);
}

/* ================= export / backup ================= */
const b64 = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
function summaryText(list) {
  const lines = [`HSK trainer export · ${new Date().toLocaleString("en")} · ${list.length} attempts`, ""];
  list.filter(a => a.type !== "ordering").forEach((a, i) => {
    lines.push(`[${i + 1}] ${a.type.toUpperCase()} · ${a.task} · ${a.prompt || a.itemId}`);
    if (a.type === "writing") { a.drafts.forEach((d, j) => lines.push(`Draft ${j + 1} (${zhCount(d)} 字): ${d}`)); lines.push("Checker: " + (a.checks || []).join(" | ")); lines.push("Self-check ticked: " + (a.self || []).filter(Boolean).length + "/5"); }
    if (a.type === "speaking") { lines.push(`Takes: ${a.takes.length} (${a.takes.map(t => t.dur + "s").join(", ")})`); if (a.transcript) lines.push("Dictated transcript: " + a.transcript); if (a.keyPoints) lines.push("Key points: " + a.keyPoints); }
    lines.push("");
  });
  const ord = list.filter(a => a.type === "ordering"); if (ord.length) lines.push(`Ordering: ${ord.length} passages, ${ord.reduce((s, a) => s + a.score, 0)}/${ord.reduce((s, a) => s + a.max, 0)} links correct.`);
  lines.push("", "Please mark each writing draft against the HSK 3.0 rubric, list my 3 most common grammar errors, and comment on the speaking transcripts (recordings are in the file).");
  return lines.join("\n");
}
async function buildFile(list, name, withKV) {
  const blobs = [];
  for (const a of list) for (const t of (a.takes || [])) if (t.blobId) { const r = await DB.get("blobs", t.blobId); if (r) blobs.push({ id: r.id, type: r.type, data: await b64(r.blob) }); }
  const payload = { app: "hsk-trainer", version: 1, createdAt: new Date().toISOString(), summary: summaryText(list), attempts: list, recordings: blobs, kv: withKV ? KV : undefined };
  return new File([JSON.stringify(payload)], name, { type: "application/json" });
}
async function shareFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return true; } catch (e) { if (e && e.name === "AbortError") return false; }
  }
  const url = URL.createObjectURL(file), a = document.createElement("a"); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); return true;
}
async function doBackup() {
  toast("Preparing backup…"); await refreshAttempts();
  const f = await buildFile(ATT, `hsk-backup-${dayKey()}.json`, true);
  if (await shareFile(f)) { kvSet("lastBackup", Date.now()); markDone("bk"); toast("Backup ready. Choose “Save to Files”."); render(); }
}
async function doExport() {
  await refreshAttempts(); const list = ATT.filter(a => !a.exported);
  if (!list.length) { toast("Nothing new to export"); return; }
  toast("Preparing export…");
  const f = await buildFile(list, `hsk-export-${dayKey()}.json`, false);
  if (await shareFile(f)) { for (const a of list) { a.exported = true; await DB.put("attempts", a); } await refreshAttempts(); kvSet("lastExport", Date.now()); toast("Export ready. Save it to Files, then send it to Claude when you're online."); render(); }
}
async function doImport(file) {
  try {
    const d = JSON.parse(await file.text()); if (d.app !== "hsk-trainer") throw new Error("not a backup");
    for (const a of d.attempts || []) await DB.put("attempts", a);
    for (const r of d.recordings || []) { const bin = atob(r.data), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); await DB.put("blobs", { id: r.id, type: r.type, blob: new Blob([u], { type: r.type }), size: u.length }); }
    if (d.kv) for (const [k, v] of Object.entries(d.kv)) await kvSet(k, v);
    await refreshAttempts(); toast(`Restored ${(d.attempts || []).length} attempts`); render();
  } catch (e) { toast("That file isn't an HSK Trainer backup"); }
}
function vExport() {
  const list = ATT.filter(a => !a.exported).sort((a, b) => b.at - a.at), byDay = {};
  list.forEach(a => { const k = new Date(a.at).toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short" }); (byDay[k] = byDay[k] || []).push(a); });
  const recs = ATT.reduce((s, a) => s + (a.takes || []).filter(t => t.blobId).length, 0), size = ATT.reduce((s, a) => s + (a.takes || []).reduce((x, t) => x + (t.size || 0), 0), 0);
  const lb = kv("lastBackup", null);
  return topBar("导出") + `<main class="page wrap"><div class="wide">
    <h1>Saved on this iPad</h1><p class="lede">${ATT.length} attempts · ${recs} recordings · ${(size / 1048576).toFixed(1)} MB. Everything stays here until you export, even with no internet.</p>
    <div class="ex-actions"><button class="ex-act press" data-act="backup"><b>Back up to Files</b><span>Works offline. One file with everything, in case Safari clears the app. ${lb ? "Last: " + new Date(lb).toLocaleString("en", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "No backup yet."}</span></button>
     <button class="ex-act primary press" data-act="export" ${list.length ? "" : "disabled"}><b>Export for Claude · ${list.length} new</b><span>Makes the file now (works offline). Send it to Claude when you're back online.</span></button></div>
    ${list.length ? Object.entries(byDay).map(([d, items]) => `<div class="h" style="margin-top:20px">${d}</div>${items.map(a => `<div class="ex-row"><span class="k">${a.type.toUpperCase()}</span><span class="t han">${esc(((a.prompt || a.title || a.itemId) + "").slice(0, 34))}${((a.prompt || a.title || "") + "").length > 34 ? "…" : ""}<span>${a.type === "writing" ? a.drafts.length + " draft(s) · " + zhCount(a.drafts[a.drafts.length - 1]) + " 字" : a.type === "speaking" ? a.takes.length + " take(s)" + (a.keyPoints ? " · " + a.keyPoints + " key points" : "") : a.score + "/" + a.max + " · " + a.task}</span></span><span class="r">${(a.takes || []).reduce((x, t) => x + (t.size || 0), 0) ? ((a.takes.reduce((x, t) => x + (t.size || 0), 0)) / 1048576).toFixed(1) + " MB" : ""}</span></div>`).join("")}`).join("") : `<p class="muted">Nothing waiting. Attempts appear here as soon as you finish them.</p>`}
    <div class="chips" style="margin-top:22px"><button class="chip press" data-act="summary">Show text summary</button><label class="chip press" style="cursor:pointer">Restore from a backup<input type="file" id="importf" accept="application/json,.json" hidden></label></div>
  </div></main>`;
}
after.export = () => { const f = $("#importf"); if (f) f.onchange = () => f.files[0] && doImport(f.files[0]); };

/* ================= setup ================= */
const TONIGHT = ["Download the enhanced Chinese voice (Settings → Accessibility → Spoken Content → Voices) — optional now that clips are recorded", "Add the Chinese (Simplified) Pinyin keyboard; turn on Dictation; Mandarin", "Add this app to the Home Screen and open it from there", "See “Offline ready ✓” at the top", "Open every module once; record one test clip; allow the microphone", "Pleco offline dictionary + Anki HSK 3.0 decks downloaded", "Official HSK 3.0 mock PDFs and audio saved to Files", "Airplane-mode test: open from Home Screen, do one task in each module"];
function vSetup() {
  const t = kv("tonight", {});
  return topBar("设置") + `<main class="page wrap"><div class="col">
    <h1>Setup & status</h1><p class="lede">Check these before you go offline.</p>
    <div class="status" id="status"><div><span>Offline cache</span><span id="st-cache" class="muted">checking…</span></div><div><span>Storage kept by Safari</span><span id="st-persist" class="muted">checking…</span></div><div><span>Storage used</span><span id="st-usage" class="muted">checking…</span></div><div><span>Installed (Home Screen)</span><span class="${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "ok" : "no"}">${matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "yes" : "not yet: Share → Add to Home Screen"}</span></div><div><span>Network</span><span>${navigator.onLine ? "online" : "offline"}</span></div></div>
    <div class="chips" style="margin:14px 0 26px"><button class="chip press" data-act="testmic">Test microphone</button><button class="chip press" data-act="testvoice">Play a voice clip</button><button class="chip press" data-act="persist">Ask Safari to keep data</button></div>
    <div class="h">Before going offline</div>
    <div class="selfcheck">${TONIGHT.map((x, i) => `<button data-act="tonight" data-i="${i}"><span class="tick ${t[i] ? "on" : ""}">${TICK}</span><span>${esc(x)}</span></button>`).join("")}</div>
    <div class="h" style="margin-top:26px">Speech speed</div>
    <div class="chips">${[0.8, 0.9, 1].map(r => `<button class="chip press" aria-pressed="${kv("rate", 0.9) === r}" data-act="rate" data-r="${r}">${r}×</button>`).join("")}</div>
    <p class="muted small" style="margin-top:26px">Timings: HSK 5 speaking uses the official 3.0 sample (retell 1:30; pictures 3:00 + 2:00; opinion 3:30 + 2:30). HSK 4 timings are placeholders until checked. Voice: Fish Audio, generated in advance. Dictionary: CC-CEDICT (CC BY-SA 4.0). HSK 3.0 lists: drkameleon/complete-hsk-vocabulary.</p>
  </div></main>`;
}
after.setup = async () => {
  try { const n = await cachedCount(); $("#st-cache").textContent = n ? n + " files ✓" : "not cached"; $("#st-cache").className = n ? "ok" : "no"; } catch (e) { }
  try { const p = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; $("#st-persist").textContent = p ? "yes ✓" : "not yet"; $("#st-persist").className = p ? "ok" : "no"; } catch (e) { }
  try { const e = await navigator.storage.estimate(); $("#st-usage").textContent = (e.usage / 1048576).toFixed(0) + " MB of " + (e.quota / 1073741824).toFixed(1) + " GB"; } catch (e) { }
};
async function cachedCount() { if (!window.caches) return 0; const keys = await caches.keys(); let n = 0; for (const k of keys) { if (!k.startsWith("hsk-")) continue; n += (await (await caches.open(k)).keys()).length; } return n; }

/* ================= menu ================= */
function menuSheet() {
  openSheet(`<h2>Go to</h2><div class="list" style="margin-top:6px">${SCREENS.map(([k, z, e]) => `<button data-go="${k}"><span><span class="han" style="font-size:18px">${z}</span> <span class="muted">${e}</span></span><span class="min">${k === route() ? "here" : ""}</span></button>`).join("")}</div>`);
}

/* ================= events ================= */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act],[data-go],.article .c,#scrim"); if (!el) return;
  if (el.id === "scrim") { closeSheet(); return; }
  if (el.matches(".article .c")) { lookupAt(+el.dataset.p, +el.dataset.i); return; }
  const d = el.dataset;
  if (d.go) { if (d.mode) { kvSet("orderMode", d.mode); newOrder(d.mode); } closeSheet(); go(d.go); return; }
  switch (d.act) {
    case "menu": menuSheet(); break;
    case "closesheet": closeSheet(); break;
    case "tick": markDone(d.id, !today()[d.id]); render(); break;
    case "backup": closeSheet(); doBackup(); break;
    case "export": doExport(); break;
    case "summary": await refreshAttempts(); { const txt = summaryText(ATT.filter(a => !a.exported)); openSheet(`<h2>Text summary</h2><p class="muted">Paste this into Claude along with the file.</p><pre class="sum" id="sumtxt">${esc(txt)}</pre><button class="btn press" data-act="copysum">Copy</button>`); } break;
    case "copysum": try { await navigator.clipboard.writeText($("#sumtxt").textContent); toast("Copied"); } catch (er) { const r = document.createRange(); r.selectNodeContents($("#sumtxt")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selected. Tap Copy."); } break;
    /* ordering */
    case "omode": kvSet("orderMode", d.mode); stopTick(); newOrder(d.mode); render(); break;
    case "olevel": kvSet("orderLevel", d.level); stopTick(); newOrder(); render(); break;
    case "opara": { const o = S.order; if (o.checked) break; const i = o.slots.indexOf(d.l); if (i >= 0) o.slots[i] = null; else { const j = o.slots.indexOf(null); if (j >= 0) o.slots[j] = d.l; } render(); break; }
    case "oslot": { const o = S.order; if (!o.checked) { o.slots[+d.i] = null; render(); } break; }
    case "ocheck": checkOrder(); break;
    case "opick": { const o = S.order; if (o.checked) break; o.pick = +d.pi; o.checked = true; const target = o.mode === "first" ? 0 : o.given + 1; const ok = o.pick === target; logClues([{ type: o.item.paras[target].type, ok }]); finishOrderItem(ok ? 1 : 0, 1); render(); toast(ok ? "正确！" : "Not quite. The right one is highlighted."); break; }
    case "onext": closeSheet(); stopTick(); newOrder(); render(); window.scrollTo(0, 0); break;
    case "oread": S.book = S.order.item.id; go("read"); break;
    /* writing */
    case "wtask": kvSet("wTask", d.task); stopTick(); newWrite(d.task); render(); break;
    case "wnext": { closeSheet(); stopTick(); const items = wItems(S.w.task); newWrite(S.w.task, (S.w.idx + 1) % items.length); render(); window.scrollTo(0, 0); break; }
    case "wtimer": if (S.w.left != null) { S.w.left = null; stopTick(); } else S.w.left = C.writing.tasks[S.w.task].minutes * 60; render(); break;
    case "wcheck": writeCheck(); break;
    case "wself": { const i = +d.i; S.w.self[i] = !S.w.self[i]; el.querySelector(".tick").classList.toggle("on", S.w.self[i]); const a = await DB.get("attempts", S.w.attemptId); if (a) { a.self = S.w.self; DB.put("attempts", a); } break; }
    case "wagain": closeSheet(); S.w.draft1 = S.w.text; S.w.text = ""; render(); window.scrollTo(0, 0); break;
    /* speaking */
    case "sptask": openSheet(`<h2>Speaking task</h2><p class="muted" style="margin:0 0 6px">HSK 5 timings come from the official 3.0 sample. HSK 4 timings still need checking.</p><div class="list">${SP_TASKS.map(([k, a, b]) => `<button data-act="spset" data-task="${k}"><span><b>${a}</b> · ${b}</span><span class="min">${SP_TIME[k][0] ? "prep " + fmt(SP_TIME[k][0]) + " · " : ""}answer ${fmt(SP_TIME[k][1])}</span></button>`).join("")}</div>`); break;
    case "spset": kvSet("spTask", d.task); closeSheet(); stopTick(); await stopRecording(true); player.pause(); newSpeak(d.task); render(); break;
    case "spplay": el.textContent = "Playing…"; playSrc(S.sp.item.audio, () => { if (S.sp.phase === "listen") spBeginAnswer(); }); markDone("sh"); break;
    case "spq": playSrc(S.sp.item.audio); break;
    case "spanswer": spBeginAnswer(); break;
    case "spstop": spFinish(); break;
    case "spagain": { const sp = S.sp; player.pause(); if (sp.kind === "repeat" || sp.kind === "retell") { sp.phase = "listen"; render(); } else spBeginPrep(); break; }
    case "spreveal": S.sp.reveal = !S.sp.reveal; render(); break;
    case "spmodel": playSrc(S.sp.item.modelAudio); break;
    case "spplaytake": playTake(+d.n); break;
    case "spboth": { const ts = S.sp.takes.filter(t => t.blobId).slice(-2); playTake(ts[0].n, () => playTake(ts[1].n)); break; }
    case "spself": { const i = +d.i; S.sp.self[i] = !S.sp.self[i]; el.querySelector(".tick").classList.toggle("on", S.sp.self[i]); spSave(); break; }
    case "spnext": { stopTick(); player.pause(); const items = spItems(S.sp.task); newSpeak(S.sp.task, (S.sp.idx + 1) % items.length); render(); window.scrollTo(0, 0); break; }
    case "rate": kvSet("rate", +d.r); player.playbackRate = +d.r; render(); break;
    /* reading */
    case "book": S.book = d.id; markDone("rd"); render(); window.scrollTo(0, 0); break;
    case "shelf": S.book = null; $("#pop").classList.remove("on"); render(); break;
    case "saveword": { const s = kv("savedWords", []); if (!s.some(x => x.w === d.w)) { s.push({ w: d.w, at: Date.now(), from: S.book }); kvSet("savedWords", s); } el.textContent = "Saved to review ✓"; break; }
    /* setup */
    case "tonight": { const t = kv("tonight", {}); t[d.i] = !t[d.i]; kvSet("tonight", t); el.querySelector(".tick").classList.toggle("on", t[d.i]); break; }
    case "testmic": { const ok = await startRecording(); if (ok) { toast("Recording 3 seconds…"); setTimeout(async () => { const r = await stopRecording(false); if (r && r.blob.size) { const u = URL.createObjectURL(r.blob); player.src = u; player.playbackRate = 1; player.play().catch(() => { }); toast("Playing back your test clip"); } else toast("Got no audio. Check the microphone permission."); }, 3000); } break; }
    case "testvoice": playSrc("audio/h5p1-01.mp3"); break;
    case "persist": try { const p = await navigator.storage.persist(); toast(p ? "Safari will keep your data" : "Safari said no. Add to Home Screen, then try again."); render(); } catch (er) { toast("Not supported here"); } break;
  }
});
$("#scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

/* ================= boot ================= */
(async function boot() {
  try {
    await DB.open(); await kvLoad();
    if (!kv("tripStart")) kvSet("tripStart", dayKey());
    const [speaking, ordering, writing, reading, picsets] = await Promise.all(["speaking", "ordering", "writing", "reading", "picsets"].map(n => loadJSON("content/" + n + ".json")));
    Object.assign(C, { speaking, ordering, writing, reading, picsets });
    loadJSON("content/levels.json").then(l => { LEVELS = l; }).catch(() => { });
    await refreshAttempts();
    render();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  } catch (e) {
    $("#app").innerHTML = `<div class="wrap col" style="padding-top:80px"><h1>Couldn't start</h1><p class="muted">${esc(e.message)}</p><p>If you're offline, open the app once with internet so it can save itself to this iPad.</p></div>`;
  }
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
      navigator.serviceWorker.addEventListener("message", ev => { if (ev.data && ev.data.type === "cached") { CACHED = ev.data.count; render(); } });
      CACHED = await cachedCount(); if (route() !== "speak" || !S.sp || S.sp.phase !== "answer") render();
    } catch (e) { CACHED = 0; }
  }
})();
