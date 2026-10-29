'use strict';

/* =========================================================
   Storage
   ========================================================= */
const STORE_KEY = 'goalie.v1';

// The App Store app (Capacitor) rather than the web app: no install tips or self-updates, and
// reminders use real iPhone notifications.
const isNativeApp = !!window.Capacitor?.isNativePlatform?.();

// 5 color families × 5 shades, light → dark. Shown as a 5×5 grid in the goal form.
const PALETTE = [
  { name: 'Sky', shades: ['#a9d6f5', '#6ec1f0', '#4aa8e2', '#2b7fc4', '#1d4e89'] },
  { name: 'Mint', shades: ['#b5e8c9', '#7ed6a5', '#3fbf7f', '#1c7f4f', '#11573a'] },
  { name: 'Sunset', shades: ['#ffe38a', '#ffc94d', '#ffa62b', '#f07f1a', '#c85a12'] },
  { name: 'Rose', shades: ['#ffb3c1', '#ff7a93', '#f2506e', '#d63150', '#9e1f3a'] },
  { name: 'Grape', shades: ['#d9c2f5', '#b794ec', '#9466db', '#7445bd', '#4e2c8a'] },
  { name: 'Mono', shades: ['#ffffff', '#c9ccd1', '#8a9099', '#4b5563', '#111827'] },
];
const COLORS = PALETTE.flatMap(p => p.shades);
const DEFAULT_COLOR = '#4aa8e2';

function luminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
const NAVY_L = luminance('#1c2a4a');

// Background + text color for a goal card or stat card. Custom text color overrides the automatic one.
function cardColorClass(t) {
  const pale = /^#?[0-9a-f]{6}$/i.test(t.color || '') && luminance(t.color) > 0.85;
  return `${inkClass(t.color)}${pale ? ' is-pale' : ''}`;
}
function cardColorStyle(t, kind = 'card') {
  let s = `background:${t.color}`;
  const tc = t.textColor;
  if (tc) {
    const soft = `color-mix(in srgb, ${tc} 72%, transparent)`;
    s += kind === 'card'
      ? `;--card-ink:${tc};--card-name:${tc};--card-soft:${soft}`
      : `;--stat-ink:${tc};--stat-soft:${soft}`;
  }
  return s;
}

// Card text is navy or white, whichever has more contrast against the card's color.
function inkClass(hex) {
  if (!/^#?[0-9a-f]{6}$/i.test(hex || '')) return '';
  const L = luminance(hex);
  const navyContrast = (L + 0.05) / (NAVY_L + 0.05);
  const whiteContrast = 1.05 / (L + 0.05);
  return navyContrast >= whiteContrast ? 'on-light' : 'on-dark';
}

// Idea chips. Personal-growth goals first; each fills in a sensible starting setup.
const SUGGESTIONS = [
  { name: 'Running', unit: 'custom', customUnit: 'miles' },
  { name: 'Meet someone new' },
  { name: 'Reading', unit: 'custom', customUnit: 'pages' },
  { name: 'Healthy eating', unit: 'custom', customUnit: 'healthy meals' },
  { name: 'Saving money', unit: 'dollars' },
  { name: 'Smoking', direction: 'decrease' },
  { name: 'Phone use', unit: 'minutes', direction: 'decrease' },
  { name: 'Workout', unit: 'minutes' },
  { name: 'Meditate', unit: 'minutes' },
  { name: 'Journal' },
  { name: 'Drink water', unit: 'custom', customUnit: 'glasses' },
  { name: 'Learn something new' },
  { name: 'Call a friend or family member' },
  { name: 'Practice gratitude' },
  { name: 'Walk', unit: 'custom', customUnit: 'steps' },
  { name: 'Stretch', unit: 'minutes' },
  { name: 'Volunteer', unit: 'hours' },
  { name: 'Practice a skill', unit: 'minutes' },
  { name: 'Vaping', direction: 'decrease' },
  { name: 'Junk food', direction: 'decrease' },
];

const DEFAULT_STATE = () => ({
  tallies: [],
  entries: [],
  trash: [], // recently deleted goals: { id, tally, entries, index, deletedAt }
  todos: [], // { id, title, section, priority (bool), quadrant (1-4), done, createdAt, doneAt }
  todoSections: [], // section names, in order
  todoTrash: [], // completed or deleted to-dos: { id, todo, reason ('completed' | 'deleted'), deletedAt }
  settings: { layout: 'grid', weekStart: 0, reminderFired: {}, theme: 'auto', customDateMode: 'add' },
});

const TRASH_DAYS = 30;

/* Storage: every save goes to localStorage (small, ~5 MB, read instantly at start) and to IndexedDB
   (much larger). At start the newer of the two wins, so data keeps saving after localStorage fills. */
const storage = { synced: false, idbWorks: false, damagedKey: null, saves: 0 };
let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open('goalie', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}
function idbRun(mode, fn) {
  return idb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}
const idbGet = key => idbRun('readonly', s => s.get(key));
const idbSet = (key, value) => idbRun('readwrite', s => s.put(value, key));

// Saved data that couldn't be read is kept (localStorage + IndexedDB) and offered in Settings.
function keepDamagedCopy(raw) {
  const key = `${STORE_KEY}.damaged-${Date.now()}`;
  storage.damagedKey = key;
  try { localStorage.setItem(key, raw); } catch (e) { /* full: the IndexedDB copy below still works */ }
  idbSet(key, raw).catch(() => {});
}

let state = load();
migrate();

// A goal can be in several groups (t.groups). Older data had a single t.group.
function groupsOf(t) { return Array.isArray(t.groups) ? t.groups : (t.group ? [t.group] : []); }
function setGroups(t, list) {
  t.groups = [...new Set(list.map(g => String(g).trim()).filter(Boolean))];
  t.group = t.groups[0] || ''; // kept for older backups
}

// Bring older saved data up to date, and clear out Recently Deleted items past 30 days.
function migrate() {
  state.tallies.forEach(t => { if (!Array.isArray(t.groups)) setGroups(t, groupsOf(t)); });

  // One-time: cards used to default to showing "last time"; show the measurement instead.
  if (!state.settings.unitLabelMigrated) {
    state.tallies.forEach(t => { if (t.bottomMode === 'last') t.bottomMode = 'unit'; });
    state.settings.unitLabelMigrated = true;
    save();
  }

  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  const kept = state.trash.filter(item => item.deletedAt >= cutoff);
  if (kept.length !== state.trash.length) { state.trash = kept; save(); }
  // To-dos checked off before they moved to Recently Deleted on completion.
  const finished = state.todos.filter(t => t.done);
  if (finished.length) {
    state.todos = state.todos.filter(t => !t.done);
    for (const t of finished) state.todoTrash.unshift({ id: 'tt' + t.id, todo: { ...t, done: false, doneAt: null }, reason: 'completed', deletedAt: t.doneAt || Date.now() });
  }
  const keptTodos = state.todoTrash.filter(item => item.deletedAt >= cutoff);
  if (finished.length || keptTodos.length !== state.todoTrash.length) { state.todoTrash = keptTodos; save(); }
}

// Fill in anything missing from saved (or imported) data.
function normalizeState(data) {
  const base = DEFAULT_STATE();
  return {
    tallies: Array.isArray(data.tallies) ? data.tallies : [],
    entries: Array.isArray(data.entries) ? data.entries : [],
    trash: Array.isArray(data.trash) ? data.trash : [],
    todos: Array.isArray(data.todos) ? data.todos : [],
    todoSections: Array.isArray(data.todoSections) ? data.todoSections : [],
    todoTrash: Array.isArray(data.todoTrash) ? data.todoTrash : [],
    settings: { ...base.settings, ...(data.settings || {}) },
    savedAt: data.savedAt || 0,
  };
}

// Quick start from localStorage; the bigger IndexedDB copy is checked right after (see syncStorage).
function load() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return DEFAULT_STATE(); }
  if (!raw) return DEFAULT_STATE();
  try {
    return normalizeState(JSON.parse(raw));
  } catch (e) {
    // Unreadable: keep a copy instead of letting the next save overwrite it.
    keepDamagedCopy(raw);
    return DEFAULT_STATE();
  }
}

function save() {
  storage.saves++;
  // Only stamp the time once the IndexedDB copy has been checked; saves before that (start-up
  // tidying) must not make a blank or older state look newer than the copy there.
  if (storage.synced) state.savedAt = Date.now();
  const json = JSON.stringify(state);
  if (storage.synced) idbSet('state', json).catch(() => {});
  try {
    localStorage.setItem(STORE_KEY, json);
  } catch (e) {
    // Full: fine while the IndexedDB copy is working (it holds far more); otherwise warn.
    if (!storage.idbWorks) toast('Could not save — storage full or blocked');
  }
  window.goalieCloud?.changed(); // signed in: back up and sync (account.js)
  window.goalieReminders?.(); // App Store app: keep iPhone reminders in step with the goals
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* =========================================================
   Date helpers
   ========================================================= */
const DAY_MS = 86400000;
const DAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) {
  const x = startOfDay(d);
  const diff = (x.getDay() - state.settings.weekStart + 7) % 7;
  return addDays(x, -diff);
}
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
function dayKey(d) { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; }

function periodStart(reset, now = new Date()) {
  switch (reset) {
    case 'minute': { const m = new Date(now); m.setSeconds(0, 0); return m; }
    case 'hour': { const h = new Date(now); h.setMinutes(0, 0, 0); return h; }
    case 'day': return startOfDay(now);
    case 'week': return startOfWeek(now);
    case 'month': return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'year': return new Date(now.getFullYear(), 0, 1);
    default: return new Date(0);
  }
}

const PERIOD_LABEL = { minute: 'THIS MINUTE', hour: 'THIS HOUR', day: 'TODAY', week: 'THIS WEEK', month: 'THIS MONTH', year: 'THIS YEAR', never: 'ALL TIME' };

function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  const today = startOfDay(new Date()).getTime();
  if (ts >= today) return `${Math.floor(diff / 3600000)}h ago`;
  if (ts >= today - DAY_MS) return 'Yesterday';
  const days = Math.ceil((today - ts) / DAY_MS);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function fmt(n) {
  return String(Math.round(n * 100) / 100);
}

/* =========================================================
   Tally queries
   ========================================================= */
// Entries grouped by goal, rebuilt only when the data changes (every change goes through save()).
let entryIndex = null;
function entriesFor(id) {
  const all = state.entries;
  if (!entryIndex || entryIndex.src !== all || entryIndex.len !== all.length || entryIndex.at !== storage.saves) {
    const map = new Map();
    for (const e of all) { let list = map.get(e.tallyId); if (!list) map.set(e.tallyId, list = []); list.push(e); }
    entryIndex = { src: all, len: all.length, at: storage.saves, map };
  }
  return (entryIndex.map.get(id) || []).slice();
}

// Whether a log at this time counts toward the goal: it must be on one of the goal's measured
// weekdays, and (by-date goals) between the start of the current run and the end of the date.
function countsToward(t, ts) {
  const days = measuredWeekdays(t);
  if (days.length < 7 && !days.includes(new Date(ts).getDay())) return false;
  if (byDate(t)) return ts >= (t.countFrom || 0) && ts < dueEndMs(t);
  return true;
}
function countedEntries(t) { return entriesFor(t.id).filter(e => countsToward(t, e.ts)); }

/* The day shown on the home page: today (null), or an earlier day picked with the arrows.
   Cards then show the goal's period around that day, as it stood at the end of that day, and
   logging adds entries to that day. */
let homeDay = null;
const homeRef = () => (homeDay ? new Date(homeDay.getTime() + 12 * 3600000) : new Date()); // noon on a past day
const homeEnd = () => (homeDay ? addDays(homeDay, 1).getTime() : Infinity);
const logTime = () => (homeDay ? homeRef().getTime() : Date.now());

function nextPeriodStart(reset, from) {
  switch (reset) {
    case 'minute': return new Date(from.getTime() + 60000);
    case 'hour': return new Date(from.getTime() + 3600000);
    case 'day': return addDays(from, 1);
    case 'week': return addDays(from, 7);
    case 'month': return new Date(from.getFullYear(), from.getMonth() + 1, 1);
    case 'year': return new Date(from.getFullYear() + 1, 0, 1);
    default: return new Date(8.64e15);
  }
}
// [from, to) of the goal's current period on the home page (minute/hour goals show the whole day
// when looking back).
function viewPeriod(t) {
  const reset = homeDay && (t.reset === 'minute' || t.reset === 'hour') ? 'day' : t.reset;
  const from = periodStart(reset, homeRef());
  return [from.getTime(), Math.min(nextPeriodStart(reset, from).getTime(), homeEnd())];
}

function currentCount(t) {
  const [from, to] = viewPeriod(t);
  return countedEntries(t).reduce((s, e) => (e.ts >= from && e.ts < to ? s + e.value : s), 0);
}

// Card label for the period shown: THIS WEEK today, or WEEK OF OCT 12 when looking back.
function periodLabel(t) {
  if (!homeDay) return PERIOD_LABEL[t.reset] || 'TODAY';
  const d = homeRef(), from = periodStart(t.reset === 'minute' || t.reset === 'hour' ? 'day' : t.reset, d);
  switch (t.reset) {
    case 'week': return `WEEK OF ${MONTH_SHORT[from.getMonth()].toUpperCase()} ${from.getDate()}`;
    case 'month': return MONTH_LONG[d.getMonth()].toUpperCase();
    case 'year': return String(d.getFullYear());
    case 'never': return 'ALL TIME';
    default: return `${DAY_NAMES[d.getDay()].toUpperCase()}, ${MONTH_SHORT[d.getMonth()].toUpperCase()} ${d.getDate()}`;
  }
}

// Today isn't one of the goal's measured weekdays.
const offDay = t => !measuredWeekdays(t).includes(homeRef().getDay());

// By-date goals: the date has passed (the goal is locked with its result).
const dueEndMs = t => addDays(fromYmd(t.dueDate), 1).getTime();
const goalEnded = t => byDate(t) && Math.min(Date.now(), homeEnd()) >= dueEndMs(t);

function lastEntry(id) {
  let last = null;
  for (const e of state.entries) if (e.tallyId === id && (!last || e.ts > last.ts)) last = e;
  return last;
}

function hasActivityToday(id) {
  const from = startOfDay(new Date()).getTime();
  return state.entries.some(e => e.tallyId === id && e.ts >= from);
}

// ts: when it happened (now by default; the custom amount sheet can pick an earlier day).
// replaceDay: remove what was already logged that day first (Settings → When logging custom dates).
function logEntry(t, value, ts = logTime(), replaceDay = false) {
  if (isCheck(t)) {
    // One check-off per period, for past days as well as today.
    const period = periodStart(t.reset, new Date(ts)).getTime();
    const already = countedEntries(t).some(e => periodStart(t.reset, new Date(e.ts)).getTime() === period);
    if (already && !replaceDay) { toast(ts >= periodStart(t.reset).getTime() ? `${t.name} is already checked off` : `${t.name} was already checked off then`); return; }
    value = 1;
  }
  entryChange(t.id, () => {
    if (replaceDay) {
      const from = startOfDay(new Date(ts)).getTime(), to = addDays(startOfDay(new Date(ts)), 1).getTime();
      state.entries = state.entries.filter(e => e.tallyId !== t.id || e.ts < from || e.ts >= to);
    }
    state.entries.push({ id: uid(), tallyId: t.id, ts, value: Number(value) });
  });
  save();
  renderToday(t.id);
  toast(isCheck(t) ? `${t.name} ✓` : `${t.name} ${value >= 0 ? '+' : '−'}${num(t, Math.abs(value))}`, () => entryUndo(t.id));
}

// Undo / redo per goal (the arrows beside the goal name when you hold a card): each change to a
// goal's entries saves a copy of that goal's entries first.
const entryHistory = {};
const historyOf = id => (entryHistory[id] ??= { back: [], forward: [] });
const goalEntriesCopy = id => JSON.stringify(state.entries.filter(e => e.tallyId === id));
function entryChange(id, fn) {
  const h = historyOf(id);
  h.back.push(goalEntriesCopy(id));
  if (h.back.length > 100) h.back.shift();
  h.forward = [];
  fn();
}
function putGoalEntries(id, json) {
  state.entries = state.entries.filter(e => e.tallyId !== id).concat(JSON.parse(json));
  save(); refreshAll();
}
function entryUndo(id) {
  const h = historyOf(id);
  if (!h.back.length) return false;
  h.forward.push(goalEntriesCopy(id));
  putGoalEntries(id, h.back.pop());
  return true;
}
// After Import, Delete all data or edit-mode CANCEL the old undo steps no longer match the data.
function clearUndoHistory({ todos = true } = {}) {
  for (const id of Object.keys(entryHistory)) delete entryHistory[id];
  if (todos) { todoHistory.back = []; todoHistory.forward = []; }
}
function entryRedo(id) {
  const h = historyOf(id);
  if (!h.forward.length) return false;
  h.back.push(goalEntriesCopy(id));
  putGoalEntries(id, h.forward.pop());
  return true;
}

/* =========================================================
   DOM helpers
   ========================================================= */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

/* =========================================================
   Screens
   ========================================================= */
function openScreen(id) { $(`#screen-${id}`).classList.add('active'); }
function closeScreen(id) { $(`#screen-${id}`).classList.remove('active'); }

$$('[data-close]').forEach(btn => btn.addEventListener('click', () => {
  btn.closest('.screen').classList.remove('active');
}));

/* =========================================================
   Today screen
   ========================================================= */
let editMode = false;

// Snapshot taken when edit mode starts, so CANCEL can undo everything done since.
let editSnapshot = null;
const EDIT_SETTINGS = ['groupFilter', 'collapsedGroups', 'filter', 'groupOrder'];

function setEditMode(on) {
  const wasEditing = editMode;
  editMode = on && state.tallies.length > 0;
  if (editMode && homeDay) { homeDay = null; toast('Back to today to rearrange'); } // cards are rearranged on today
  if (editMode && !wasEditing) {
    editSnapshot = JSON.parse(JSON.stringify({
      tallies: state.tallies, entries: state.entries, trash: state.trash,
      settings: Object.fromEntries(EDIT_SETTINGS.map(k => [k, state.settings[k]])),
    }));
  }
  if (!editMode) editSnapshot = null; // DONE (or leaving the screen) keeps the changes
  const btn = $('#btn-edit');
  btn.classList.toggle('on', editMode);
  btn.setAttribute('aria-pressed', String(editMode));
  btn.setAttribute('aria-label', editMode ? 'Done editing' : 'Edit goals');
  renderToday();
}

// Rebuilding the cards empties the list for a moment, which would snap it back to the top;
// keep the scroll position so logging an entry leaves the page where it was.
function renderToday(bumpId) {
  if (dragActive) return; // the drop re-renders
  const list = $('#tally-list'), top = list.scrollTop, pageTop = window.scrollY;
  drawToday(bumpId);
  list.scrollTop = top;
  if (window.scrollY !== pageTop) window.scrollTo(0, pageTop);
}

// The date bar under the title: ‹ day › (tap the day to jump to a date), TODAY when looking back.
function renderDayBar() {
  const d = homeRef();
  $('#day-label').textContent = `${homeDay ? '' : 'Today · '}${DAY_FULL[d.getDay()]}, ${MONTH_LONG[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? ', ' + d.getFullYear() : ''}`;
  $('#day-next').disabled = !homeDay;
  $('#day-today').classList.toggle('hidden', !homeDay);
  $('.day-bar').classList.toggle('past', !!homeDay);
}
function setHomeDay(day) {
  const today = startOfDay(new Date());
  homeDay = !day || startOfDay(day) >= today ? null : startOfDay(day);
  renderToday();
}
$('#day-prev').addEventListener('click', () => setHomeDay(addDays(homeDay || startOfDay(new Date()), -1)));
$('#day-next').addEventListener('click', () => homeDay && setHomeDay(addDays(homeDay, 1)));
$('#day-today').addEventListener('click', () => setHomeDay(null));
$('#day-label').addEventListener('click', () => {
  const now = new Date();
  const wheels = dateWheels(homeRef(), { minYear: now.getFullYear() - 5, maxYear: now.getFullYear() });
  openSheet(
    el('h3', {}, 'Go to a day'),
    el('p', {}, 'See and log any earlier day. Cards show each goal as it stood at the end of that day.'),
    wheels.node,
    el('button', { class: 'sheet-btn primary', onclick: () => { closeSheet(); setHomeDay(wheels.get()); } }, 'Go'),
    el('button', { class: 'sheet-btn', onclick: () => { closeSheet(); setHomeDay(null); } }, 'Today'),
  );
});
// Coming back to Goalie after a while starts on today again.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (homeDay && Date.now() - hiddenAt > 10 * 60000) setHomeDay(null);
});

