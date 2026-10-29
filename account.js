'use strict';

/* =========================================================
   Account: Sign in with Apple / Google, backup and sync (Firebase)
   =========================================================
   Signed out, nothing here runs and Goalie works exactly as before. Firebase (vendor/firebase.js)
   only loads once someone opens Settings or is already signed in.

   Cloud layout (users can only read and write their own documents):
     users/{uid}               { main: JSON of everything except entries, manifest: { 'YYYY-MM': hash }, ... }
     users/{uid}/months/{YYYY-MM}  { entries: JSON of that month's entries, hash }
   Entries are split by month so years of history never reach Firestore's 1 MB document limit.

   Sync is a three-way merge: `base` is the data as of the last successful sync, so for every goal,
   entry, to-do and setting Goalie can tell which side changed it. Changes from both sides are kept;
   if both changed the same item, this device's version wins. */

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDSoCUfuUIXh4JnN3h4ltTiPKd11WDOVEM',
  authDomain: 'goalie-9522d.firebaseapp.com',
  projectId: 'goalie-9522d',
  storageBucket: 'goalie-9522d.firebasestorage.app',
  messagingSenderId: '1027633895605',
  appId: '1:1027633895605:web:6525bcf5e1a5f7d6e446fc',
};
const ACCOUNT_KEY = 'goalie.account'; // { uid, email, provider } while signed in on this device

// Settings that belong to this device only (what was shown or asked here), never synced.
const DEVICE_SETTINGS = ['reminderFired', 'updateAt', 'backupNagDay', 'backupFrom', 'lastExport', 'trashOpen', 'streakDay'];

const isNative = () => !!window.Capacitor?.isNativePlatform?.();
const nativeAuth = () => window.Capacitor?.Plugins?.FirebaseAuthentication;

const cloud = {
  fb: null, auth: null, db: null, loading: null,
  user: null,
  base: null,          // cloud view as of the last sync (null: never synced on this device)
  remote: null,        // latest consistent cloud view (null: no cloud data yet)
  remoteMeta: null,    // { main, manifest, months: Map(month → hash) } as stored in the cloud
  remoteReady: false,  // a server snapshot (not just cache) has arrived
  mainSnap: null, monthsSnap: null, unsub: [],
  busy: false, again: false, timer: null,
  status: 'off',       // off · connecting · saving · synced · error
  syncedAt: 0, error: '',
};

function readAccount() { try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null'); } catch (e) { return null; } }
function writeAccount(a) { try { a ? localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a)) : localStorage.removeItem(ACCOUNT_KEY); } catch (e) { /* blocked */ } }

/* ---------- Loading Firebase ---------- */
function loadFirebase() {
  if (!cloud.loading) {
    cloud.loading = import('./vendor/firebase.js').then(fb => {
      const app = fb.initializeApp(FIREBASE_CONFIG);
      cloud.fb = fb;
      cloud.auth = fb.initializeAuth(app, isNative()
        ? { persistence: fb.indexedDBLocalPersistence }
        : { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence], popupRedirectResolver: fb.browserPopupRedirectResolver });
      cloud.db = fb.initializeFirestore(app, {});
      fb.onAuthStateChanged(cloud.auth, user => (user ? startSync(user) : stopSync()));
      return fb;
    }).catch(err => { cloud.loading = null; throw err; });
  }
  return cloud.loading;
}

/* ---------- The cloud view of the data ---------- */
const EMPTY_VIEW = () => cloudView(DEFAULT_STATE());

// What gets synced: everything but device-only settings and the save time, with entries in a fixed
// order so two devices holding the same entries produce the same data.
function cloudView(s) {
  const settings = { ...s.settings };
  for (const k of DEVICE_SETTINGS) delete settings[k];
  const entries = s.entries.slice().sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.parse(JSON.stringify({
    tallies: s.tallies, entries, trash: s.trash, todos: s.todos,
    todoSections: s.todoSections, todoTrash: s.todoTrash, settings,
  }));
}

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isIdList = v => Array.isArray(v) && v.every(x => isObj(x) && x.id != null);

