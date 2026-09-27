// Photrix service worker.
//
// It exists to make the site installable and to show a friendly offline page
// instead of the browser's error screen when the installed app is launched
// without a connection. It deliberately caches nothing else: photos and the API
// always come from the network, and the app shell can never be served stale
// after a deploy. Only top-level navigations are intercepted; every other
// request goes straight to the network without touching this worker.

const CACHE = "photrix-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL, "/icons/icon-192.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("photrix-") && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      // Start the navigation request in parallel with worker boot-up, so
      // intercepting navigations costs no extra latency.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch {
        const offline = await caches.match(OFFLINE_URL);
        return offline ?? Response.error();
      }
    })(),
  );
});
