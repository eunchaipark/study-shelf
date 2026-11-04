// 서재 — app-shell service worker.
// Precaches the shell (HTML/CSS-in-HTML/JS/icons/vendor lib) so the reader still
// opens offline; book content itself lives in IndexedDB, not here.
const SHELL_CACHE = "seojae-shell-v69";
const RUNTIME_CACHE = "seojae-runtime-v69";
// The Firebase SDK is fetched from a versioned URL, so a copy never goes
// stale — but it lived in the runtime cache, which every deploy deletes.
// The first offline launch after an update then had no SDK, and sync stayed
// dead for the rest of that session. It keeps its own cache now, one that
// outlives deploys.
const SDK_CACHE = "seojae-sdk";
const CURRENT_CACHES = [SHELL_CACHE, RUNTIME_CACHE, SDK_CACHE];

const SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./vendor/marked.min.js",
  "./vendor/purify.min.js",
  "./vendor/highlight.min.js",
  "./vendor/hljs-languages/bash.min.js",
  "./vendor/hljs-languages/c.min.js",
  "./vendor/hljs-languages/cpp.min.js",
  "./vendor/hljs-languages/csharp.min.js",
  "./vendor/hljs-languages/css.min.js",
  "./vendor/hljs-languages/go.min.js",
  "./vendor/hljs-languages/java.min.js",
  "./vendor/hljs-languages/javascript.min.js",
  "./vendor/hljs-languages/json.min.js",
  "./vendor/hljs-languages/kotlin.min.js",
  "./vendor/hljs-languages/markdown.min.js",
  "./vendor/hljs-languages/php.min.js",
  "./vendor/hljs-languages/plaintext.min.js",
  "./vendor/hljs-languages/python.min.js",
  "./vendor/hljs-languages/ruby.min.js",
  "./vendor/hljs-languages/rust.min.js",
  "./vendor/hljs-languages/sql.min.js",
  "./vendor/hljs-languages/swift.min.js",
  "./vendor/hljs-languages/typescript.min.js",
  "./vendor/hljs-languages/xml.min.js",
  "./vendor/hljs-languages/yaml.min.js",
  "./vendor/katex/katex.min.css",
  "./vendor/katex/katex.min.js",
  "./vendor/katex/fonts/KaTeX_AMS-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Main-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2",
  "./vendor/katex/fonts/KaTeX_Main-Italic.woff2",
  "./vendor/katex/fonts/KaTeX_Main-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2",
  "./vendor/katex/fonts/KaTeX_Math-Italic.woff2",
  "./vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2",
  "./vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2",
  "./vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Script-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size1-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size2-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size3-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Size4-Regular.woff2",
  "./vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-32.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => Promise.all(
        // cache:"reload" bypasses the browser's own HTTP cache for each
        // fetch — same reasoning as handleNavigation below: GitHub Pages
        // sends Cache-Control: max-age=600 on every file, so a plain
        // cache.addAll() could precache stale copies for up to 10 minutes
        // after a deploy instead of what was just pushed.
        // a missing file fails the install rather than being cached as a 404
        SHELL_URLS.map((url) => fetch(url, { cache: "reload" }).then((res) => {
          if (!res.ok) throw new Error("shell asset " + url + " -> " + res.status);
          return cache.put(url, res);
        }))
      ))
      .then(() => self.skipWaiting())
  );
});

// SDK files an older version kept in its runtime cache move across before
// that cache goes, so this update isn't the one that strands them.
async function keepSdkCopies(oldNames) {
  const sdk = await caches.open(SDK_CACHE);
  for (const name of oldNames) {
    if (!name.startsWith("seojae-runtime-")) continue;
    const old = await caches.open(name);
    for (const req of await old.keys()) {
      if (!isFirebaseSdkRequest(new URL(req.url)) || (await sdk.match(req))) continue;
      const res = await old.match(req);
      if (res) await sdk.put(req, res);
    }
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(async (names) => {
        const stale = names.filter((n) => !CURRENT_CACHES.includes(n));
        try { await keepSdkCopies(stale); } catch (e) {}
        await Promise.all(stale.map((n) => caches.delete(n)));
      })
      .then(() => self.clients.claim())
  );
});

function isGoogleFontRequest(url) {
  return url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
}

// Firebase SDK modules (loaded lazily for optional cloud sync) — cache them
// the same way as fonts so sync can still boot from cache when briefly
// offline. Firestore's own API traffic (firestore.googleapis.com) is live
// data, not a static asset, and is intentionally left uncached.
function isFirebaseSdkRequest(url) {
  return url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
}

// Stale-while-revalidate: serve cached copy instantly, refresh in the background.
async function handleRuntimeCacheRequest(request, cacheName) {
  const cache = await caches.open(cacheName || RUNTIME_CACHE);
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
    const res = await fetch(request, { cache: "reload" });
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    if (request.mode === "navigate") return cache.match("./index.html");
    return Response.error();
  }
}

// Network-first for navigations so users get the newest shell when online,
// falling back to the cached shell when offline. cache:"reload" bypasses the
// *browser's own* HTTP cache for this fetch — GitHub Pages serves index.html
// with Cache-Control: max-age=600, so without this, "network-first" could
// still silently hand back a stale copy for up to 10 minutes after a deploy.
// The network gets a few seconds; on a weak signal, waiting on it left the
// app blank until the request finally gave up. Past that the cached shell
// opens, and the page's own update check finds the newer one in the
// background when it lands.
const NAV_TIMEOUT_MS = 3500;
async function handleNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = cache.match("./index.html");
  // the fetch keeps going after a timeout, so a late arrival still lands
  // in the cache for the next open
  const network = fetch(request, { cache: "reload" }).then((res) => {
    if (res && res.ok) cache.put("./index.html", res.clone());
    return res;
  });
  network.catch(() => {});
  try {
    const res = await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error("nav timeout")), NAV_TIMEOUT_MS)),
    ]);
    if (res && res.ok) return res;
    return (await cached) || res;
  } catch (e) {
    return (await cached) || (await cache.match(request)) || Response.error();
  }
}

// handleNavigation stores whatever it fetches as the app shell, so it must
// only ever see the app itself. Any other page in scope (md-book-reader.html)
// used to overwrite the cached shell, and the next offline or slow launch
// opened that page instead of the library.
function isAppShellNavigation(url) {
  const base = new URL("./", self.location.href).pathname;
  return url.origin === self.location.origin &&
    (url.pathname === base || url.pathname === base + "index.html");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (request.mode === "navigate") {
    // other pages go to the network as if there were no worker
    if (isAppShellNavigation(url)) event.respondWith(handleNavigation(request));
    return;
  }
  if (isFirebaseSdkRequest(url)) {
    event.respondWith(handleRuntimeCacheRequest(request, SDK_CACHE));
    return;
  }
  if (isGoogleFontRequest(url)) {
    event.respondWith(handleRuntimeCacheRequest(request));
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith(handleShellRequest(request));
  }
});