function merge3(base, local, remote) {
  if (same(local, base)) return remote;
  if (same(remote, base) || same(local, remote)) return local;
  if (isIdList(local) && isIdList(remote)) return mergeList(isIdList(base) ? base : [], local, remote);
  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {}, out = {};
    for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const v = merge3(b[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return local; // both changed the same value: this device wins
}

// The merged data in the same shape and entry order as cloudView, so comparing it with this
// device's data only finds real differences.
const mergeViews = (base, local, remote) => cloudView(normalizeState(merge3(base, local, remote)));

// Lists of items with ids (goals, entries, to-dos…): merge item by item. The order comes from
// whichever side rearranged the list; items only the other side has go at the end.
function mergeList(base, local, remote) {
  const byId = list => new Map(list.map(x => [x.id, x]));
  const B = byId(base), L = byId(local), R = byId(remote);
  const common = list => list.filter(x => B.has(x.id)).map(x => x.id);
  // (First sync, with nothing to compare against: this device's order.)
  const reordered = !base.length || !same(common(local).filter(id => R.has(id)), common(base).filter(id => L.has(id) && R.has(id)));
  const first = reordered ? local : remote, second = reordered ? remote : local;
  const out = [], seen = new Set();
  for (const x of [...first, ...second]) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const v = merge3(B.get(x.id), L.get(x.id), R.get(x.id));
    if (v !== undefined) out.push(v);
  }
  return out;
}

// cyrb53: a quick string hash, used to tell which months changed.
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const monthOf = ts => (Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 7) : 'undated');

// View → the strings stored in the cloud.
function splitView(view) {
  const { entries, ...rest } = view;
  const groups = new Map();
  for (const e of entries) { const m = monthOf(e.ts); if (!groups.has(m)) groups.set(m, []); groups.get(m).push(e); }
  const months = new Map(), manifest = {};
  for (const [m, list] of groups) { const json = JSON.stringify(list); const h = hash(json); months.set(m, { json, hash: h }); manifest[m] = h; }
  return { main: JSON.stringify(rest), manifest, months };
}

// The two listeners (main document, months) report separately, and another device's write can
// arrive in between; only use the cloud data once every month the main document lists is there.
function assembleRemote() {
  const m = cloud.mainSnap, ms = cloud.monthsSnap;
  if (!m || !ms) return false;
  for (const s of [m, ms]) if (s.metadata.hasPendingWrites || s.metadata.fromCache) return false;
  const stored = new Map(ms.docs.map(d => [d.id, d.data()]));
  const months = new Map([...stored].map(([k, d]) => [k, d.hash]));
  if (!m.exists()) {
    cloud.remote = null;
    cloud.remoteMeta = { main: null, manifest: {}, months };
  } else {
    const d = m.data(), entries = [];
    for (const [k, h] of Object.entries(d.manifest || {})) {
      const md = stored.get(k);
      if (!md || md.hash !== h) return false; // that month hasn't arrived yet
      entries.push(...JSON.parse(md.entries));
    }
    const view = { ...JSON.parse(d.main), entries };
    cloud.remote = cloudView(normalizeState(view)); // same shape and order as local views
    cloud.remoteMeta = { main: d.main, manifest: d.manifest || {}, months };
  }
  cloud.remoteReady = true;
  return true;
}

/* ---------- Sync ---------- */
const baseKey = () => `syncBase:${cloud.user.uid}`;

async function startSync(user) {
  const fb = cloud.fb;
  if (cloud.user?.uid === user.uid) return;
  stopSync({ keepAccount: true });
  cloud.user = user;
  const provider = user.providerData[0]?.providerId === 'apple.com' ? 'apple' : 'google';
  writeAccount({ uid: user.uid, email: user.email || '', provider });
  setStatus('connecting');
  if (!state.settings.name && user.displayName) { state.settings.name = user.displayName.split(' ')[0]; save(); }

  await storageReady; // the IndexedDB copy must be loaded before comparing with the cloud
  let base = null;
  try { base = JSON.parse(await idbGet(baseKey()) || 'null'); } catch (e) { /* none yet */ }
  if (cloud.user !== user) return; // signed out (or switched) while loading
  cloud.base = base;

  const userDoc = fb.doc(cloud.db, 'users', user.uid);
  // A live connection that drops (server hiccup, expired sign-in) reconnects half a minute later.
  const onError = err => {
    setStatus('error', err);
    clearTimeout(cloud.retry);
    cloud.retry = setTimeout(() => { if (cloud.user === user) { cloud.user = null; startSync(user); } }, 30000);
  };
  const onUpdate = () => { if (assembleRemote()) reconcile(); };
  cloud.unsub.push(
    fb.onSnapshot(userDoc, { includeMetadataChanges: true }, snap => { cloud.mainSnap = snap; onUpdate(); }, onError),
    fb.onSnapshot(fb.collection(userDoc, 'months'), { includeMetadataChanges: true }, snap => { cloud.monthsSnap = snap; onUpdate(); }, onError),
  );
  refreshAccountUI();
}

