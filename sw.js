/* WindMar Itinerary — service worker for Web Push (crew updates).
   Receives high-priority push even when the app tab/window is closed. */
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : "" }; }
  const title = d.title || "WindMar — Crew Update";
  const opts = {
    body: d.body || "",
    tag: d.tag || ("crew-" + Date.now()),
    data: { url: d.url || "/" },
    requireInteraction: true,           // stays on screen until the coordinator acts (high priority)
    renotify: true,
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) { c.focus(); if (c.navigate && url && url !== "/") { try { c.navigate(url); } catch (e) {} } return; }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
