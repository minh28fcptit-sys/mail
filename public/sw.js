/**
 * Service worker — THONG BAO DAY + SO DO tren icon app.
 * Cache: CHI cache icon/anh tinh (khong bao gio cache HTML/JS/CSS/API)
 * -> deploy ban moi khong bao gio bi ket ban cu.
 */
const ICON_CACHE = "icons-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      /* Don cache cu cua cac phien ban truoc */
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== ICON_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  )
);

/* Chi icon app moi duoc cache (khong doi noi dung, tai lai rat nhieu lan) */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/icons/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(ICON_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })()
  );
});

/* Ap so do len icon app (iOS 16.4+ / Android / macOS) */
async function setBadge(n) {
  try {
    const count = Number(n) || 0;
    if (count > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(count);
    else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
  } catch { }
}

/* Neu dang mo app va nhin thay man hinh -> khong can hien thong bao he thong */
async function hasVisibleClient() {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return list.some((c) => c.visibilityState === "visible" && c.focused);
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let d = {};
      try {
        d = event.data ? event.data.json() : {};
      } catch {
        d = { title: "Tin nhắn mới", body: event.data ? event.data.text() : "" };
      }

      if (typeof d.unreadTotal === "number" && d.kind !== "test") await setBadge(d.unreadTotal);
      else if (d.kind === "test") await setBadge(1);

      /* Cho trang dang mo tu cap nhat danh sach */
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) c.postMessage({ type: "push", data: d });

      if (d.kind === "badge" || d.silent) return;
      if (await hasVisibleClient()) return;

      /* Hien so tin chua doc ngay tren tieu de: hon 9 tin thi ghi 9+ */
      const n = Number(d.unreadTotal) || 0;
      const label = n > 9 ? "9+" : String(n);
      const title = (d.title || "Tin nhắn mới") + (n > 1 ? ` (${label})` : "");

      await self.registration.showNotification(title, {
        body: d.body || "",
        icon: d.icon || "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: d.conversationId || "chat",
        renotify: true,
        data: { url: d.url || "/chat" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/chat";
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        if (new URL(c.url).pathname.startsWith("/chat")) {
          c.postMessage({ type: "open", url });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })()
  );
});

/* Trang gui yeu cau cap nhat so do (khi doc tin, khi tai lai danh sach) */
self.addEventListener("message", (event) => {
  const m = event.data || {};
  if (m.type === "badge") event.waitUntil(setBadge(m.count));
});