function stopSync({ keepAccount = false } = {}) {
  cloud.unsub.forEach(u => u());
  Object.assign(cloud, { unsub: [], user: null, base: null, remote: null, remoteMeta: null, remoteReady: false, mainSnap: null, monthsSnap: null, again: false });
  clearTimeout(cloud.timer);
  clearTimeout(cloud.retry);
  if (!keepAccount) writeAccount(null);
  setStatus('off');
}

// Called from save(): sync a moment after the last change.
function cloudChanged() {
  if (!cloud.user) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(reconcile, 1500);
}

// Remote changes wait while someone is in the middle of something (typing, editing cards, a sheet).
const uiBusy = () => editMode || !!$('#sheet').dataset.open || document.activeElement?.matches?.('input, textarea, [contenteditable]');

async function reconcile() {
  if (!cloud.user || !cloud.remoteReady) return;
  if (cloud.busy) { cloud.again = true; return; }
  cloud.busy = true;
  try {
    do {
      cloud.again = false;
      const local = cloudView(state);
      const remote = cloud.remote || EMPTY_VIEW();
      // Never synced here: start from nothing, so this device's data and the cloud's are combined.
      // If the cloud copy is gone after syncing before (account deleted elsewhere), stop instead of
      // reading that as "everything was deleted".
      if (cloud.base && !cloud.remote && cloud.remoteMeta.main === null && hasData(cloud.base)) { accountGone(); return; }
      const base = cloud.base || EMPTY_VIEW();
      const merged = mergeViews(base, local, remote);
      if (!same(merged, local)) {
        if (uiBusy()) { cloud.timer = setTimeout(reconcile, 2000); return; }
        if (!cloud.base && hasData(local)) idbSet('beforeFirstSync', JSON.stringify(state)).catch(() => {});
        applyMerged(merged);
      }
      const uploaded = await upload(merged);
      cloud.base = merged;
      await idbSet(baseKey(), JSON.stringify(merged)).catch(() => {});
      if (uploaded || cloud.status !== 'synced') { cloud.syncedAt = Date.now(); setStatus('synced'); }
    } while (cloud.again);
  } catch (err) {
    setStatus('error', err);
    clearTimeout(cloud.timer);
    cloud.timer = setTimeout(reconcile, 30000); // try again (offline changes stay saved on the phone)
  } finally {
    cloud.busy = false;
  }
}

const hasData = v => v.tallies.length || v.entries.length || v.todos.length;

// Write whatever differs from the cloud copy, all at once (a batch), so other devices never see half.
async function upload(view) {
  const fb = cloud.fb, uid = cloud.user.uid, meta = cloud.remoteMeta;
  const next = splitView(view);
  const batch = fb.writeBatch(cloud.db);
  let writes = 0;
  const userDoc = fb.doc(cloud.db, 'users', uid);
  for (const [m, { json, hash: h }] of next.months) {
    if (meta.months.get(m) !== h) { batch.set(fb.doc(userDoc, 'months', m), { entries: json, hash: h }); writes++; }
  }
  for (const m of meta.months.keys()) {
    if (!next.months.has(m)) { batch.delete(fb.doc(userDoc, 'months', m)); writes++; }
  }
  if (writes || next.main !== meta.main) {
    batch.set(userDoc, { main: next.main, manifest: next.manifest, format: 1, updatedAt: Date.now() });
    writes++;
  }
  if (!writes) return false;
  setStatus('saving');
  await batch.commit();
  // The listeners will report this write too; until they do, the cloud copy is what was just written.
  cloud.remote = view;
  cloud.remoteMeta = { main: next.main, manifest: next.manifest, months: new Map([...next.months].map(([m, x]) => [m, x.hash])) };
  return true;
}

// Bring changes from the cloud into this device's data.
function applyMerged(view) {
  const keep = Object.fromEntries(DEVICE_SETTINGS.filter(k => k in state.settings).map(k => [k, state.settings[k]]));
  state = normalizeState({ ...view, settings: { ...view.settings, ...keep } });
  clearUndoHistory();
  save();
  applyTheme();
  renderToday();
  if ($('#screen-stats').classList.contains('active')) renderStats();
  if ($('#screen-todo').classList.contains('active')) renderTodos();
  if ($('#screen-settings').classList.contains('active')) renderSettings();
}

