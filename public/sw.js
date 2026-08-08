const VERSION = '2026-08-08-v1';
const PRECACHE = `pixel-city-precache-${VERSION}`;
const RUNTIME = `pixel-city-runtime-${VERSION}`;
const CACHE_NAMES = [PRECACHE, RUNTIME];

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './offline.html',
  './browserconfig.xml',
  './favicon.ico',
  './assets/data/manifest.json',
  './assets/data/animations.json',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-16.png',
  './assets/icons/favicon-32.png',
  './assets/icons/icon-72.png',
  './assets/icons/icon-96.png',
  './assets/icons/icon-128.png',
  './assets/icons/icon-144.png',
  './assets/icons/icon-152.png',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-384.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/screenshots/pixel-city-wide.png',
];

const HASHED_BUILD_ASSET = /\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css|map)$/;
const STATIC_ASSET = /\.(?:png|jpg|jpeg|webp|gif|ico|json|webmanifest|xml|woff2?|mp3|ogg|wav)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS.map((url) => toScopeUrl(url)))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => shouldDeleteCache(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isImmutableBuildAsset(url) || isPwaShellAsset(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isRuntimeAsset(url)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

function toScopeUrl(path) {
  return new URL(path, self.registration.scope).toString();
}

function shouldDeleteCache(cacheName) {
  return cacheName.startsWith('pixel-city-') && !CACHE_NAMES.includes(cacheName);
}

function isImmutableBuildAsset(url) {
  return HASHED_BUILD_ASSET.test(url.pathname);
}

function isPwaShellAsset(url) {
  return (
    url.pathname.endsWith('/manifest.webmanifest') ||
    url.pathname.endsWith('/browserconfig.xml') ||
    url.pathname.endsWith('/favicon.ico') ||
    url.pathname.includes('/assets/icons/') ||
    url.pathname.includes('/assets/screenshots/')
  );
}

function isRuntimeAsset(url) {
  return url.origin === self.location.origin && STATIC_ASSET.test(url.pathname);
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(RUNTIME);
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (
      (await cache.match(request)) ||
      (await caches.match(toScopeUrl('./index.html'))) ||
      (await caches.match(toScopeUrl('./offline.html'))) ||
      Response.error()
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheable(response)) {
    const cache = await caches.open(PRECACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) {
        void cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  return cached || (await network) || Response.error();
}

function isCacheable(response) {
  return response.ok && response.type === 'basic';
}
