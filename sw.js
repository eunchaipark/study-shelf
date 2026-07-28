// 서재 — app-shell service worker.
// Precaches the shell (HTML/CSS-in-HTML/JS/icons/vendor lib) so the reader still
// opens offline; book content itself lives in IndexedDB, not here.
const SHELL_CACHE = "seojae-shell-v3";
const RUNTIME_CACHE = "seojae-runtime-v3";
const CURRENT_CACHES = [SHELL_CACHE, RUNTIME_CACHE];

const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./vendor/marked.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-32.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => !CURRENT_CACHES.includes(n)).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

function isGoogleFontRequest(url) {
  return url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
}

// Stale-while-revalidate: serve cached font instantly, refresh in the background.
async function handleFontRequest(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => { if (res && res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

// Cache-first for same-origin shell assets, with a network fallback that
// backfills the cache (covers files added after the last SW install).
async function handleShellRequest(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    if (request.mode === "navigate") return cache.match("./index.html");
    return Response.error();
  }
}

// Network-first for navigations so users get the newest shell when online,
// falling back to the cached shell when offline.
async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put("./index.html", res.clone());
    return res;
  } catch (e) {
    return (await cache.match("./index.html")) || (await cache.match(request));
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }
  if (isGoogleFontRequest(url)) {
    event.respondWith(handleFontRequest(request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(handleShellRequest(request));
  }
});
