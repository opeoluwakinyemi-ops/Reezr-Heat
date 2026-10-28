const CACHE = "reezr-heat-v9";
const CORE = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png", "icons/logo-mark.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request, url = new URL(r.url);
  if (r.method !== "GET" || url.origin !== location.origin) return;
  // Network first so health advice updates quickly; fall back to cache when offline.
  // Shared links (?place=...) all open the same page, so match them to the cached page.
  e.respondWith(
    fetch(r).then(res => {
      // Only cache good responses, so a server error never replaces the offline copy.
      if (res.ok && !url.search) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(r, copy));
      }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || caches.match("./")))
  );
});
