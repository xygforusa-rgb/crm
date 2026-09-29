/* 日语词汇 · Service Worker
   策略：网络优先，失败回落缓存 —— 在线总能拿到最新版，断网也能继续背。
   改了应用代码后不用动这个文件（网络优先会自动更新缓存）。 */
const CACHE = "jpvocab-v1";

const CORE = [
  "./",
  "index.html",
  "style.css",
  "manifest.json",
  "js/fsrs.js",
  "js/app.js",
  "data/meta.js",
  "data/vocab-n5.js",
  "data/vocab-n4.js",
  "data/vocab-n3.js",
  "data/vocab-n2.js",
  "data/vocab-n1.js",
  "data/families.js",
  "data/pairs.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-180.png",
  "icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个加，别用 addAll：一个 404 会把整批全废掉
    await Promise.all(CORE.map(async (p) => {
      try { await c.add(new Request(p, { cache: "reload" })); } catch (_) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;   // 只管自己这个目录，别碰 CRM

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === "basic") {
        const c = await caches.open(CACHE);
        c.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === "navigate") {
        const idx = await caches.match("index.html");
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