function accountGone() {
  stopSync();
  cloud.fb && cloud.fb.signOut(cloud.auth).catch(() => {});
  toast('This account was deleted. Your goals are still on this phone.');
  refreshAccountUI();
}

function setStatus(status, err) {
  cloud.status = status;
  cloud.error = err ? (err.code || err.message || String(err)) : '';
  if (err) console.warn('Goalie sync:', err);
  refreshAccountUI();
}

/* ---------- Signing in and out ---------- */
function providerFor(kind) {
  const fb = cloud.fb;
  if (kind === 'apple') {
    const p = new fb.OAuthProvider('apple.com');
    p.addScope('email'); p.addScope('name');
    return p;
  }
  const p = new fb.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  return p;
}

// In the iPhone app, the native Apple / Google sheet signs in and hands Firebase the result.
async function nativeCredential(kind) {
  const fb = cloud.fb, plugin = nativeAuth();
  if (kind === 'apple') {
    const r = await plugin.signInWithApple({ skipNativeAuth: true });
    const c = r.credential;
    return { credential: new fb.OAuthProvider('apple.com').credential({ idToken: c.idToken, rawNonce: c.nonce }), appleCode: c.authorizationCode };
  }
  const r = await plugin.signInWithGoogle({ skipNativeAuth: true });
  return { credential: fb.GoogleAuthProvider.credential(r.credential.idToken, r.credential.accessToken) };
}

async function signIn(kind) {
  try {
    if (!cloud.fb) await loadFirebase();
    const fb = cloud.fb;
    // (No waiting before the popup when Firebase is already loaded: Safari only allows a popup
    // straight from the tap.)
    if (isNative()) await fb.signInWithCredential(cloud.auth, (await nativeCredential(kind)).credential);
    else await fb.signInWithPopup(cloud.auth, providerFor(kind));
    toast('Signed in. Your goals are backed up.');
  } catch (err) {
    const code = err?.code || '';
    if (/cancel|closed-by-user|popup-closed|1001/i.test(code + ' ' + err?.message)) return;
    if (code === 'auth/popup-blocked') { toast('Tap the button again to sign in'); return; }
    console.warn('Goalie sign-in:', err);
    toast(code === 'auth/network-request-failed' ? 'No internet connection. Try again when you’re online.' : 'Couldn’t sign in. Please try again.');
  }
}

async function signOutHere() {
  await Promise.race([reconcile(), new Promise(r => setTimeout(r, 4000))]); // send any last changes first
  stopSync();
  await cloud.fb?.signOut(cloud.auth).catch(() => {});
  if (isNative()) await nativeAuth()?.signOut().catch(() => {});
  toast('Signed out. Your goals stay on this phone.');
  refreshAccountUI();
}

// Delete account: sign in once more (Apple and Firebase both require a fresh sign-in), delete the
// cloud data, revoke Sign in with Apple, then delete the account itself.
async function deleteAccount() {
  const fb = cloud.fb, user = cloud.user;
  if (!fb || !user) return;
  const kind = readAccount()?.provider || 'google';
  try {
    let appleCode = null;
    if (isNative()) {
      const r = await nativeCredential(kind);
      await fb.reauthenticateWithCredential(user, r.credential);
      appleCode = r.appleCode || null;
    } else {
      const result = await fb.reauthenticateWithPopup(user, providerFor(kind));
      if (kind === 'apple') appleCode = fb.OAuthProvider.credentialFromResult(result)?.accessToken || null;
    }
    toast('Deleting your account…');
    const userDoc = fb.doc(cloud.db, 'users', user.uid);
    const uid = user.uid;
    cloud.unsub.forEach(u => u()); cloud.unsub = [];
    const months = await fb.getDocs(fb.collection(userDoc, 'months'));
    const batch = fb.writeBatch(cloud.db);
    months.forEach(d => batch.delete(d.ref));
    batch.delete(userDoc);
    await batch.commit();
    if (appleCode) await fb.revokeAccessToken(cloud.auth, appleCode).catch(err => console.warn('Goalie: Apple revoke', err));
    await fb.deleteUser(user);
    idbRun('readwrite', s => s.delete(`syncBase:${uid}`)).catch(() => {});
    stopSync();
    if (isNative()) await nativeAuth()?.signOut().catch(() => {});
    closeSheet();
    toast('Your account was deleted. Your goals are still on this phone.');
  } catch (err) {
    const code = err?.code || '';
    if (/cancel|closed-by-user|popup-closed|1001/i.test(code + ' ' + err?.message)) return;
    console.warn('Goalie delete account:', err);
    toast('Couldn’t delete your account. Check your connection and try again.');
    if (cloud.user && !cloud.unsub.length) { const u = cloud.user; cloud.user = null; startSync(u); }
  }
  refreshAccountUI();
}

