// Bump this when you change any app file so phones pick up the new version.
const CACHE = 'goalie-v88';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './account.js',
  './vendor/firebase.js',
  './manifest.webmanifest',
  './fonts/outfit-latin.woff2',
  './fonts/outfit-latin-ext.woff2',
  './icons/goalie-bar-192.png',
  './icons/goalie-bar-512.png',
  './icons/goalie-bar-touch-180.png',
  './icons/goalie-bar-maskable-512.png',
];

// A new version downloads its files in the background, then WAITS: Goalie keeps running the version
// you have until you choose Update now (or the time you scheduled), which sends 'skipWaiting'.
self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores stale files.
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App files come from this version's saved copy (works offline, and never changes underneath you);
// anything missing is fetched and saved. version.json always goes to the server, so the app can
// tell when a newer version exists.
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/version.json')) return; // straight to the network

  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req, { ignoreSearch: true }).then(hit => hit ||
        fetch(req).then(res => {
          if (res.ok) cache.put(req, res.clone()); // never save an error page
          return res;
        }).catch(() => (req.mode === 'navigate' ? cache.match('./index.html') : Response.error())))
    )
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(list => {
      if (list.length) return list[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