function drawToday(bumpId) {
  renderDayBar();
  document.querySelectorAll('.drag-ghost').forEach(g => g.remove());
  const list = $('#tally-list');
  if (editMode && !state.tallies.length) editMode = false;
  list.classList.toggle('list', state.settings.layout === 'list');
  const layoutBtn = $('#btn-layout');
  layoutBtn.classList.toggle('is-list', state.settings.layout === 'list');
  layoutBtn.setAttribute('aria-label', state.settings.layout === 'list' ? 'Switch to square cards' : 'Switch to list view');
  list.classList.toggle('editing', editMode);
  $('#btn-edit').classList.toggle('on', editMode);
  $('#btn-edit-cancel').classList.toggle('hidden', !editMode);
  $('.today-header').classList.toggle('editing', editMode);
  if (!editMode) editSnapshot = null;
  list.innerHTML = '';

  const filter = state.settings.filter || 'all';
  $$('#goal-filter button').forEach(b => {
    const on = b.dataset.v === filter;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });

  if (!state.tallies.length) {
    renderGroupChips([], ''); // no goals left: hide the old group chips
    list.append(el('div', { class: 'empty' },
      el('strong', {}, 'No goals yet'),
      'Tap + below to set your first goal.'));
    return;
  }

  // Group chips: All · each group · No group
  const groupNames = allGroupNames();
  let groupFilter = state.settings.groupFilter || '';
  if (groupFilter && groupFilter !== NO_GROUP && !groupNames.includes(groupFilter)) groupFilter = state.settings.groupFilter = '';
  renderGroupChips(groupNames, groupFilter);

  const visible = state.tallies.filter(t => matchesFilter(t, filter) && matchesGroup(t, groupFilter));
  if (!visible.length) {
    const where = groupFilter === NO_GROUP ? ' without a group' : groupFilter ? ` in ${groupFilter}` : '';
    list.append(el('div', { class: 'empty' },
      el('strong', {}, filter === 'all' ? `No goals${where}` : `No ${FILTER_NAMES[filter]} goals${where}`),
      filter === 'all' ? 'Add one with + or pick a different group.'
        : filter === 'date' ? 'Goals with a custom end date (PER → BY CUSTOM DATE) show up here.'
        : `Goals that reset every ${filter} show up here.`));
    return;
  }

  // Groups in order of first appearance; goals without a group come last.
  const groups = new Map();
  for (const t of visible) {
    // A goal in several groups shows under each one (or only the selected group when filtering).
    const gs = groupFilter && groupFilter !== NO_GROUP ? [groupFilter] : (groupsOf(t).length ? groupsOf(t) : ['']);
    for (const g of gs) {
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
  }
  // Put the sections in the group order (set by dragging the chips in edit mode); no group last.
  const ordered = new Map();
  for (const g of [...groupNames, '']) if (groups.has(g)) ordered.set(g, groups.get(g));
  for (const [g, list] of groups) if (!ordered.has(g)) ordered.set(g, list);
  groups.clear(); for (const [g, list] of ordered) groups.set(g, list);

  // Section headings when there are groups and the chips aren't already narrowing to one
  // (always in edit mode, so a group's delete button is reachable).
  const showHeadings = groupNames.length > 0 && (!groupFilter || editMode);
  const collapsed = new Set(state.settings.collapsedGroups || []);
  for (const [name, tallies] of groups) {
    const key = name || NO_GROUP;
    const isCollapsed = showHeadings && collapsed.has(key);
    if (showHeadings) {
      list.append(el('div', { class: `group-title${isCollapsed ? ' collapsed' : ''}` },
        editMode && name ? el('button', {
          type: 'button',
          class: 'group-delete',
          'aria-label': `Remove group ${name}`,
          onclick: () => deleteGroup(name),
        }, '×') : null,
        el('button', {
          type: 'button',
          class: 'group-toggle',
          'aria-expanded': String(!isCollapsed),
          onclick: () => toggleGroup(key),
        },
        el('span', { class: 'group-name' }, name ? name.toUpperCase() : 'NO GROUP'),
        el('span', { class: 'group-count' }, String(tallies.length)),
        el('span', { class: 'group-chev', 'aria-hidden': 'true' }, '›')),
        name && !editMode ? visionButton(name) : null));
    }
    const grid = el('div', { class: `grid${isCollapsed ? ' collapsed' : ''}`, 'data-group': name });
    tallies.forEach(t => grid.append(tallyCard(t, t.id === bumpId)));
    list.append(grid);
  }
}

const NO_GROUP = '__none__';

/* ---------- Group vision: why the goals in a group matter ---------- */
const visionOf = g => ((state.settings.groupVisions || {})[g] || '').trim();
const VISION_PROMPT = 'Questions to think about:\n• What will these goals help you accomplish in the long run?\n• Why did you set them?\n• Who do they help you become?';
function eyeIcon() {
  const span = el('span', { class: 'eye', 'aria-hidden': 'true' });
  span.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  return span;
}
function visionButton(group) {
  return el('button', { type: 'button', class: `vision-btn${visionOf(group) ? ' has' : ''}`, 'aria-label': `${group} vision`, onclick: () => visionSheet(group) }, eyeIcon());
}
function visionSheet(group) {
  const area = el('textarea', { class: 'text-area vision-input', rows: 6, placeholder: VISION_PROMPT });
  area.value = visionOf(group);
  autoList(area);
  growWithText(area);
  const saveVision = () => {
    const v = (state.settings.groupVisions ||= {});
    if (area.value.trim()) v[group] = area.value.trim(); else delete v[group];
    save(); renderToday(); closeSheet();
    toast(area.value.trim() ? 'Vision saved' : 'Vision cleared');
  };
  openSheet(
    el('div', { class: 'vision-head' }, eyeIcon(), el('h3', {}, `${group} vision`)),
    el('p', {}, 'Why do the goals in this group matter to you? Come back here whenever you need the reminder.'),
    area,
    el('button', { class: 'sheet-btn primary', onclick: saveVision }, 'Save vision'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
  fitTextArea(area);
  area.addEventListener('focus', () => $('#sheet').classList.add('full')); // writing: use the whole screen
  // Swiped away or tapped outside: keep what was written (only Cancel throws it away).
  onSheetDismiss = () => { if (area.value.trim() !== visionOf(group)) saveVision(); };
}

// Every group name, in the user's chosen order (new groups go at the end in order of first appearance).
function allGroupNames() {
  const names = [...new Set(state.tallies.flatMap(groupsOf))];
  const order = state.settings.groupOrder || [];
  const rank = new Map(names.map((g, i) => [g, order.includes(g) ? order.indexOf(g) : order.length + i]));
  return names.sort((a, b) => rank.get(a) - rank.get(b));
}

// Edit mode: drag a group chip left or right to reorder the groups (their cards move with them).
let chipDragAt = 0;
function attachChipDrag(chip, box) {
  chip.addEventListener('pointerdown', e => {
    if (!editMode) return;
    const startX = e.clientX;
    let moved = false;
    chip.setPointerCapture(e.pointerId);
    const move = ev => {
      if (!moved && Math.abs(ev.clientX - startX) < 6) return;
      moved = true;
      chip.classList.add('dragging');
      const target = [...box.querySelectorAll('.group-chip[data-group]')].find(c => {
        if (c === chip) return false;
        const r = c.getBoundingClientRect();
        return ev.clientX > r.left && ev.clientX < r.right;
      });
      if (target) {
        const r = target.getBoundingClientRect();
        if (ev.clientX < r.left + r.width / 2) target.before(chip); else target.after(chip);
      }
      const br = box.getBoundingClientRect();
      if (ev.clientX < br.left + 30) box.scrollLeft -= 8;
      else if (ev.clientX > br.right - 30) box.scrollLeft += 8;
    };
    const end = () => {
      chip.removeEventListener('pointermove', move);
      chip.removeEventListener('pointerup', end);
      chip.removeEventListener('pointercancel', end);
      if (!moved) return;
      chipDragAt = Date.now();
      state.settings.groupOrder = [...box.querySelectorAll('.group-chip[data-group]')].map(c => c.dataset.group);
      save();
      renderToday();
    };
    chip.addEventListener('pointermove', move);
    chip.addEventListener('pointerup', end);
    chip.addEventListener('pointercancel', end);
  });
}

function matchesGroup(t, groupFilter) {
  if (!groupFilter) return true;
  if (groupFilter === NO_GROUP) return groupsOf(t).length === 0;
  return groupsOf(t).includes(groupFilter);
}

function renderGroupChips(groupNames, active, box = $('#group-chips'), onPick = value => {
  state.settings.groupFilter = value; save(); $('#tally-list').scrollTop = 0; renderToday();
}) {
  box.classList.toggle('hidden', groupNames.length === 0);
  box.innerHTML = '';
  if (!groupNames.length) return;
  const count = g => state.tallies.filter(t => matchesGroup(t, g)).length;
  const chip = (value, label) => el('button', {
    type: 'button',
    role: 'tab',
    class: `group-chip${value === active ? ' on' : ''}`,
    'aria-selected': String(value === active),
    'data-group': value && value !== NO_GROUP ? value : null,
    onclick: () => { if (Date.now() - chipDragAt > 400) onPick(value); },
  }, label, el('span', { class: 'chip-count' }, String(count(value))));
  const reorderable = editMode && box.id === 'group-chips';
  box.classList.toggle('editing', reorderable);
  box.append(chip('', 'All'));
  groupNames.forEach(g => {
    const c = chip(g, g);
    if (reorderable) attachChipDrag(c, box);
    box.append(c);
  });
  if (state.tallies.some(t => !groupsOf(t).length)) box.append(chip(NO_GROUP, 'No group'));
  // Bring the picked chip into view sideways only (scrollIntoView can also scroll the whole page on iPhone).
  const on = box.querySelector('.on');
  if (on) {
    const left = on.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft, right = left + on.offsetWidth;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (right > box.scrollLeft + box.clientWidth) box.scrollLeft = right - box.clientWidth;
  }
}

// Removes the group name only: its goals stay and move to "No group".
function deleteGroup(name) {
  const members = state.tallies.filter(t => groupsOf(t).includes(name));
  const before = new Map(members.map(t => [t.id, [...groupsOf(t)]]));
  const wasFilter = state.settings.groupFilter === name;
  const wasCollapsed = (state.settings.collapsedGroups || []).includes(name);
  members.forEach(t => setGroups(t, groupsOf(t).filter(g => g !== name)));
  if (wasFilter) state.settings.groupFilter = '';
  state.settings.collapsedGroups = (state.settings.collapsedGroups || []).filter(g => g !== name);
  save();
  renderToday();
  toast(`Removed group ${name}`, () => {
    members.forEach(t => setGroups(t, before.get(t.id)));
    if (wasFilter) state.settings.groupFilter = name;
    if (wasCollapsed) state.settings.collapsedGroups = [...(state.settings.collapsedGroups || []), name];
    save();
    renderToday();
  });
}

function toggleGroup(key) {
  const set = new Set(state.settings.collapsedGroups || []);
  if (set.has(key)) set.delete(key); else set.add(key);
  state.settings.collapsedGroups = [...set];
  save();
  renderToday();
}

function tallyCard(t, bump) {
  const count = currentCount(t);
  const countText = t.target ? `${num(t, count)}/${num(t, t.target)}` : num(t, count);
  const sizeClass = countText.length > 7 ? 'tiny' : countText.length > 5 ? 'small' : '';
  const tracksToday = !offDay(t);

  let bottom;
  if (t.bottomMode === 'custom') bottom = t.bottomText || '';
  else if (t.bottomMode === 'unit') bottom = isCheck(t) ? (count >= 1 ? 'Done' : 'Not yet') : capitalize(unitLabel(t));
  else {
    const last = lastEntry(t.id);
    bottom = last ? relTime(last.ts) : 'Not yet';
  }

  // Met its goal (increase), or within its limit (decrease): big ✓; only + / − change it now.
  const completed = (t.target > 0 || isCheck(t)) && goalReached(t, count);
  const card = el('div', {
    // wide-count: times / money like "12:30/30:00" — in list view the title gets its own full-width line
    class: `card ${cardColorClass(t)}${tracksToday ? '' : ' off-day'}${completed ? ' completed' : ''}${bump ? ' bump' : ''}${!isCheck(t) && countText.length > 6 ? ' wide-count' : ''}`,
    style: cardColorStyle(t),
    role: 'button',
    tabindex: '0',
    'data-id': t.id,
    'aria-label': editMode
      ? `${t.name}. Drag to reorder, tap to edit.`
      : `${t.name}: ${countText}. Tap to log, hold for options.`,
  },
  el('div', { class: 'card-top' },
    el('div', { class: 'card-name' + nameSizeClass(t.name) }, goalTitle(t)), // the ↑ / ↓ always shows the goal's direction (the big ✓ marks completion)
    el('div', { class: 'card-period' }, goalEnded(t) ? `ENDED ${goalReached(t, count) ? '✓' : '✗'}`
      : byDate(t) ? `BY ${longDate(t.dueDate).toUpperCase()}` : periodLabel(t),
      t.dueDate && !byDate(t) ? el('span', { class: 'card-due' }, `· BY ${longDate(t.dueDate).replace(/, \d{4}$/, '').toUpperCase()}`) : null,
      goalBadge(t, count))),
  completed
    ? el('div', { class: 'card-count card-done' }, checkMark(true),
      el('span', { class: 'done-label' }, 'GOAL COMPLETED'),
      isCheck(t) ? null : el('span', { class: 'done-count' }, countText))
    : el('div', { class: `card-count ${sizeClass}` }, isCheck(t) ? checkMark(count >= 1) : countText),
  cardFoot(t, bottom),
  editMode ? deleteButton(t) : null);

  // Hold to lift and drag anywhere (in edit mode a plain press drags); held still = the menu.
  let fromGroup = '';
  dragSort(card, {
    holdMs: editMode ? 0 : homeDay ? 500 : 250, // ready to drag after 0.25s
    menuMs: 500, // held still 0.5s: the menu
    noDrag: !!homeDay && !editMode, // looking back at an earlier day: no rearranging (the order is shared by every day)
    scroller: $('#tally-list'),
    itemSelector: '#tally-list .card',
    containerSelector: '#tally-list .grid',
    onTap: () => (editMode ? openForm(t) : completed && !goalEnded(t) ? toast('Goal completed. Use + or − to change it.') : onTap(t)),
    onHold: () => (editMode ? openForm(t) : tallyMenu(t)),
    onLift: () => { fromGroup = card.parentElement?.dataset.group || ''; },
    onDrop: () => commitCardOrder(card, t, fromGroup),
  });
  return card;
}

function deleteButton(t) {
  const b = el('button', { type: 'button', class: 'card-delete', 'aria-label': `Delete ${t.name}` }, '×');
  ['pointerdown', 'pointerup', 'pointermove'].forEach(ev => b.addEventListener(ev, e => e.stopPropagation()));
  b.addEventListener('click', e => { e.stopPropagation(); deleteTally(t); });
  return b;
}

// Moves a goal (and its history) to Recently Deleted. Undo from the toast or restore from Settings.
function deleteTally(t) {
  const index = state.tallies.findIndex(x => x.id === t.id);
  if (index < 0) return;
  const item = {
    id: uid(),
    tally: t,
    entries: state.entries.filter(e => e.tallyId === t.id),
    index,
    deletedAt: Date.now(),
  };
  state.trash.unshift(item);
  state.tallies.splice(index, 1);
  state.entries = state.entries.filter(e => e.tallyId !== t.id);
  save();
  renderToday();
  renderTrash();
  toast(`Deleted ${t.name}`, () => restoreTally(item.id));
}

function restoreTally(trashId) {
  const i = state.trash.findIndex(x => x.id === trashId);
  if (i < 0) return;
  const [item] = state.trash.splice(i, 1);
  state.tallies.splice(Math.min(item.index, state.tallies.length), 0, item.tally);
  state.entries.push(...item.entries);
  save();
  renderToday();
  renderTrash();
}

// Edit mode: drag a card to reorder (or into another group); a plain tap opens its settings.
/* Hold-and-drag sorting, used by goal cards, to-dos and to-do sections.
   Press and hold (or just press, in edit modes: holdMs 0) and the item lifts; it then follows your
   finger until you let go, and the list scrolls by itself while you hold near its top or bottom.
   Touch events (not pointer events) are used so iPhone can't take a lifted item over for scrolling.
   opts: holdMs, scroller, itemSelector (what it can be dropped next to), containerSelector (empty
   places it can be dropped into), onTap, onHold (held without moving), onLift, onDrop, handle. */
// Buttons inside a draggable item that keep working on their own (they never start a drag).
const OWN_CONTROLS = '.step-btn, .card-delete, .todo-check, .todo-section-add, .todo-section-more, .todo-section-delete, input, textarea';
let holdReleasedAt = 0; // when a finger last let go of a hold that opened a menu
// After a drag (or a hold) ends, the phone still sends a 'tap' where the finger lifted. The cards may
// have just redrawn, so that tap could land on a different card or its + and log something: ignore
// every tap for a moment.
let blockTap = { until: 0, x: 0, y: 0 };
window.addEventListener('click', e => {
  // only the leftover tap right where the finger lifted; taps anywhere else work immediately
  if (Date.now() < blockTap.until && Math.hypot(e.clientX - blockTap.x, e.clientY - blockTap.y) < 40) { e.preventDefault(); e.stopPropagation(); }
}, true);
let dragActive = false; // something is being dragged; hold off re-rendering until it's dropped
function dragSort(node, opts) {
  const { holdMs = 450, menuMs = holdMs, noDrag = false, scroller, itemSelector, containerSelector, onTap, onHold, onLift, onDrop } = opts;
  const handle = opts.handle || node;
  let sx = 0, sy = 0, x = 0, y = 0, timer = null, pressed = false, lifted = false, moved = false, ghost = null, gx = 0, gy = 0, raf = null;
  let suppressClickUntil = 0;

  // Held still for holdMs: the item lifts and (cards) the menu opens right away. It stays open when
  // the finger lifts; moving the finger instead closes it and drags the item.
  // menuMs: how long a still hold takes to open the menu (cards: it can drag sooner, at holdMs).
  let menuOpen = false, menuTimer = null;
  const lift = () => {
    timer = null; lifted = true; dragActive = true;
    node.classList.add('lifted');
    onLift?.();
    if (onHold && holdMs > 0) menuTimer = setTimeout(() => {
      menuTimer = null;
      if (pressed && !ghost) { menuOpen = true; onHold(); }
    }, Math.max(0, menuMs - holdMs));
  };
  const startGhost = () => {
    const r = node.getBoundingClientRect();
    gx = sx - r.left; gy = sy - r.top;
    ghost = node.cloneNode(true);
    ghost.classList.remove('lifted');
    ghost.classList.add('drag-ghost');
    Object.assign(ghost.style, { left: '0px', top: '0px', width: `${r.width}px`, height: `${r.height}px` });
    document.body.append(ghost);
    node.classList.add('drag-placeholder');
    raf = requestAnimationFrame(tick);
  };
  // keeps the ghost under the finger and scrolls the list while held near an edge
  const tick = () => {
    if (!ghost) return;
    ghost.style.transform = `translate(${x - gx}px, ${y - gy}px) scale(1.04)`;
    if (scroller) {
      const r = scroller.getBoundingClientRect(), edge = 60;
      if (y < r.top + edge) scroller.scrollTop -= Math.ceil((r.top + edge - y) / 6);
      else if (y > r.bottom - edge) scroller.scrollTop += Math.ceil((y - (r.bottom - edge)) / 6);
      reposition();
    }
    raf = requestAnimationFrame(tick);
  };
  const reposition = () => {
    const under = document.elementFromPoint(x, y);
    if (!under) return;
    const target = under.closest(itemSelector);
    if (target && target !== node && !target.contains(node)) {
      const all = [...document.querySelectorAll(itemSelector)];
      const sameParent = target.parentElement === node.parentElement;
      if (sameParent) { if (all.indexOf(node) < all.indexOf(target)) target.after(node); else target.before(node); }
      else { const r = target.getBoundingClientRect(); if (y > r.top + r.height / 2) target.after(node); else target.before(node); }
      return;
    }
    const box = containerSelector && under.closest(containerSelector);
    if (box && node.parentElement !== box && !node.contains(box)) box.append(node);
  };
  const finish = () => {
    clearTimeout(timer); timer = null;
    clearTimeout(menuTimer); menuTimer = null;
    const hadMenu = menuOpen;
    menuOpen = false;
    cancelAnimationFrame(raf);
    const wasLifted = lifted, wasDragged = !!ghost;
    ghost?.remove(); ghost = null;
    node.classList.remove('lifted', 'drag-placeholder');
    pressed = lifted = false;
    dragActive = false;
    if (wasLifted) { suppressClickUntil = Date.now() + 600; blockTap = { until: Date.now() + 450, x, y }; }
    if (hadMenu && !wasDragged) holdReleasedAt = Date.now(); // this release mustn't close the menu it opened
    if (wasDragged) onDrop?.();
    else if (hadMenu) { /* the menu is already open */ }
    else if (wasLifted) onHold?.(); // (cards open their menu while held; to-dos and sections have none)
    else if (!moved && onTap) { suppressClickUntil = Date.now() + 600; onTap(); } // (no onTap: the tap goes to the buttons inside)
  };

  const down = (px, py, target) => {
    if (target.closest(OWN_CONTROLS)) return false;
    pressed = true; moved = false; lifted = false; menuOpen = false;
    sx = x = px; sy = y = py;
    if (holdMs > 0) timer = setTimeout(lift, holdMs);
    return true;
  };
  const drag = (px, py) => {
    x = px; y = py;
    const far = Math.hypot(px - sx, py - sy);
    if (!lifted) {
      if (far > 14) {
        moved = true;
        if (holdMs > 0) { clearTimeout(timer); timer = null; pressed = false; return false; } // it's a scroll
        lift();
      } else return false;
    }
    if (!ghost && far > 12 && !noDrag) {
      clearTimeout(menuTimer); menuTimer = null;
      if (menuOpen) { menuOpen = false; closeSheet(); } // moving after the menu opened: drag instead
      startGhost();
    }
    return true;
  };

  // touch
  handle.addEventListener('touchstart', e => { if (e.touches.length === 1) down(e.touches[0].clientX, e.touches[0].clientY, e.target); }, { passive: true });
  handle.addEventListener('touchmove', e => {
    if (!pressed) return;
    if (drag(e.touches[0].clientX, e.touches[0].clientY) || lifted) e.preventDefault();
  }, { passive: false });
  handle.addEventListener('touchend', e => {
    if (pressed) { if (lifted || (!moved && onTap)) e.preventDefault(); finish(); }
  });
  handle.addEventListener('touchcancel', () => { if (pressed) finish(); });
  // mouse (computers)
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0 || !down(e.clientX, e.clientY, e.target)) return;
    const mm = ev => { if (drag(ev.clientX, ev.clientY)) ev.preventDefault(); };
    const mu = () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); if (pressed) finish(); };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
  });
  // a held/dragged item shouldn't also "click" what's under it; VoiceOver/keyboard clicks still tap
  handle.addEventListener('click', e => {
    if (e.target.closest(OWN_CONTROLS)) return; // + / − / ✓ and friends always work
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.target.closest('button') && e.target.closest('button') !== handle) return;
    onTap?.();
  }, true);
  handle.addEventListener('keydown', e => { if (e.target === handle && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onTap?.(); } });
  handle.addEventListener('contextmenu', e => e.preventDefault());
}

// After a goal card is dropped: save the new order (and group, if it moved into another section).
function commitCardOrder(card, t, fromGroup) {
  const list = $('#tally-list');
  const byId = new Map(state.tallies.map(x => [x.id, x]));
  const ordered = [];
  const seen = new Set();
  for (const c of list.querySelectorAll('.card')) {
    const tally = byId.get(c.dataset.id);
    if (!tally || seen.has(tally.id)) continue; // a goal in several groups appears more than once
    seen.add(tally.id);
    ordered.push(tally);
  }
  const toGroup = card.parentElement?.dataset.group || '';
  if (toGroup !== fromGroup) {
    const gs = groupsOf(t).filter(g => g !== fromGroup);
    if (toGroup) gs.push(toGroup);
    setGroups(t, gs);
  }
  // Goals hidden by the filter keep their slots; the visible ones fill the rest in their new order.
  const shown = new Set(ordered.map(x => x.id));
  let next = 0;
  state.tallies = state.tallies.map(x => (shown.has(x.id) ? ordered[next++] : x));
  save();
  renderToday();
}

// Goal title followed by an up (increase) or down (decrease) arrow.
// reached: the goal is met (or, for decrease goals, still within the limit), so the arrow becomes a checkmark.
function goalTitle(t, reached = false) {
  const down = t.direction === 'decrease';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', reached ? 'dir-arrow is-done' : 'dir-arrow');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', reached ? 'M2 6.5 4.8 9.2 10 3' : down ? 'M6 2v8M2.5 6.5 6 10l3.5-3.5' : 'M6 10V2M2.5 5.5 6 2l3.5 3.5');
  svg.append(path);
  // Keep the arrow glued to the last word so it never ends up alone on a line.
  const words = String(t.name).trim().split(/\s+/);
  const last = words.pop() || '';
  return [
    el('span', { class: 'name-text' },
      words.length ? words.join(' ') + ' ' : '',
      el('span', { class: last.length > 11 ? 'name-last can-break' : 'name-last' }, last, svg)),
    el('span', { class: 'sr-only' }, reached ? ' (goal reached)' : down ? ' (decrease)' : ' (increase)'),
  ];
}

// Long titles get a smaller size so every word fits.
function nameSizeClass(name) {
  const n = String(name).length;
  return n > 24 ? ' name-xlong' : n > 13 ? ' name-long' : '';
}

// Increase goals: reached once the count hits the target this period.
// Decrease goals: on track (checkmark) while the count is at or under the limit.
function goalReached(t, count) {
  if (isCheck(t)) return t.direction === 'decrease' ? count === 0 : count >= 1;
  if (!(t.target > 0)) return false;
  return t.direction === 'decrease' ? count <= t.target : count >= t.target;
}

// Red ! when a decrease goal goes over its limit. (Met goals show a ✓ in the title instead.)
// Big plain check / X for check-off goals (drawn as lines so it matches the app's style).
function checkMark(done) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'check-mark');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', done ? 'Done' : 'Not done');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', done ? 'M4 12.5 9.5 18 20 6' : 'M6 6l12 12M18 6 6 18');
  svg.append(path);
  return svg;
}

function goalBadge(t, count) {
  if (!t.target || t.direction !== 'decrease') return null;
  return count > t.target ? el('span', { class: 'card-check over', title: 'Over your goal' }, '!') : null;
}


function lastInPeriod(t) {
  const [from, to] = viewPeriod(t);
  let last = null;
  for (const e of countedEntries(t)) {
    if (e.ts >= from && e.ts < to && (!last || e.ts > last.ts)) last = e;
  }
  return last;
}

// Take back the most recent entry in the current period.
function takeBack(t) {
  const last = lastInPeriod(t);
  if (!last) return;
  entryChange(t.id, () => { state.entries = state.entries.filter(e => e.id !== last.id); });
  save();
  renderToday(t.id);
  toast(`${t.name} −${num(t, last.value)}`, () => entryUndo(t.id));
}

// Bottom row of a card: − take back, the label, + log.
function cardFoot(t, label) {
  const btn = (label, cls, action, disabled) => {
    const b = el('button', { type: 'button', class: `step-btn ${cls}`, 'aria-label': cls === 'minus' ? `Take back last ${t.name} entry` : `Log ${t.name}` }, label);
    if (disabled) b.disabled = true;
    // Keep the card's own tap / long-press from firing.
    ['pointerdown', 'pointerup', 'pointermove'].forEach(ev => b.addEventListener(ev, e => e.stopPropagation()));
    b.addEventListener('click', e => { e.stopPropagation(); action(); });
    return b;
  };
  if (isCheck(t)) {
    const done = !!lastInPeriod(t);
    const x = btn(checkMark(false), 'minus', () => takeBack(t), !done);
    const ok = btn(checkMark(true), 'plus', () => onTap(t), done);
    x.setAttribute('aria-label', `Mark ${t.name} not done`);
    ok.setAttribute('aria-label', `Mark ${t.name} done`);
    return el('div', { class: 'card-foot is-check' }, x, el('div', { class: 'card-bottom' }, label), ok);
  }
  return el('div', { class: 'card-foot' },
    btn('−', 'minus', () => takeBack(t), !lastInPeriod(t) || goalEnded(t)),
    el('div', { class: 'card-bottom' }, label),
    btn('+', 'plus', () => onTap(t)));
}

