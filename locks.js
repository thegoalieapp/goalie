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
const isLocked = lock => lockGoals(lock).some(t => !goalDoneForLock(t));
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
function appsText(apps) {
  if (!apps) return 'No apps chosen yet';
  const parts = [];
  if (apps.apps) parts.push(`${apps.apps} app${apps.apps === 1 ? '' : 's'}`);
  if (apps.categories) parts.push(`${apps.categories} categor${apps.categories === 1 ? 'y' : 'ies'}`);
  if (apps.sites) parts.push(`${apps.sites} website${apps.sites === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'No apps chosen yet';
}

function relockText(lock) {
  const periods = new Set(lockGoals(lock).map(lockPeriod));
  if (periods.has('day')) return 'Locks again tomorrow';
  if (periods.has('week')) return 'Locks again next week';
  if (periods.has('month')) return 'Locks again next month';
  if (periods.has('year')) return 'Locks again next year';
  return 'Stays unlocked';
}

async function renderLocks() {
  const box = $('#locks-body');
  box.innerHTML = '';
  try { locksUi.auth = (await locksPlugin().authorization()).status; } catch (e) { locksUi.auth = 'unavailable'; }
  if (locksUi.auth !== 'approved') {
    box.append(el('div', { class: 'locks-intro' },
      el('h3', {}, 'Lock apps until your goals are done'),
      el('p', {}, 'Pick apps like social media and the goals that unlock them. The apps stay locked until those goals are done, and lock again when the goals start over (tomorrow for daily goals, next week for weekly ones).'),
      locksUi.auth === 'denied'
        ? el('p', { class: 'note' }, 'Screen Time access is off for Goalie. Turn it on in iPhone Settings → Screen Time → Apps with Screen Time Access.')
        : el('button', { type: 'button', class: 'submit-btn', onclick: allowScreenTime }, 'Allow Screen Time access'),
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
      el('div', { class: 'lock-apps' }, appsText(lock.apps)),
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
  renderLocks();
}

// New lock (null) or change one. While it's locked, apps and goals can only be added.
function lockSheet(existing) {
  const lock = existing ? JSON.parse(JSON.stringify(existing)) : { id: uid(), name: '', goalIds: [], apps: null, createdAt: Date.now() };
  const locked = existing ? isLocked(existing) : false;
  const kept = new Set(locked ? existing.goalIds : []);
  const nameInput = el('input', { class: 'text-input full', type: 'text', maxlength: '30', placeholder: 'e.g. Social media', value: lock.name });
  const appsLine = el('div', { class: 'lock-apps' }, appsText(lock.apps));
  const goals = state.tallies.filter(lockable);
  const picks = new Set(lock.goalIds);
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

  const chooseApps = async () => {
    try {
      const r = await locksPlugin().pickApps({ id: lock.id, locked });
      if (!r.cancelled) { lock.apps = { apps: r.apps, categories: r.categories, sites: r.sites }; appsLine.textContent = appsText(lock.apps); }
    } catch (e) { toast('Couldn’t open the app picker'); }
  };
  const saveLock = () => {
    lock.name = nameInput.value.trim();
    lock.goalIds = goals.filter(t => picks.has(t.id)).map(t => t.id);
    if (!lock.goalIds.length) { toast('Choose at least one goal'); return; }
    if (!lock.apps || !(lock.apps.apps || lock.apps.categories || lock.apps.sites)) { toast('Choose at least one app'); return; }
    const list = readLocks();
    const at = list.findIndex(l => l.id === lock.id);
    if (at >= 0) list[at] = lock; else list.push(lock);
    writeLocks(list);
    closeSheet();
    syncLocks({ now: true });
    toast(isLocked(lock) ? `${lock.name || 'Lock'} is on. Finish its goals to unlock.` : `${lock.name || 'Lock'} saved`);
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
    el('button', { type: 'button', class: 'sheet-btn', onclick: chooseApps }, lock.apps ? (locked ? 'Add apps' : 'Change apps') : 'Choose apps'),
    el('div', { class: 'sheet-label' }, 'GOALS THAT UNLOCK IT'),
    goalList,
    el('button', { class: 'sheet-btn primary', onclick: saveLock }, existing ? 'Save' : 'Turn on lock'),
    existing ? el('button', { class: `sheet-btn danger${locked ? ' disabled' : ''}`, onclick: deleteLock }, 'Delete lock') : null,
    el('button', { class: 'sheet-btn', onclick: cancel }, 'Cancel'),
  );
  onSheetDismiss = () => { if (!existing) locksPlugin()?.remove({ id: lock.id }).catch(() => {}); };
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
   minutes a day"), locked hours ("10 PM to 7 AM, every day"), or both. Each limit is also a goal on the home screen ("Instagram ↓ 30 min") that fills
   itself in from Screen Time in 5-minute steps (Apple only says when the apps reach each step, never
   exact numbers), even while Goalie is closed. Reaching the limit locks the apps until midnight.
   No early unlocks: while a limit has its apps locked, the limit can only go down, apps can only be
   added, and it can't be deleted until midnight.

   Goal fields: screen (true), screenKey (where its apps are saved on the phone), screenApps (how many
   apps / categories / websites), screenLock (true: lock at the limit). The minutes stay on the phone
   (account.js keeps them out of the cloud). */

const canLockAtLimit = f => f.direction === 'decrease' && f.target > 0;
const screenLimits = () => state.tallies.filter(t => t.screen && t.screenKey);
const limitReached = t => t.target > 0 && countThisPeriod(t) >= t.target;
// Locked hours ("22:00" to "07:00", every day; they may run past midnight).
const clockMinutes = hhmm => { const [h, m] = (hhmm || '').split(':').map(Number); return h * 60 + m; };
const hasWindow = t => !!(t.screenFrom && t.screenTo && t.screenFrom !== t.screenTo);
function inWindowNow(t) {
  if (!hasWindow(t)) return false;
  const d = new Date(), now = d.getHours() * 60 + d.getMinutes(), start = clockMinutes(t.screenFrom), end = clockMinutes(t.screenTo);
  return start < end ? now >= start && now < end : now >= start || now < end;
}
const windowText = t => `${fmtTime(t.screenFrom)} to ${fmtTime(t.screenTo)}`;
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
    const used = countThisPeriod(t), over = limitReached(t), inHours = inWindowNow(t);
    const foot = inHours ? `Locked until ${fmtTime(t.screenTo)}`
      : over ? `${num(t, used)} of ${num(t, t.target)} today · locked until midnight`
        : t.target > 0 ? `${num(t, used)} of ${num(t, t.target)} today · ${num(t, t.target - used)} left`
          : `${num(t, used)} today`;
    box.append(el('button', { type: 'button', class: `lock-card${over || inHours ? ' locked' : ''}`, onclick: () => limitSheet(t) },
      el('div', { class: 'lock-card-top' },
        el('strong', {}, t.name),
        el('span', { class: 'lock-state' }, over || inHours ? 'LOCKED' : 'OPEN')),
      el('div', { class: 'lock-apps' }, appsText(t.screenApps)),
      hasWindow(t) ? el('div', { class: 'lock-apps' }, `Locked hours: ${windowText(t)}, every day`) : null,
      t.target > 0 ? el('div', { class: 'limit-bar', role: 'img', 'aria-label': `${Math.round(used)} of ${t.target} minutes used today` },
        el('span', { style: `width:${Math.min(100, (used / t.target) * 100)}%` })) : null,
      el('div', { class: 'lock-foot' }, foot)));
  }
  box.append(el('button', { type: 'button', class: 'submit-btn secondary', onclick: () => limitSheet(null) }, '+ NEW LIMIT'));
}

// New limit (null) or change one. No early unlocks: once the daily limit is reached it can only go
// down; during the locked hours they can't be changed or turned off; and while either has the apps
// locked, apps can only be added and the limit can't be deleted.
function limitSheet(existing) {
  const over = existing ? limitReached(existing) : false;
  const inHours = existing ? inWindowNow(existing) : false;
  const locked = over || inHours;
  const key = existing?.screenKey || uid();
  let apps = existing?.screenApps || null;
  let dailyOn = existing ? existing.target > 0 : true;
  let hoursOn = existing ? hasWindow(existing) : false;
  const nameInput = el('input', { class: 'text-input full', type: 'text', maxlength: '30', placeholder: 'e.g. Instagram', value: existing?.name || '' });
  const limitInput = el('input', { class: 'text-input goal-input', type: 'number', inputmode: 'numeric', min: '5', step: '5', value: String(existing?.target || 30) });
  const appsLine = el('div', { class: 'lock-apps' }, appsText(apps));
  // The time wheels go in when locked hours are switched on: a wheel reads its time from where it's
  // scrolled to, and a hidden one never scrolls into place.
  let fromWheels = null, toWheels = null;
  const buildWheels = () => {
    if (fromWheels) return;
    fromWheels = timeWheels(dateAt(existing?.screenFrom || '22:00'), { compact: true });
    toWheels = timeWheels(dateAt(existing?.screenTo || '07:00'), { compact: true });
    hoursBox.append(el('div', { class: 'sheet-label' }, 'FROM'), fromWheels.node, el('div', { class: 'sheet-label' }, 'TO'), toWheels.node);
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
  const dailyBox = el('div', { class: dailyOn ? '' : 'hidden' },
    el('div', { class: 'goal-row' }, limitInput, el('span', { class: 'goal-per' }, 'MINUTES A DAY')));
  const hoursBox = el('div', { class: inHours ? 'fixed' : '' });
  if (hoursOn) buildWheels();

  const chooseApps = async () => {
    try {
      const r = await locksPlugin().pickApps({ id: `screen-${key}`, locked });
      if (!r.cancelled) { apps = (r.apps || r.categories || r.sites) ? { apps: r.apps, categories: r.categories, sites: r.sites } : null; appsLine.textContent = appsText(apps); }
    } catch (e) { toast('Couldn’t open the app picker'); }
  };
  const saveLimit = () => {
    const name = nameInput.value.trim(), limit = Math.round(+limitInput.value);
    const from = fromWheels ? hhmmOf(fromWheels.get()) : null, to = toWheels ? hhmmOf(toWheels.get()) : null;
    if (!name) { toast('Give the limit a name'); return; }
    if (!apps) { toast('Choose at least one app'); return; }
    if (!dailyOn && !hoursOn) { toast('Turn on a daily limit, locked hours, or both'); return; }
    if (dailyOn && !(limit >= 1)) { toast('Set a daily limit in minutes'); return; }
    if (hoursOn) {
      const length = (clockMinutes(to) - clockMinutes(from) + 1440) % 1440;
      if (length < 15) { toast('Locked hours need to be at least 15 minutes'); return; }
    }
    if (over && (!dailyOn || limit > existing.target)) { toast('Limit reached today: it can be lowered, not raised or turned off, until midnight'); return; }
    if (inHours && (!hoursOn || from !== existing.screenFrom || to !== existing.screenTo)) { toast(`Locked hours can’t be changed until ${fmtTime(existing.screenTo)}`); return; }
    const fields = { name, target: dailyOn ? limit : null, screenApps: apps, screenFrom: hoursOn ? from : null, screenTo: hoursOn ? to : null };
    if (existing) {
      Object.assign(existing, fields);
    } else {
      state.tallies.push({
        ...blankForm(), ...fields, unit: 'minutes', reset: 'day', direction: 'decrease',
        color: '#ff7a93', screen: true, screenKey: key, screenLock: true,
        days: [0, 1, 2, 3, 4, 5, 6], id: uid(), createdAt: Date.now(),
      });
    }
    save(); closeSheet(); renderLocks(); renderToday();
    toast(existing ? `${name} saved` : `${name} limit is on`);
  };
  const deleteLimit = () => {
    if (locked) { toast(inHours ? `A limit can be deleted after ${fmtTime(existing.screenTo)}, once its apps unlock` : 'A limit can be deleted after midnight, once its apps unlock'); return; }
    openSheet(
      el('h3', {}, `Delete ${existing.name}?`),
      el('p', {}, 'Its apps stop being tracked and limited, and its goal card moves to Recently Deleted.'),
      el('button', { class: 'sheet-btn danger', onclick: () => { closeSheet(); deleteTally(existing); renderLocks(); } }, 'Delete limit'),
      el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
    );
  };
  openSheet(
    el('h3', {}, existing ? existing.name : 'New screen-time limit'),
    inHours ? el('p', { class: 'note' }, `It’s within the locked hours, so these apps are locked until ${fmtTime(existing.screenTo)}. Until then the hours can’t change and apps can only be added.`)
      : over ? el('p', { class: 'note' }, 'Today’s limit is reached, so these apps are locked until midnight. Until then the limit can only go down and apps can only be added.') : null,
    el('div', { class: 'sheet-label' }, 'NAME'),
    nameInput,
    el('div', { class: 'sheet-label' }, 'APPS'),
    appsLine,
    el('button', { type: 'button', class: 'sheet-btn', onclick: chooseApps }, apps ? (locked ? 'Add apps' : 'Change apps') : 'Choose apps'),
    el('div', { class: 'sheet-label' }, 'DAILY LIMIT'),
    onOff(dailyOn, on => { dailyOn = on; dailyBox.classList.toggle('hidden', !on); }, false),
    dailyBox,
    el('div', { class: 'sheet-label' }, 'LOCKED HOURS'),
    onOff(hoursOn, on => { hoursOn = on; if (on) buildWheels(); hoursBox.classList.toggle('hidden', !on); }, inHours),
    hoursBox,
    el('p', { class: 'note' }, 'Goalie tracks the apps’ use in 5-minute steps, even while it’s closed, and shows it as a goal on your home screen. Reach the daily limit and the apps lock until midnight; during locked hours they’re locked every day.'),
    el('button', { class: 'sheet-btn primary', onclick: saveLimit }, existing ? 'Save' : 'Turn on limit'),
    existing ? el('button', { class: `sheet-btn danger${locked ? ' disabled' : ''}`, onclick: deleteLimit }, 'Delete limit') : null,
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
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
      key: t.screenKey, name: t.name, limit: t.target > 0 ? Math.round(t.target) : 0, lock: !!t.screenLock && canLockAtLimit(t),
      from: hasWindow(t) ? t.screenFrom : null, to: hasWindow(t) ? t.screenTo : null,
    }));
    try {
      const { usage } = await locksPlugin().screenGoals({ json: JSON.stringify(goals) });
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
