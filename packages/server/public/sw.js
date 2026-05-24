// spannora service worker.
//
// Purpose: make the app installable as a PWA and speed up repeat loads.
// We never cache API responses — chat, auth, and conversation state must
// always hit the network so streaming and session checks stay correct.
//
// Bump VERSION any time the precache list or strategy changes. v2 fixed a
// nasty bug where /app.js could be precached as redirect-followed login
// HTML when the SW installed before the user was authenticated. v4 switched
// /app.js to <script type="module"> and split the chat rendering into
// /shared/*.js modules — old caches need to be evicted so the cache-first
// path doesn't serve a stale non-module app.js.

const VERSION = "v5";
const CACHE = `spannora-${VERSION}`;

// We don't precache auth-gated assets anymore: if the SW installs while
// the user is on /login, the server replies 302 → /login for /app.js, and
// the redirected response would poison the cache under the /app.js key.
// Only assets that are always public belong here.
const PRECACHE = [
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))
    ),
  );
  self.skipWaiting();
});

// A response is safe to cache only if (a) it succeeded, (b) the browser
// didn't follow a redirect to get it (which would mean we'd store one
// URL's content under a *different* URL's key), and (c) it's a regular
// same-origin response (`type: "basic"`).
function isCacheable(req, resp) {
  if (!resp || !resp.ok) return false;
  if (resp.type !== "basic") return false;
  if (resp.redirected) return false;
  if (resp.url && resp.url !== req.url) return false;
  return true;
}

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

  // Navigation requests (HTML pages) — network-first so redeploys land
  // immediately, with cache as a graceful offline fallback. Use a manual
  // redirect so a 302 → /login doesn't get cached under the original URL.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (isCacheable(req, resp)) {
            const clone = resp.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match(req).then((m) => m || Response.error())),
    );
    return;
  }

  // Static assets — cache-first, refresh in background. Same redirect
  // guard via isCacheable() so we never cache an auth wall under an
  // asset URL.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((resp) => {
        if (isCacheable(req, resp)) {
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
