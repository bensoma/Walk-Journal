/**
 * Service Worker for SWCP Walk Journal v8
 * ─────────────────────────────────────────
 * Caching strategy follows the upgrade brief §10:
 *
 *   • PRECACHE — the app shell (HTML, manifest, icons) is fetched on install
 *     and made available immediately. Cache name is versioned so each release
 *     invalidates cleanly.
 *
 *   • RUNTIME CACHE — third-party CDN assets (Leaflet, jsPDF, JSZip, Google
 *     Fonts) are fetched on first online use and cached lazily. Cache-first
 *     thereafter so the lazy loaders defined in index.html Section 0 work
 *     offline after a single online visit.
 *
 *   • NAVIGATION — top-level navigation requests use network-first with a
 *     fallback to the cached index.html. This gives users the latest version
 *     when online, and a working offline boot when not.
 *
 *   • IDB IS NOT TOUCHED — the service worker caches HTTP responses only.
 *     IndexedDB persistence (walks, photos, gpx) is independent, lives in the
 *     origin's storage, and survives without any service-worker involvement.
 *
 * On activate, old caches not matching the current version are deleted.
 * Clients are claimed immediately so the first load after install is served
 * by the new worker without requiring a second reload.
 */

const VERSION       = 'v8.0.1';
const PRECACHE      = `swcp-precache-${VERSION}`;
const RUNTIME_CACHE = `swcp-runtime-${VERSION}`;

/**
 * Files copied into the precache on install.
 * Paths are relative to the service-worker scope (the directory containing
 * sw.js) so the same list works on localhost and GitHub Pages project sites.
 */
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
];

/** Hostnames whose responses should be opportunistically cached at runtime. */
const RUNTIME_CACHE_HOSTS = [
  'cdnjs.cloudflare.com',           // Leaflet, jsPDF, JSZip
  'fonts.googleapis.com',           // Google Fonts CSS
  'fonts.gstatic.com',              // Google Fonts woff2 files
  'unpkg.com',                      // alternate CDN for some libs
  'a.tile.openstreetmap.org',       // Leaflet map tiles
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
];

// ─── Install: precache the shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(PRECACHE).then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: clean up old caches, take control of open clients ─────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== PRECACHE && k !== RUNTIME_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch: route requests through the appropriate strategy ─────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;                   // never cache POSTs
  const url = new URL(req.url);

  // Connectivity probe: bypass cache so the fetch reflects actual network
  if(url.searchParams.has('_probe')) return;

  // Top-level navigation: network-first with cached index.html fallback
  if(req.mode === 'navigate'){
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  // Same-origin: cache-first for everything in the precache, network-first otherwise
  if(url.origin === self.location.origin){
    event.respondWith(cacheFirst(req, PRECACHE));
    return;
  }

  // CDN / runtime hosts: cache-first, lazily populating on miss
  if(RUNTIME_CACHE_HOSTS.includes(url.hostname)){
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // Anything else (Drive API, analytics, ad-hoc fetches): leave alone
});

/**
 * Cache-first: return the cached response if present, otherwise fetch from the
 * network and cache the response opportunistically. On network failure with
 * no cached entry, returns the network error.
 */
async function cacheFirst(request, cacheName){
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if(cached) return cached;
  try{
    const response = await fetch(request);
    if(response && response.status === 200 && response.type !== 'opaque'){
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }catch(e){
    // Last-ditch fallback: return cached if any, else propagate error
    return cached || Response.error();
  }
}

/**
 * Network-first for navigation requests. Falls back to the cached index.html
 * shell when offline so the SPA can boot and run from IDB-backed local data.
 */
async function networkFirstNavigation(request){
  try{
    const fresh = await fetch(request);
    // Refresh the cached index.html on every successful navigation
    const cache = await caches.open(PRECACHE);
    cache.put('./index.html', fresh.clone()).catch(() => {});
    return fresh;
  }catch(e){
    const cache = await caches.open(PRECACHE);
    const fallback = await cache.match('./index.html');
    if(fallback) return fallback;
    return Response.error();
  }
}

// ─── Update channel ─────────────────────────────────────────────────────────
// The page can post {type:'SKIP_WAITING'} to force activation of a newly
// installed worker (for an "update available — refresh" prompt). The default
// flow without the prompt also works: the next page reload picks up the new
// version automatically because skipWaiting() runs on install.
self.addEventListener('message', event => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});