function onTap(t) {
  if (goalEnded(t)) { repeatSheet(t); return; }
  if (offDay(t)) {
    // Logs on days the goal doesn't measure don't count toward it; check before logging one.
    openSheet(
      el('h3', {}, `${DAY_FULL[homeRef().getDay()]} isn't a measured day`),
      el('p', {}, `${t.name} is measured on ${daysSummary(measuredWeekdays(t))}. Anything logged ${homeDay ? 'that day' : 'today'} is kept in its history but won't count toward the goal.`),
      el('button', { class: 'sheet-btn primary', onclick: () => { closeSheet(); setTimeout(() => logNow(t), 300); } }, 'Log anyway'),
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
    );
    return;
  }
  logNow(t);
}
function logNow(t) {
  if (t.logMode === 'custom') promptValue(t);
  else logEntry(t, t.defaultCount || 1);
}
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A by-date goal whose date has passed: show how it went and offer to run it again.
function repeatSheet(t) {
  const total = countedEntries(t).reduce((s, e) => s + e.value, 0);
  const reached = goalReached(t, total);
  const now = new Date();
  // suggest the same length as last time, starting today
  const lastStart = startOfDay(new Date(t.countFrom || t.createdAt || Date.now()));
  const length = Math.max(1, Math.round((fromYmd(t.dueDate) - lastStart) / DAY_MS));
  const wheels = dateWheels(addDays(startOfDay(now), length), { minYear: now.getFullYear(), maxYear: now.getFullYear() + 10 });
  const error = el('p', { class: 'form-error hidden' });
  t.endAsked = t.dueDate; save();
  openSheet(
    el('h3', {}, `${t.name} ended ${reached ? '✓' : '✗'}`),
    el('p', {}, isCheck(t)
      ? `${reached ? 'You did it' : 'Not checked off'} by ${longDate(t.dueDate)}.`
      : `${reached ? 'You reached your goal' : 'You didn’t reach your goal'}: ${amountText(t, total)} of ${amountText(t, t.target || 0)} by ${longDate(t.dueDate)}.`),
    el('p', {}, 'Do you want to repeat this goal? Pick the new date; counting starts over today.'),
    wheels.node,
    error,
    el('button', {
      class: 'sheet-btn primary',
      onclick: () => {
        const d = wheels.get();
        if (d < startOfDay(new Date())) { error.textContent = 'Pick today or a later date.'; error.classList.remove('hidden'); return; }
        t.countFrom = startOfDay(new Date()).getTime();
        t.dueDate = toDateInput(d);
        t.endAsked = '';
        save(); renderToday(); closeSheet();
        toast(`${t.name} repeats until ${longDate(t.dueDate)}`);
      },
    }, 'Repeat goal'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Not now'),
  );
}

// Once per ended goal, ask whether to repeat it (when nothing else is open).
function askAboutEndedGoals() {
  if (document.querySelector('.screen.modal.active, .sheet.show, #sheet[data-open]')) return;
  const t = state.tallies.find(x => goalEnded(x) && x.endAsked !== x.dueDate);
  if (t) repeatSheet(t);
}

function promptValue(t) {
  const field = amountField(t, null, { placeholder: `${capitalize(unitLabel(t))} (default ${num(t, t.defaultCount || 1)})` });
  const now = new Date();
  const dateLabel = el('div', { class: 'log-date' });
  const showDate = d => { dateLabel.textContent = `${sameDay(d, now) ? 'Today' : DAY_NAMES[d.getDay()]} · ${longDate(toDateInput(d))}`; };
  // Settings → When logging custom dates: add to that day's number, or replace it.
  const replacing = () => state.settings.customDateMode === 'replace';
  const modeNote = el('p', { class: 'note log-mode' });
  const onDay = d => {
    showDate(d);
    const from = startOfDay(d).getTime(), to = addDays(startOfDay(d), 1).getTime();
    const already = entriesFor(t.id).filter(e => e.ts >= from && e.ts < to).reduce((sum, e) => sum + e.value, 0);
    modeNote.textContent = !already || isCheck(t) ? ''
      : replacing() ? `Replaces the ${amountText(t, already)} already logged that day.`
      : `Adds to the ${amountText(t, already)} already logged that day.`;
  };
  const wheels = dateWheels(homeRef(), { minYear: now.getFullYear() - 5, maxYear: now.getFullYear(), onChange: onDay });
  const error = el('p', { class: 'form-error hidden' });
  const submit = () => {
    const read = field.read();
    const v = read == null ? (t.defaultCount || 1) : read;
    if (!isFinite(v) || v === 0) return;
    const day = wheels.get();
    if (day > now) { error.textContent = 'That day has not happened yet.'; error.classList.remove('hidden'); return; }
    // today: right now; an earlier day: noon that day
    const ts = sameDay(day, now) ? Date.now() : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).getTime();
    closeSheet();
    logEntry(t, v, ts, replacing());
  };
  field.node.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  openSheet(
    el('h3', { class: 'log-title' }, `Log ${t.name}`),
    dateLabel,
    wheels.node,
    modeNote,
    error,
    isDuration(t) ? el('p', {}, `Leave blank to log ${durationLong(t, t.defaultCount || 1)}.`) : null,
    field.node,
    el('button', { class: 'sheet-btn primary', onclick: submit }, 'Log'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
  setTimeout(() => field.focus(), 250);
}

const UNDO_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const REDO_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>';

function tallyMenu(t) {
  const h = historyOf(t.id);
  const arrow = (icon, label, enabled, fn) => {
    const b = el('button', { type: 'button', class: 'icon-btn hist-arrow', 'aria-label': label, onclick: () => { if (fn()) tallyMenu(t); } });
    b.innerHTML = icon;
    b.disabled = !enabled;
    return b;
  };
  openSheet(
    el('div', { class: 'menu-head' },
      el('h3', {}, t.name),
      arrow(UNDO_ICON, 'Undo', h.back.length > 0, () => entryUndo(t.id)),
      arrow(REDO_ICON, 'Redo', h.forward.length > 0, () => entryRedo(t.id))),
    el('button', { class: 'sheet-btn', onclick: () => { closeSheet(); setTimeout(() => promptValue(t), 300); } }, 'Log custom amount'),
    el('button', { class: 'sheet-btn', onclick: () => { closeSheet(); openForm(t); } }, 'Edit Goal Description'),
    el('button', { class: 'sheet-btn danger', onclick: () => { closeSheet(); deleteTally(t); } }, 'Delete goal'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
}

const pad2 = n => String(n).padStart(2, '0');
const toDateInput = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toTimeInput = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "Sun–Sat", "Mon–Fri", "Mon, Wed, Fri", "Sat, Sun"…
function daysSummary(days) {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (!set.length) return 'No days selected';
  if (set.length === 7) return 'Sun–Sat';
  const runs = [];
  for (const d of set) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d); else runs.push([d]);
  }
  return runs.map(r => (r.length >= 3 ? `${DAY_NAMES[r[0]]}–${DAY_NAMES[r[r.length - 1]]}` : r.map(d => DAY_NAMES[d]).join(', '))).join(', ');
}

// Swap one sheet for another after the closing animation.
function switchSheet(fn) { closeSheet(); setTimeout(fn, 300); }

// Every entry for a goal, newest first. Tap one to change its date, time or amount.
function historySheet(t) {
  const all = entriesFor(t.id).sort((a, b) => b.ts - a.ts);
  const shown = all.slice(0, 200);
  const box = el('div', { class: 'hist' });
  if (!shown.length) box.append(el('p', {}, 'No entries yet.'));
  for (const e of shown) {
    const d = new Date(e.ts);
    box.append(el('button', { type: 'button', class: 'hist-row', onclick: () => switchSheet(() => entrySheet(t, e)) },
      el('span', { class: 'hist-when' },
        el('strong', {}, `${DAY_NAMES[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`),
        d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : '',
        el('span', {}, d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))),
      el('span', { class: 'hist-amount' }, amountText(t, e.value)),
      el('span', { class: 'hist-chev', 'aria-hidden': 'true' }, '›')));
  }
  openSheet(
    el('h3', {}, `${t.name} history`),
    el('p', {}, all.length > shown.length ? `Most recent ${shown.length} of ${all.length} entries. Tap one to edit it.`
      : all.length ? `${all.length} entr${all.length === 1 ? 'y' : 'ies'}. Tap one to edit it.` : 'Add entries for days you missed.'),
    el('button', { class: 'sheet-btn primary', onclick: () => switchSheet(() => entrySheet(t, null)) }, '+ Add past entry'),
    box,
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Done'),
  );
}

// Add an entry on any past date, or edit / delete an existing one.
// opts.date: preset day for a new entry; opts.back: sheet to return to (default: history).
function entrySheet(t, entry, opts = {}) {
  const back = opts.back || (() => historySheet(t));
  const now = new Date();
  let when = entry ? new Date(entry.ts) : new Date();
  if (!entry && opts.date && startOfDay(opts.date) < startOfDay(now)) {
    when = new Date(opts.date); when.setHours(12, 0, 0, 0); // past day: default to noon
  }
  const wheels = dateWheels(when, { minYear: now.getFullYear() - 10, maxYear: now.getFullYear() });
  const time = el('input', { class: 'text-input', type: 'time', value: toTimeInput(when) });
  const amount = amountField(t, entry ? entry.value : (t.defaultCount || 1));
  const error = el('p', { class: 'form-error hidden' });

  const submit = () => {
    const day = wheels.get();
    const [hh, mm] = (time.value || '12:00').split(':').map(Number);
    const ts = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh || 0, mm || 0).getTime();
    const value = amount.read();
    let problem = '';
    if (!isFinite(ts)) problem = 'Pick a date.';
    else if (ts > Date.now() + 60000) problem = 'That’s in the future. Pick a date and time that already happened.';
    else if (value == null || !isFinite(value) || value === 0) problem = 'Enter an amount.';
    if (problem) { error.textContent = problem; error.classList.remove('hidden'); return; }

    entryChange(t.id, () => {
      if (entry) {
        entry.ts = ts;
        entry.value = value;
      } else {
        state.entries.push({ id: uid(), tallyId: t.id, ts, value });
      }
    });
    save();
    refreshAll();
    const label = new Date(ts);
    toast(`${entry ? 'Updated' : 'Added'} ${num(t, value)} on ${MONTH_SHORT[label.getMonth()]} ${label.getDate()}`);
    switchSheet(back);
  };

  const remove = () => {
    entryChange(t.id, () => { state.entries = state.entries.filter(x => x.id !== entry.id); });
    save();
    refreshAll();
    toast('Entry deleted', () => entryUndo(t.id));
    switchSheet(back);
  };

  openSheet(
    el('h3', {}, entry ? `Edit ${t.name} entry` : `Add past ${t.name} entry`),
    el('div', { class: 'sheet-label' }, 'DATE', wheels.node),
    el('label', { class: 'sheet-label' }, 'TIME', time),
    el('div', { class: 'sheet-label' }, capitalize(unitLabel(t)).toUpperCase(), amount.node),
    error,
    el('button', { class: 'sheet-btn primary', onclick: submit }, entry ? 'Save changes' : 'Add entry'),
    entry ? el('button', { class: 'sheet-btn danger', onclick: remove }, 'Delete entry') : null,
    el('button', { class: 'sheet-btn', onclick: () => switchSheet(back) }, 'Back'),
  );
}

// Re-draw whatever is on screen after entries change.
function refreshAll() {
  renderToday();
  if ($('#screen-stats').classList.contains('active')) renderStats();
}

// One day's entries for a goal (opened by tapping a bar or point on the Stats page).
function daySheet(t, day) {
  const from = startOfDay(day).getTime(), to = addDays(startOfDay(day), 1).getTime();
  const entries = entriesFor(t.id).filter(e => e.ts >= from && e.ts < to).sort((a, b) => a.ts - b.ts);
  const total = entries.reduce((s, e) => s + e.value, 0);
  const again = () => daySheet(t, day);
  const box = el('div', { class: 'hist' });
  if (!entries.length) box.append(el('p', {}, 'Nothing logged this day.'));
  for (const e of entries) {
    const d = new Date(e.ts);
    box.append(el('button', { type: 'button', class: 'hist-row', onclick: () => switchSheet(() => entrySheet(t, e, { back: again })) },
      el('span', { class: 'hist-when' }, el('strong', {}, d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))),
      el('span', { class: 'hist-amount' }, amountText(t, e.value)),
      el('span', { class: 'hist-chev', 'aria-hidden': 'true' }, '›')));
  }
  openSheet(
    el('h3', {}, `${t.name}: ${DAY_NAMES[day.getDay()]}, ${MONTH_SHORT[day.getMonth()]} ${day.getDate()}`),
    el('p', {}, entries.length ? `${amountText(t, total)} total. Tap an entry to change it.` : 'Add anything you missed for this day.'),
    el('button', { class: 'sheet-btn primary', onclick: () => switchSheet(() => entrySheet(t, null, { date: day, back: again })) }, '+ Add entry for this day'),
    box,
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Done'),
  );
}

// Tapping bucket i on a stat card: open that day, or (Year view) jump to that month.
function pickBucket(t, r, i) {
  const now = new Date();
  if (statsState.range === 'year') {
    statsState.range = 'month';
    statsState.offset = (r.start.getFullYear() - now.getFullYear()) * 12 + (i - now.getMonth());
    renderStats();
    return;
  }
  const day = statsState.range === 'day' ? startOfDay(r.start) : addDays(startOfDay(r.start), i);
  if (day > now) { toast('That day hasn’t happened yet'); return; }
  daySheet(t, day);
}

const FILTER_NAMES = { all: 'all', day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly', date: 'by-date' };

// DATE shows the By Custom Date goals; the others match how often the goal resets.
function matchesFilter(t, filter) {
  if (filter === 'all') return true;
  return filter === 'date' ? byDate(t) : t.reset === filter;
}

$('#goal-filter').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.settings.filter = b.dataset.v;
  save();
  $('#tally-list').scrollTop = 0;
  renderToday();
});

$('#btn-edit').addEventListener('click', () => setEditMode(!editMode));

// CANCEL: put goals, entries, Recently Deleted and group settings back to how they were.
$('#btn-edit-cancel').addEventListener('click', () => {
  const snap = editSnapshot;
  if (snap) {
    state.tallies = snap.tallies;
    state.entries = snap.entries;
    state.trash = snap.trash;
    EDIT_SETTINGS.forEach(k => { state.settings[k] = snap.settings[k]; });
    save();
    clearUndoHistory({ todos: false });
  }
  setEditMode(false);
  toast('Edits canceled');
});

$('#btn-layout').addEventListener('click', () => {
  state.settings.layout = state.settings.layout === 'list' ? 'grid' : 'list';
  save(); renderToday();
});

$('#btn-help').addEventListener('click', () => {
  openSheet(
    el('div', { class: 'help-hero' },
      el('div', { class: 'help-word' }, 'GOALIE'),
      el('p', {}, 'This app was not designed to be a motivator, but rather to reflect the person you are becoming')),
    el('h3', {}, 'How it works'),
    el('ol', {},
      el('li', {}, 'Tap + at the bottom to set a goal: anything you want to do more of or cut back on.'),
      el('li', {}, 'Tap a goal card (or its +) to check in. Use − to take one back. Hold a card to log a custom amount or date, undo or redo, edit or delete it.'),
      el('li', {}, 'Tap the pencil (top right) to reorder goals, drag the group chips to reorder groups, delete goals, or remove group names.'),
      el('li', {}, 'Tap the chart icon to see your day, week, month and year. Tap any bar or point to view or edit that day.')),
    isNativeApp ? null : el('h3', {}, 'Install on iPhone'),
    isNativeApp ? null : el('ol', {},
      el('li', {}, 'Open this page in Safari.'),
      el('li', {}, 'Tap Share, then “Add to Home Screen”.'),
      el('li', {}, 'Launch it from the home screen icon — it runs full-screen and works offline.')),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Got it'),
  );
});

$('#btn-add').addEventListener('click', () => { if (editMode) setEditMode(false); openForm(null); });
$('#btn-todo').addEventListener('click', () => {
  if (editMode) setEditMode(false);
  todoEditing = false; $('#btn-todo-edit').classList.remove('on'); $('#btn-todo-edit').setAttribute('aria-pressed', 'false');
  renderTodos();
  openScreen('todo');
});
$('#btn-stats').addEventListener('click', () => {
  if (editMode) setEditMode(false); statsState.offset = 0; renderStats(); openScreen('stats'); });
$('#btn-settings').addEventListener('click', () => {
  if (editMode) setEditMode(false); renderSettings(); openScreen('settings'); });

/* =========================================================
   Create / Edit form
   ========================================================= */
let form = null;
let editingId = null;
let autoCustom = false; // logMode was switched by picking a time unit, not by the user

function blankForm() {
  return {
    name: '', examples: '', nonExamples: '', direction: 'increase', unit: 'occurrences', customUnit: '', reset: 'day', days: [0, 1, 2, 3, 4, 5, 6], groups: [], dueDate: '', defaultCount: 1,
    logMode: 'default', target: null, reminder: null,
    color: DEFAULT_COLOR, textColor: '', bottomMode: 'unit', bottomText: '',
  };
}

function openForm(t) {
  editingId = t ? t.id : null;
  unitChangeOk = false;
  autoCustom = false;
  colorTarget = 'goal';
  form = t ? { ...blankForm(), ...JSON.parse(JSON.stringify(t)) } : blankForm();
  form.groups = [...groupsOf(form)];
  // Days / weeks / months / years are no longer unit choices; keep the same word as a custom unit.
  if (['days', 'weeks', 'months', 'years'].includes(form.unit)) {
    form.customUnit = form.unit;
    form.unit = 'custom';
  }
  $('#create-title').textContent = t ? 'EDIT' : 'CREATE';
  $('#btn-submit').textContent = t ? 'SAVE' : 'ADD';
  $('#btn-delete').classList.toggle('hidden', !t);
  $('#history-section').classList.toggle('hidden', !t);
  $('#idea-chips').classList.add('hidden');
  $('#f-name').value = form.name;
  $('#f-default').value = form.defaultCount;
  $('#f-goal').value = form.target ?? '';
  $('#f-examples').value = form.examples || '';
  $('#f-nonexamples').value = form.nonExamples || '';
  requestAnimationFrame(() => { fitTextArea($('#f-examples')); fitTextArea($('#f-nonexamples')); });
  $('#f-bottom').value = form.bottomText;
  $('#f-unit').value = form.customUnit || '';
  $('#create-form').scrollTop = 0;
  syncForm();
  openScreen('create');
}

function syncForm() {
  setSeg('logMode', form.logMode);
  setSeg('direction', form.direction);
  setSeg('unit', form.unit);
  setSeg('bottomMode', form.bottomMode);
  $$('[data-field="days"] button').forEach(b => b.classList.toggle('on', form.days.includes(+b.dataset.v)));
  $('#days-summary').textContent = daysSummary(form.days);
  $('#days-section').classList.toggle('hidden', !daysPickable(form));
  $('#goal-per').textContent = PER_PHRASE[form.reset].trim().toUpperCase();
  renderGoalDesc();
  $('#f-bottom').classList.toggle('hidden', form.bottomMode !== 'custom');
  $('#f-unit').classList.toggle('hidden', form.unit !== 'custom');
  $('#goal-amount-row').classList.toggle('hidden', isCheck(form));
  $('#amount-section').classList.toggle('hidden', isCheck(form));
  setSeg('per', byDate(form) ? 'date' : form.reset);
  $('#f-default').value = isFinite(form.defaultCount) ? fmt(form.defaultCount) : $('#f-default').value;
  $('#bottom-unit-btn').textContent = unitLabel(form).toUpperCase() || 'MEASUREMENT';
  $('#group-value').textContent = form.groups.length ? form.groups.join(', ').toUpperCase() : 'NONE';
  $('#per-date').textContent = byDate(form) ? `BY ${longDate(form.dueDate).toUpperCase()}` : 'BY CUSTOM DATE';
  if (byDate(form)) $('#goal-per').textContent = `BY ${longDate(form.dueDate).toUpperCase()}`;
  $('#reminder-value').textContent = form.reminder ? `DAILY AT ${fmtTime(form.reminder)}` : 'NONE';
  setSeg('colorTarget', colorTarget);
  const picked = colorTarget === 'goal' ? form.color : form.textColor;
  $$('#color-grid .swatch').forEach(s => s.classList.toggle('on', s.dataset.c === picked));
  $('#text-auto').classList.toggle('hidden', colorTarget !== 'text');
  $('#text-auto').classList.toggle('on', !form.textColor);
  renderColorPreview();
  validateForm();
}

function setSeg(field, value) {
  $$(`[data-field="${field}"] [data-v]`).forEach(b => b.classList.toggle('on', b.dataset.v === value));
}

function validateForm() {
  const ok = form.name.trim().length > 0 && (form.days.length > 0 || !daysPickable(form)) &&
    isFinite(form.defaultCount) && form.defaultCount !== 0 &&
    (form.target == null || form.target > 0) &&
    (form.unit !== 'custom' || (form.customUnit || '').trim().length > 0);
  $('#btn-submit').disabled = !ok;
}

// "By custom date" goals count everything logged until their date (stored as reset 'never' + dueDate).
const byDate = f => f.reset === 'never' && !!f.dueDate;

// Picking specific weekdays applies to day, week, month and year goals; minute, hour and
// by-date goals count every day.
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const daysPickable = f => !f.dueDate && ['day', 'week', 'month', 'year'].includes(f.reset);
const measuredWeekdays = f => (daysPickable(f) ? f.days : ALL_DAYS);

const PER_PHRASE = { minute: ' per minute', hour: ' per hour', day: ' per day', week: ' per week', month: ' per month', year: ' per year', never: ' in total' };
const DAY_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// The unit as the user sees it: a built-in unit or their own custom word.
const isCheck = t => t.unit === 'check';

function unitLabel(t) {
  if (t.unit === 'check') return 'check-ins';
  if (t.unit === 'custom') return (t.customUnit || '').trim();
  return t.unit || 'occurrences';
}

function singular(word) {
  if (/(ss|sh|ch|x|z)es$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

function unitWord(t, n) {
  const label = unitLabel(t);
  return n === 1 ? singular(label) : label;
}

const isMoney = t => t.unit === 'dollars';
function money(n) { return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2)); }

