const CACHE_NAME = 'tss-driver-shell-v3-20261002';
const SHELL = ['/motorista', '/motorista/', '/mobile.html', '/mobile.css', '/mobile.mjs', '/mobile-model.mjs', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];
const ALLOWED = new Set(SHELL);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('tss-driver-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // No API, authentication, attachments, exports or private pages enter CacheStorage.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.search || !ALLOWED.has(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    if (!['/motorista', '/motorista/', '/mobile.html'].includes(url.pathname)) return;
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(CACHE_NAME);
          await cache.put('/motorista', response.clone());
        }
        return response;
      } catch { return await caches.match('/motorista') || Response.error(); }
    })());
    return;
  }
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch { return await caches.match(event.request) || Response.error(); }
  })());
});