/* ---------- Settings ---------- */
const APPLE_LOGO = '<svg viewBox="0 0 17 20" aria-hidden="true"><path fill="currentColor" d="M14.04 10.62c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.76 2.28-1.6 2.78-.41 6.9 1.15 9.16.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.76-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.38-3.69zM11.77 3.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.68-1.09 1.76-.96 2.8 1.02.08 2.05-.52 2.68-1.28z"/></svg>';
const GOOGLE_LOGO = '<svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg>';

function signInButton(kind) {
  const b = el('button', { type: 'button', class: `signin-btn ${kind}`, onclick: () => signIn(kind) });
  b.innerHTML = kind === 'apple' ? APPLE_LOGO : GOOGLE_LOGO;
  b.append(kind === 'apple' ? 'Sign in with Apple' : 'Sign in with Google');
  return b;
}

function statusText() {
  if (!navigator.onLine && cloud.status !== 'saving') return 'No internet right now. Your changes are saved on this phone and will sync when you’re back online.';
  switch (cloud.status) {
    case 'connecting': return 'Connecting…';
    case 'saving': return 'Saving to your account…';
    case 'error': return 'Couldn’t sync right now. Goalie will keep trying, and your changes are saved on this phone.';
    case 'synced': return `Backed up and synced${cloud.syncedAt ? ` ${relTime(cloud.syncedAt).toLowerCase()}` : ''}.`;
    default: return '';
  }
}

function refreshAccountUI() {
  const box = $('#account-box');
  if (!box) return;
  const acct = readAccount();
  box.innerHTML = '';
  if (!acct) {
    box.append(
      signInButton('apple'), signInButton('google'),
      el('p', { class: 'note' }, 'Sign in to back up your goals and keep them in sync on all your devices. Signing in is optional.'),
    );
  } else {
    box.append(
      el('div', { class: 'account-who' },
        // "Hide My Email" gives a random @privaterelay.appleid.com address; show that plainly instead.
        el('strong', {}, /@privaterelay\.appleid\.com$/i.test(acct.email) ? 'Apple ID · email hidden' : (acct.email || 'Signed in')),
        el('span', {}, acct.provider === 'apple' ? 'Signed in with Apple' : 'Signed in with Google')),
      el('p', { class: 'note' }, statusText()),
      el('button', { type: 'button', class: 'row-btn', onclick: signOutHere }, 'Sign out'),
      el('button', { type: 'button', class: 'row-btn danger', onclick: confirmDeleteAccount }, 'Delete account'),
    );
  }
  const where = $('#storage-note');
  if (where) where.textContent = acct
    ? 'Your data is saved on this device and backed up to your account.'
    : `Data is stored only on this device. Deleting Goalie${isNative() ? '' : ' from your Home Screen'} erases it, so sign in or export a backup first.`;
}

function confirmDeleteAccount() {
  openSheet(
    el('h3', {}, 'Delete your account?'),
    el('p', {}, 'Your account and everything backed up to it are deleted for good, and your other devices stop syncing. The goals on this phone stay here.'),
    el('p', {}, 'You’ll be asked to sign in once more to confirm.'),
    el('button', { class: 'sheet-btn danger', onclick: () => { closeSheet(); deleteAccount(); } }, 'Delete account'),
    el('button', { class: 'sheet-btn', onclick: closeSheet }, 'Cancel'),
  );
}

/* ---------- Start ---------- */
window.goalieCloud = {
  changed: cloudChanged,
  signedIn: () => !!readAccount(),
  // Settings opened: load Firebase now, so a sign-in tap can open its window right away.
  prepare: () => { refreshAccountUI(); if (!readAccount()) loadFirebase().catch(() => {}); },
};
addEventListener('online', () => { refreshAccountUI(); reconcile(); });
addEventListener('offline', refreshAccountUI);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reconcile(); });
refreshAccountUI();
if (readAccount()) loadFirebase().catch(err => setStatus('error', err));
