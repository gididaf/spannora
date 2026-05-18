// spannora service worker.
//
// Purpose: make the app installable as a PWA and speed up repeat loads.
// We never cache API responses — chat, auth, and conversation state must
// always hit the network so streaming and session checks stay correct.
//
// Bump VERSION any time the precache list or strategy changes.

const VERSION = "v1";
const CACHE = `spannora-${VERSION}`;

const PRECACHE = [
  "/",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // addAll is atomic — if any item fails the whole install rolls back.
      // Wrap each in a Request with cache: 'reload' so we don't pick up a
      // stale browser cache entry during install.
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))
    ),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept API traffic or the service worker file itself.
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  // Navigation requests (HTML pages) — network-first so a redeploy lands
  // immediately, with the precached shell as a graceful offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // Cache the latest HTML for offline use, but only if it's a real
          // 200 (not a redirect / 401).
          if (resp.ok && resp.type === "basic") {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("/"))),
    );
    return;
  }

  // Static assets — cache-first, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((resp) => {
        if (resp.ok && resp.type === "basic") {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return resp;
      });
      return cached || networkFetch;
    }),
  );
});

// Allow the page to ask us to drop in immediately when a new SW is waiting.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
