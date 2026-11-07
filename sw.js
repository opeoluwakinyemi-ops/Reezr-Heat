const CACHE = "reezr-heat-v57";
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
// Heat alerts: a push carries no words, so ask the server what to show.
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let m = { title: "Reezr Heat alert", body: "Open the app to see tomorrow's heat." };
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const r = await fetch("/api/push/msg", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      if (r.ok) m = await r.json();
    } catch (err) {}
    await self.registration.showNotification(m.title, { body: m.body, icon: "icons/icon-192.png", tag: "rh-alert" });
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(l => {
    // An alert opens on the reading, not the landing page.
    const open = l.find(c => "navigate" in c);
    return open ? open.navigate("./?open=today").then(c => c.focus()) : self.clients.openWindow("./?open=today");
  }));
});