// Minutes goals store minutes (12.5 = 12 min 30 sec); hours goals store hours (1.25 = 1 hr 15 min).
const isDuration = t => t.unit === 'minutes' || t.unit === 'hours';
function splitDuration(n) {
  const sign = n < 0 ? -1 : 1;
  let big = Math.floor(Math.abs(n) + 1e-9);
  let small = Math.round((Math.abs(n) - big) * 60);
  if (small === 60) { big += 1; small = 0; }
  return [sign * big, small];
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Compact: "12m 30s" / "1h 15m"
function durationShort(t, n) {
  const [big, small] = splitDuration(n);
  const [a, b] = t.unit === 'hours' ? ['h', 'm'] : ['m', 's'];
  return small ? `${big}${a} ${small}${b}` : `${big}${a}`;
}
// Sentence: "12 minutes 30 seconds" / "1 hour 15 minutes"
function durationLong(t, n) {
  const [big, small] = splitDuration(n);
  const [a, b] = t.unit === 'hours' ? ['hour', 'minute'] : ['minute', 'second'];
  return small ? `${plural(big, a)} ${plural(small, b)}` : plural(big, a);
}

// An amount with its unit: "$12.50", "3 miles", "1 occurrence", "12m 30s".
function amountText(t, n) {
  if (isCheck(t)) return n >= 1 ? '✓ Done' : '✗ Not done';
  if (isMoney(t)) return money(n);
  if (isDuration(t)) return durationShort(t, n);
  return `${fmt(n)} ${unitWord(t, n)}`;
}
// Just the number: dollars for money goals, clock style (12:30) for time goals.
function num(t, n) {
  if (isCheck(t)) return n >= 1 ? '✓' : '✗';
  if (isMoney(t)) return money(n);
  if (isDuration(t)) { const [big, small] = splitDuration(n); return `${big}:${pad2(small)}`; }
  return fmt(n);
}

// Amount input: one number box, or two boxes (min + sec / hr + min) for time goals.
function amountField(t, value, { placeholder = '' } = {}) {
  if (!isDuration(t)) {
    const input = el('input', { class: 'text-input', type: 'number', inputmode: 'decimal', step: 'any', placeholder });
    if (value != null) input.value = fmt(value);
    return { node: input, focus: () => input.focus(), read: () => (input.value === '' ? null : parseFloat(input.value)) };
  }
  const [bigLabel, smallLabel] = t.unit === 'hours' ? ['HR', 'MIN'] : ['MIN', 'SEC'];
  const big = el('input', { class: 'text-input', type: 'number', inputmode: 'numeric', min: '0', step: '1', placeholder: '0' });
  const small = el('input', { class: 'text-input', type: 'number', inputmode: 'numeric', min: '0', max: '59', step: '1', placeholder: '0' });
  if (value != null) { const [b, s] = splitDuration(value); big.value = String(b); small.value = s ? String(s) : ''; }
  const node = el('div', { class: 'duration-field' },
    el('label', {}, big, el('span', {}, bigLabel)),
    el('label', {}, small, el('span', {}, smallLabel)));
  return {
    node,
    focus: () => big.focus(),
    read: () => {
      if (big.value === '' && small.value === '') return null;
      const b = parseFloat(big.value || '0'), s = parseFloat(small.value || '0');
      if (!isFinite(b) || !isFinite(s) || b < 0 || s < 0) return NaN;
      return b + s / 60; // seconds beyond 59 simply roll over into minutes
    },
  };
}

// Lists in text boxes: Enter after "1. …" starts "2. ", after "- …" or "• …" another bullet.
// Enter on a line that's only a number or bullet removes it and ends the list.
function autoList(area) {
  area.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const { selectionStart: a, selectionEnd: b, value } = area;
    if (a !== b) return;
    const lineStart = value.lastIndexOf('\n', a - 1) + 1;
    const lineEnd = value.indexOf('\n', a) === -1 ? value.length : value.indexOf('\n', a);
    const m = value.slice(lineStart, lineEnd).match(/^(\s*)(?:(\d+)([.)])|([-•]))(?: (.*))?$/);
    if (!m) return;
    e.preventDefault();
    const [, indent, n, sep, bullet, text = ''] = m;
    if (!text.trim() && a === lineEnd) {
      area.setRangeText('', lineStart, lineEnd, 'end'); // empty item: end the list
    } else {
      area.setRangeText(`\n${indent}${n ? `${+n + 1}${sep}` : bullet} `, a, a, 'end');
    }
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
autoList($('#f-examples'));
autoList($('#f-nonexamples'));

/* Text boxes that grow with what's written (no scrolling inside the box), and keep the line being
   typed on screen: the page scrolls along when a new line (or numbered / dashed item) is added. */
function fitTextArea(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}
function caretBottom(area) {
  const cs = getComputedStyle(area), copy = document.createElement('div');
  for (const p of ['boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'tabSize']) copy.style[p] = cs[p];
  Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0', width: `${area.offsetWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
  copy.textContent = area.value.slice(0, area.selectionEnd);
  const mark = el('span', {}, '​');
  copy.append(mark);
  document.body.append(copy);
  const y = mark.offsetTop + mark.offsetHeight;
  copy.remove();
  return area.getBoundingClientRect().top - area.scrollTop + y;
}
function keepCaretVisible(area) {
  if (document.activeElement !== area) return;
  const scroller = area.closest('.sheet, .form-scroll, .todo-scroll');
  if (!scroller) return;
  const vv = window.visualViewport; // the part of the screen above the keyboard
  const visibleBottom = Math.min(scroller.getBoundingClientRect().bottom, vv ? vv.offsetTop + vv.height : innerHeight) - 24;
  const over = caretBottom(area) - visibleBottom;
  if (over > 0) scroller.scrollTop += over;
}
function growWithText(area) {
  area.classList.add('grows');
  area.addEventListener('input', () => { fitTextArea(area); requestAnimationFrame(() => keepCaretVisible(area)); });
  area.addEventListener('focus', () => setTimeout(() => keepCaretVisible(area), 350)); // after the keyboard opens
}
growWithText($('#f-examples'));
growWithText($('#f-nonexamples'));

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function daysPhrase(days) {
  const set = [...days].sort().join('');
  if (set === '0123456') return '';
  if (set === '12345') return 'weekdays';
  if (set === '06') return 'weekends';
  return joinList(days.slice().sort().map(d => DAY_PLURAL[d]));
}

function goalDescription(f) {
  const name = (f.name || '').trim().toLowerCase();
  if (!name) return null;
  if (isCheck(f)) {
    const every = { minute: 'every minute', hour: 'every hour', day: 'every day', week: 'every week', month: 'every month', year: 'every year', never: 'once' }[f.reset];
    let t = `Your goal is to ${f.direction === 'decrease' ? 'avoid' : 'check off'} ${name} ${every}`;
    const d = daysPhrase(measuredWeekdays(f));
    if (d) t += ` on ${d}`;
    if (f.dueDate) t += `, by ${longDate(f.dueDate)}`;
    return t + '.';
  }
  let text = `Your goal is to ${f.direction} ${name}`;
  if (f.target > 0) text += ` to ${isDuration(f) ? durationLong(f, f.target) : amountText(f, f.target)}${byDate(f) ? '' : PER_PHRASE[f.reset]}`;
  const days = daysPhrase(measuredWeekdays(f));
  if (days) text += (f.reset === 'day' || f.reset === 'hour' || f.reset === 'minute') ? ` on ${days}` : `, tracked on ${days}`;
  if (f.dueDate) text += `${byDate(f) && f.target > 0 ? '' : ','} by ${longDate(f.dueDate)}`;
  return text + '.';
}

function renderGoalDesc() {
  const p = $('#goal-desc');
  const text = goalDescription(form);
  p.textContent = text || 'Enter a goal title to see your goal.';
  p.classList.toggle('empty-desc', !text);
  schedulePreview(); // the preview card shows the title, goal and period too
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toUpperCase();
}

// Color swatches
// One grid sets either the goal (card) color or the text color, chosen by the toggle above it.
let colorTarget = 'goal';
PALETTE.forEach(({ name, shades }) => shades.forEach((c, i) => {
  $('#color-grid').append(el('button', {
    type: 'button', class: `swatch${c === '#ffffff' ? ' swatch-white' : ''}`, style: `background:${c}`, 'data-c': c, 'aria-label': `${name} ${i + 1}`, title: `${name} ${i + 1}`,
    onclick: () => { if (colorTarget === 'goal') form.color = c; else form.textColor = c; syncForm(); },
  }));
}));
$('#text-auto').addEventListener('click', () => { form.textColor = ''; syncForm(); });

// While typing, redraw the preview a moment after the last key, so the page doesn't shift on every
// letter (the card can change height as the title wraps).
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderColorPreview, 350);
}

// Mini card showing the current goal + text colors.
function renderColorPreview() {
  clearTimeout(previewTimer);
  const box = $('#color-preview');
  box.innerHTML = '';
  // The real home-screen card (same builder, same count, buttons and bottom text), shrunk to fit.
  const t = { ...form, id: editingId || '__preview', name: (form.name || '').trim() || 'Your goal', days: measuredWeekdays(form) };
  const wasEditing = editMode;
  editMode = false;
  const card = tallyCard(t, false);
  editMode = wasEditing;
  const CARD_W = 164;
  const inner = el('div', { class: 'preview-scale', style: `width:${CARD_W}px`, 'aria-hidden': 'true' }, card);
  box.append(inner);
  const fit = () => {
    const scale = (box.clientWidth || 118) / CARD_W;
    inner.style.transform = `scale(${scale})`;
    if (card.offsetHeight) box.style.height = `${Math.ceil(card.offsetHeight * scale)}px`;
  };
  fit();
  requestAnimationFrame(fit); // measure again once the screen is showing
}

// Segmented controls
$$('#create-form .seg').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('[data-v]'); if (!b) return;
  const v = b.dataset.v;
  switch (seg.dataset.field) {
    case 'per':
      if (v === 'date') { dueDateSheet(); return; }
      form.reset = v; form.dueDate = '';
      break;
    case 'colorTarget': colorTarget = v; break;
    case 'logMode': form.logMode = v; autoCustom = false; break;
    case 'bottomMode': form.bottomMode = v; break;
    case 'direction': form.direction = v; break;
    case 'unit': {
      // Minutes ↔ hours: keep the same amounts (30 minutes becomes 0.5 hours).
      const k = unitFactor(form.unit, v);
      if (k && k !== 1) {
        if (form.target != null) { form.target = +(form.target * k).toFixed(4); $('#f-goal').value = fmt(form.target); }
        if (isFinite(form.defaultCount)) form.defaultCount = +(form.defaultCount * k).toFixed(4);
      }
      form.unit = v;
      if (v === 'check') {
        // A check-off has no number: one tap marks it done for the period.
        form.target = null; $('#f-goal').value = '';
        form.defaultCount = 1; $('#f-default').value = '1';
        form.logMode = 'default'; autoCustom = false;
      }
      if (v === 'custom') setTimeout(() => $('#f-unit').focus(), 50);
      // Time-based goals are usually logged as an amount, not a fixed +1.
      if (['minutes', 'hours', 'dollars'].includes(v) && form.logMode === 'default' && form.defaultCount === 1) {
        form.logMode = 'custom';
        autoCustom = true;
      } else if (!['minutes', 'hours', 'dollars'].includes(v) && autoCustom) {
        form.logMode = 'default';
        autoCustom = false;
      }
      break;
    }
  }
  syncForm();
}));

$('[data-field="days"]').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = +b.dataset.v;
  form.days = form.days.includes(d) ? form.days.filter(x => x !== d) : [...form.days, d].sort();
  syncForm();
});

$('#f-name').addEventListener('input', e => { form.name = e.target.value; validateForm(); renderGoalDesc(); });
$('#f-default').addEventListener('input', e => { form.defaultCount = parseFloat(e.target.value); validateForm(); schedulePreview(); });
$('#f-goal').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  form.target = isFinite(v) ? v : null;
  validateForm(); renderGoalDesc();
});
$('#f-examples').addEventListener('input', e => { form.examples = e.target.value; });
$('#f-nonexamples').addEventListener('input', e => { form.nonExamples = e.target.value; });
$('#f-bottom').addEventListener('input', e => { form.bottomText = e.target.value; schedulePreview(); });
$('#f-unit').addEventListener('input', e => {
  form.customUnit = e.target.value;
  validateForm(); renderGoalDesc();
  $('#bottom-unit-btn').textContent = unitLabel(form).toUpperCase() || 'MEASUREMENT';
});

function applySuggestion(s) {
  const unit = s.unit || 'occurrences';
  form.name = s.name;
  form.direction = s.direction || 'increase';
  form.unit = unit;
  form.customUnit = s.customUnit || '';
  // Amount-style units are entered manually; counts add the usual amount per tap.
  const manual = ['minutes', 'hours', 'dollars'].includes(unit) || (unit === 'custom' && ['miles', 'pages', 'steps'].includes(form.customUnit));
  form.logMode = manual ? 'custom' : 'default';
  autoCustom = false;
  $('#f-name').value = s.name;
  $('#f-unit').value = form.customUnit;
  $('#idea-chips').classList.add('hidden');
  syncForm();
}

$('#btn-idea').addEventListener('click', () => {
  const box = $('#idea-chips');
  if (!box.childElementCount) {
    SUGGESTIONS.forEach(s => box.append(el('button', {
      type: 'button', class: 'chip',
      onclick: () => applySuggestion(s),
    }, s.name)));
  }
  box.classList.toggle('hidden');
});

// Groups: pick as many as you like (tap to toggle), or add a new one.
$('#btn-group').addEventListener('click', () => {
  const draw = () => {
    const all = [...new Set([...state.tallies.flatMap(groupsOf), ...form.groups])];
    const input = el('input', { class: 'text-input', type: 'text', maxlength: 24, placeholder: 'New group name' });
    const add = () => {
      const g = input.value.trim();
      if (!g) return;
      if (!form.groups.includes(g)) form.groups.push(g);
      syncForm(); draw();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    openSheet(
      el('h3', {}, 'Groups'),
      el('p', {}, 'Pick every group this goal belongs to.'),
      all.map(g => {
        const on = form.groups.includes(g);
        return el('button', {
          class: `sheet-btn group-pick${on ? ' selected' : ''}`,
          'aria-pressed': String(on),
          onclick: () => {
            form.groups = on ? form.groups.filter(x => x !== g) : [...form.groups, g];
            syncForm(); draw();
          },
        }, el('span', { class: 'pick-box', 'aria-hidden': 'true' }, on ? '✓' : ''), g);
      }),
      input,
      el('button', { class: 'sheet-btn', onclick: add }, '+ Add group'),
      el('button', { class: 'sheet-btn primary', onclick: closeSheet }, 'Done'),
    );
  };
  draw();
});

// Target date ("This goal will be accomplished by:")
function longDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}
// PER → BY CUSTOM DATE: the goal counts everything logged until this date.
function dueDateSheet() {
  const now = new Date();
  const start = form.dueDate ? fromYmd(form.dueDate) : addDays(startOfDay(now), 30);
  const wheels = dateWheels(start, { minYear: now.getFullYear(), maxYear: now.getFullYear() + 10 });
  const error = el('p', { class: 'form-error hidden' });
  openSheet(
    el('h3', {}, 'Accomplish this goal by'),
    el('p', {}, 'Pick the date you want to reach this goal. Everything you log until then counts toward it.'),
    wheels.node,
    error,
    el('button', {
      class: 'sheet-btn primary',
      onclick: () => {
        const d = wheels.get();
        if (d < startOfDay(now)) { error.textContent = 'Pick today or a later date.'; error.classList.remove('hidden'); return; }
        form.reset = 'never'; form.dueDate = toDateInput(d); syncForm(); closeSheet();
      },
    }, 'Save date'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
}

const fromYmd = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };

// Date picker with three spinning wheels (month, day, year), like the iPhone's.
// Returns { node, get } where get() is the picked day at midnight.
// One spinning column: labels, the starting row, a callback when it settles, and a class.
const WHEEL_ROW = 36;
// loop: the list repeats endlessly (after 12 comes 1 again). Values passed to onPick and returned
// by index() are always positions in labels.
function wheel(labels, index, onPick, cls, { loop = false } = {}) {
  const ROW = WHEEL_ROW, n = labels.length;
  const CYCLES = loop ? 21 : 1, MID = loop ? 10 : 0; // loop: 21 copies, starting in the middle one
  const all = Array.from({ length: n * CYCLES }, (_, i) => labels[i % n]);
  const items = all.map((label, i) => el('div', { class: 'wheel-item', onclick: () => col.scrollTo({ top: i * ROW, behavior: 'smooth' }) }, String(label)));
  const col = el('div', { class: `wheel ${cls}` }, el('div', { class: 'wheel-pad' }), items, el('div', { class: 'wheel-pad' }));
  const mark = r => items.forEach((it, j) => it.classList.toggle('on', j === r));
  const rawNow = () => Math.max(0, Math.min(all.length - 1, Math.round(col.scrollTop / ROW)));
  let timer = null, placed = false;
  col.addEventListener('scroll', () => {
    const r = rawNow();
    mark(r);
    clearTimeout(timer);
    timer = setTimeout(() => {
      // drifting toward either end of a looping list: jump back to the same value in the middle copy
      if (loop && (r < n * 3 || r > n * (CYCLES - 3))) col.setRaw(MID * n + (r % n));
      onPick(r % n);
    }, 90);
  });
  col.setRaw = r => { col.scrollTop = r * ROW; mark(r); placed = true; };
  col.setIndex = i => col.setRaw(MID * n + i);
  // the row in the middle right now (even mid-spin), so a quick Save never gets the previous value
  col.index = () => (placed ? rawNow() % n : index);
  // items for the value at position i (every copy of it, for looping lists)
  col.items = labels.map((_, i) => items[MID * n + i]);
  col.allItems = items;
  mark(MID * n + index);
  setTimeout(() => col.setIndex(index), 0); // once it's on the page
  return col;
}

// compact: three rows tall (the picked row plus one faded row above and below)
function dateWheels(initial, { minYear, maxYear, onChange, compact = false } = {}) {
  let m = initial.getMonth(), d = initial.getDate(), y = initial.getFullYear();
  minYear = Math.min(minYear ?? y - 5, y); maxYear = Math.max(maxYear ?? y + 5, y);
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i);
  const days = Array.from({ length: 31 }, (_, i) => i + 1);

  const fixDay = () => {
    const max = daysInMonth(y, m);
    dayWheel.allItems.forEach((it, i) => it.classList.toggle('off', (i % 31) + 1 > max));
    if (d > max) { d = max; dayWheel.setIndex(d - 1); }
    onChange?.(new Date(y, m, d));
  };
  const monthWheel = wheel(MONTH_SHORT, m, i => { m = i; fixDay(); }, 'wheel-month');
  const dayWheel = wheel(days, d - 1, i => { d = i + 1; fixDay(); }, 'wheel-day');
  const yearWheel = wheel(years, y - minYear, i => { y = years[i]; fixDay(); }, 'wheel-year');
  fixDay();
  return {
    node: el('div', { class: `wheels${compact ? ' compact' : ''}` }, monthWheel, dayWheel, yearWheel),
    get: () => {
      const yy = years[yearWheel.index()], mm = monthWheel.index(), dd = dayWheel.index() + 1;
      return new Date(yy, mm, Math.min(dd, daysInMonth(yy, mm)));
    },
  };
}

// Time picker with spinning wheels: hour, minute (5-minute steps) and AM/PM. get() returns [hours 0-23, minutes].
function timeWheels(initial, { compact = false } = {}) {
  const hours = Array.from({ length: 12 }, (_, i) => i + 1);
  const minutes = Array.from({ length: 12 }, (_, i) => pad2(i * 5));
  const h24 = initial.getHours(), min = Math.min(55, Math.round(initial.getMinutes() / 5) * 5);
  const hourWheel = wheel(hours, (h24 % 12 || 12) - 1, () => {}, 'wheel-hour', { loop: true }); // … 11, 12, 1, 2 …
  const minuteWheel = wheel(minutes, min / 5, () => {}, 'wheel-minute', { loop: true }); // … 50, 55, 00, 05 …
  const ampmWheel = wheel(['AM', 'PM'], h24 >= 12 ? 1 : 0, () => {}, 'wheel-ampm');
  return {
    node: el('div', { class: `wheels time-wheels${compact ? ' compact' : ''}` }, hourWheel, minuteWheel, ampmWheel),
    get: () => {
      const h = hours[hourWheel.index()] % 12 + (ampmWheel.index() ? 12 : 0);
      return [h, minuteWheel.index() * 5];
    },
  };
}

$('#btn-reminder').addEventListener('click', () => {
  const input = el('input', { class: 'text-input', type: 'time', value: form.reminder || '09:00' });
  openSheet(
    el('h3', {}, 'Daily reminder'),
    el('p', {}, 'You’ll get a banner at this time. iPhone only lets web apps send it while Goalie is open or was used recently. For a guaranteed alert, also set an iPhone Reminder.'),
    input,
    el('button', {
      class: 'sheet-btn primary',
      onclick: () => { form.reminder = input.value || null; syncForm(); closeSheet(); ensureNotifyPermission(); },
    }, 'Save reminder'),
    el('button', { class: 'sheet-btn', onclick: () => { form.reminder = null; syncForm(); closeSheet(); } }, 'No reminder'),
  );
});

$('#create-form').addEventListener('submit', e => e.preventDefault());

// Multiply amounts by this when switching units (null: no conversion possible).
function unitFactor(from, to) {
  if (from === to) return 1;
  if (from === 'minutes' && to === 'hours') return 1 / 60;
  if (from === 'hours' && to === 'minutes') return 60;
  return null;
}
let unitChangeOk = false; // the "change the unit anyway?" warning was accepted for this edit

$('#btn-submit').addEventListener('click', () => {
  validateForm();
  if ($('#btn-submit').disabled) return;
  // Changing the unit of a goal with history: convert minutes ↔ hours, warn about anything else.
  const old = editingId && state.tallies.find(t => t.id === editingId);
  const logged = old ? entriesFor(old.id) : [];
  const factor = old ? unitFactor(old.unit, form.unit) : 1;
  if (logged.length && factor == null && !unitChangeOk) {
    const n = logged.length;
    openSheet(
      el('h3', {}, 'Change the unit?'),
      el('p', {}, form.unit === 'check'
        ? `${old.name} has ${n} entr${n === 1 ? 'y' : 'ies'}. As a check-off goal, any day (or period) with an entry will count as done.`
        : `${old.name} has ${n} entr${n === 1 ? 'y' : 'ies'} logged in ${unitLabel(old)}. They keep their numbers, so ${fmt(logged[0].value)} ${unitLabel(old)} becomes ${fmt(logged[0].value)} ${unitLabel(form) || 'of the new unit'}.`),
      el('button', { class: 'sheet-btn primary', onclick: () => { unitChangeOk = true; closeSheet(); $('#btn-submit').click(); } }, 'Change anyway'),
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Keep editing'),
    );
    return;
  }
  if (logged.length && factor && factor !== 1) {
    logged.forEach(e => { e.value = +(e.value * factor).toFixed(6); });
    delete entryHistory[old.id]; // undo steps were in the old unit
  }
  const data = {
    ...form,
    name: form.name.trim(),
    bottomText: (form.bottomText || '').trim(),
    groups: [...new Set(form.groups.map(g => g.trim()).filter(Boolean))],
    group: (form.groups[0] || '').trim(),
    examples: (form.examples || '').trim(),
    nonExamples: (form.nonExamples || '').trim(),
    days: measuredWeekdays(form).slice(),
  };
  if (editingId) {
    const i = state.tallies.findIndex(t => t.id === editingId);
    if (i >= 0) state.tallies[i] = { ...state.tallies[i], ...data, id: editingId };
  } else {
    state.tallies.push({ ...data, id: uid(), createdAt: Date.now() });
    if (!matchesFilter(data, state.settings.filter || 'all')) state.settings.filter = 'all';
    if (!matchesGroup(data, state.settings.groupFilter || '')) state.settings.groupFilter = '';
  }
  save();
  renderToday();
  closeScreen('create');
});

$('#btn-history').addEventListener('click', () => {
  const t = state.tallies.find(x => x.id === editingId);
  if (t) historySheet(t);
});

$('#btn-delete').addEventListener('click', () => {
  const t = state.tallies.find(x => x.id === editingId);
  if (t) { deleteTally(t); closeScreen('create'); }
});

/* =========================================================
   Statistics
   ========================================================= */
const statsState = { range: 'week', offset: 0, view: 'bars' };

function statsRange() {
  const now = new Date();
  const { range, offset } = statsState;
  if (range === 'day') {
    const start = addDays(startOfDay(now), offset);
    return { start, end: addDays(start, 1), buckets: 24 };
  }
  if (range === 'week') {
    const start = addDays(startOfWeek(now), offset * 7);
    return { start, end: addDays(start, 7), buckets: 7 };
  }
  if (range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    return { start, end, buckets: daysInMonth(start.getFullYear(), start.getMonth()) };
  }
  const start = new Date(now.getFullYear() + offset, 0, 1);
  return { start, end: new Date(start.getFullYear() + 1, 0, 1), buckets: 12 };
}

