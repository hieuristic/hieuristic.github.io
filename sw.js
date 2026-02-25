const CACHE_NAME = 'hieuristic-cache-v1';
const ASSETS_TO_CACHE = [
  '/style.css',
  'https://www.googletagmanager.com/gtag/js?id=G-P4Z1VKV3L1'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return Promise.all(
        ASSETS_TO_CACHE.map(async url => {
          try {
            const request = new Request(url, { mode: url.startsWith('http') ? 'no-cors' : 'cors' });
            const response = await fetch(request);
            if (response.ok || response.type === 'opaque') {
              await cache.put(request, response);
            }
          } catch (e) {
            console.error('Failed to cache', url, e);
          }
        })
      );
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Intercept requests for style.css and GTM script
  if (url.pathname.endsWith('style.css') || url.hostname === 'www.googletagmanager.com') {
    event.respondWith(
      caches.match(event.request).then(cachedResponse => {
        const networkFetch = fetch(event.request).then(networkResponse => {
          // Update the cache with the fresh response
          if (networkResponse.ok || networkResponse.type === 'opaque') {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(() => {
          // Ignore network errors for background updates
        });

        // Return cached response immediately if available, otherwise wait for network
        return cachedResponse || networkFetch;
      })
    );
  }
});
