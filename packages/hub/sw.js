// spannora hub — service worker.
//
// The hub is a pure static PWA shell; all chat data lives on the backends
// reached cross-origin. We only precache files served from THIS origin
// (the hub itself), never anything from the spannora backends — those
// requests must always hit the live network so SSE works and token
// validity is checked.
//
// Cache name is namespaced (`spannora-hub-v*`) so it can coexist with
// per-server spannora PWAs installed from individual spannora origins
// without collision.

const VERSION = "v2";
const CACHE = `spannora-hub-${VERSION}`;

// All paths are relative to the SW's scope, so this works whether the
// hub is deployed at `/spannora/` (GitHub Pages) or `/` (local dev).
const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./src/main.js",
  "./src/storage.js",
  "./src/instances.js",
  "./src/client.js",
  "./src/sidebar.js",
  "./src/chatView.js",
  "./src/addInstance.js",
  "./src/instanceSettings.js",
  "./src/reorder.js",
  "./src/picker.js",
  "./shared/index.js",
  "./shared/sse.js",
  "./shared/dom.js",
  "./shared/diff.js",
  "./shared/highlight.js",
  "./shared/toolRenderers.js",
  "./shared/toolCard.js",
  "./shared/askUserQuestion.js",
  "./shared/messageRenderer.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
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

function isCacheable(req, resp) {
  if (!resp || !resp.ok) return false;
  if (resp.type !== "basic") return false;
  if (resp.redirected) return false;
  if (resp.url && resp.url !== req.url) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never touch cross-origin requests — those are spannora backends.
  // Letting them through unmodified preserves SSE streaming + bearer
  // auth + CORS semantics.
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/sw.js" || url.pathname.endsWith("/sw.js")) return;

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
        .catch(() => caches.match(req).then((m) => m || caches.match("./index.html"))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req).then((resp) => {
        if (isCacheable(req, resp)) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || networkFetch;
    }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});
