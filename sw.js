// 오프라인 사용을 위한 앱 셸 캐시 (현장에서 통신이 약해도 입력은 가능하게)
const CACHE = 'mindone-cc-v3';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './css/app.css',
  './js/app.js', './js/store.js', './js/schema.js', './js/ui.js', './js/audio.js', './js/ai.js',
  './js/hwpx.js', './js/localai.js', './js/db.js', './js/sync.js', './js/vendor/fflate.module.js', './assets/form.hwpx',
  './assets/logo.png', './assets/favicon.png', './assets/icon-192.png', './assets/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API 호출과 외부 요청은 항상 네트워크
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