function rangeLabel({ start, end }) {
  const { range } = statsState;
  if (range === 'month') return `${MONTH_LONG[start.getMonth()]} ${start.getFullYear()}`;
  if (range === 'year') return String(start.getFullYear());
  if (range === 'day') return `${DAY_NAMES[start.getDay()]}, ${MONTH_SHORT[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
  const last = addDays(end, -1);
  const a = `${MONTH_SHORT[start.getMonth()]} ${start.getDate()}`;
  const b = `${MONTH_SHORT[last.getMonth()]} ${last.getDate()}, ${last.getFullYear()}`;
  return start.getFullYear() === last.getFullYear() ? `${a} - ${b}` : `${a}, ${start.getFullYear()} - ${b}`;
}

function bucketIndex(ts, start) {
  const d = new Date(ts);
  if (statsState.range === 'year') return d.getMonth();
  if (statsState.range === 'day') return d.getHours();
  return Math.round((startOfDay(d) - startOfDay(start)) / DAY_MS);
}

function bucketLabels(r) {
  if (statsState.range === 'day') {
    return Array.from({ length: 24 }, (_, h) => ({ 0: '12a', 6: '6a', 12: '12p', 18: '6p' }[h] || ''));
  }
  if (statsState.range === 'week') {
    return Array.from({ length: 7 }, (_, i) => DAY_SHORT[(state.settings.weekStart + i) % 7]);
  }
  if (statsState.range === 'month') {
    return Array.from({ length: r.buckets }, (_, i) => ((i % 7) === 0 ? String(i + 1) : ''));
  }
  return 'JFMAMJJASOND'.split('');
}

function niceMax(v) {
  if (v <= 10) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function renderStats() {
  startDayCache = new Map();
  try { drawStats(); } finally { startDayCache = null; }
}

function drawStats() {
  const name = (state.settings.name || '').trim();
  $('#stats-title').textContent = name ? `Here are your STATS, ${name}!` : 'Here are your STATS!';
  const r = statsRange();
  $('#range-label').textContent = statsState.view === 'calendar' ? calendarLabel() : rangeLabel(r);
  $('#range-next').disabled = (statsState.view === 'calendar' ? calState.offset : statsState.offset) >= 0;
  $$('#range-tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === statsState.range));
  $$('.view-btn').forEach(b => b.classList.toggle('on', b.dataset.view === statsState.view));

  // Which goals to show: the Show dropdown (goal types and groups, any mix).
  renderShowPanel();
  const calendar = statsState.view === 'calendar';
  $('#range-tabs').classList.toggle('hidden', calendar);
  statsModel = { kind: calendar ? 'calendar' : statsState.view, rangeText: '', cards: [] };

  const list = $('#stats-list');
  list.innerHTML = '';
  if (!state.tallies.length) {
    list.append(el('div', { class: 'empty' }, el('strong', {}, 'No data yet'), 'Set a goal to see your stats.'));
    return;
  }
  if (calendar) {
    // goals picked in GOALS that GROUPS (or the calendar type) now hides are unpicked; none left = All
    const picked = state.settings.calGoals;
    if (picked) {
      const ok = new Set(calendarGoalChoices().map(t => t.id));
      const kept = picked.filter(id => ok.has(id));
      if (kept.length !== picked.length) { state.settings.calGoals = kept.length ? kept : null; save(); renderShowPanel(); }
    }
    renderCalendar(list, state.tallies.filter(calendarShows));
    return;
  }
  const shown = state.tallies.filter(statsShows);
  statsModel.rangeText = rangeLabel(r);
  if (!shown.length) {
    list.append(el('div', { class: 'empty' }, el('strong', {}, 'No goals here'), 'Turn on more goal types or groups in SHOW at the top.'));
    return;
  }

  list.append(el('p', { class: 'stats-hint' }, statsState.range === 'year' ? 'Tap a month to zoom in.' : 'Tap a bar or point to see or edit that day.'));
  const startMs = r.start.getTime(), endMs = r.end.getTime();
  const currentIdx = Date.now() >= startMs && Date.now() < endMs ? bucketIndex(Date.now(), r.start) : -1;
  const periodWord = statsState.range.toUpperCase();

  for (const t of shown) {
    const entries = countedEntries(t).filter(e => e.ts >= startMs && e.ts < endMs);
    const sums = new Array(r.buckets).fill(0);
    const isDay = statsState.range === 'day';
    const active = new Set();
    let total = 0;
    for (const e of entries) {
      sums[bucketIndex(e.ts, r.start)] += e.value;
      active.add(isDay ? new Date(e.ts).getHours() : dayKey(e.ts));
      total += e.value;
    }
    // Average over every measured day (the weekdays picked for the goal), whether or not anything was logged.
    const measured = measuredDays(t, startMs, endMs);
    const avgPer = averagePeriod(t);
    const periods = avgPer ? measuredPeriods(t, avgPer, startMs, endMs) : measured;
    const avg = periods ? total / periods : 0;
    // Weekly, monthly and yearly goals average per week/month/year; on views no longer than one goal
    // period (a weekly goal on Week, a yearly goal on any view) only the total makes sense.
    const totalOnly = isDay || (avgPer && PERIOD_DAYS[avgPer] >= PERIOD_DAYS[statsState.range]);
    const totalText = `${amountText(t, total).toUpperCase()}${isMoney(t) || isDuration(t) ? ' TOTAL' : ''}`;

    const card = el('div', { class: `stat-card ${cardColorClass(t)}`, style: cardColorStyle(t, 'stat') },
      el('h3', {}, goalTitle(t)),
      el('div', { class: 'stat-sub' }, isCheck(t)
        ? `${fmt(total)} ✓ ${total === 1 ? 'CHECK-IN' : 'CHECK-INS'}`
        : totalOnly ? totalText
        : `${totalText} · ${isDuration(t) ? amountText(t, avg).toUpperCase() : num(t, avg)} PER ${avgPer ? avgPer.toUpperCase() : 'MEASURED DAY'}`));

    const pick = i => pickBucket(t, r, i);
    const isBars = statsState.view === 'bars';
    let values = sums, goal = goalForChart(t), caption = null;
    const lastIdx = currentIdx >= 0 ? currentIdx : (r.start.getTime() > Date.now() ? -1 : sums.length - 1);
    if (showsRunningTotal(t)) {
      // The goal's period is as long as the chart or longer (weekly goal on Week or Month, yearly goal
      // on any view…): show the total so far in each goal period climbing toward the goal, starting
      // over when a new period begins.
      values = runningTotals(t, r, sums, lastIdx);
      goal = t.target;
      caption = t.reset === statsState.range || byDate(t) ? 'RUNNING TOTAL' : `RUNNING ${RESET_ADJ[t.reset]} TOTAL`;
    } else if (statsState.range === 'year') {
      // How many goal periods each month counted (tracked days so far, in the goal's own period).
      const counts = sums.map((_, i) => periodsCounted(t, r.start.getFullYear(), i));
      const per = PERIOD_NOUN[t.reset] || 'day';
      if (isBars) {
        // Average per measured day (or week…) in each month, logged or not.
        values = sums.map((v, i) => (counts[i] > 0 ? v / counts[i] : 0));
        goal = isCheck(t) ? 0 : (t.target > 0 ? t.target : 0);
        caption = `AVERAGE PER MEASURED ${per.toUpperCase()} EACH MONTH`;
      } else {
        goal = !isCheck(t) && t.target > 0 ? counts.map(c => (c > 0 ? t.target * c : null)) : 0;
        caption = 'TOTAL EACH MONTH';
      }
    }
    if (!isBars && statsState.range === 'year') goal = 0; // Year line charts: no dashed goal line
    const scale = chartScale(t, values, goal);
    statsModel.cards.push({ t, values, labels: bucketLabels(r), currentIdx, scale, goal, caption, sub: card.querySelector('.stat-sub').textContent, isBars });
    card.append(isBars
      ? barChart(values, bucketLabels(r), currentIdx, pick, scale, goal, caption)
      : lineChart(t, values, bucketLabels(r), currentIdx, pick, scale, goal, caption));
    list.append(card);
  }
}

const RESET_ADJ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };

function showsRunningTotal(t) {
  if (isCheck(t) || !(t.target > 0)) return false;
  if (byDate(t)) return true; // by-date goals: everything so far, climbing toward the goal
  if (!(t.reset in RESET_ADJ)) return false;
  const range = statsState.range;
  if (range === 'year') return t.reset === 'year'; // weekly/monthly goals on Year use per-month averages and totals
  return t.reset !== 'day' || range === 'day'; // daily goals on Week/Month compare each day to the goal instead
}

// When the goal period containing a moment began.
function goalPeriodStart(reset, d) {
  if (reset === 'week') return startOfWeek(d);
  if (reset === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
  if (reset === 'year') return new Date(d.getFullYear(), 0, 1);
  if (reset === 'never') return new Date(0); // by-date goals never start over
  return startOfDay(d);
}

// Running total for each chart step: everything logged so far in that step's goal period.
function runningTotals(t, r, sums, lastIdx) {
  const range = statsState.range;
  const stepStart = i => (range === 'year' ? new Date(r.start.getFullYear(), i, 1)
    : range === 'day' ? new Date(r.start.getFullYear(), r.start.getMonth(), r.start.getDate(), i)
    : addDays(r.start, i));
  // anything logged earlier in the first step's period, before this chart starts
  const firstPeriod = goalPeriodStart(t.reset, r.start).getTime();
  let run = countedEntries(t).reduce((s, e) => (e.ts >= firstPeriod && e.ts < r.start.getTime() ? s + e.value : s), 0);
  let period = firstPeriod;
  return sums.map((v, i) => {
    if (i > lastIdx) return 0;
    const p = goalPeriodStart(t.reset, stepStart(i)).getTime();
    if (p !== period) { period = p; run = 0; }
    return (run += v);
  });
}

// The goal per chart step, when the goal's period matches the steps (daily goal on Week/Month, etc.).
function goalForChart(t) {
  if (isCheck(t) || !(t.target > 0)) return 0;
  const range = statsState.range;
  const fits = (range === 'day' && (t.reset === 'hour' || t.reset === 'day')) ||
    (t.reset === 'day' && (range === 'week' || range === 'month')) ||
    (t.reset === 'month' && range === 'year');
  return fits ? t.target : 0;
}

const PERIOD_NOUN = { minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month', year: 'year', never: 'day' };

// Goal periods a month "counted": tracked days in that month up to today, expressed in the goal's period
// (7 days = 1 week, any tracked day = 1 month…). Future months count 0.
// Which goal period an entry falls in (for counting "active" days, weeks…).
function activePeriodKey(reset, ts) {
  const d = new Date(ts);
  switch (reset) {
    case 'minute': return d.getTime() - (d.getTime() % 60000);
    case 'hour': return dayKey(d) + ':' + d.getHours();
    case 'week': return dayKey(startOfWeek(d));
    case 'month': return d.getFullYear() + '-' + d.getMonth();
    case 'year': return d.getFullYear();
    default: return dayKey(d);
  }
}

// The day a goal started counting: when it was created, or earlier if entries were added for earlier days.
// (A repeated by-date goal starts again from its new run.) Cached while the Stats page draws,
// since it's asked for many times per goal.
let startDayCache = null;
function goalStartDay(t) {
  if (startDayCache?.has(t.id)) return startDayCache.get(t.id);
  let start = t.createdAt ? startOfDay(new Date(t.createdAt)).getTime() : Infinity;
  for (const e of state.entries) if (e.tallyId === t.id && e.ts < start) start = startOfDay(new Date(e.ts)).getTime();
  if (start === Infinity) start = startOfDay(new Date()).getTime();
  if (t.countFrom) start = Math.max(start, startOfDay(new Date(t.countFrom)).getTime());
  startDayCache?.set(t.id, start);
  return start;
}

// Measured days between two times: the goal's selected weekdays, from its start day, up to today.
// everyDay: count calendar days instead (weeks, months and years are calendar time even when only
// some weekdays are measured).
function measuredDays(t, fromMs, toMs, everyDay = false) {
  const end = Math.min(toMs, addDays(startOfDay(new Date()), 1).getTime());
  let days = 0;
  for (let d = new Date(Math.max(fromMs, goalStartDay(t))); d.getTime() < end; d = addDays(d, 1)) {
    if (everyDay || !t.days || t.days.includes(d.getDay())) days++;
  }
  return days;
}

const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const averagePeriod = t => (['week', 'month', 'year'].includes(t.reset) ? t.reset : null);

// How many weeks, months or years were measured between two times (partial ones count as a fraction).
function measuredPeriods(t, per, fromMs, toMs) {
  if (per === 'week') return measuredDays(t, fromMs, toMs, true) / 7;
  let n = 0;
  for (let d = new Date(fromMs); d.getTime() < toMs;) {
    const next = per === 'month' ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : new Date(d.getFullYear() + 1, 0, 1);
    const start = per === 'month' ? new Date(d.getFullYear(), d.getMonth(), 1) : new Date(d.getFullYear(), 0, 1);
    const len = Math.round((next - start) / DAY_MS);
    n += measuredDays(t, d.getTime(), Math.min(next.getTime(), toMs), true) / len;
    d = next;
  }
  return n;
}

function periodsCounted(t, year, month) {
  const from = new Date(year, month, 1).getTime(), to = new Date(year, month + 1, 1).getTime();
  const days = measuredDays(t, from, to, ['week', 'month', 'year'].includes(t.reset));
  switch (t.reset) {
    case 'minute': return days * 1440;
    case 'hour': return days * 24;
    case 'week': return days / 7;
    case 'month': return days > 0 ? 1 : 0;
    case 'year': return days / 365;
    default: return days;
  }
}

// Top of the y-axis: the goal itself (30 for "30 minutes a day"), or the biggest value if one went past it.
function chartScale(t, sums, goal) {
  const top = Math.max(0, ...sums);
  if (Array.isArray(goal)) return Math.max(top, ...goal.filter(g => g != null), 0) || niceThirds(top);
  if (isCheck(t)) return Math.max(1, top);
  if (goal) return Math.max(goal, top);
  return niceThirds(top);
}

// A tidy top value that splits into thirds (3, 6, 15, 30, 60…), used when there's no goal to scale to.
function niceThirds(v) {
  if (!(v > 0)) return 3;
  for (let k = -2; k < 9; k++) for (const m of [1, 2, 5]) { const step = m * Math.pow(10, k); if (step * 3 >= v) return step * 3; }
  return v;
}
const axisNum = v => fmt(Math.round(v * 10) / 10);
// Rows between the y-axis numbers: whole numbers for small tops (0–1, 0–1–2), thirds otherwise.
const axisRows = max => (max <= 1 ? 1 : max === 2 ? 2 : 3);

// Y-axis labels: 0, ⅓, ⅔ and the top — or just 0 and the top when the top is 1 or less.
function yAxisLabels(max) {
  const rows = axisRows(max);
  return Array.from({ length: rows + 1 }, (_, i) => {
    const frac = i / rows; // 0 = top
    return el('span', { style: `top:${frac * 100}%` }, axisNum(max * (1 - frac)));
  });
}

function barChart(sums, labels, currentIdx, onPick, max, goal, caption) {
  const yAxis = el('div', { class: 'y-axis', style: 'height:var(--chart-h)' }, yAxisLabels(max));
  const bars = el('div', { class: 'bars' },
    goal ? el('div', { class: 'bar-goal', style: `bottom:${(goal / max) * 100}%`, 'aria-hidden': 'true' }) : null,
    sums.map((v, i) => el('div', { class: `bar-col${i === currentIdx ? ' current' : ''}`, onclick: () => onPick(i) },
      el('div', { class: 'bar-track' },
        el('div', { class: 'bar-fill', style: `height:${Math.max(0, Math.min(100, (v / max) * 100))}%` })))));
  const xl = el('div', { class: 'x-labels' }, labels.map(l => el('span', { style: 'display:flex;justify-content:center' }, l)));
  return el('div', {},
    caption ? el('div', { class: 'chart-caption' }, caption) : null,
    el('div', { class: 'chart' }, yAxis, el('div', { class: 'plot' }, bars, xl)));
}

// Line chart: y = amount in the goal's own unit, one point per day (or per month in Year view).
function lineChart(t, sums, labels, currentIdx, onPick, max, goal, caption) {
  const n = sums.length;
  const span = n - 1;
  // Don't draw into the future: stop at today in the current period.
  const last = currentIdx >= 0 ? currentIdx : n - 1;

  const { range } = statsState;
  const goalFits = Array.isArray(goal) ? goal.some(g => g != null) : goal > 0; // dashed goal line only when the goal fits the chart's steps
  const yOf = v => 100 - (v / max) * 100;
  const xOf = i => (span ? (i / span) * 100 : 50);

  const colw = range === 'month' ? (7 / span) * 100 : range === 'day' ? (6 / span) * 100 : 100 / span;
  // background rows line up with the y-axis numbers
  const plot = el('div', { class: 'scatter', style: `--colw:${colw}%;--rows:${axisRows(max)}` });
  const points = sums.slice(0, last + 1).map((v, i) => ({ x: xOf(i), y: yOf(v), v, i }));

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'scatter-line');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  if (goalFits) {
    const g = Array.isArray(goal)
      // Year: the goal for each month (goal × days counted), joined month to month
      ? document.createElementNS(NS, 'polyline')
      : document.createElementNS(NS, 'line');
    g.setAttribute('class', 'goal-line');
    if (Array.isArray(goal)) {
      g.setAttribute('points', goal.map((v, i) => (v == null ? null : `${xOf(i)},${yOf(v)}`)).filter(Boolean).join(' '));
      g.setAttribute('fill', 'none');
    } else {
      g.setAttribute('x1', '0'); g.setAttribute('x2', '100');
      g.setAttribute('y1', String(yOf(goal))); g.setAttribute('y2', String(yOf(goal)));
    }
    g.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(g);
  }
  if (points.length > 1) {
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', points.map(p => `${p.x},${p.y}`).join(' '));
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
  }
  plot.append(svg);

  for (const p of points) {
    plot.append(el('button', { type: 'button', class: 'pt', style: `left:${p.x}%;top:${p.y}%`, 'aria-label': amountText(t, p.v), onclick: () => onPick(p.i) }));
  }

  const yAxis = el('div', { class: 'y-axis', style: 'height:var(--chart-h)' }, yAxisLabels(max));
  const xl = el('div', { class: 'x-labels line-x' },
    labels.map((l, i) => (l ? el('span', { style: `left:${xOf(i)}%` }, l) : null)));

  return el('div', {},
    caption ? el('div', { class: 'chart-caption' }, caption) : null,
    el('div', { class: 'chart' }, yAxis, el('div', { class: 'plot line-plot' }, plot, xl)));
}


$('#range-tabs').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  statsState.range = b.dataset.v; statsState.offset = 0; renderStats();
});
// ‹ › (and swipes) move the charts' period, or the calendar's month / year / five years.
function shiftStats(step) {
  const o = statsState.view === 'calendar' ? calState : statsState;
  if (step > 0 && o.offset >= 0) return false;
  o.offset += step;
  renderStats();
  return true;
}
$('#range-prev').addEventListener('click', () => shiftStats(-1));
$('#range-next').addEventListener('click', () => shiftStats(1));
$$('.view-btn').forEach(b => b.addEventListener('click', () => { statsState.view = b.dataset.view; renderStats(); }));

// Swipe left/right on stats to change period
(() => {
  let sx = null, sy = null;
  const list = $('#stats-list');
  list.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  list.addEventListener('touchend', e => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;
    shiftStats(dx > 0 ? -1 : 1);
  });
})();

/* ---------- Streaks ----------
   How many periods in a row a goal has been completed (met, or within the limit for decrease
   goals), counting back from the current period (which counts once it's completed). Days a goal
   doesn't measure are skipped, not counted as misses. */
function goalStreak(t) {
  if (byDate(t) || !(t.target > 0 || isCheck(t)) || !['day', 'week', 'month', 'year'].includes(t.reset)) return 0;
  const startDay = goalStartDay(t), entries = countedEntries(t);
  const done = (from, to) => {
    const total = entries.reduce((s, e) => (e.ts >= from && e.ts < to ? s + e.value : s), 0);
    if (isCheck(t)) return t.direction === 'decrease' ? total === 0 : total >= 1;
    return t.direction === 'decrease' ? total <= t.target : total >= t.target;
  };
  let from = periodStart(t.reset), streak = 0;
  for (let i = 0; i < 1000; i++) {
    const to = nextPeriodStart(t.reset, from);
    if (to.getTime() <= startDay) break; // before the goal existed
    const measured = t.reset !== 'day' || measuredWeekdays(t).includes(from.getDay());
    if (measured) {
      if (done(from.getTime(), to.getTime())) streak++;
      else if (i > 0) break; // the current period can still be completed
    }
    from = periodStart(t.reset, new Date(from.getTime() - 1));
  }
  return streak;
}
const STREAK_UNIT = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] };
function streakLine(t, n) {
  const [one, many] = STREAK_UNIT[t.reset];
  return t.direction === 'decrease' && !isCheck(t) ? `${n} ${n === 1 ? one : many} within your limit` : `${n} ${n === 1 ? one : many} in a row`;
}

// The first time Goalie is opened each day: what you're doing well at.
function streakPopup() {
  const today = dayKey(new Date());
  if (state.settings.streakDay === today || !state.tallies.length) return;
  state.settings.streakDay = today; save();
  const streaks = state.tallies.map(t => ({ t, n: goalStreak(t) })).filter(x => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 6);
  // yesterday's daily goals
  const y0 = addDays(startOfDay(new Date()), -1).getTime(), y1 = startOfDay(new Date()).getTime();
  const daily = state.tallies.filter(t => t.reset === 'day' && !byDate(t) && (t.target > 0 || isCheck(t)) && goalStartDay(t) <= y0 && measuredWeekdays(t).includes(new Date(y0).getDay()));
  const doneYesterday = daily.filter(t => { const n = countedEntries(t).reduce((s, e) => (e.ts >= y0 && e.ts < y1 ? s + e.value : s), 0); return isCheck(t) ? (t.direction === 'decrease' ? n === 0 : n >= 1) : (t.direction === 'decrease' ? n <= t.target : n >= t.target); });
  const visionGroups = allGroupNames().filter(visionOf);
  const vg = visionGroups.length ? visionGroups[Math.floor(Date.now() / DAY_MS) % visionGroups.length] : null;
  if (!streaks.length && !doneYesterday.length && !vg) return; // nothing to show yet
  const name = (state.settings.name || '').trim();
  const lines = streaks.map(({ t, n }) => ({ name: t.name, color: t.color, text: streakLine(t, n), n }));
  const yesterday = daily.length ? `Yesterday you completed ${doneYesterday.length} of ${daily.length} daily goal${daily.length === 1 ? '' : 's'}.` : '';
  openSheet(
    el('h3', {}, name ? `Nice work, ${name}!` : 'Nice work!'),
    streaks.length || yesterday ? el('p', {}, streaks.length ? 'Here’s what you’re doing well at:' : yesterday) : null,
    streaks.length ? el('div', { class: 'streaks' }, lines.map(l => el('div', { class: 'streak-row' },
      el('span', { class: 'streak-n', style: `background:${l.color};color:${inkClass(l.color) === 'on-light' ? '#1c2a4a' : '#fff'}` }, String(l.n)),
      el('span', { class: 'streak-text' }, el('strong', {}, l.name), el('span', {}, l.text))))) : null,
    streaks.length && yesterday ? el('p', {}, yesterday) : null,
    vg ? el('div', { class: 'vision-card' }, el('div', { class: 'vision-card-head' }, eyeIcon(), `YOUR ${vg.toUpperCase()} VISION`), el('p', {}, visionOf(vg))) : null,
    el('button', { class: 'sheet-btn primary', onclick: closeSheet }, 'Let’s go'),
    el('button', { class: 'sheet-btn', onclick: () => shareImage(drawStreakImage(lines, yesterday, name), 'goalie-streaks') }, 'Share'),
  );
}
function drawStreakImage(lines, yesterday, name) {
  const { c, g } = imageCanvas(270 + lines.length * 140 + (yesterday ? 100 : 0) + 120);
  let y = imageHeader(g, name ? `${name}’s streaks` : 'My streaks', longDate(toDateInput(new Date())));
  for (const l of lines) {
    g.fillStyle = l.color; g.beginPath(); g.arc(PAD + 50, y + 50, 50, 0, Math.PI * 2); g.fill();
    g.fillStyle = inkClass(l.color) === 'on-light' ? '#1c2a4a' : '#fff'; g.font = `800 40px ${FONT}`; g.textAlign = 'center';
    g.fillText(String(l.n), PAD + 50, y + 64); g.textAlign = 'left';
    g.fillStyle = '#1c2a4a'; g.font = `700 40px ${FONT}`; g.fillText(l.name, PAD + 130, y + 42);
    g.fillStyle = '#6b7280'; g.font = `600 30px ${FONT}`; g.fillText(l.text, PAD + 130, y + 86);
    y += 140;
  }
  if (yesterday) { g.fillStyle = '#1c2a4a'; g.font = `600 30px ${FONT}`; g.fillText(yesterday, PAD, y + 40); y += 100; }
  imageFooter(g, y + 40);
  return c;
}

/* ---------- Stats: SHOW dropdown (goal types + groups, any mix) ---------- */
const STAT_TYPES = [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly'], ['date', 'Custom date'], ['hour', 'Hourly'], ['minute', 'Per minute']];
const statType = t => (byDate(t) ? 'date' : t.reset);
// settings.statsTypes / statsGroups: null = everything on, otherwise the list that's on
function statsGroupOk(t) {
  const groups = state.settings.statsGroups;
  if (!groups) return true;
  const gs = groupsOf(t);
  return gs.length ? gs.some(g => groups.includes(g)) : groups.includes(NO_GROUP);
}
function statsShows(t) {
  const types = state.settings.statsTypes;
  if (types && !types.includes(statType(t))) return false;
  return statsGroupOk(t);
}
// Calendar: no goal-type filter (the calendar has its own DAILY/WEEKLY… buttons); groups, then picked goals.
const calendarGoalChoices = () => state.tallies.filter(t => !byDate(t) && t.reset === calState.type && (t.target > 0 || isCheck(t)) && statsGroupOk(t));
function calendarShows(t) {
  const picked = state.settings.calGoals;
  return statsGroupOk(t) && (!picked || picked.includes(t.id));
}
function showSummary() {
  const types = statsState.view === 'calendar' ? null : state.settings.statsTypes, groups = state.settings.statsGroups;
  const parts = [];
  if (statsState.view === 'calendar' && state.settings.calGoals) {
    const names = state.tallies.filter(t => state.settings.calGoals.includes(t.id)).map(t => t.name);
    parts.push(names.length ? names.join(', ') : 'No goals');
  }
  if (types) parts.push(types.length ? STAT_TYPES.filter(([k]) => types.includes(k)).map(([, n]) => n).join(', ') : 'No types');
  if (groups) parts.push(groups.length ? groups.map(g => (g === NO_GROUP ? 'No group' : g)).join(', ') : 'No groups');
  return parts.length ? parts.join(' · ') : 'All goals';
}
// SHOW panel: GOAL TYPES and GROUPS side by side (each "All" to start). Tapping one drops down its
// chips; picked chips turn navy. From All, tapping a chip shows just that one; tap more to add them.
let showOpen = 'types'; // which list is dropped down: 'types' | 'groups' | null
function renderShowPanel() {
  $('#stats-show-value').textContent = showSummary();
  const panel = $('#stats-show-panel');
  const open = !panel.classList.contains('hidden');
  $('#stats-show').setAttribute('aria-expanded', String(open));
  $('#stats-show').classList.toggle('open', open);
  if (!open) return;
  panel.innerHTML = '';
  const typesHere = STAT_TYPES.filter(([k]) => ['day', 'week', 'month', 'year', 'date'].includes(k) || state.tallies.some(t => statType(t) === k));
  const groupsHere = [...allGroupNames(), ...(state.tallies.some(t => !groupsOf(t).length) ? [NO_GROUP] : [])].map(g => [g, g === NO_GROUP ? 'No group' : g]);
  const calendar = statsState.view === 'calendar';
  // goal chips wear each goal's own card + text colors
  const goalsHere = calendar ? calendarGoalChoices().map(t => [t.id, t.name, `--chip-bg:${t.color};--chip-ink:${t.textColor || (inkClass(t.color) === 'on-light' ? '#1c2a4a' : '#ffffff')}`]) : [];
  const lists = calendar
    ? { groups: ['GROUPS', 'statsGroups', groupsHere], goals: ['GOALS', 'calGoals', goalsHere] }
    : { types: ['GOAL TYPES', 'statsTypes', typesHere], groups: ['GROUPS', 'statsGroups', groupsHere] };
  if (!lists[showOpen]) showOpen = Object.keys(lists)[0];
  const picked = key => state.settings[key]; // null = All
  const summary = (key, items) => {
    const list = picked(key);
    if (!list) return 'All';
    const names = items.filter(([k]) => list.includes(k)).map(([, n]) => n);
    return names.length <= 2 ? names.join(', ') : `${names.length} selected`;
  };
  const pick = (key, items, k) => {
    const list = picked(key);
    let next;
    if (k === null) next = null; // All
    else if (!list) next = [k]; // from All: just this one
    else next = list.includes(k) ? list.filter(x => x !== k) : [...list, k];
    if (next && (next.length === 0 || next.length === items.length)) next = null; // none or every one = All
    state.settings[key] = next;
    save(); $('#stats-list').scrollTop = 0; renderStats();
  };
  panel.append(el('div', { class: 'show-tabs' }, Object.entries(lists)
    .filter(([id, [, , items]]) => id !== 'groups' || items.length)
    .map(([id, [title, key, items]]) => el('button', {
      type: 'button',
      class: `show-tab${showOpen === id ? ' open' : ''}${picked(key) ? ' filtered' : ''}`,
      'aria-expanded': String(showOpen === id),
      onclick: () => { showOpen = showOpen === id ? null : id; renderShowPanel(); },
    }, el('span', { class: 'show-tab-title' }, title), el('span', { class: 'show-tab-value' }, summary(key, items)), el('span', { class: 'show-chev', 'aria-hidden': 'true' }, '›')))));
  if (showOpen && lists[showOpen][2].length) {
    const [, key, items] = lists[showOpen];
    const list = picked(key);
    panel.append(el('div', { class: 'show-chips' },
      el('button', { type: 'button', class: `group-chip${!list ? ' on' : ''}`, onclick: () => pick(key, items, null) }, 'All'),
      items.map(([k, label, style]) => el('button', { type: 'button', class: `group-chip${style ? ' goal-chip' : ''}${list && list.includes(k) ? ' on' : ''}`, style: style || '', 'aria-pressed': String(!!(list && list.includes(k))), onclick: () => pick(key, items, k) }, label))));
  } else if (showOpen === 'goals') {
    panel.append(el('p', { class: 'note show-empty' }, 'No goals with a goal amount for this calendar.'));
  }
}
$('#stats-show').addEventListener('click', () => { $('#stats-show-panel').classList.toggle('hidden'); renderShowPanel(); });

/* ---------- Stats: calendar ----------
   Colors show the share of goals completed in each day / week / month / year:
   red 0–33%, orange 34–66%, yellow 67–99%, green 100%. Settings decides whether a goal counts only
   once it's completed, or by how far along it got. */
const calState = { type: 'day', offset: 0 };
let statsModel = null; // what's on screen, for Share
const CAL_TYPES = [['day', 'DAILY'], ['week', 'WEEKLY'], ['month', 'MONTHLY'], ['year', 'YEARLY']];
const PCT_COLORS = [[33, '#ef4444'], [66, '#f97316'], [99, '#facc15'], [100, '#22c55e']];
// Over 100% (only possible with Average progress): a white box with gold lettering.
const OVER = 'over', GOLD = '#b8860b';
const pctColor = p => (p == null ? null : Math.round(p) > 100 ? OVER : PCT_COLORS.find(([max]) => Math.round(p) <= max)[1]);

function calendarRange() {
  const now = new Date(), o = calState.offset;
  if (calState.type === 'day' || calState.type === 'week') {
    const start = new Date(now.getFullYear(), now.getMonth() + o, 1);
    return { start, end: new Date(start.getFullYear(), start.getMonth() + 1, 1) };
  }
  if (calState.type === 'month') return { start: new Date(now.getFullYear() + o, 0, 1), end: new Date(now.getFullYear() + o + 1, 0, 1) };
  return { start: new Date(now.getFullYear() + o * 5 - 4, 0, 1), end: new Date(now.getFullYear() + o * 5 + 1, 0, 1) };
}
function calendarLabel() {
  const { start, end } = calendarRange();
  if (calState.type === 'day' || calState.type === 'week') return `${MONTH_LONG[start.getMonth()]} ${start.getFullYear()}`;
  if (calState.type === 'month') return String(start.getFullYear());
  return `${start.getFullYear()} – ${end.getFullYear() - 1}`;
}

// How one goal did in one period: 0..1, or null when it wasn't measured then.
function periodScore(t, from, to) {
  if (goalStartDay(t) >= to) return null; // the goal didn't exist yet
  if (calState.type === 'day' && !measuredWeekdays(t).includes(new Date(from).getDay())) return null;
  const total = countedEntries(t).reduce((s, e) => (e.ts >= from && e.ts < to ? s + e.value : s), 0);
  const down = t.direction === 'decrease';
  let progress;
  if (isCheck(t)) progress = down ? (total === 0 ? 1 : 0) : (total >= 1 ? 1 : 0);
  else if (down) progress = total <= t.target ? 1 : t.target / total;
  else progress = total / t.target; // Average progress counts going over (150% of the goal = 1.5)
  if ((state.settings.calendarMode || 'complete') === 'complete') return progress >= 1 ? 1 : 0;
  return progress;
}
// Average score of all the goals measured in a period, as a percentage (null: none measured / future).
function periodPct(goals, from, to) {
  if (from > Date.now()) return null;
  const scores = goals.map(t => periodScore(t, from, to)).filter(v => v != null);
  return scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) * 100 : null;
}

function renderCalendar(list, shown) {
  const type = calState.type;
  const goals = shown.filter(t => !byDate(t) && t.reset === type && (t.target > 0 || isCheck(t)));
  const { start, end } = calendarRange();
  const now = Date.now();
  const cells = []; // also used for Share: { label, sub, pct, from, to, current }
  const box = el('div', { class: `cal cal-${type}` });
  const pick = cell => calendarDaySheet(goals, cell);

  if (type === 'day') {
    const first = startOfWeek(start);
    box.append(el('div', { class: 'cal-grid cal-head' }, Array.from({ length: 7 }, (_, i) => el('span', {}, DAY_SHORT[(state.settings.weekStart + i) % 7]))));
    const grid = el('div', { class: 'cal-grid' });
    for (let d = new Date(first); d < end || d.getDay() !== state.settings.weekStart; d = addDays(d, 1)) {
      const inMonth = d >= start && d < end, from = d.getTime(), to = addDays(d, 1).getTime();
      const cell = { label: String(d.getDate()), from, to, pct: inMonth ? periodPct(goals, from, to) : null, current: now >= from && now < to, out: !inMonth };
      cells.push(cell);
      grid.append(calCell(cell, inMonth ? () => pick(cell) : null));
      if (d >= end && d.getDay() === (state.settings.weekStart + 6) % 7) break;
    }
    box.append(grid);
  } else if (type === 'week') {
    for (let w = startOfWeek(start); w < end; w = addDays(w, 7)) {
      const last = addDays(w, 6), from = w.getTime(), to = addDays(w, 7).getTime();
      const cell = { label: `${DAY_NAMES[w.getDay()]} ${MONTH_SHORT[w.getMonth()]} ${w.getDate()} – ${DAY_NAMES[last.getDay()]} ${MONTH_SHORT[last.getMonth()]} ${last.getDate()}`, from, to, pct: periodPct(goals, from, to), current: now >= from && now < to };
      cells.push(cell);
      box.append(calCell(cell, () => pick(cell), 'cal-bar'));
    }
  } else if (type === 'month') {
    const grid = el('div', { class: 'cal-tiles' });
    for (let m = 0; m < 12; m++) {
      const f = new Date(start.getFullYear(), m, 1), from = f.getTime(), to = new Date(start.getFullYear(), m + 1, 1).getTime();
      const cell = { label: MONTH_SHORT[m], from, to, pct: periodPct(goals, from, to), current: now >= from && now < to };
      cells.push(cell);
      grid.append(calCell(cell, () => pick(cell)));
    }
    box.append(grid);
  } else {
    const grid = el('div', { class: 'cal-tiles cal-years' });
    for (let y = start.getFullYear(); y < end.getFullYear(); y++) {
      const from = new Date(y, 0, 1).getTime(), to = new Date(y + 1, 0, 1).getTime();
      const cell = { label: String(y), from, to, pct: periodPct(goals, from, to), current: now >= from && now < to };
      cells.push(cell);
      grid.append(calCell(cell, () => pick(cell)));
    }
    box.append(grid);
  }

  const scored = cells.filter(c => !c.out && c.pct != null);
  const avg = scored.length ? scored.reduce((a, c) => a + c.pct, 0) / scored.length : null;
  const noun = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' }[type];
  const summary = !goals.length ? `No ${noun} goals with a goal amount are showing. Check SHOW at the top.`
    : avg == null ? 'Nothing to score yet in this period.'
    : `Average: ${Math.round(avg)}% of ${noun} goals ${(state.settings.calendarMode || 'complete') === 'complete' ? 'completed' : 'progress'} · ${goals.length} goal${goals.length === 1 ? '' : 's'}`;
  statsModel = { kind: 'calendar', type, rangeText: calendarLabel(), cells, summary, goals };

  list.append(
    el('div', { class: 'seg tabs cal-types' }, CAL_TYPES.map(([k, label]) =>
      el('button', { type: 'button', class: k === type ? 'on' : '', onclick: () => { calState.type = k; calState.offset = 0; state.settings.calGoals = null; save(); renderStats(); } }, label))),
    el('p', { class: 'cal-summary' }, summary),
    box,
    el('div', { class: 'cal-legend' }, [['0–33%', '#ef4444'], ['34–66%', '#f97316'], ['67–99%', '#facc15'], ['100%', '#22c55e'],
      ...((state.settings.calendarMode || 'complete') === 'average' ? [['Over 100%', OVER]] : [])]
      .map(([t, c]) => el('span', {}, el('i', { class: c === OVER ? 'over' : '', style: c === OVER ? '' : `background:${c}` }), t))));
}
function calCell(cell, onPick, cls = 'cal-cell') {
  const color = pctColor(cell.pct);
  return el('button', {
    type: 'button',
    class: `${cls}${cell.out ? ' out' : ''}${cell.current ? ' current' : ''}${color === OVER ? ' over' : color ? ' scored' : ''}${color === '#facc15' ? ' light' : ''}`,
    style: color && color !== OVER ? `background:${color}` : '',
    disabled: !onPick,
    onclick: onPick || null,
  }, el('span', { class: 'cal-l' }, cell.label), cell.pct != null && !cell.out ? el('span', { class: 'cal-p' }, `${Math.round(cell.pct)}%`) : null);
}
// Tap a day / week / month / year: how each goal did.
function calendarDaySheet(goals, cell) {
  const rows = goals.map(t => ({ t, score: periodScore(t, cell.from, cell.to),
    total: countedEntries(t).reduce((s, e) => (e.ts >= cell.from && e.ts < cell.to ? s + e.value : s), 0) }))
    .filter(r => r.score != null);
  const title = calState.type === 'day' ? (() => { const d = new Date(cell.from); return `${DAY_FULL[d.getDay()]}, ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`; })() : cell.label;
  openSheet(
    el('h3', {}, title),
    el('p', {}, cell.pct == null ? 'Nothing was measured then.' : `${Math.round(cell.pct)}% · ${rows.filter(r => r.score >= 1).length} of ${rows.length} completed`),
    el('div', { class: 'hist' }, rows.map(({ t, score, total }) => el('div', { class: 'hist-row' },
      el('span', { class: `cal-dot${score * 100 > 100.5 ? ' over' : ''}`, style: score * 100 > 100.5 ? '' : `background:${score >= 1 ? '#22c55e' : pctColor(score * 100)}` }),
      el('span', { class: 'hist-when' }, el('strong', {}, t.name)),
      el('span', { class: 'hist-amount' }, isCheck(t) ? (score >= 1 ? '✓' : '✗') : `${num(t, total)}/${num(t, t.target)}`)))),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Done'),
  );
}

/* ---------- Share: a picture of whatever Stats is showing ---------- */
$('#stats-share').addEventListener('click', () => shareImage(drawStatsImage(), 'goalie-stats'));

async function shareImage(canvas, name) {
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) { toast('Couldn’t make the picture'); return; }
  const file = new File([blob], `${name}-${toDateInput(new Date())}.png`, { type: 'image/png' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'My Goalie progress' }); return; }
  } catch (err) { if (err && err.name === 'AbortError') return; }
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Canvas helpers (the picture is drawn directly, at 1080px wide).
const W = 1080, PAD = 60, FONT = 'Outfit, -apple-system, sans-serif';
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function imageCanvas(height) {
  const c = document.createElement('canvas');
  c.width = W; c.height = height;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, height);
  return { c, g };
}
function imageHeader(g, title, subtitle) {
  g.fillStyle = '#1c2a4a'; g.textBaseline = 'alphabetic';
  g.font = `800 34px ${FONT}`; g.fillText('GOALIE', PAD, 92);
  g.font = `700 56px ${FONT}`; g.fillText(title, PAD, 170);
  g.fillStyle = '#6b7280'; g.font = `600 30px ${FONT}`; g.fillText(subtitle, PAD, 220);
  return 270;
}
function imageFooter(g, y) {
  g.fillStyle = '#9aa0a8'; g.font = `600 26px ${FONT}`; g.textAlign = 'center';
  g.fillText(`Made with Goalie · ${longDate(toDateInput(new Date()))}`, W / 2, y); g.textAlign = 'left';
}
function inkFor(t) {
  if (t.textColor) return { ink: t.textColor, soft: t.textColor };
  return inkClass(t.color) === 'on-light' ? { ink: '#1c2a4a', soft: 'rgba(28,42,74,.6)' } : { ink: '#ffffff', soft: 'rgba(255,255,255,.7)' };
}

function drawStatsImage() {
  const m = statsModel || { kind: 'bars', cards: [] };
  if (m.kind === 'calendar') return drawCalendarImage(m);
  const CARD_H = 470, GAP = 30;
  const { c, g } = imageCanvas(270 + Math.max(1, m.cards.length) * (CARD_H + GAP) + 90);
  let y = imageHeader(g, m.rangeText || 'My stats', showSummary());
  if (!m.cards.length) { g.fillStyle = '#6b7280'; g.font = `600 32px ${FONT}`; g.fillText('No goals showing.', PAD, y + 60); }
  for (const card of m.cards) { drawChartCard(g, card, y, CARD_H); y += CARD_H + GAP; }
  imageFooter(g, y + 40);
  return c;
}
function drawChartCard(g, { t, values, labels, currentIdx, scale, goal, caption, sub, isBars }, y, H) {
  const { ink, soft } = inkFor(t);
  g.fillStyle = t.color; roundRect(g, PAD, y, W - 2 * PAD, H, 40); g.fill();
  if (luminance(t.color) > 0.85) { g.strokeStyle = '#e3e4e6'; g.lineWidth = 3; g.stroke(); }
  g.fillStyle = ink; g.font = `700 44px ${FONT}`; g.fillText(`${t.name} ${t.direction === 'decrease' ? '↓' : '↑'}`, PAD + 40, y + 70);
  g.font = `700 24px ${FONT}`; g.fillStyle = ink; g.fillText(sub, PAD + 40, y + 110);
  if (caption) { g.fillStyle = soft; g.font = `800 20px ${FONT}`; g.fillText(caption, PAD + 40, y + 146); }
  // chart area
  const x0 = PAD + 110, x1 = W - PAD - 40, top = y + 170, bot = y + H - 70, ch = bot - top;
  const rows = axisRows(scale);
  g.font = `700 22px ${FONT}`; g.textAlign = 'right';
  for (let i = 0; i <= rows; i++) {
    const yy = top + (ch * i) / rows;
    g.fillStyle = soft; g.fillText(axisNum(scale * (1 - i / rows)), x0 - 18, yy + 8);
    g.strokeStyle = 'rgba(0,0,0,.08)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, yy); g.lineTo(x1, yy); g.stroke();
  }
  g.textAlign = 'center';
  const n = values.length, colW = (x1 - x0) / n;
  const yOf = v => bot - Math.max(0, Math.min(1, v / scale)) * ch;
  const last = currentIdx >= 0 ? currentIdx : n - 1;
  if (isBars) {
    const bw = Math.min(30, colW * 0.6);
    values.forEach((v, i) => {
      const cx = x0 + colW * (i + 0.5);
      g.fillStyle = 'rgba(0,0,0,.1)'; roundRect(g, cx - bw / 2, top, bw, ch, bw / 2); g.fill();
      const hgt = Math.max(0, Math.min(1, v / scale)) * ch;
      if (hgt > 0) { g.fillStyle = ink; roundRect(g, cx - bw / 2, bot - hgt, bw, hgt, Math.min(bw / 2, hgt / 2)); g.fill(); }
    });
  } else {
    const xs = i => x0 + (n > 1 ? (i / (n - 1)) * (x1 - x0) : (x1 - x0) / 2);
    g.strokeStyle = ink; g.lineWidth = 5; g.lineJoin = 'round'; g.beginPath();
    values.slice(0, last + 1).forEach((v, i) => (i ? g.lineTo(xs(i), yOf(v)) : g.moveTo(xs(i), yOf(v)))); g.stroke();
    g.fillStyle = ink; values.slice(0, last + 1).forEach((v, i) => { g.beginPath(); g.arc(xs(i), yOf(v), 8, 0, Math.PI * 2); g.fill(); });
  }
  // dashed goal line(s)
  g.setLineDash([16, 12]); g.strokeStyle = soft; g.lineWidth = 3;
  if (Array.isArray(goal)) {
    const xs = i => (isBars ? x0 + colW * (i + 0.5) : x0 + (n > 1 ? (i / (n - 1)) * (x1 - x0) : 0));
    g.beginPath(); let started = false;
    goal.forEach((v, i) => { if (v == null) return; started ? g.lineTo(xs(i), yOf(v)) : g.moveTo(xs(i), yOf(v)); started = true; }); g.stroke();
  } else if (goal > 0) { g.beginPath(); g.moveTo(x0, yOf(goal)); g.lineTo(x1, yOf(goal)); g.stroke(); }
  g.setLineDash([]);
  // x labels
  g.fillStyle = soft; g.font = `700 22px ${FONT}`;
  labels.forEach((l, i) => { if (l) g.fillText(l, isBars ? x0 + colW * (i + 0.5) : x0 + (n > 1 ? (i / (n - 1)) * (x1 - x0) : 0), bot + 42); });
  g.textAlign = 'left';
}

function drawCalendarImage(m) {
  const type = m.type;
  const cols = type === 'day' ? 7 : type === 'week' ? 1 : type === 'month' ? 4 : 5;
  const cells = m.cells;
  const rowsN = Math.ceil(cells.length / cols);
  const cellW = (W - 2 * PAD - (cols - 1) * 16) / cols, cellH = type === 'day' ? 120 : type === 'week' ? 110 : 150;
  const { c, g } = imageCanvas(270 + 70 + (type === 'day' ? 50 : 0) + rowsN * (cellH + 16) + 160);
  let y = imageHeader(g, `${m.rangeText} · ${CAL_TYPES.find(([k]) => k === type)[1]}`, m.summary);
  if (type === 'day') {
    g.fillStyle = '#6b7280'; g.font = `700 26px ${FONT}`; g.textAlign = 'center';
    for (let i = 0; i < 7; i++) g.fillText(DAY_SHORT[(state.settings.weekStart + i) % 7], PAD + i * (cellW + 16) + cellW / 2, y + 30);
    y += 50;
  }
  g.textAlign = 'center';
  cells.forEach((cell, i) => {
    const cx = PAD + (i % cols) * (cellW + 16), cy = y + Math.floor(i / cols) * (cellH + 16);
    const color = cell.out ? null : pctColor(cell.pct);
    g.fillStyle = color === OVER ? '#ffffff' : color || (cell.out ? '#ffffff' : '#eef0f2'); roundRect(g, cx, cy, cellW, cellH, 22); g.fill();
    if (color === OVER) { g.strokeStyle = GOLD; g.lineWidth = 4; g.stroke(); }
    if (cell.current) { g.strokeStyle = '#1c2a4a'; g.lineWidth = 5; g.stroke(); }
    const light = !color || color === '#facc15';
    g.fillStyle = cell.out ? '#c4c8cf' : color === OVER ? GOLD : light ? '#1c2a4a' : '#ffffff';
    g.font = `700 ${type === 'week' ? 32 : 34}px ${FONT}`;
    g.fillText(cell.label, cx + cellW / 2, cy + (cell.pct != null && !cell.out ? cellH / 2 - 2 : cellH / 2 + 12));
    if (cell.pct != null && !cell.out) { g.font = `800 26px ${FONT}`; g.fillText(`${Math.round(cell.pct)}%`, cx + cellW / 2, cy + cellH / 2 + 36); }
  });
  g.textAlign = 'left';
  y += rowsN * (cellH + 16) + 50;
  // legend
  let lx = PAD; g.font = `700 26px ${FONT}`;
  for (const [label, color] of [['0–33%', '#ef4444'], ['34–66%', '#f97316'], ['67–99%', '#facc15'], ['100%', '#22c55e'], ...((state.settings.calendarMode || 'complete') === 'average' ? [['Over 100%', OVER]] : [])]) {
    g.fillStyle = color === OVER ? '#ffffff' : color; g.beginPath(); g.arc(lx + 14, y - 9, 14, 0, Math.PI * 2); g.fill();
    if (color === OVER) { g.strokeStyle = GOLD; g.lineWidth = 3; g.stroke(); }
    g.fillStyle = '#1c2a4a'; g.fillText(label, lx + 38, y); lx += g.measureText(label).width + 90;
  }
  imageFooter(g, y + 80);
  return c;
}

/* =========================================================
   Settings
   ========================================================= */
function renderTrash() {
  const box = $('#trash-list');
  box.innerHTML = '';
  // Collapsible: the arrow opens and closes the list; the count shows how many are inside.
  const open = !!state.settings.trashOpen;
  $('#trash-body').classList.toggle('hidden', !open);
  $('#trash-toggle').setAttribute('aria-expanded', String(open));
  const n = state.trash.length + state.todoTrash.length;
  $('#trash-count').textContent = String(n);
  if (!state.trash.length && !state.todoTrash.length) {
    box.append(el('p', { class: 'note trash-empty' }, 'Nothing here.'));
    return;
  }
  const rows = [
    ...state.trash.map(item => ({ at: item.deletedAt, row: () => goalTrashRow(item) })),
    ...state.todoTrash.map(item => ({ at: item.deletedAt, row: () => todoTrashRow(item, renderTrash) })),
  ].sort((a, b) => b.at - a.at);
  for (const r of rows) box.append(r.row());
}

function goalTrashRow(item) {
  {
    const daysLeft = Math.max(1, Math.ceil((item.deletedAt + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS));
    const when = relTime(item.deletedAt).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
    const n = item.entries.length;
    return el('div', { class: 'trash-row' },
      el('span', { class: 'trash-dot', style: `background:${item.tally.color}` }),
      el('div', { class: 'trash-info' },
        el('div', { class: 'trash-name' }, item.tally.name),
        el('div', { class: 'trash-meta' }, `Deleted ${when} · ${n} entr${n === 1 ? 'y' : 'ies'} · ${daysLeft}d left`)),
      el('button', {
        class: 'trash-btn restore',
        onclick: () => { restoreTally(item.id); toast(`Restored ${item.tally.name}`); },
      }, 'Restore'),
      el('button', {
        class: 'trash-btn forever',
        'aria-label': `Delete ${item.tally.name} forever`,
        onclick: () => openSheet(
          el('h3', {}, `Delete “${item.tally.name}” forever?`),
          el('p', {}, 'This goal and its history will be gone for good. This can’t be undone.'),
          el('button', {
            class: 'sheet-btn danger',
            onclick: () => {
              state.trash = state.trash.filter(x => x.id !== item.id);
              save(); renderTrash(); closeSheet();
            },
          }, 'Delete forever'),
          el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
        ),
      }, '×'));
  }
}

function renderSettings() {
  $('#screen-info').textContent = `Goalie v${APP_VERSION}`;
  const last = state.settings.lastExport;
  $('#backup-status').textContent = last
    ? `Last backup: ${longDate(toDateInput(new Date(last)))} (${daysAgo(last)}).`
    : 'No backup yet. Goalie reminds you every 2 weeks.';
  $('#btn-damaged').classList.toggle('hidden', !damagedKeys().length);
  window.goalieCloud?.prepare();
  $$('#set-theme button').forEach(b => b.classList.toggle('on', b.dataset.v === (state.settings.theme || 'auto')));
  if (document.activeElement !== $('#set-name')) $('#set-name').value = state.settings.name || '';
  renderTrash();
  $$('#set-weekstart button').forEach(b => b.classList.toggle('on', +b.dataset.v === state.settings.weekStart));
  $$('#set-custommode button').forEach(b => b.classList.toggle('on', b.dataset.v === (state.settings.customDateMode || 'add')));
  $$('#set-calmode button').forEach(b => b.classList.toggle('on', b.dataset.v === (state.settings.calendarMode || 'complete')));
  $('#updates-section').classList.toggle('hidden', isNativeApp); // the App Store handles updates
  const status = $('#notify-status');
  if (isNativeApp) {
    renderNativeNotifyStatus();
  } else if (!('Notification' in window)) {
    status.textContent = 'System banners need Goalie added to your Home Screen (iOS 16.4+). In-app banners still work.';
  } else {
    status.textContent = {
      granted: 'Banners are on.',
      denied: 'Banners are blocked. Turn them on in iPhone Settings → Notifications → Goalie. In-app banners still work.',
      default: 'Tap above to allow reminder banners.',
    }[Notification.permission] || '';
  }
}

$('#set-name').addEventListener('input', e => {
  state.settings.name = e.target.value.trim();
  save();
});
$('#set-name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

// Appearance: light, dark, or follow the phone (auto).
const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme() {
  const pref = state.settings.theme || 'auto';
  const dark = pref === 'dark' || (pref === 'auto' && !!darkQuery?.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  // Browsers (iPhone especially) can ignore an edited theme-color tag; swapping in a fresh one
  // makes the top bar recolor immediately.
  const color = dark ? '#0f1520' : '#ffffff';
  const old = document.querySelector('meta[name="theme-color"]');
  if (old?.getAttribute('content') !== color) {
    const fresh = document.createElement('meta');
    fresh.name = 'theme-color';
    fresh.content = color;
    old ? old.replaceWith(fresh) : document.head.append(fresh);
  }
  // iPhone app: the clock and battery follow Goalie's theme, not the phone's (DARK = light text).
  window.Capacitor?.Plugins?.StatusBar?.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
}
applyTheme();

/* =========================================================
   App updates: never automatic
   When a newer version is on the server, Goalie asks the next time it's opened: update now, or
   pick a later time. At that time it updates on its own (as soon as nothing is open), or the next
   time you open it. Until then the offline copy keeps running the version you have.
   ========================================================= */
const APP_VERSION = document.querySelector('meta[name="goalie-version"]')?.content || '';
let swReg = null;
let updateAsked = false; // asked already since the app was last opened

// Something is open or being edited: don't interrupt it.
function appBusy() {
  const a = document.activeElement;
  return !!document.querySelector('.screen.modal.active, .sheet.show, #sheet[data-open]') || dragActive || editMode ||
    !!(a && /^(INPUT|TEXTAREA)$/.test(a.tagName));
}
function whenIdle(fn) {
  if (appBusy()) { setTimeout(() => whenIdle(fn), 3000); return; }
  fn();
}

async function latestVersion() {
  const res = await fetch('version.json?ts=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()).version || null;
}

async function checkForUpdate(opening = false) {
  try {
    const latest = await latestVersion();
    if (!latest || latest === APP_VERSION) {
      // Up to date. A new offline copy for this same version may be waiting: let it take over quietly.
      if (state.settings.updateAt) { state.settings.updateAt = null; save(); }
      swReg?.waiting?.postMessage('skipWaiting');
      return;
    }
    const at = state.settings.updateAt;
    if (at === 'open' ? opening : at && Date.now() >= at) { whenIdle(applyUpdate); return; }
    if (at || updateAsked) return; // scheduled for later, or already asked this time
    updateAsked = true;
    whenIdle(() => updatePrompt(latest));
  } catch (e) { /* offline: ask next time */ }
}

function updatePrompt(latest) {
  openSheet(
    el('h3', {}, 'Update available'),
    el('p', {}, `A new version of Goalie (v${latest}) is ready. Updating takes a few seconds and keeps all your goals, history and to-dos.`),
    el('button', { class: 'sheet-btn primary', onclick: () => { closeSheet(); applyUpdate(); } }, 'Update now'),
    el('button', { class: 'sheet-btn', onclick: () => switchSheet(() => laterSheet(latest)) }, 'Schedule for later'),
  );
}

// Schedule for later: the user picks any date (wheels) and time. Goalie updates then, or, if it's
// closed at that time, the next time it's opened.
function laterSheet(latest) {
  const now = new Date();
  // start one hour from now, on the hour
  const start = new Date(now.getTime() + 3600000); start.setMinutes(0, 0, 0);
  const wheels = dateWheels(start, { minYear: now.getFullYear(), maxYear: now.getFullYear() + 1, compact: true });
  const clock = timeWheels(start, { compact: true });
  const error = el('p', { class: 'form-error hidden' });
  const schedule = () => {
    const day = wheels.get();
    const [hh, mm] = clock.get();
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh || 0, mm || 0);
    if (at.getTime() <= Date.now()) { error.textContent = 'Pick a time that hasn\u2019t happened yet.'; error.classList.remove('hidden'); return; }
    state.settings.updateAt = at.getTime();
    save(); closeSheet();
    const when = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    toast(sameDay(at, now) ? `Goalie will update today at ${when}` : `Goalie will update ${DAY_NAMES[at.getDay()]}, ${MONTH_SHORT[at.getMonth()]} ${at.getDate()} at ${when}`);
  };
  openSheet(
    el('h3', {}, 'When should Goalie update?'),
    el('p', { class: 'sheet-note' }, `Version ${latest} installs then (or next time you open Goalie).`),
    el('div', { class: 'sheet-label' }, 'DATE', wheels.node),
    el('div', { class: 'sheet-label' }, 'TIME', clock.node),
    error,
    // side by side, so the whole sheet fits on short screens without scrolling
    el('div', { class: 'sheet-btn-row' },
      el('button', { class: 'sheet-btn', onclick: () => switchSheet(() => updatePrompt(latest)) }, 'Back'),
      el('button', { class: 'sheet-btn primary', onclick: schedule }, 'Schedule update')),
  );
  $('#sheet').classList.add('tight');
}

// Switch to the new version: the new offline copy takes over, then the page reloads.
async function applyUpdate() {
  state.settings.updateAt = null;
  save();
  toast('Updating…');
  try {
    const reg = swReg || await navigator.serviceWorker?.getRegistration?.();
    if (reg) {
      await reg.update().catch(() => {});
      const waiting = reg.waiting || await installedWorker(reg, 10000);
      if (waiting) {
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        waiting.postMessage('skipWaiting');
        setTimeout(freshReload, 6000); // in case the switch never reports back
        return;
      }
    }
  } catch (e) { /* fall through */ }
  freshReload();
}
function installedWorker(reg, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    const watch = w => w && w.addEventListener('statechange', () => {
      if (w.state === 'installed') { clearTimeout(timer); resolve(w); }
    });
    if (reg.installing) watch(reg.installing);
    reg.addEventListener('updatefound', () => watch(reg.installing));
  });
}
// Last resort: clear Goalie's saved app files (never your data) and load straight from the server.
async function freshReload() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    await Promise.all(regs.map(r => r.unregister()));
    const keys = (await window.caches?.keys?.()) || [];
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch (e) { /* reload anyway */ }
  location.replace(location.pathname + '?fresh=' + Date.now());
}


darkQuery?.addEventListener?.('change', applyTheme);

$('#set-theme').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.v === (state.settings.theme || 'auto')) return;
  state.settings.theme = b.dataset.v;
  save(); applyTheme(); renderSettings();
  // iPhone only picks the top bar's color when a home-screen app starts, so restart it right away
  // (and come back to Settings) instead of waiting for the next launch.
  const homeScreenApp = navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
  if (homeScreenApp) {
    sessionStorage.setItem('goalie-reopen', 'settings');
    setTimeout(() => location.reload(), 150);
  }
});

$('#set-weekstart').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.settings.weekStart = +b.dataset.v;
  save(); renderSettings(); renderToday();
});

$('#set-custommode').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.settings.customDateMode = b.dataset.v;
  save(); renderSettings();
});

$('#set-calmode').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  state.settings.calendarMode = b.dataset.v;
  save(); renderSettings();
});

$('#trash-toggle').addEventListener('click', () => {
  state.settings.trashOpen = !state.settings.trashOpen;
  save(); renderTrash();
});

$('#btn-export').addEventListener('click', async () => {
  const json = JSON.stringify({ app: 'goalie', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
  const name = `goalie-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([json], name, { type: 'application/json' });
  const done = () => { state.settings.lastExport = Date.now(); save(); hideBanner(); renderSettings(); };
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Goalie backup' });
      done();
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  done();
});

