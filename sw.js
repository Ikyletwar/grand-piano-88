const CACHE_NAME = 'grand-piano-88-v3';

const SAMPLE_FILES = [
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8',
  'Ds1', 'Ds2', 'Ds3', 'Ds4', 'Ds5', 'Ds6', 'Ds7',
  'Fs1', 'Fs2', 'Fs3', 'Fs4', 'Fs5', 'Fs6', 'Fs7'
].map(name => `./samples/${name}.mp3`);

const PRECACHE = ['./', './index.html', './styles.css', './app.js', './sw.js', ...SAMPLE_FILES];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreMethod: true }).then(cached => {
      if (cached) return cached;
      return fetch(request)
        .then(response => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => request.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    })
  );
});
