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
