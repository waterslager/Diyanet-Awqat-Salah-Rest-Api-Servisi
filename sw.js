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

// no-store: tarayıcının HTTP önbelleğini de atlar, her seferinde sunucudan alınır.
// İstek nesnesi olduğu gibi iletilir: mod, yönlendirme ve başlıklar korunur.
// Geçici bağlantı/sunucu hatasında (kopma, 404, 5xx) bir kez daha denenir; tek bir kayıp istek sayfayı bozmasın.
async function load(req) {
  let first = null;
  try {
    first = await fetch(req, { cache: 'no-store' });
    if (first.status !== 404 && first.status < 500) return first;
  } catch (e) { /* ikinci deneme */ }
  await new Promise((r) => setTimeout(r, 400));
  try {
    return await fetch(req, { cache: 'no-store' });
  } catch (e) {
    if (first) return first;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(load(req).catch(() =>
    new Response(
      'Çevrimdışısınız. Bu uygulama internet bağlantısı gerektirir.',
      { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    )
  ));
});
