const CACHE = 'crm-pwa-v5.15.0-dash-projects';
const APP_SHELL = [
  './', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k.startsWith('crm-pwa-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request, {cache:'no-store'})
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request.mode === 'navigate' ? './index.html' : request, copy));
        }
        return response;
      })
      .catch(() => request.mode === 'navigate'
        ? caches.match('./index.html').then(r => r || caches.match('./'))
        : caches.match(request))
  );
});
