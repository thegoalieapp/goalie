'use strict';

/* =========================================================
   App locks (App Store app only): Screen Time locks that lift when goals are done
   =========================================================
   Settings → App Locks. Each lock has its own apps (Apple's picker) and its own goals. It's locked
   until every one of its goals is done for the current period, and locks again when a goal's period
   restarts (the native re-locker handles that even while Goalie is closed). Decided with the owner:
   - no early unlocks; while locked a lock only gets stricter (add apps or goals, never remove, no deleting)
   - any goal can unlock one (daily, weekly, monthly, yearly, by a date)
   - the lock screen lists the goals still left, with progress

   Locks belong to this device (Apple's app tokens only work on the phone that picked them), so they
   live in their own storage, apart from the synced data. The native side is GoalieLocksPlugin. */

const LOCKS_KEY = 'goalie.locks';
const locksPlugin = () => window.Capacitor?.Plugins?.GoalieLocks;
const locksUi = { auth: 'notDetermined', wasLocked: new Map() };
try { if (localStorage.getItem('goalie.screenTimeOK')) locksUi.auth = 'approved'; } catch (e) { /* storage blocked */ }

function readLocks() { try { return JSON.parse(localStorage.getItem(LOCKS_KEY) || '[]'); } catch (e) { return []; } }
function writeLocks(list) { try { localStorage.setItem(LOCKS_KEY, JSON.stringify(list)); } catch (e) { /* full */ } }

/* ---------- When is a lock locked? ---------- */
// This period's total for a goal, always for today (not the day picked on the home page).
function countThisPeriod(t) {
  const now = new Date(), from = periodStart(t.reset, now), to = nextPeriodStart(t.reset, from);
  return countedEntries(t).reduce((s, e) => (e.ts >= from.getTime() && e.ts < to.getTime() ? s + e.value : s), 0);
}
// Goals that can unlock something: ones with a target, or check-offs.
const lockable = t => t.target > 0 || isCheck(t);
// Done for now: completed (the same rule as the big ✓ on its card), not measured today, or ended.
function goalDoneForLock(t) {
  if (t.reset === 'day' && !measuredWeekdays(t).includes(new Date().getDay())) return true;
  if (byDate(t) && Date.now() >= dueEndMs(t)) return true;
  return goalReached(t, countThisPeriod(t));
}
const lockGoals = lock => lock.goalIds.map(id => state.tallies.find(t => t.id === id)).filter(Boolean);
// A lock only applies on its days (Sun–Sat; none chosen: every day). On other days its apps are open.
const lockDays = lock => (Array.isArray(lock.days) && lock.days.length ? lock.days : [0, 1, 2, 3, 4, 5, 6]);
const lockAppliesToday = lock => lockDays(lock).includes(new Date().getDay());
const isLocked = lock => lockAppliesToday(lock) && lockGoals(lock).some(t => !goalDoneForLock(t));
const lockPeriod = t => (t.reset === 'minute' || t.reset === 'hour' ? 'day' : t.reset);

function progressText(t, n) {
  if (isCheck(t)) return goalReached(t, n) ? '✓' : '✗';
  return `${num(t, n)}/${num(t, t.target)}${isMoney(t) ? '' : ` ${unitLabel(t)}`}`;
}

// What the native side keeps for each lock (and shows on the lock screen).
function lockForNative(lock) {
  const goals = lockGoals(lock);
  return {
    id: lock.id,
    name: lock.name,
    locked: isLocked(lock),
    relock: [...new Set(goals.map(lockPeriod).filter(p => p !== 'never'))],
    days: lockDays(lock),
    goals: goals.map(t => ({
      name: t.name,
      progress: progressText(t, countThisPeriod(t)),
      done: goalDoneForLock(t),
      period: lockPeriod(t),
      resetProgress: progressText(t, 0),
    })),
  };
}

// Send every lock's state to the native side: locks or unlocks apps right away.
let locksTimer = null;
function syncLocks({ now = false } = {}) {
  if (!locksPlugin()) return;
  clearTimeout(locksTimer);
  locksTimer = setTimeout(async () => {
    const locks = readLocks();
    const native = locks.map(lockForNative);
    for (const l of native) { // a lock that just lifted: say so
      if (locksUi.wasLocked.get(l.id) && !l.locked) toast(`${l.name || 'Your apps'} unlocked. Nice work!`);
      locksUi.wasLocked.set(l.id, l.locked);
    }
    try {
      await locksPlugin().update({ json: JSON.stringify({ locks: native, weekStart: state.settings.weekStart || 0 }) });
    } catch (e) { console.warn('Goalie locks:', e); }
    if ($('#screen-locks').classList.contains('active')) renderLocks();
  }, now ? 0 : 400);
}

