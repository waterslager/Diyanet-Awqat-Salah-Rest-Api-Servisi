// Önbelleksiz service worker: hiçbir şey saklanmaz, her istek doğrudan ağdan gider.
// Eski sürümlerin bıraktığı tüm önbellekler aktivasyonda silinir.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // no-store: tarayıcının HTTP önbelleğini de atlar, her seferinde sunucudan alınır.
  // İstek nesnesi olduğu gibi iletilir: mod, yönlendirme ve başlıklar korunur.
  event.respondWith(
    fetch(req, { cache: 'no-store' }).catch(() =>
      new Response(
        'Çevrimdışısınız. Bu uygulama internet bağlantısı gerektirir.',
        { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      )
    )
  );
});
