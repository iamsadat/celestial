const CACHE_NAME = 'celestial-v1';
const SHELL = ['./', './celestial-dashboard.html', './manifest.json'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