// Unreadable saved data that was kept aside (see keepDamagedCopy): download it to recover by hand.
function damagedKeys() {
  const keys = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(STORE_KEY + '.damaged-')) keys.push(k); } } catch (e) { /* blocked */ }
  return keys;
}
$('#btn-damaged').addEventListener('click', () => {
  for (const k of damagedKeys()) {
    const url = URL.createObjectURL(new Blob([localStorage.getItem(k)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `goalie-damaged-${k.split('-').pop()}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
});

// 'today', 'yesterday', '15 days ago'
function daysAgo(ts) {
  const n = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts))) / DAY_MS);
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

// Every 2 weeks (at most once a day), remind about exporting a backup.
function backupReminder() {
  if (!state.tallies.length || document.visibilityState !== 'visible') return;
  if (window.goalieCloud?.signedIn()) return; // backed up to the account already
  const s = state.settings, today = dayKey(new Date());
  if (!s.lastExport && !s.backupFrom) { s.backupFrom = Date.now(); save(); return; }
  const since = s.lastExport || s.backupFrom;
  if (Date.now() - since < 14 * DAY_MS || s.backupNagDay === today) return;
  if (document.querySelector('.screen.modal.active, .sheet.show')) return;
  s.backupNagDay = today; save();
  const b = $('#banner');
  b.innerHTML = '';
  b.style.setProperty('--banner-accent', 'var(--accent)');
  b.append(
    el('div', { class: 'banner-text' }, el('strong', {}, 'Back up your Goalie data'),
      el('span', {}, s.lastExport ? `Your last backup was ${daysAgo(s.lastExport)}.` : 'Your goals are only saved on this phone.')),
    el('button', { class: 'banner-btn', onclick: () => $('#btn-export').click() }, 'Export'),
    el('button', { class: 'banner-close', 'aria-label': 'Dismiss', onclick: hideBanner }, '×'),
  );
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, 15000);
}

$('#import-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.tallies) || !Array.isArray(data.entries)) throw new Error('bad file');
    openSheet(
      el('h3', {}, 'Replace current data?'),
      el('p', {}, `This backup has ${data.tallies.length} tallies and ${data.entries.length} entries. Your current data will be replaced${window.goalieCloud?.signedIn() ? ' here and on your other signed-in devices' : ''}.`),
      el('button', {
        class: 'sheet-btn primary',
        onclick: () => {
          state = normalizeState(data);
          migrate(); save(); clearUndoHistory();
          renderToday(); renderSettings(); closeSheet(); toast('Backup imported');
        },
      }, 'Import'),
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
    );
  } catch (err) {
    toast('That file isn’t a valid backup');
  }
});

// Settings → Update Goalie now: load the newest version straight from the server (data is kept).
$('#btn-force-update').addEventListener('click', () => { toast('Updating…'); freshReload(); });

$('#btn-notify').addEventListener('click', async () => { await ensureNotifyPermission(); renderSettings(); });

$('#btn-wipe').addEventListener('click', () => {
  openSheet(
    el('h3', {}, 'Delete everything?'),
    el('p', {}, window.goalieCloud?.signedIn()
      ? 'All tallies and history will be erased on this device, in your account, and on your other signed-in devices. Export a backup first if you might want it back.'
      : 'All tallies and history on this device will be erased. Export a backup first if you might want it back.'),
    el('button', {
      class: 'sheet-btn danger',
      onclick: () => { state = DEFAULT_STATE(); save(); clearUndoHistory(); renderToday(); renderSettings(); closeSheet(); toast('All data deleted'); },
    }, 'Delete all data'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
});

/* =========================================================
   Reminders (system banner + in-app banner)
   ========================================================= */
async function ensureNotifyPermission() {
  if (isNativeApp) {
    const plugin = nativeNotify();
    if (!plugin) return false;
    try {
      let { display } = await plugin.checkPermissions();
      if (display === 'prompt' || display === 'prompt-with-rationale') ({ display } = await plugin.requestPermissions());
      scheduleNativeReminders(true);
      return display === 'granted';
    } catch (e) { return false; }
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
  }
  return Notification.permission === 'granted';
}

/* App Store app: reminders are real iPhone notifications, scheduled for each goal's reminder time on
   its days, so they arrive even when Goalie is closed. (The web app can only remind while it's
   open.) Rescheduled whenever a goal's name, reminder or days change. */
const nativeNotify = () => window.Capacitor?.Plugins?.LocalNotifications;
const REMINDER_ID = 100000; // Goalie's reminder notifications use ids from here up
let reminderTimer = null, reminderSig = null;
function scheduleNativeReminders(force = false) {
  if (!isNativeApp || !nativeNotify()) return;
  const goals = state.tallies.filter(t => t.reminder && !(byDate(t) && Date.now() >= dueEndMs(t)));
  const sig = JSON.stringify(goals.map(t => [t.id, t.name, t.reminder, t.days]));
  if (!force && sig === reminderSig) return;
  reminderSig = sig;
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(async () => {
    const plugin = nativeNotify();
    try {
      const { notifications } = await plugin.getPending();
      const ours = notifications.filter(n => n.id >= REMINDER_ID);
      if (ours.length) await plugin.cancel({ notifications: ours.map(n => ({ id: n.id })) });
      if ((await plugin.checkPermissions()).display !== 'granted') return;
      const list = [];
      goals.forEach((t, i) => {
        const [hour, minute] = t.reminder.split(':').map(Number);
        const days = t.days?.length ? t.days : [0, 1, 2, 3, 4, 5, 6];
        const note = (id, on) => ({ id, title: t.name, body: 'Time to check in.', schedule: { on, allowWhileIdle: true }, extra: { tallyId: t.id } });
        // Every day: one daily notification. Some days: one per weekday (iOS weekdays: Sunday = 1).
        if (days.length === 7) list.push(note(REMINDER_ID + i * 10, { hour, minute }));
        else for (const d of days) list.push(note(REMINDER_ID + i * 10 + d + 1, { weekday: d + 1, hour, minute }));
      });
      // iPhone keeps at most 64 scheduled notifications per app.
      if (list.length) await plugin.schedule({ notifications: list.slice(0, 64) });
    } catch (e) { console.warn('Goalie reminders:', e); }
  }, 1000);
}
if (isNativeApp) { window.goalieReminders = () => scheduleNativeReminders(); scheduleNativeReminders(true); }
async function renderNativeNotifyStatus() {
  const plugin = nativeNotify();
  $('#btn-notify').textContent = 'Turn on reminders';
  let display = 'denied';
  try { ({ display } = await plugin.checkPermissions()); } catch (e) { /* no plugin */ }
  $('#notify-status').textContent = display === 'granted'
    ? 'Reminders are on. Each goal’s reminder arrives at its time, even when Goalie is closed.'
    : display === 'denied'
      ? 'Notifications are off for Goalie. Turn them on in iPhone Settings → Notifications → Goalie.'
      : 'Tap above to allow reminders. Set a reminder time on any goal.';
}

// The icon badge feature was removed; clear any badge an older version left behind.
try { navigator.clearAppBadge?.().catch(() => {}); } catch (e) { /* unsupported */ }

let bannerTimer = null;
function showBanner(t, body) {
  const b = $('#banner');
  b.innerHTML = '';
  b.style.setProperty('--banner-accent', t.color);
  b.append(
    el('div', { class: 'banner-text' }, el('strong', {}, t.name), el('span', {}, body)),
    el('button', { class: 'banner-btn', onclick: () => { hideBanner(); onTap(t); } }, 'Check in'),
    el('button', { class: 'banner-close', 'aria-label': 'Dismiss', onclick: hideBanner }, '×'),
  );
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, 8000);
}
function hideBanner() { $('#banner').classList.remove('show'); }

async function checkReminders() {
  const now = new Date();
  const todayK = dayKey(now);
  const fired = state.settings.reminderFired || (state.settings.reminderFired = {});
  for (const t of state.tallies) {
    if (!t.reminder || fired[t.id] === todayK) continue;
    if (t.days && !t.days.includes(now.getDay())) continue;
    const [h, m] = t.reminder.split(':').map(Number);
    const due = new Date(now); due.setHours(h, m, 0, 0);
    const late = now - due;
    if (late < 0 || late > 15 * 60000) continue;
    fired[t.id] = todayK;
    save();
    const body = `Time to check in. ${amountText(t, currentCount(t))} so far ${(PERIOD_LABEL[t.reset] || '').toLowerCase()}.`;
    // Looking at the app: slide down an in-app banner. Otherwise: a system banner (needs permission).
    if (document.visibilityState === 'visible') {
      showBanner(t, body);
    } else if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) reg.showNotification(t.name, { body, icon: 'icons/goalie-bar-192.png', tag: t.id });
        else new Notification(t.name, { body });
      } catch (e) { /* ignore */ }
    }
  }
}

/* =========================================================
   To-Do list (sections + Eisenhower priority)
   ========================================================= */
// Quadrant → priority list: Q1 High, Q2 Medium, Q3 Low, Q4 No priority.
const QUADRANTS = {
  1: { title: 'Q1', desc: 'Important & urgent', priority: 'High priority', key: 'high' },
  2: { title: 'Q2', desc: 'Important, not urgent', priority: 'Medium priority', key: 'medium' },
  3: { title: 'Q3', desc: 'Urgent, not important', priority: 'Low priority', key: 'low' },
  4: { title: 'Q4', desc: 'Not urgent, not important', priority: 'No priority', key: 'none' },
};
let todoView = 'lists';

// Undo / redo for the to-do page: each change saves a snapshot of the to-do data first.
const todoHistory = { back: [], forward: [] };
const todoSnapshot = () => JSON.stringify({ todos: state.todos, todoSections: state.todoSections, todoTrash: state.todoTrash });
function restoreTodoSnapshot(json) {
  const s = JSON.parse(json);
  state.todos = s.todos; state.todoSections = s.todoSections; state.todoTrash = s.todoTrash;
  save(); renderTodos();
  if ($('#screen-settings').classList.contains('active')) renderTrash();
}
function todoChange(fn) {
  todoHistory.back.push(todoSnapshot());
  if (todoHistory.back.length > 100) todoHistory.back.shift();
  todoHistory.forward = [];
  fn();
  save(); renderTodos();
}
function todoUndo() {
  if (!todoHistory.back.length) return;
  todoHistory.forward.push(todoSnapshot());
  restoreTodoSnapshot(todoHistory.back.pop());
}
function todoRedo() {
  if (!todoHistory.forward.length) return;
  todoHistory.back.push(todoSnapshot());
  restoreTodoSnapshot(todoHistory.forward.pop());
}
function syncTodoHistoryButtons() {
  $('#btn-todo-undo').disabled = !todoHistory.back.length;
  $('#btn-todo-redo').disabled = !todoHistory.forward.length;
}

// Move a to-do to Recently Deleted (kept 30 days).
function trashTodo(t, reason) {
  state.todos = state.todos.filter(x => x !== t);
  state.todoTrash.unshift({ id: uid(), todo: { ...t, done: false, doneAt: null }, reason, deletedAt: Date.now() });
}

function restoreTodo(item) {
  state.todoTrash = state.todoTrash.filter(x => x.id !== item.id);
  state.todos.push({ ...item.todo, done: false, doneAt: null });
  if (item.todo.section && !state.todoSections.includes(item.todo.section)) state.todoSections.push(item.todo.section);
}

function todoTrashRow(item, rerender) {
  const daysLeft = Math.max(1, Math.ceil((item.deletedAt + TRASH_DAYS * DAY_MS - Date.now()) / DAY_MS));
  const when = relTime(item.deletedAt).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  return el('div', { class: 'trash-row' },
    el('span', { class: 'trash-dot todo-dot' }, item.reason === 'completed' ? checkMark(true) : null),
    el('div', { class: 'trash-info' },
      el('div', { class: 'trash-name todo-trash-name' }, item.todo.title),
      el('div', { class: 'trash-meta' }, 'To-do · ' + (item.reason === 'completed' ? 'Completed' : 'Deleted') + ' ' + when + ' · ' + daysLeft + 'd left')),
    el('button', {
      class: 'trash-btn restore',
      onclick: () => { todoChange(() => restoreTodo(item)); rerender(); toast('To-do restored'); },
    }, 'Restore'),
    el('button', {
      class: 'trash-btn forever',
      'aria-label': 'Delete ' + item.todo.title + ' forever',
      onclick: () => { todoChange(() => { state.todoTrash = state.todoTrash.filter(x => x.id !== item.id); }); rerender(); toast('Deleted for good', todoUndo); },
    }, '×'));
}

function todoTrashSheet() {
  const draw = () => {
    openSheet(
      el('h3', {}, 'Recently deleted to-dos'),
      el('p', { class: 'note' }, 'Completed and deleted to-dos stay here for 30 days, then are removed for good.'),
      state.todoTrash.length
        ? el('div', { class: 'trash-list' }, state.todoTrash.map(item => todoTrashRow(item, draw)))
        : el('p', { class: 'note trash-empty' }, 'Nothing here.'),
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Close'));
  };
  draw();
}

function todoSectionNames() {
  const names = [...new Set(state.todoSections)]; // (never show a section twice)
  for (const t of state.todos) if (t.section && !names.includes(t.section)) names.push(t.section);
  return names;
}

function renderTodos() {
  syncTodoHistoryButtons();
  $$('#todo-view button').forEach(b => b.classList.toggle('on', b.dataset.v === todoView));
  const box = $('#todo-list');
  box.innerHTML = '';
  if (todoView === 'priority') return renderPriorityView(box);
  if (todoEditing) box.append(el('p', { class: 'stats-hint todo-edit-hint' }, 'Drag a section by its name to move it, or tap the trash can to delete it. Tap DONE when finished.'));

  const sections = todoSectionNames();
  const loose = state.todos.filter(t => !t.section);
  if (!sections.length && !loose.length) {
    box.append(el('div', { class: 'empty' }, el('strong', {}, 'Nothing to do yet'), 'Tap + NEW TO-DO, or make a section like “Weekly Chores”.'));
  }
  for (const name of sections) box.append(todoSection(name, state.todos.filter(t => t.section === name)));
  if (loose.length) box.append(todoSection('', loose));
  box.append(todoTrashLink());
}

function todoTrashLink() {
  const n = state.todoTrash.length;
  return el('button', { type: 'button', class: 'todo-trash-link', onclick: todoTrashSheet }, 'Recently deleted' + (n ? ' (' + n + ')' : ''));
}

// Sections open and close with their arrow (remembered); ⋯ renames or removes a section.
const todoFolded = key => (state.settings.todoCollapsed || []).includes(key);
function toggleTodoFold(key) {
  const set = new Set(state.settings.todoCollapsed || []);
  if (set.has(key)) set.delete(key); else set.add(key);
  state.settings.todoCollapsed = [...set];
  save(); renderTodos();
}
function foldHead(key, label, count, ...extra) {
  const folded = todoFolded(key);
  return el('div', { class: 'todo-section-head' },
    el('button', { type: 'button', class: 'todo-section-name', 'aria-expanded': String(!folded), onclick: () => toggleTodoFold(key) },
      label, el('span', { class: 'group-count' }, String(count)), el('span', { class: `todo-chev${folded ? ' folded' : ''}`, 'aria-hidden': 'true' }, '›')),
    ...extra);
}

function todoSection(name, items) {
  const open = items.filter(t => !t.done).length;
  const key = name || '__none__';
  const color = name && (state.settings.todoSectionColors || {})[name];
  const ink = name && (state.settings.todoSectionTextColors || {})[name];
  const head = foldHead(key, name ? name.toUpperCase() : 'NO SECTION', open,
    el('div', { class: 'todo-head-actions' },
      todoEditing && name ? el('button', { type: 'button', class: 'todo-section-delete', 'aria-label': `Delete ${name}`, onclick: () => deleteSectionSheet(name) }, TRASH_ICON()) : null,
      todoEditing && name ? el('span', { class: 'todo-grip', 'aria-hidden': 'true' }, '≡') : null,
      !todoEditing && name ? el('button', { type: 'button', class: 'todo-section-more', 'aria-label': `Edit ${name}`, onclick: () => sectionMenu(name) }, '⋯') : null,
      todoEditing ? null : el('button', { type: 'button', class: 'todo-section-add', 'aria-label': `Add to ${name || 'no section'}`, onclick: () => todoSheet(null, name) }, '+ Add')));
  const folded = todoEditing || todoFolded(key);
  const section = el('div', {
    class: `todo-section${color ? ` colored ${inkClass(color)}` : ''}${ink ? ' custom-ink' : ''}${todoEditing ? ' editing' : ''}`,
    style: [color ? `background:${color}` : '', ink ? `--sec-ink:${ink}` : ''].filter(Boolean).join(';'),
    'data-section': name,
  },
  head,
  el('div', { class: 'todo-items', 'data-section': name },
    folded ? null : items.length ? sortTodos(items).map(t => todoRow(t, false)) : el('p', { class: 'todo-empty' }, 'No to-dos here yet.')));
  // Hold a section's header to move the whole section (in EDIT, just press and drag).
  if (name) dragSort(section, {
    handle: head,
    holdMs: todoEditing ? 0 : 450,
    scroller: $('#todo-list'),
    itemSelector: '#todo-list .todo-section[data-section]:not([data-section=""])',
    onDrop: commitSectionOrder,
  });
  return section;
}

// open items first (newest first), then finished ones
// To-dos with a priority sort by it (High first); the rest stay in the order they were added (or
// dragged into).
const todoRank = t => (t.priority && QUADRANTS[t.quadrant] ? t.quadrant : 9);
const todoOrder = t => t.order ?? t.createdAt;
function sortTodos(items) {
  return [...items].sort((a, b) => (todoRank(a) - todoRank(b)) || (todoOrder(a) - todoOrder(b)));
}

function todoRow(t, showSection) {
  const q = t.priority && QUADRANTS[t.quadrant];
  const row = el('div', { class: `todo-row${t.done ? ' done' : ''}`, 'data-id': t.id },
    el('button', {
      type: 'button',
      class: 'todo-check',
      'aria-label': t.done ? `Mark ${t.title} not done` : `Mark ${t.title} done`,
      onclick: e => {
        // Show the check for a moment, then move it to Recently Deleted.
        const btn = e.currentTarget;
        btn.closest('.todo-row').classList.add('done', 'leaving');
        btn.replaceChildren(checkMark(true));
        btn.disabled = true;
        setTimeout(() => {
          if (!state.todos.includes(t)) return;
          todoChange(() => trashTodo(t, 'completed'));
          toast('Done! Moved to Recently deleted', todoUndo);
        }, 450);
      },
    }, t.done ? checkMark(true) : null),
    el('button', { type: 'button', class: 'todo-main', onclick: () => todoSheet(t) },
      el('span', { class: 'todo-title' }, t.title),
      el('span', { class: 'todo-meta' },
        q ? el('span', { class: `todo-tag p-${q.key}` }, `${q.title} · ${q.key.toUpperCase()}`) : null,
        showSection && t.section ? el('span', { class: 'todo-sec' }, t.section) : null)));
  // Hold a to-do to drag it within its section or into another one (Lists view only).
  if (!showSection) dragSort(row, {
    scroller: $('#todo-list'),
    itemSelector: '#todo-list .todo-row',
    containerSelector: '#todo-list .todo-items',
    onDrop: commitTodoOrder,
  });
  return row;
}

// After a drop: each section's to-dos take the order shown, and a to-do moved into another section joins it.
function commitTodoOrder() {
  const byId = new Map(state.todos.map(t => [t.id, t]));
  const moves = [];
  for (const box of document.querySelectorAll('#todo-list .todo-items')) {
    [...box.querySelectorAll('.todo-row')].forEach((r, i) => moves.push([byId.get(r.dataset.id), box.dataset.section, i]));
  }
  todoChange(() => moves.forEach(([t, section, i]) => { if (t) { t.section = section; t.order = i; } }));
}
// After a section is dropped: the sections take the order shown.
function commitSectionOrder() {
  const names = [...document.querySelectorAll('#todo-list .todo-section[data-section]')].map(n => n.dataset.section).filter(Boolean);
  todoChange(() => { state.todoSections = [...new Set([...names, ...todoSectionNames()])]; });
}
let todoEditing = false; // EDIT: sections shrink to their headers so they're easy to reorder

function renderPriorityView(box) {
  const withPriority = state.todos.filter(t => t.priority && QUADRANTS[t.quadrant]);
  if (!withPriority.length) {
    box.append(el('div', { class: 'empty' }, el('strong', {}, 'No prioritized to-dos'), 'Turn on “Use priority list” when you add a to-do.'));
    box.append(todoTrashLink());
    return;
  }
  for (const n of [1, 2, 3, 4]) {
    const q = QUADRANTS[n];
    const items = withPriority.filter(t => t.quadrant === n);
    const key = 'prio:' + q.key;
    box.append(el('div', { class: `todo-section prio p-${q.key}` },
      foldHead(key, q.priority.toUpperCase(), items.filter(t => !t.done).length, el('span', { class: 'todo-prio-q' }, `${q.title} · ${q.desc}`)),
      todoFolded(key) ? null : items.length ? sortTodos(items).map(t => todoRow(t, true)) : el('p', { class: 'todo-empty' }, 'Nothing here.')));
  }
  box.append(todoTrashLink());
}

// New / edit a to-do
function todoSheet(t, presetSection) {
  const draft = t ? { ...t } : { title: '', section: presetSection || '', priority: true, quadrant: null };
  const draw = () => {
    const title = el('textarea', { class: 'text-area todo-title-input', rows: 1, placeholder: 'e.g. Go to the grocery store' });
    title.value = draft.title;
    // grows with the text, so long to-dos are fully visible while typing
    const grow = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
    title.addEventListener('input', () => { draft.title = title.value; grow(); });
    autoList(title);
    requestAnimationFrame(grow);
    const sections = todoSectionNames();
    const newSec = el('input', { class: 'text-input', type: 'text', maxlength: 30, placeholder: 'Or type a new section name' });
    // keep what's typed here when the sheet redraws (tapping a chip, YES/NO or a quadrant)
    newSec.value = draft.newSection || '';
    newSec.addEventListener('input', () => { draft.newSection = newSec.value; });
    const error = el('p', { class: 'form-error hidden' });

    const save_ = () => {
      draft.title = title.value.trim();
      if (newSec.value.trim()) draft.section = newSec.value.trim();
      delete draft.newSection;
      if (!draft.title) { error.textContent = 'Give the to-do a name.'; error.classList.remove('hidden'); return; }
      if (draft.priority && !QUADRANTS[draft.quadrant]) { error.textContent = 'Pick a quadrant, or turn off the priority list.'; error.classList.remove('hidden'); return; }
      todoChange(() => {
        if (draft.section && !state.todoSections.includes(draft.section)) state.todoSections.push(draft.section);
        if (t) Object.assign(t, draft, { quadrant: draft.priority ? draft.quadrant : null });
        else state.todos.push({ id: uid(), title: draft.title, section: draft.section, priority: draft.priority, quadrant: draft.priority ? draft.quadrant : null, done: false, createdAt: Date.now(), order: Date.now(), doneAt: null });
      });
      closeSheet();
      toast(t ? 'To-do updated' : 'To-do added');
    };

    openSheet(
      el('h3', {}, t ? 'Edit to-do' : 'New to-do'),
      el('div', { class: 'sheet-label' }, 'TO-DO', title),
      el('div', { class: 'sheet-label' }, 'SECTION'),
      el('div', { class: 'chips todo-sec-chips' },
        el('button', { type: 'button', class: `chip${!draft.section ? ' on' : ''}`, onclick: () => { draft.title = title.value; draft.section = ''; draw(); } }, 'None'),
        sections.map(s => el('button', { type: 'button', class: `chip${draft.section === s ? ' on' : ''}`, onclick: () => { draft.title = title.value; draft.section = s; draw(); } }, s))),
      newSec,
      el('div', { class: 'sheet-label' }, 'USE PRIORITY LIST'),
      el('div', { class: 'seg pills todo-prio-toggle' },
        el('button', { type: 'button', class: draft.priority ? 'on' : '', onclick: () => { draft.title = title.value; draft.priority = true; draw(); } }, 'YES'),
        el('button', { type: 'button', class: draft.priority ? '' : 'on', onclick: () => { draft.title = title.value; draft.priority = false; draw(); } }, 'NO')),
      draft.priority ? el('div', { class: 'todo-reflect' },
        el('div', { class: 'todo-reflect-title' }, 'Ask yourself'),
        el('ol', {},
          el('li', {}, 'Does this task genuinely matter to my goals or responsibilities?'),
          el('li', {}, 'Does it genuinely need to be done soon?'))) : null,
      draft.priority ? el('div', { class: 'quadrants' },
        [1, 2, 3, 4].map(n => {
          const q = QUADRANTS[n];
          return el('button', {
            type: 'button',
            class: `quadrant p-${q.key}${draft.quadrant === n ? ' on' : ''}`,
            onclick: () => { draft.title = title.value; draft.quadrant = n; draw(); },
          }, el('strong', {}, q.title), el('span', {}, q.desc), el('em', {}, '→ ' + q.priority));
        })) : null,
      error,
      el('button', { class: 'sheet-btn primary', onclick: save_ }, t ? 'Save' : 'Add to-do'),
      t ? el('button', {
        class: 'sheet-btn danger',
        onclick: () => {
          todoChange(() => trashTodo(t, 'deleted'));
          closeSheet();
          toast('Moved to Recently deleted', todoUndo);
        },
      }, 'Delete to-do') : null,
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
    );
    if (!t && !draft.title) setTimeout(() => title.focus(), 250);
  };
  draw();
}

// The card color grid for a to-do section, plus NO COLOR. onPick(color or '').
// Section colors: one grid sets either the section's background or its text color (toggle above it),
// like the goal form. "" = no background / automatic text color. onPick({ bg, text }).
function sectionColorPicker(current, onPick) {
  const picked = { bg: current.bg || '', text: current.text || '' };
  let target = 'bg';
  const tabs = el('div', { class: 'seg pills section-color-target' },
    el('button', { type: 'button', 'data-t': 'bg', onclick: () => setTarget('bg') }, 'SECTION COLOR'),
    el('button', { type: 'button', 'data-t': 'text', onclick: () => setTarget('text') }, 'TEXT COLOR'));
  const grid = el('div', { class: 'colors section-colors' }, PALETTE.flatMap(({ name: fam, shades }) => shades.map((c, i) =>
    el('button', { type: 'button', class: `swatch${c === '#ffffff' ? ' swatch-white' : ''}`, style: `background:${c}`, 'data-c': c, 'aria-label': `${fam} ${i + 1}`, onclick: () => pick(c) }))));
  const clear = el('button', { type: 'button', class: 'text-auto', onclick: () => pick('') });
  const sync = () => {
    tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === target));
    grid.querySelectorAll('.swatch').forEach(sw => sw.classList.toggle('on', sw.dataset.c === picked[target]));
    clear.textContent = target === 'bg' ? 'NO COLOR' : 'AUTO (BEST CONTRAST)';
    clear.classList.toggle('on', !picked[target]);
  };
  const setTarget = t => { target = t; sync(); };
  const pick = c => { picked[target] = c; sync(); onPick({ ...picked }); };
  sync();
  return [tabs, grid, clear];
}
const sectionColors = () => state.settings.todoSectionColors || (state.settings.todoSectionColors = {});
const sectionTextColors = () => state.settings.todoSectionTextColors || (state.settings.todoSectionTextColors = {});
function setSectionColors(name, { bg, text }) {
  const b = sectionColors(), t = sectionTextColors();
  if (bg) b[name] = bg; else delete b[name];
  if (text) t[name] = text; else delete t[name];
}

// Trash can icon for deleting a section in EDIT.
function TRASH_ICON() {
  const span = el('span', { class: 'trash-icon', 'aria-hidden': 'true' });
  span.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  return span;
}

// Delete a section: just the section (its to-dos move to No section), or the section and its to-dos
// (they go to Recently Deleted for 30 days). Either can be undone.
function deleteSectionSheet(name) {
  const items = state.todos.filter(t => t.section === name);
  const n = items.length, word = `to-do${n === 1 ? '' : 's'}`;
  const dropSection = () => {
    state.todoSections = state.todoSections.filter(s => s !== name);
    delete sectionColors()[name];
    delete sectionTextColors()[name];
    state.settings.todoCollapsed = (state.settings.todoCollapsed || []).filter(k => k !== name);
  };
  openSheet(
    el('h3', {}, `Delete “${name}”?`),
    el('p', {}, n ? `This section has ${n} ${word}.` : 'This section is empty.'),
    el('button', {
      class: 'sheet-btn',
      onclick: () => {
        todoChange(() => { dropSection(); items.forEach(t => { t.section = ''; }); });
        closeSheet(); toast(`Deleted section ${name}`, todoUndo);
      },
    }, n ? `Delete section only (keep its ${n} ${word})` : 'Delete section'),
    n ? el('button', {
      class: 'sheet-btn danger',
      onclick: () => {
        todoChange(() => { dropSection(); items.forEach(t => trashTodo(t, 'deleted')); });
        closeSheet(); toast(`Deleted ${name} and ${n} ${word}`, todoUndo);
      },
    }, `Delete section and its ${n} ${word}`) : null,
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
}

function newSectionSheet() {
  const input = el('input', { class: 'text-input', type: 'text', maxlength: 30, placeholder: 'e.g. Weekly Chores' });
  let colors = { bg: '', text: '' };
  const add = () => {
    const name = input.value.trim();
    if (!name) return;
    setSectionColors(name, colors);
    if (!state.todoSections.includes(name)) todoChange(() => state.todoSections.push(name));
    else { save(); renderTodos(); }
    closeSheet();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  // The Add button previews the picked colors: the section color as its background, the text color
  // (or the automatic navy / white) as its text.
  const addBtn = el('button', { class: 'sheet-btn primary', onclick: add }, 'Add section');
  const paintAdd = () => {
    const bg = colors.bg, ink = colors.text || (bg ? (inkClass(bg) === 'on-light' ? '#1c2a4a' : '#ffffff') : '');
    addBtn.style.background = bg || '';
    addBtn.style.color = ink || '';
    addBtn.style.boxShadow = bg && luminance(bg) > 0.85 ? 'inset 0 0 0 1.5px var(--line)' : '';
  };
  openSheet(
    el('h3', {}, 'New section'),
    input,
    el('div', { class: 'sheet-label' }, 'COLORS'),
    sectionColorPicker(colors, c => { colors = c; paintAdd(); }),
    addBtn,
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'));
  setTimeout(() => input.focus(), 250);
}

function sectionMenu(name) {
  const input = el('input', { class: 'text-input', type: 'text', maxlength: 30, value: name });
  const colors = sectionColors(), textColors = sectionTextColors();
  const pickColor = c => { setSectionColors(name, c); save(); renderTodos(); };
  openSheet(
    el('h3', {}, name),
    el('div', { class: 'sheet-label' }, 'RENAME', input),
    el('div', { class: 'sheet-label' }, 'COLORS'),
    sectionColorPicker({ bg: colors[name] || '', text: textColors[name] || '' }, pickColor),
    el('button', {
      class: 'sheet-btn primary',
      onclick: () => {
        const next = input.value.trim();
        if (next && next !== name) todoChange(() => {
          if (colors[name]) { colors[next] = colors[name]; delete colors[name]; }
          if (textColors[name]) { textColors[next] = textColors[name]; delete textColors[name]; }
          state.todoSections = state.todoSections.map(s => (s === name ? next : s)).filter((s, i, a) => a.indexOf(s) === i);
          state.todos.forEach(t => { if (t.section === name) t.section = next; });
        });
        closeSheet();
      },
    }, 'Save name'),
    el('button', { class: 'sheet-btn danger', onclick: () => switchSheet(() => deleteSectionSheet(name)) }, 'Delete section…'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
}

$('#todo-view').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  todoView = b.dataset.v; renderTodos();
});
$('#btn-todo-add').addEventListener('click', () => todoSheet(null));
$('#btn-section-add').addEventListener('click', newSectionSheet);
$('#btn-todo-edit').addEventListener('click', () => {
  todoEditing = !todoEditing;
  if (todoEditing) todoView = 'lists';
  $('#btn-todo-edit').classList.toggle('on', todoEditing);
  $('#btn-todo-edit').setAttribute('aria-pressed', String(todoEditing));
  renderTodos();
});
$('#btn-todo-undo').addEventListener('click', todoUndo);
$('#btn-todo-redo').addEventListener('click', todoRedo);

/* =========================================================
   Sheet + toast
   ========================================================= */
function openSheet(...children) {
  const sheet = $('#sheet');
  sheet.classList.remove('tight', 'full'); // (only the sheet that asks for it is compact)
  onSheetDismiss = null;
  sheet.style.transform = '';
  sheet.style.transition = '';
  sheet.innerHTML = '';
  sheet.append(...children.flat().filter(Boolean));
  sheet.dataset.open = '1';
  $('#sheet-backdrop').classList.add('show');
  requestAnimationFrame(() => sheet.classList.add('show'));
}
function closeSheet() {
  delete $('#sheet').dataset.open;
  $('#sheet').classList.remove('show');
  $('#sheet-backdrop').classList.remove('show');
  if (document.activeElement) document.activeElement.blur();
}
$('#sheet-backdrop').addEventListener('click', e => {
  if (Date.now() - holdReleasedAt < 500 && Math.hypot(e.clientX - blockTap.x, e.clientY - blockTap.y) < 40) return; // the finger lifting off the card
  dismissSheet();
});

// Closing a sheet by tapping outside it or swiping it away (not its Cancel button). A sheet with
// something worth keeping (a vision being written) sets onSheetDismiss to save it first.
let onSheetDismiss = null;
function dismissSheet() {
  const keep = onSheetDismiss;
  onSheetDismiss = null;
  keep?.();
  closeSheet();
}

/* Swipes on a sheet:
   - up (content at the top): grow to full screen, when there's more to see or a box to write in
   - down (content at the top): a full-screen sheet shrinks back; otherwise the sheet closes
   Text boxes that have scrolled keep their own swipes, so scrolling a vision never closes it. */
(() => {
  const sheet = $('#sheet');
  let startY = null, dy = 0, dragging = false, atTop = true;
  const canGrow = () => !sheet.classList.contains('full') && (sheet.scrollHeight > sheet.clientHeight + 4 || !!sheet.querySelector('textarea'));
  sheet.addEventListener('touchstart', e => {
    if (!sheet.classList.contains('show')) { startY = null; return; }
    // Date wheels and scrolling lists inside the sheet handle their own up/down swipes.
    if (e.target.closest('.wheel, .hist')) { startY = null; return; }
    const box = e.target.closest('textarea');
    atTop = sheet.scrollTop <= 0 && !(box && box.scrollTop > 0);
    startY = e.touches[0].clientY; dy = 0; dragging = false;
  }, { passive: true });
  sheet.addEventListener('touchmove', e => {
    if (startY == null) return;
    dy = e.touches[0].clientY - startY;
    if (!dragging) {
      if (dy < -12 && canGrow()) { startY = null; sheet.classList.add('full'); return; } // up: grow first, then scroll
      if (dy < 8) { if (dy < -12) startY = null; return; } // moving up = normal scrolling
      if (!atTop || sheet.scrollTop > 0) { startY = null; return; } // down = scrolling back up
      dragging = true;
      sheet.style.transition = 'none';
      document.activeElement?.blur?.();
    }
    e.preventDefault();
    sheet.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }, { passive: false });
  const end = () => {
    if (startY == null) return;
    startY = null;
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    if (dy > Math.min(120, sheet.offsetHeight * 0.25)) {
      if (sheet.classList.contains('full')) { sheet.classList.remove('full'); sheet.style.transform = ''; return; }
      const keep = onSheetDismiss;
      onSheetDismiss = null;
      keep?.();
      sheet.style.transform = 'translateY(110%)';
      $('#sheet-backdrop').classList.remove('show');
      delete sheet.dataset.open;
      setTimeout(() => { sheet.classList.remove('show'); sheet.style.transform = ''; }, 280);
    } else {
      sheet.style.transform = '';
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
})();

let toastTimer = null;
function toast(msg, undoFn) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(el('span', {}, msg));
  if (undoFn) t.append(el('button', { onclick: () => { undoFn(); t.classList.remove('show'); } }, 'UNDO'));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), undoFn ? 3500 : 2200);
}

/* =========================================================
   Boot
   ========================================================= */
renderToday();
if (sessionStorage.getItem('goalie-reopen') === 'settings') {
  sessionStorage.removeItem('goalie-reopen');
  renderSettings();
  openScreen('settings');
}
checkReminders();
setInterval(() => { renderToday(); checkReminders(); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { renderToday(); checkReminders(); }
});

// Use the IndexedDB copy if it's newer than what localStorage had (e.g. localStorage filled up),
// then keep both up to date from here on.
async function syncStorage() {
  let saved = null;
  try {
    const json = await idbGet('state');
    storage.idbWorks = true;
    if (json) {
      try { saved = JSON.parse(json); } catch (e) { keepDamagedCopy(json); }
    }
  } catch (e) { return; } // no IndexedDB: localStorage only
  if (saved && (saved.savedAt || 0) > (state.savedAt || 0)) {
    state = normalizeState(saved);
    migrate();
    applyTheme();
    renderToday();
  }
  storage.synced = true;
  idbSet('state', JSON.stringify(state)).catch(() => {});
}
const storageReady = syncStorage(); // (account.js waits for this before syncing with the cloud)
// Ask iPhone not to clear Goalie's storage when space runs low.
navigator.storage?.persist?.().catch(() => {});
if (storage.damagedKey) setTimeout(() => toast('Saved data couldn’t be read. A copy was kept (Settings → Backup).'), 1200);

// (Not on localhost: while developing, edits should show up without an update step.)
const isLocalDev = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
if ('serviceWorker' in navigator && !isLocalDev) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      swReg = reg;
      checkForUpdate(true);
    }).catch(() => checkForUpdate(true));
  });
} else {
  checkForUpdate(true);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { updateAsked = false; return; } // reopening asks again
  swReg?.update().catch(() => {});
  checkForUpdate(true);
  startupPopups();
});
setInterval(() => checkForUpdate(false), 60000); // a scheduled update time may arrive while open
function startupPopups() {
  whenIdle(() => {
    streakPopup();
    whenIdle(() => { askAboutEndedGoals(); backupReminder(); });
  });
}
setTimeout(startupPopups, 1500);