/* ---------- Locks screen ---------- */
// Screen Time access, once allowed, is remembered, so the App Locks screen opens straight away
// without asking. iPhone's real answer (which waits out the "not decided yet" it gives for a moment
// after Goalie starts) comes after: if access was turned off, the Allow button comes back.
const SCREEN_TIME_OK = 'goalie.screenTimeOK';
function rememberScreenTime() {
  try {
    if (locksUi.auth === 'approved') localStorage.setItem(SCREEN_TIME_OK, '1');
    else if (locksUi.auth !== 'unavailable') localStorage.removeItem(SCREEN_TIME_OK);
  } catch (e) { /* storage blocked */ }
}
function appsText(apps) {
  if (!apps) return 'No apps chosen yet';
  const parts = [];
  if (apps.apps) parts.push(`${apps.apps} app${apps.apps === 1 ? '' : 's'}`);
  if (apps.categories) parts.push(`${apps.categories} categor${apps.categories === 1 ? 'y' : 'ies'}`);
  if (apps.sites) parts.push(`${apps.sites} website${apps.sites === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'No apps chosen yet';
}

// A lock or limit holds up to 50 apps, 50 websites and 50 categories (Apple's picker won't finish
// past that). When one is filled up, offer another with the same settings for the rest.
const fullPicks = new Set(); // ids picked up to the limit, until they're saved
const nextName = name => {
  const m = name.match(/^(.*?)\s*(\d+)$/);
  return (m ? `${m[1]} ${+m[2] + 1}` : `${name} 2`).slice(0, 30);
};
function offerAnother(kind, name, open) {
  setTimeout(() => openSheet(
    el('h3', {}, 'Want to block more?'),
    el('p', {}, `${name} is full: one ${kind} holds up to 50 apps, 50 websites and 50 categories. Make another ${kind} with the same settings for the rest?`),
    kind === 'limit' ? el('p', { class: 'note' }, 'Each limit keeps its own daily time.') : null,
    el('button', { class: 'sheet-btn primary', onclick: () => switchSheet(open) }, `Make another ${kind}`),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Not now'),
  ), 400);
}

// "See which apps": Apple's own list of what a lock or limit has picked, with names and icons.
// Goalie itself is never told which apps they are, so the list comes up from iPhone, not here.
function seeApps(id, picked) {
  return el('button', { type: 'button', class: 'see-apps', onclick: async () => {
    if (!picked()) { toast('No apps chosen yet'); return; }
    try { await locksPlugin().showApps({ id }); } catch (e) { toast('Couldn’t show the apps'); }
  } }, 'See which apps ›');
}

function relockText(lock) {
  const periods = new Set(lockGoals(lock).map(lockPeriod));
  if (periods.has('day')) return 'Locks again tomorrow';
  if (periods.has('week')) return 'Locks again next week';
  if (periods.has('month')) return 'Locks again next month';
  if (periods.has('year')) return 'Locks again next year';
  return 'Stays unlocked';
}

// The screen appears right away from what's remembered; iPhone's answer about Screen Time access
// (which can take a moment) is checked after, and the screen only redraws if it turns out different.
async function renderLocks() {
  drawLocks();
  const before = locksUi.auth;
  try { locksUi.auth = (await locksPlugin().authorization()).status; } catch (e) { locksUi.auth = 'unavailable'; }
  rememberScreenTime();
  if (locksUi.auth !== before) drawLocks();
}

function drawLocks() {
  const box = $('#locks-body');
  box.innerHTML = '';
  if (locksUi.auth !== 'approved') {
    box.append(el('div', { class: 'locks-intro' },
      el('h3', {}, 'Lock apps until your goals are done'),
      el('p', {}, 'Pick apps like social media and the goals that unlock them. The apps stay locked until those goals are done, and lock again when the goals start over (tomorrow for daily goals, next week for weekly ones).'),
      el('button', { type: 'button', class: 'submit-btn', onclick: allowScreenTime }, 'Allow Screen Time access'),
      locksUi.auth === 'denied'
        ? el('p', { class: 'note' }, 'Screen Time access is off for Goalie. If the button doesn’t ask, turn it on in iPhone Settings → Screen Time → Apps with Screen Time Access.')
        : null,
      el('p', { class: 'note' }, 'Goalie never sees which apps you pick or how you use them. That stays on your phone with Apple.')));
    return;
  }
  const locks = readLocks();
  box.append(el('h2', { class: 'locks-heading' }, 'LOCKED UNTIL GOALS ARE DONE'));
  if (!locks.length) box.append(el('p', { class: 'note locks-empty' }, 'No locks yet. Make one to keep distracting apps closed until your goals are done.'));
  for (const lock of locks) {
    const locked = isLocked(lock), goals = lockGoals(lock);
    box.append(el('button', { type: 'button', class: `lock-card${locked ? ' locked' : ''}`, onclick: () => lockSheet(lock) },
      el('div', { class: 'lock-card-top' },
        el('strong', {}, lock.name || 'Lock'),
        el('span', { class: 'lock-state' }, locked ? 'LOCKED' : 'UNLOCKED')),
      el('div', { class: 'lock-apps' }, [appsText(lock.apps), lockDays(lock).length < 7 ? daysSummary(lockDays(lock)) : ''].filter(Boolean).join(' · ')),
      el('ul', { class: 'lock-goals' }, goals.length
        ? goals.map(t => el('li', { class: goalDoneForLock(t) ? 'done' : '' },
          el('span', { class: 'lock-goal-mark' }, goalDoneForLock(t) ? '✓' : '•'),
          el('span', { class: 'lock-goal-name' }, t.name),
          el('span', { class: 'lock-goal-progress' }, progressText(t, countThisPeriod(t)))))
        : el('li', {}, 'No goals chosen')),
      el('div', { class: 'lock-foot' }, locked ? `${goals.filter(t => !goalDoneForLock(t)).length} left to unlock` : relockText(lock))));
  }
  box.append(el('button', { type: 'button', class: 'submit-btn', onclick: () => lockSheet(null) }, '+ NEW LOCK'));
  renderLimits(box);
}

async function allowScreenTime() {
  try { locksUi.auth = (await locksPlugin().requestAuthorization()).status; } catch (e) { /* stays as it was */ }
  rememberScreenTime();
  if (locksUi.auth === 'approved') { syncLocks({ now: true }); syncScreenGoals({ now: true }); } // turned back on: everything restarts
  renderLocks();
}

// New lock (null) or change one. While it's locked, apps and goals can only be added. A new lock
// shows what it will do before it's turned on (draft: its choices, coming back from that step).
function lockSheet(existing, draft = null) {
  const lock = draft || (existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), name: '', goalIds: [], apps: null, createdAt: Date.now() });
  const locked = existing ? isLocked(existing) : false;
  const kept = new Set(locked ? existing.goalIds : []);
  const nameInput = el('input', { class: 'text-input full', type: 'text', maxlength: '30', placeholder: 'e.g. Social media', value: lock.name });
  const appsLine = el('div', { class: 'lock-apps' }, appsText(lock.apps));
  const goals = state.tallies.filter(lockable);
  const picks = new Set(lock.goalIds);
  // Sun–Sat: the days the lock applies. While it's locked, days can be added, not removed.
  const days = new Set(lockDays(lock));
  const keepDays = new Set(locked ? lockDays(existing) : []);
  const daysRow = el('div', { class: 'days multi limit-days' }, ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((label, d) => {
    const b = el('button', { type: 'button', class: days.has(d) ? 'on' : '', 'aria-pressed': String(days.has(d)) }, label);
    b.addEventListener('click', () => {
      if (days.has(d) && keepDays.has(d)) { toast('Locked now: days can be added, not removed'); return; }
      if (days.has(d)) days.delete(d); else days.add(d);
      b.classList.toggle('on', days.has(d));
      b.setAttribute('aria-pressed', String(days.has(d)));
    });
    return b;
  }));
  const goalList = el('div', { class: 'lock-goal-picks' }, goals.length ? goals.map(t => {
    const fixed = kept.has(t.id);
    const row = el('button', { type: 'button', class: `lock-goal-pick${picks.has(t.id) ? ' on' : ''}${fixed ? ' fixed' : ''}`, 'aria-pressed': String(picks.has(t.id)) },
      el('span', { class: 'lock-pick-box' }, '✓'), el('span', {}, t.name), el('span', { class: 'lock-pick-period' }, (PERIOD_LABEL[t.reset] || '').toLowerCase()));
    row.addEventListener('click', () => {
      if (fixed) { toast('Locked: goals can be added, not removed'); return; }
      if (picks.has(t.id)) picks.delete(t.id); else picks.add(t.id);
      row.classList.toggle('on', picks.has(t.id));
      row.setAttribute('aria-pressed', String(picks.has(t.id)));
    });
    return row;
  }) : el('p', { class: 'note' }, 'Add a goal with a target (or a check-off goal) first.'));

  if (dailyOn) buildDaily();
  if (hoursOn) buildHours();

  const chooseApps = async () => {
    try {
      const r = await locksPlugin().pickApps({ id: lock.id, locked });
      if (!r.cancelled) { lock.apps = { apps: r.apps, categories: r.categories, sites: r.sites }; appsLine.textContent = appsText(lock.apps); }
      if (!r.cancelled) fullPicks[r.full ? 'add' : 'delete'](lock.id);
    } catch (e) { toast('Couldn’t open the app picker'); }
  };
  const saveLock = () => {
    lock.name = nameInput.value.trim();
    lock.goalIds = goals.filter(t => picks.has(t.id)).map(t => t.id);
    lock.days = [...days].sort((a, b) => a - b);
    if (!lock.days.length) { toast('Pick at least one day'); return; }
    if (!lock.goalIds.length) { toast('Choose at least one goal'); return; }
    if (!lock.apps || !(lock.apps.apps || lock.apps.categories || lock.apps.sites)) { toast('Choose at least one app'); return; }
    if (existing) commitLock(lock); else confirmNewLock(lock);
  };
  const deleteLock = () => {
    if (locked) { toast('A lock can be deleted once its goals are done'); return; }
    openSheet(
      el('h3', {}, `Delete ${lock.name || 'this lock'}?`),
      el('p', {}, 'Its apps stop being locked.'),
      el('button', { class: 'sheet-btn danger', onclick: async () => {
        writeLocks(readLocks().filter(l => l.id !== lock.id));
        try { await locksPlugin().remove({ id: lock.id }); } catch (e) { /* gone already */ }
        closeSheet(); renderLocks(); toast('Lock deleted');
      } }, 'Delete lock'),
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
    );
  };
  // A new lock that's abandoned: forget the apps picked for it.
  const cancel = () => { if (!existing) locksPlugin()?.remove({ id: lock.id }).catch(() => {}); closeSheet(); };

  openSheet(
    el('h3', {}, existing ? (lock.name || 'Lock') : 'New lock'),
    locked ? el('p', { class: 'note' }, 'This lock is on. You can add apps and goals, but not remove them, until its goals are done.') : null,
    el('div', { class: 'sheet-label' }, 'NAME'),
    nameInput,
    el('div', { class: 'sheet-label' }, 'APPS TO LOCK'),
    appsLine,
    seeApps(lock.id, () => lock.apps),
    el('button', { type: 'button', class: 'sheet-btn', onclick: chooseApps }, lock.apps ? (locked ? 'Add apps' : 'Change apps') : 'Choose apps'),
    el('div', { class: 'sheet-label' }, 'GOALS THAT UNLOCK IT'),
    goalList,
    el('div', { class: 'sheet-label' }, 'DAYS'),
    daysRow,
    el('button', { class: 'sheet-btn primary', onclick: saveLock }, existing ? 'Save' : 'Turn on lock'),
    existing ? el('button', { class: `sheet-btn danger${locked ? ' disabled' : ''}`, onclick: deleteLock }, 'Delete lock') : null,
    el('button', { class: 'sheet-btn', onclick: cancel }, 'Cancel'),
  );
  onSheetDismiss = () => { if (!existing) locksPlugin()?.remove({ id: lock.id }).catch(() => {}); };
}

// Save a lock and lock or unlock its apps.
function commitLock(lock) {
  if (fullPicks.delete(lock.id)) offerAnother('lock', lock.name || 'This lock', () => lockSheet(null, {
    ...JSON.parse(JSON.stringify(lock)), id: uid(), name: nextName(lock.name || 'Lock'), apps: null, createdAt: Date.now(),
  }));
  const list = readLocks();
  const at = list.findIndex(l => l.id === lock.id);
  if (at >= 0) list[at] = lock; else list.push(lock);
  writeLocks(list);
  closeSheet();
  syncLocks({ now: true });
  toast(isLocked(lock) ? `${lock.name || 'Lock'} is on. Finish its goals to unlock.` : `${lock.name || 'Lock'} saved`);
}

// Before a new lock turns on: exactly what it locks and what unlocks it. Nothing is locked until
// Complete; Go back returns to the choices.
function confirmNewLock(lock) {
  const goals = lockGoals(lock), lockedNow = isLocked(lock);
  const left = goals.filter(t => !goalDoneForLock(t));
  openSheet(
    el('h3', {}, 'Are these right?'),
    el('div', { class: 'confirm-summary' },
      el('p', {}, el('strong', {}, lock.name || 'This lock'), ` locks ${appsText(lock.apps).toLowerCase()}`,
        lockDays(lock).length < 7 ? ` on ${daysSummary(lockDays(lock))} (other days they stay open).` : '.'),
      seeApps(lock.id, () => lock.apps),
      el('p', {}, lockedNow
        ? `They lock as soon as you tap Complete, and unlock once you finish ${left.length === 1 ? 'this goal' : 'these goals'}:`
        : !lockAppliesToday(lock)
          ? 'Today isn’t one of its days, so they stay open. On its days, they’re locked until you finish:'
          : 'Your goals are done for now, so they stay open. When a goal starts over, they lock until you finish:'),
      el('ul', {}, (lockedNow ? left : goals).map(t => el('li', {},
        el('strong', {}, t.name), ` · ${progressText(t, countThisPeriod(t))} ${(PERIOD_LABEL[t.reset] || '').toLowerCase()}`))),
      el('p', {}, relockText(lock) === 'Stays unlocked'
        ? 'Once they’re done, the apps stay unlocked.'
        : `${relockText(lock)}, when ${goals.length === 1 ? 'the goal starts' : 'the goals start'} over.`),
      el('p', { class: 'note' }, 'While it’s locked, apps and goals can be added but not removed, and the lock can’t be deleted.')),
    el('button', { class: 'sheet-btn primary', onclick: () => commitLock(lock) }, 'Complete'),
    el('button', { class: 'sheet-btn', onclick: () => lockSheet(null, lock) }, 'Go back'),
  );
  onSheetDismiss = () => locksPlugin()?.remove({ id: lock.id }).catch(() => {});
}

/* ---------- Start ---------- */
if (isNativeApp && locksPlugin()) {
  $('#locks-settings').classList.remove('hidden');
  $('#btn-locks').addEventListener('click', () => { renderLocks(); openScreen('locks'); });
  window.goalieLocks = () => syncLocks(); // save() calls this
  readLocks().forEach(l => locksUi.wasLocked.set(l.id, isLocked(l)));
  storageReady.then(() => syncLocks({ now: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncLocks({ now: true }); });
  setInterval(() => syncLocks(), 60000); // a new day (or week…) can start while Goalie is open
}


/* =========================================================
   Screen-time limits (App Store app only)
   =========================================================
   Settings → App Locks · Screen Time → + New limit: pick apps and a daily limit ("Instagram, 30
   minutes a day"), locked hours ("10 PM to 7 AM"), or both, on the days picked (Sun–Sat). Each limit is also a goal on the home screen ("Instagram ↓ 30 min") that fills
   itself in from Screen Time in 5-minute steps (Apple only says when the apps reach each step, never
   exact numbers), even while Goalie is closed. Reaching the limit locks the apps until midnight.
   No early unlocks: while a limit has its apps locked, the limit can only go down, apps can only be
   added, and it can't be deleted until midnight.

   Goal fields: screen (true), screenKey (where its apps are saved on the phone), screenApps (how many
   apps / categories / websites), screenLock (true: lock at the limit). The minutes stay on the phone
   (account.js keeps them out of the cloud). */

const canLockAtLimit = f => f.direction === 'decrease' && f.target > 0;
const screenLimits = () => state.tallies.filter(t => t.screen && t.screenKey);
// How many apps reached their own limit today ("each" limits), as the phone last reported.
let screenReached = {};
// Schedules iPhone refused for a limit (shown on its card, so a lock can't quietly not happen).
let screenProblems = {};
// The daily limit has the apps (or, for "each" limits, some of them) locked right now.
const limitReached = t => (t.screenEach ? (screenReached[t.screenKey] || 0) > 0 : t.target > 0 && countThisPeriod(t) >= t.target);
// Locked hours: one or more times ("22:00" to "07:00"), each on its own days; they may run past
// midnight. (Limits from before several times were possible have screenFrom/screenTo on the
// limit's days.)
const MAX_TIMES = 4; // iPhone only lets an app run so many schedules at once
const clockMinutes = hhmm => { const [h, m] = (hhmm || '').split(':').map(Number); return h * 60 + m; };
const realTime = h => !!(h && h.from && h.to && h.from !== h.to);
function limitHours(t) {
  if (Array.isArray(t.screenHours)) return t.screenHours.filter(realTime);
  return realTime({ from: t.screenFrom, to: t.screenTo }) ? [{ from: t.screenFrom, to: t.screenTo, days: limitDays(t) }] : [];
}
const hasWindow = t => limitHours(t).length > 0;
// The days a limit applies (Sun–Sat picked in the sheet; it's also the goal card's measured days).
const limitDays = t => (Array.isArray(t.days) && t.days.length ? t.days : ALL_DAYS);
const timeDays = h => (Array.isArray(h.days) && h.days.length ? h.days : ALL_DAYS);
// Locked hours that run past midnight (10 PM to 7 AM) belong to the day they start.
function timeActive(h, d = new Date()) {
  const now = d.getHours() * 60 + d.getMinutes(), start = clockMinutes(h.from), end = clockMinutes(h.to);
  const on = date => timeDays(h).includes(date.getDay());
  if (start < end) return now >= start && now < end && on(d);
  if (now >= start) return on(d);
  if (now < end) return on(new Date(d.getTime() - DAY_MS));
  return false;
}
// The locked-hours time that has the apps locked right now (the one ending last), if any.
function activeTime(t) {
  const ends = h => (clockMinutes(h.to) - new Date().getHours() * 60 - new Date().getMinutes() + 1440) % 1440;
  return limitHours(t).filter(h => timeActive(h)).sort((a, b) => ends(b) - ends(a))[0] || null;
}
const inWindowNow = t => !!activeTime(t);
const timeText = h => `${fmtTime(h.from)} to ${fmtTime(h.to)}`;
const sameTime = (a, b) => a.from === b.from && a.to === b.to;
const hhmmOf = ([h, m]) => `${pad2(h)}:${pad2(m)}`;
const dateAt = hhmm => { const d = new Date(); d.setHours(...hhmm.split(':').map(Number), 0, 0); return d; };

// Editing a limit's goal card in the goal form: its unit, period and limit are set in App Locks.
function syncScreenForm() {
  const fixed = !!form.screen;
  ['[data-field="unit"]', '#per-row', '[data-field="direction"]'].forEach(sel => $(sel)?.classList.toggle('fixed', fixed));
  $('#f-goal').readOnly = fixed;
  let note = $('#screen-form-note');
  if (!note) { note = el('p', { class: 'note', id: 'screen-form-note' }, 'This is a screen-time limit: change its apps and limit in Settings → App Locks · Screen Time.'); $('#goal-desc').after(note); }
  note.classList.toggle('hidden', !fixed);
}

// The limits on the App Locks · Screen Time screen.
function renderLimits(box) {
  box.append(el('h2', { class: 'locks-heading' }, 'SCREEN TIME LIMITS'));
  const limits = screenLimits();
  if (!limits.length) box.append(el('p', { class: 'note locks-empty' }, 'Limit apps like Instagram to a number of minutes a day, lock them during set hours (like 10 PM to 7 AM), or both.'));
  for (const t of limits) {
    const used = countThisPeriod(t), over = limitReached(t), active = activeTime(t), inHours = !!active;
    const hit = screenReached[t.screenKey] || 0;
    const foot = inHours ? `Locked until ${fmtTime(active.to)}`
      : t.screenEach && t.target > 0 ? (hit ? `${hit} app${hit === 1 ? '' : 's'} at the limit · locked until midnight` : `${num(t, t.target)} for each app · ${num(t, used)} used today in all`)
      : over ? `${num(t, used)} of ${num(t, t.target)} today · locked until midnight`
        : t.target > 0 ? `${num(t, used)} of ${num(t, t.target)} today · ${num(t, t.target - used)} left`
          : `${num(t, used)} today`;
    box.append(el('button', { type: 'button', class: `lock-card${over || inHours ? ' locked' : ''}`, onclick: () => limitSheet(t) },
      el('div', { class: 'lock-card-top' },
        el('strong', {}, t.name),
        el('span', { class: 'lock-state' }, over || inHours ? 'LOCKED' : 'OPEN')),
      el('div', { class: 'lock-apps' }, appsText(t.screenApps)),
      t.target > 0 ? el('div', { class: 'lock-apps' }, `Daily limit: ${daysSummary(limitDays(t))}`) : null,
      limitHours(t).map(h => el('div', { class: 'lock-apps' }, `Locked ${timeText(h)} · ${daysSummary(timeDays(h))}`)),
      t.target > 0 && !t.screenEach ? el('div', { class: 'limit-bar', role: 'img', 'aria-label': `${Math.round(used)} of ${t.target} minutes used today` },
        el('span', { style: `width:${Math.min(100, (used / t.target) * 100)}%` })) : null,
      el('div', { class: 'lock-foot' }, foot),
      screenProblems[t.screenKey] ? el('div', { class: 'lock-problem' }, `⚠ ${screenProblems[t.screenKey]}. Goalie tries again each time it opens.`) : null));
  }
  box.append(el('button', { type: 'button', class: 'submit-btn secondary', onclick: () => limitSheet(null) }, '+ NEW LIMIT'));
  box.append(el('button', { type: 'button', class: 'check-blocking', onclick: () => checkBlocking() }, 'Something not locking? Check blocking'));
}

// "Check blocking": what the phone side thinks should be locked and what iPhone is holding, in
// words, plus a button that writes every block again.
async function checkBlocking(reapply = false) {
  let r;
  try { r = await locksPlugin().checkBlocking({ reapply }); } catch (e) { toast('Couldn’t check blocking'); return; }
  const s = r.shield || {};
  const yes = b => (b ? 'yes' : 'no');
  const what = (a, w, c) => appsText({ apps: a, sites: w, categories: c }).replace('No apps chosen yet', 'nothing');
  const rows = [];
  rows.push(['Screen Time access', r.status === 'approved' ? 'On' : 'Off: nothing can lock until it’s on']);
  rows.push(['Should be locked now', what(s.wantApps, s.wantSites, s.wantCategories)]);
  rows.push(['iPhone is holding', `${what(s.mainApps, s.mainSites, s.mainCategories)}${s.extraStores ? ` (+${s.extraStores} extra group${s.extraStores === 1 ? '' : 's'})` : ''}`]);
  rows.push(['Schedules running', String(r.schedules ?? 0)]);
  const items = [
    ...(r.locks || []).map(l => [l.name || 'Lock', `locked: ${yes(l.locked)}${l.picked ? '' : ' · no apps saved on this phone'}`]),
    ...(r.limits || []).map(l => [l.name, `in locked hours: ${yes(l.inHours)} (locked: ${yes(l.hoursLocked)}) · daily limit locked: ${yes(l.limitLocked)} · ${l.picked ? what(l.apps, l.sites, l.categories) : 'no apps saved on this phone'}`]),
  ];
  const list = rows.concat(items);
  openSheet(
    el('h3', {}, 'Check blocking'),
    el('p', { class: 'note' }, 'What Goalie has told iPhone to lock. If a screenshot of this would help, send one.'),
    el('div', { class: 'hist check-rows' }, list.map(([k, v]) => el('div', { class: 'check-row' }, el('strong', {}, k), el('span', {}, v)))),
    el('button', { class: 'sheet-btn primary', onclick: () => { closeSheet(); setTimeout(() => checkBlocking(true), 300); } }, 'Lock again now'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Done'),
  );
}

// "1 hr 30 min", "45 min", "2 hr".
function durationText(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return [h ? `${h} hr` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ');
}

// Hours then minutes (every 5), as two wheels that go round.
function durationWheels(total) {
  const hours = Array.from({ length: 24 }, (_, h) => `${h} hr`);
  const minutes = Array.from({ length: 12 }, (_, i) => `${pad2(i * 5)} min`);
  const h = Math.min(23, Math.floor(total / 60)), m = Math.round((total % 60) / 5) % 12;
  const hourWheel = wheel(hours, h, () => {}, 'wheel-hour', { loop: true });
  const minuteWheel = wheel(minutes, m, () => {}, 'wheel-minute', { loop: true });
  return {
    node: el('div', { class: 'wheels compact duration-wheels' }, hourWheel, minuteWheel),
    get: () => hourWheel.index() * 60 + minuteWheel.index() * 5,
  };
}

// Sun–Sat buttons that add and remove days in a Set (days in keep can't be removed: says why).
function dayButtons(days, keep, why) {
  return el('div', { class: 'days multi limit-days' }, ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((label, d) => {
    const b = el('button', { type: 'button', class: days.has(d) ? 'on' : '', 'aria-pressed': String(days.has(d)) }, label);
    b.addEventListener('click', () => {
      if (days.has(d) && keep.has(d)) { toast(why); return; }
      if (days.has(d)) days.delete(d); else days.add(d);
      b.classList.toggle('on', days.has(d));
      b.setAttribute('aria-pressed', String(days.has(d)));
    });
    return b;
  }));
}
const onDays = days => (daysSummary(days) === 'Sun–Sat' ? 'every day' : daysSummary(days));

// New limit (null) or change one. No early unlocks: once the daily limit is reached it can only go
// down; during the locked hours they can't be changed or turned off; and while either has the apps
// locked, apps and days can only be added and the limit can't be deleted. A new limit shows what it
// will do before it's turned on (draft: its choices, coming back from that step).
function limitSheet(existing, draft = null) {
  const over = existing ? limitReached(existing) : false;
  const active = existing ? activeTime(existing) : null, inHours = !!active;
  const activeNow = existing ? limitHours(existing).filter(h => timeActive(h)) : []; // these can't change yet
  const locked = over || inHours;
  const key = draft?.key || existing?.screenKey || uid();
  let apps = draft ? draft.apps : existing?.screenApps || null;
  let dailyOn = draft ? draft.dailyOn : existing ? existing.target > 0 : true;
  let each = draft ? draft.each : !!existing?.screenEach;
  let hoursOn = draft ? draft.hoursOn : existing ? hasWindow(existing) : false;
  const startMinutes = draft?.minutes || existing?.target || 30;
  const newTime = () => ({ from: '22:00', to: '07:00', days: ALL_DAYS });
  const startTimes = draft?.hours?.length ? draft.hours : existing && hasWindow(existing) ? limitHours(existing) : [newTime()];
  const nameInput = el('input', { class: 'text-input full', type: 'text', maxlength: '30', placeholder: 'e.g. Instagram', value: draft?.name ?? existing?.name ?? '' });
  const appsLine = el('div', { class: 'lock-apps' }, appsText(apps));

  // Wheels go in when their part is switched on: a wheel reads its value from where it's scrolled
  // to, and a hidden one never scrolls into place.
  const dailyBox = el('div', { class: dailyOn ? '' : 'hidden' });
  const hoursBox = el('div', { class: hoursOn ? '' : 'hidden' });
  let amount = null, times = null; // times: each locked-hours time in the sheet, once built
  const eachSeg = el('div', { class: 'seg pills' },
    ...[['combined', 'COMBINED'], ['each', 'EACH APP']].map(([v, label]) => {
      const b = el('button', { type: 'button', 'data-v': v, class: (v === 'each') === each ? 'on' : '' }, label);
      b.addEventListener('click', () => {
        if (over && v === 'combined' && each) { toast('Limit reached today: it can’t change until midnight'); return; }
        each = v === 'each';
        eachSeg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        eachNote.textContent = eachText();
      });
      return b;
    }));
  const eachText = () => (each ? 'Each app gets its own daily limit and locks on its own when it reaches it.' : 'All the apps share one daily limit and lock together when it’s reached.');
  const eachNote = el('p', { class: 'note' }, eachText());
  const buildDaily = () => {
    if (amount) return;
    amount = durationWheels(startMinutes);
    dailyBox.append(amount.node, eachSeg, eachNote, el('div', { class: 'sheet-label' }, 'DAYS'), daysRow);
  };
  // Locked hours: one or more times, each with its own days ("+ Add another time"). A time that has
  // the apps locked right now can't be changed or removed until it ends (days can be added).
  const addTimeBtn = el('button', { type: 'button', class: 'sheet-btn', onclick: () => addTime(newTime()) }, '+ Add another time');
  const numberTimes = () => {
    times.forEach((t, i) => {
      t.title.textContent = times.length > 1 ? `TIME ${i + 1}` : 'TIME';
      t.remove.classList.toggle('hidden', times.length === 1);
    });
    addTimeBtn.classList.toggle('hidden', times.length >= MAX_TIMES);
  };
  const addTime = h => {
    const fixed = activeNow.some(a => sameTime(a, h));
    const fromWheels = timeWheels(dateAt(h.from), { compact: true }), toWheels = timeWheels(dateAt(h.to), { compact: true });
    const picked = new Set(timeDays(h));
    const entry = {
      title: el('span', {}, 'TIME'),
      remove: el('button', { type: 'button', class: 'time-remove', onclick: () => {
        if (fixed) { toast(`Locked until ${fmtTime(h.to)}: this time can’t be removed until then`); return; }
        times = times.filter(x => x !== entry);
        entry.node.remove();
        numberTimes();
      } }, 'Remove'),
      get: () => ({ from: hhmmOf(fromWheels.get()), to: hhmmOf(toWheels.get()), days: [...picked].sort((a, b) => a - b) }),
    };
    entry.node = el('div', { class: 'locked-time' },
      el('div', { class: 'sheet-label time-head' }, entry.title, entry.remove),
      el('div', { class: fixed ? 'fixed' : '' },
        el('div', { class: 'sheet-label' }, 'FROM'), fromWheels.node,
        el('div', { class: 'sheet-label' }, 'TO'), toWheels.node),
      el('div', { class: 'sheet-label' }, 'DAYS'),
      dayButtons(picked, new Set(fixed ? timeDays(h) : []), 'Locked now: days can be added, not removed'));
    times.push(entry);
    addTimeBtn.before(entry.node);
    numberTimes();
  };
  const buildHours = () => {
    if (times) return;
    times = [];
    hoursBox.append(addTimeBtn);
    startTimes.forEach(addTime);
  };
  const onOff = (on, set, fixed) => {
    const seg = el('div', { class: `seg pills${fixed ? ' fixed' : ''}` },
      el('button', { type: 'button', 'data-v': 'off', class: on ? '' : 'on' }, 'OFF'),
      el('button', { type: 'button', 'data-v': 'on', class: on ? 'on' : '' }, 'ON'));
    seg.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      set(b.dataset.v === 'on');
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
    return seg;
  };

  // Sun–Sat: the days the daily limit applies. Once reached today, days can be added, not removed.
  const days = new Set(draft ? draft.days : existing ? limitDays(existing) : ALL_DAYS);
  const daysRow = dayButtons(days, new Set(over ? limitDays(existing) : []), 'Limit reached today: days can be added, not removed');

  if (dailyOn) buildDaily();
  if (hoursOn) buildHours();

  const chooseApps = async () => {
    try {
      const r = await locksPlugin().pickApps({ id: `screen-${key}`, locked });
      if (!r.cancelled) fullPicks[r.full ? 'add' : 'delete'](key);
      if (!r.cancelled) { apps = (r.apps || r.categories || r.sites) ? { apps: r.apps, categories: r.categories, sites: r.sites } : null; appsLine.textContent = appsText(apps); }
    } catch (e) { toast('Couldn’t open the app picker'); }
  };
  // The choices as they stand (also what Go back brings back).
  const choices = () => ({
    key, name: nameInput.value.trim(), apps, dailyOn, each, hoursOn,
    minutes: amount ? amount.get() : startMinutes,
    hours: times ? times.map(t => t.get()) : startTimes,
    days: [...days].sort((a, b) => a - b), // the daily limit's days
  });
  const saveLimit = () => {
    const c = choices();
    if (!c.name) { toast('Give the limit a name'); return; }
    if (!c.apps) { toast('Choose at least one app'); return; }
    if (!c.dailyOn && !c.hoursOn) { toast('Turn on a daily limit, locked hours, or both'); return; }
    if (c.dailyOn && !c.days.length) { toast('Pick at least one day for the daily limit'); return; }
    if (c.dailyOn && c.minutes < 5) { toast('Set a daily limit of at least 5 minutes'); return; }
    if (c.hoursOn && c.hours.some(h => !h.days.length)) { toast('Pick at least one day for each time'); return; }
    if (c.hoursOn && c.hours.some(h => (clockMinutes(h.to) - clockMinutes(h.from) + 1440) % 1440 < 15)) { toast('Locked hours need to be at least 15 minutes'); return; }
    if (over && (!c.dailyOn || c.minutes > existing.target)) { toast('Limit reached today: it can be lowered, not raised or turned off, until midnight'); return; }
    if (inHours && (!c.hoursOn || activeNow.some(a => !c.hours.some(h => sameTime(h, a))))) { toast(`Locked hours can’t be changed until ${fmtTime(active.to)}`); return; }
    if (existing) commitLimit(existing, c); else confirmNewLimit(c);
  };
  const deleteLimit = () => {
    if (locked) { toast(inHours ? `A limit can be deleted after ${fmtTime(active.to)}, once its apps unlock` : 'A limit can be deleted after midnight, once its apps unlock'); return; }
    openSheet(
      el('h3', {}, `Delete ${existing.name}?`),
      el('p', {}, 'Its apps stop being tracked and limited, and its goal card moves to Recently Deleted.'),
      el('button', { class: 'sheet-btn danger', onclick: () => { closeSheet(); deleteTally(existing); renderLocks(); } }, 'Delete limit'),
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
    );
  };
  openSheet(
    el('h3', {}, existing ? existing.name : 'New screen-time limit'),
    inHours ? el('p', { class: 'note' }, `It’s within the locked hours, so these apps are locked until ${fmtTime(active.to)}. Until then that time can’t change and apps can only be added.`)
      : over ? el('p', { class: 'note' }, 'Today’s limit is reached, so these apps are locked until midnight. Until then the limit can only go down and apps can only be added.') : null,
    el('div', { class: 'sheet-label' }, 'NAME'),
    nameInput,
    el('div', { class: 'sheet-label' }, 'APPS'),
    appsLine,
    seeApps(`screen-${key}`, () => apps),
    el('button', { type: 'button', class: 'sheet-btn', onclick: chooseApps }, apps ? (locked ? 'Add apps' : 'Change apps') : 'Choose apps'),
    el('div', { class: 'sheet-label' }, 'DAILY LIMIT'),
    onOff(dailyOn, on => { dailyOn = on; dailyBox.classList.toggle('hidden', !on); if (on) buildDaily(); }, false),
    dailyBox,
    el('div', { class: 'sheet-label' }, 'LOCKED HOURS'),
    onOff(hoursOn, on => { hoursOn = on; hoursBox.classList.toggle('hidden', !on); if (on) buildHours(); }, inHours),
    hoursBox,
    el('p', { class: 'note' }, 'Goalie tracks the apps’ use in 5-minute steps, even while it’s closed, and shows it as a goal on your home screen. Overnight locked hours count for the night they start.'),
    el('button', { class: 'sheet-btn primary', onclick: saveLimit }, existing ? 'Save' : 'Done'),
    existing ? el('button', { class: `sheet-btn danger${locked ? ' disabled' : ''}`, onclick: deleteLimit }, 'Delete limit') : null,
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
}

// Save a limit (new: also its goal card) and lock or unlock its apps.
function commitLimit(existing, c) {
  if (fullPicks.delete(c.key)) offerAnother('limit', c.name, () => limitSheet(null, { ...c, key: uid(), name: nextName(c.name), apps: null }));
  const fields = {
    name: c.name, target: c.dailyOn ? c.minutes : null, screenEach: c.dailyOn && c.each, screenApps: c.apps,
    screenHours: c.hoursOn ? c.hours : null, screenFrom: null, screenTo: null,
    // The goal card's measured days: the daily limit's, or (no daily limit) every locked-hours day.
    days: c.dailyOn ? c.days : [...new Set(c.hours.flatMap(h => h.days))].sort((a, b) => a - b),
  };
  if (existing) {
    Object.assign(existing, fields);
  } else {
    state.tallies.push({
      ...blankForm(), ...fields, unit: 'minutes', reset: 'day', direction: 'decrease',
      color: '#ff7a93', screen: true, screenKey: c.key, screenLock: true, id: uid(), createdAt: Date.now(),
    });
  }
  save(); closeSheet(); renderLocks(); renderToday();
  toast(existing ? `${c.name} saved` : `${c.name} limit is on`);
}

// Before a new limit turns on: exactly what's locked, when and for how long. Nothing is locked until
// Complete; Go back returns to the choices.
function confirmNewLimit(c) {
  const what = appsText(c.apps).toLowerCase();
  const lines = [];
  if (c.dailyOn) {
    lines.push(c.each
      ? `Each app can be used for ${durationText(c.minutes)} a day. When one reaches it, that app locks until midnight.`
      : `These apps can be used for ${durationText(c.minutes)} a day in total. Once that’s used, they all lock until midnight.`);
  }
  if (c.dailyOn) lines[lines.length - 1] += ` The daily limit applies on ${onDays(c.days)}.`;
  if (c.hoursOn) {
    for (const h of c.hours) {
      const overnight = clockMinutes(h.to) <= clockMinutes(h.from);
      lines.push(`They’re locked from ${fmtTime(h.from)} to ${fmtTime(h.to)}${overnight ? ' the next morning' : ''} on ${onDays(h.days)}, no matter how much they’ve been used.`);
    }
  }
  openSheet(
    el('h3', {}, 'Are these right?'),
    el('div', { class: 'confirm-summary' },
      el('p', {}, el('strong', {}, c.name), ` limits ${what}.`),
      seeApps(`screen-${c.key}`, () => c.apps),
      el('ul', {}, lines.map(l => el('li', {}, l))),
      el('p', { class: 'note' }, 'Once locked, a limit can only get stricter until it unlocks: the daily limit can be lowered, apps and days added, and locked hours that are on can’t be changed.')),
    el('button', { class: 'sheet-btn primary', onclick: () => commitLimit(null, c) }, 'Complete'),
    el('button', { class: 'sheet-btn', onclick: () => limitSheet(null, c) }, 'Go back'),
  );
}

// Usage recorded on the phone → entries. Each day's highest step becomes that day's total (only
// what's missing is added), dated when it was reached.
function applyScreenUsage(usage) {
  let added = false;
  for (const t of state.tallies) {
    if (!t.screen || !t.screenKey || !usage[t.screenKey]) continue;
    for (const [day, rec] of Object.entries(usage[t.screenKey])) {
      const [y, m, d] = day.split('-').map(Number);
      const from = new Date(y, m - 1, d).getTime(), to = new Date(y, m - 1, d + 1).getTime();
      const logged = entriesFor(t.id).reduce((s, e) => (e.ts >= from && e.ts < to ? s + e.value : s), 0);
      if (rec.minutes > logged) {
        state.entries.push({ id: uid(), tallyId: t.id, ts: Math.min(Math.max(rec.at, from), to - 1), value: rec.minutes - logged, auto: true });
        added = true;
      }
    }
  }
  if (added) {
    save(); renderToday();
    if ($('#screen-locks').classList.contains('active')) renderLocks();
  }
}

let screenTimer = null;
function syncScreenGoals({ now = false } = {}) {
  clearTimeout(screenTimer);
  screenTimer = setTimeout(async () => {
    const goals = screenLimits().filter(t => t.screenApps).map(t => ({
      key: t.screenKey, name: t.name, limit: t.target > 0 ? Math.round(t.target) : 0, lock: !!t.screenLock && canLockAtLimit(t), each: !!t.screenEach,
      hours: limitHours(t).map(h => ({ from: h.from, to: h.to, days: timeDays(h) })), days: limitDays(t),
    }));
    try {
      const { usage, reached, problems } = await locksPlugin().screenGoals({ json: JSON.stringify(goals) });
      screenReached = reached || {};
      screenProblems = problems || {};
      applyScreenUsage(usage || {});
    } catch (e) { console.warn('Goalie screen time:', e); }
  }, now ? 0 : 1000);
}

if (isNativeApp && locksPlugin()) {
  window.goalieScreen = { syncForm: syncScreenForm };
  const previous = window.goalieLocks;
  window.goalieLocks = () => { previous?.(); syncScreenGoals(); }; // save() calls this
  storageReady.then(() => syncScreenGoals({ now: true }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncScreenGoals({ now: true }); });
  setInterval(() => syncScreenGoals(), 60000);
}
