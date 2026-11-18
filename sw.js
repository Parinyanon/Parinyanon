// เก็บเฉพาะไฟล์หน้าตาแอป ห้าม cache API, Auth, config.local.js หรือข้อมูลผู้ใช้
const CACHE = 'jadnee-shell-v19';
const SHELL = [
  './css/app.css',
  './css/base.css',
  './css/forms.css',
  './css/debt.css',
  './css/components.css',
  './css/theme.css',
  './js/core/page-boot.js',
  './js/core/recovery.js',
  './assets/app-icon.svg',
  './assets/app-icon-180.png',
  './assets/app-icon-192.png',
  './assets/app-icon-512.png',
  './manifest.webmanifest',
  './offline.html',
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('jadnee-shell-') && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === 'GET' &&
    event.request.mode === 'navigate' &&
    url.origin === self.location.origin &&
    url.pathname.startsWith(new URL('./', self.location.href).pathname)
  ) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(async () => {
        const cache = await caches.open(CACHE);
        const fallback = await cache.match(new URL('./offline.html', self.location.href));
        const html = fallback
          ? await fallback.text()
          : '<!doctype html><html lang="th" data-offline-fallback><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>เชื่อมต่อจัดหนี้อีกครั้ง</title><body style="margin:24px;font:16px/1.7 Tahoma,sans-serif;color:#263733;background:#f5f5ef"><h1>ยังเชื่อมต่อจัดหนี้ไม่ได้</h1><p>ลองตรวจ Wi-Fi หรืออินเทอร์เน็ตมือถือ แล้วกด “ลองอีกครั้ง”</p><a href="">ลองอีกครั้ง</a></body></html>';
        const response = new Response(html, { status: 503, headers: fallback?.headers });
        response.headers.delete('Content-Encoding');
        response.headers.delete('Content-Length');
        response.headers.set('Content-Type', 'text/html; charset=utf-8');
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('X-Jadnee-Offline', '1');
        return response;
      }),
    );
    return;
  }
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !SHELL.some((path) => new URL(path, self.location.href).pathname === url.pathname)
  )
    return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
