/* Blütenpfad — Service Worker
 * Simple App-Shell-Cache + Network-First für API.
 * Versioniere CACHE bei jedem Release, damit Updates greifen.
 */
'use strict';

const CACHE = 'bluetenpfad-shell-v17';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/species.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/vendor/markercluster/leaflet.markercluster.js',
  '/vendor/markercluster/MarkerCluster.css',
  '/vendor/markercluster/MarkerCluster.Default.css',
  '/vendor/exifr.umd.js',
  '/impressum.html',
  '/datenschutz.html',
  '/naturschutz.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // /verify setzt ein Session-Cookie + redirectet — niemals cachen, immer ans Netz.
  if (url.pathname === '/verify') return;
  // Admin-Panel (Seite + Assets + API): nie cachen, immer ans Netz.
  if (url.pathname.startsWith('/admin')) return;
  // API + geschützte Fotos: network-first, kein Caching von Auth-Antworten.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/finds/')) {
    event.respondWith(networkFirst(req));
    return;
  }
  // Statische App-Shell: cache-first, im Hintergrund refreshen.
  event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
    }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const offlineShell = await caches.match('/index.html');
    if (offlineShell) return offlineShell;
    throw err;
  }
}
