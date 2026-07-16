// Confidant service worker — makes the app installable and fast.
// Bump CACHE when static assets change to refresh the cache.
const CACHE = "confidant-v1";
const ASSETS = [
  "/", "/index.html", "/ilona.png", "/ilona.svg",
  "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png",
  "/apple-touch-icon.png", "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never touch API calls (login, chat, history) — always straight to network,
  // so nothing private is ever cached and responses are always live.
  if (url.pathname.startsWith("/api/") || event.request.method !== "GET") return;

  // The page itself: network-first (so updates show immediately), with the
  // cached shell as an offline fallback.
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
    return;
  }

  // Static assets (images, icons, manifest): cache-first for speed.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
