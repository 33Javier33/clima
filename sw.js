// sw.js — Clima App
// CarlosPN Interactive® 

const CACHE_NAME = 'clima-app-v2';

const PRECACHE = [
  './index.html',
  './manifest.json',
  './img/icon-192x192.png',
  './img/icon-512x512.png'
];

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting(); // Activar de inmediato sin esperar pestaña cerrada
});

// ── ACTIVATE — elimina cachés viejos ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Eliminando caché viejo:', k);
          return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim(); // Toma control inmediato de todas las pestañas
});

// ── FETCH — Network-first con fallback a caché ──
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // APIs externas → siempre red, nunca cachear
  const url = event.request.url;
  const isExternal =
    url.includes('open-meteo.com') ||
    url.includes('geocoding-api') ||
    url.includes('nominatim.openstreetmap.org') ||
    url.includes('ipapi.co') ||
    url.includes('wikipedia.org') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com');

  if (isExternal) {
    event.respondWith(fetch(event.request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // App shell → Network-first
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── MENSAJE desde la app para forzar actualización ──
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
