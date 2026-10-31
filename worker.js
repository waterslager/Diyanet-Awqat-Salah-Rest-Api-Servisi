// Diyanet (awqatsalah.diyanet.gov.tr) için ara sunucu (proxy) - Cloudflare Worker  [sürüm 9]
//
// Kullanım:
//   Önbellekli : https://<worker-adresi>/?stateId=539&il=İSTANBUL
//   Anlık canlı: https://<worker-adresi>/?stateId=539&il=İSTANBUL&nocache=1
//   Durum kontrolü (şifre göstermez): https://<worker-adresi>/?status=1
//   Kota sayfası (okunaklı kart)    : https://<worker-adresi>/?kota=1   (isteğe bağlı il: &stateId=539)
//
// Gizli ayarlar (Secret): DIYANET_EMAIL, DIYANET_PASSWORD
// Bağlantı (Binding, önerilir): KV, değişken adı CACHE  -> önbellek kalıcı olur
// İsteğe bağlı ayarlar (Variable):
//   ALLOWED_ORIGIN       izinli site(ler); virgülle birden fazla yazılabilir. Yalnızca "origin" yazılır: https://kullanici.github.io
//                        (sonuna / ya da /depo-adi EKLEMEYİN). Tanımlıysa başka siteden gelen tarayıcı istekleri 403 ile reddedilir.
//   NOCACHE_MIN_MINUTES  "anlık canlı" isteklerinin aynı il için en sık kaç dakikada bir Diyanet'e gideceği (varsayılan 0 = sınır yok)
//   DAILY_LIVE_LIMIT     bir il için günlük en fazla Diyanet çekme sayısı (varsayılan 60).
//                        Developer rolü: günlük 100 istek -> 60 uygundur. Standart rol: günlük 5 istek -> 4 yapın.
//   KOTA_KEY             tanımlıysa /?kota=1 sayfası yalnızca &key=<değer> ile açılır
//   Kalan hak kontrolü: https://<worker-adresi>/?status=1&stateId=539  (bugun_cekim / gunluk_limit)
//
// Yanıt başlıkları: X-Source = live | cache | cache-throttled | stale | limit ,  X-Cached-At = verinin alındığı an (ms),
//                    X-Error = (yalnızca stale/limit durumunda) Diyanet'ten taze veri alınamama sebebi (URL kodlu),
//                    X-City = vakitleri alınan Diyanet ilçe kimliği ve adı (ör. "9541 ISTANBUL (exact)")

const BASE = "https://awqatsalah.diyanet.gov.tr";
const FRESH_MS = 24 * 60 * 60 * 1000;      // vakitler 24 saat taze sayılır
const STALE_TTL = 35 * 24 * 60 * 60;       // yedek olarak 35 gün saklanır
const CITY_TTL = 30 * 24 * 60 * 60;        // il -> merkez ilçe eşleşmesi 30 gün
const TOKEN_TTL = 25 * 60;                 // erişim anahtarı 25 dk
const FAIL_COOLDOWN = 10 * 60;             // Diyanet hata verirse 10 dk yeniden denenmez ("anlık canlı" isteği bu beklemeyi atlar)
const RECHECK_MS = 60 * 60 * 1000;         // yarının kaydı eksikse en sık saatte bir yenilenir
const FETCH_TIMEOUT_MS = 9000;             // Diyanet'e her istek için en çok bekleme

const mem = new Map(); // KV yoksa ya da erişilemezse bellek içi yedek
let ORIGIN = "*";

// ALLOWED_ORIGIN -> izinli origin listesi (boşsa herkese açık)
function allowedList(env) {
  return String(env.ALLOWED_ORIGIN || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    try { return new URL(x).origin; } catch (e) { return x.replace(/\/+$/, ""); }
  });
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

async function cget(env, key) {
  if (env.CACHE) { try { const v = await env.CACHE.get(key, "json"); if (v !== null && v !== undefined) return v; } catch (e) {} }
  const m = mem.get(key);
  return m && m.exp > Date.now() ? m.v : null;
}
async function cset(env, key, val, ttl) {
  mem.set(key, { v: val, exp: Date.now() + ttl * 1000 });
  if (env.CACHE) { try { await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: Math.max(60, ttl) }); } catch (e) {} }
}

async function fetchT(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
  } catch (e) {
    throw new Error(e && e.name === "AbortError" ? "Diyanet zaman aşımı" : "Diyanet'e ulaşılamadı");
  } finally { clearTimeout(t); }
}

// Diyanet giriş adresi dokümanda /api/Auth/Login olarak geçer, ancak canlı sistemde /Auth/Login olabilir.
// Sırayla denenir; 404 dönmeyen ilk adres 30 gün hatırlanır.
const LOGIN_PATHS = ["/Auth/Login", "/api/Auth/Login"];

async function getToken(env, force) {
  if (!force) { const t = await cget(env, "token"); if (t) return t; }
  if (!env.DIYANET_EMAIL || !env.DIYANET_PASSWORD) throw new Error("Worker'da DIYANET_EMAIL / DIYANET_PASSWORD tanımlı değil");
  const pref = await cget(env, "loginpath");
  const paths = pref ? [pref].concat(LOGIN_PATHS.filter((p) => p !== pref)) : LOGIN_PATHS;
  const notFound = [];
  for (const path of paths) {
    const r = await fetchT(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email: env.DIYANET_EMAIL, password: env.DIYANET_PASSWORD })
    });
    const j = await r.json().catch(() => null);
    if (r.status === 404) { notFound.push(path); continue; } // bu adres yok, diğerini dene
    if (r.ok && j && j.success && j.data && j.data.accessToken) {
      await cset(env, "loginpath", path, CITY_TTL);
      await cset(env, "token", j.data.accessToken, TOKEN_TTL);
      return j.data.accessToken;
    }
    throw new Error("Diyanet girişi başarısız (" + r.status + ")" + (j && j.message ? " - " + j.message : ""));
  }
  throw new Error("Diyanet giriş adresi bulunamadı (404: " + notFound.join(", ") + ")");
}

async function api(env, path) {
  for (let i = 0; i < 2; i++) {
    const tok = await getToken(env, i === 1);
    const r = await fetchT(BASE + path, { headers: { Authorization: "Bearer " + tok, Accept: "application/json" } });
    if (r.status === 401 && i === 0) continue; // anahtar süresi dolmuş: bir kez yeniden giriş
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.success === false) {
      throw new Error("Diyanet API hatası: " + r.status + (j && j.message ? " " + j.message : ""));
    }
    return j.data;
  }
  throw new Error("Diyanet yetkilendirme hatası");
}

const IL_TR = ["ADANA","ADIYAMAN","AFYONKARAHİSAR","AĞRI","AKSARAY","AMASYA","ANKARA","ANTALYA","ARDAHAN","ARTVİN","AYDIN","BALIKESİR","BARTIN","BATMAN","BAYBURT","BİLECİK","BİNGÖL","BİTLİS","BOLU","BURDUR","BURSA","ÇANAKKALE","ÇANKIRI","ÇORUM","DENİZLİ","DİYARBAKIR","DÜZCE","EDİRNE","ELAZIĞ","ERZİNCAN","ERZURUM","ESKİŞEHİR","GAZİANTEP","GİRESUN","GÜMÜŞHANE","HAKKARİ","HATAY","IĞDIR","ISPARTA","İSTANBUL","İZMİR","KAHRAMANMARAŞ","KARABÜK","KARAMAN","KARS","KASTAMONU","KAYSERİ","KİLİS","KIRIKKALE","KIRKLARELİ","KIRŞEHİR","KOCAELİ","KONYA","KÜTAHYA","MALATYA","MANİSA","MARDİN","MERSİN","MUĞLA","MUŞ","NEVŞEHİR","NİĞDE","ORDU","OSMANİYE","RİZE","SAKARYA","SAMSUN","ŞANLIURFA","SİİRT","SİNOP","ŞIRNAK","SİVAS","TEKİRDAĞ","TOKAT","TRABZON","TUNCELİ","UŞAK","VAN","YALOVA","YOZGAT","ZONGULDAK"];

// Türkçe harfleri sadeleştirip büyük harfe çevirir: "İstanbul", "ISTANBUL", "istanbul" -> "ISTANBUL"
const norm = (s) => String(s || "").toLocaleUpperCase("tr").trim()
  .replace(/[İIı]/g, "I").replace(/Ş/g, "S").replace(/Ğ/g, "G").replace(/Ü/g, "U").replace(/Ö/g, "O").replace(/Ç/g, "C");

// İlin merkez ilçesini bulur. İl adı kod numarasından (500-580) alınır, istemciden gelen ada güvenilmez.
// Sonuç 30 gün saklanır. Eşleşme yoksa ilk ilçeye düşülür ve X-City başlığında "fallback" yazar.
async function merkezCity(env, stateId) {
  const key = "city2:" + stateId;
  const c = await cget(env, key);
  if (c && c.id) return c;
  const ilAd = norm(IL_TR[Number(stateId) - 500] || "");
  const list = await api(env, "/api/Place/Cities/" + stateId);
  if (!Array.isArray(list) || !list.length) throw new Error("Bu il için ilçe listesi boş");
  let x = list.find((i) => norm(i.name) === ilAd), match = "exact";
  if (!x) { x = list.find((i) => norm(i.name) === "MERKEZ"); match = "merkez"; }
  if (!x) { x = list.find((i) => ilAd && norm(i.name).includes(ilAd)); match = "contains"; }
  if (!x) { x = list[0]; match = "fallback"; }
  const city = { id: String(x.id), name: norm(x.name), match };
  await cset(env, key, city, CITY_TTL);
  return city;
}

// ---- tarih yardımcıları (hepsi gg.aa.yyyy, İstanbul saati) ----
const p2 = (n) => (n < 10 ? "0" : "") + n;
function istanbulKey(offsetDays) {
  const d = new Date(Date.now() + 3 * 3600 * 1000 + (offsetDays || 0) * 86400000);
  return p2(d.getUTCDate()) + "." + p2(d.getUTCMonth() + 1) + "." + d.getUTCFullYear();
}
function dnum(key) { // "gg.aa.yyyy" -> sıralanabilir sayı
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(key || "");
  return m ? Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]) : 0;
}
function normDate(d) { // Diyanet gg.aa.yyyy ya da yyyy-aa-gg dönse de aynı biçime çevirir
  for (const c of [d.gregorianDateShort, d.gregorianDateShortIso8601, d.gregorianDateLong]) {
    if (typeof c !== "string") continue;
    let m = c.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return m[1] + "." + m[2] + "." + m[3];
    m = c.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[3] + "." + m[2] + "." + m[1];
  }
  return "";
}

const okTime = (v) => typeof v === "string" && /^\d{1,2}:\d{2}/.test(v);
function toAppShape(d) {
  const date = normDate(d || {});
  if (!date || ![d.fajr, d.sunrise, d.dhuhr, d.asr, d.maghrib, d.isha].every(okTime)) return null;
  return {
    MiladiTarihKisaIso8601: date,
    HicriTarihUzun: d.hijriDateLong || "",
    Imsak: d.fajr, Gunes: d.sunrise, Ogle: d.dhuhr,
    Ikindi: d.asr, Aksam: d.maghrib, Yatsi: d.isha
  };
}

async function loadTimes(env, cityId) {
  const monthly = await api(env, "/api/PrayerTime/Monthly/" + cityId);
  if (!Array.isArray(monthly)) throw new Error("Geçersiz vakit yanıtı");
  const days = monthly.map(toAppShape).filter(Boolean);
  // Ay sonunda yarının kaydı aylıkta yoksa haftalıkla tamamla
  const tomorrow = istanbulKey(1);
  if (!days.some((d) => d.MiladiTarihKisaIso8601 === tomorrow)) {
    try {
      const w = await api(env, "/api/PrayerTime/Weekly/" + cityId);
      if (Array.isArray(w)) {
        const have = new Set(days.map((d) => d.MiladiTarihKisaIso8601));
        for (const x of w.map(toAppShape).filter(Boolean)) if (!have.has(x.MiladiTarihKisaIso8601)) days.push(x);
      }
    } catch (e) {}
  }
  if (!days.length) throw new Error("Diyanet'ten vakit gelmedi");
  return days;
}

// Yeni veriyle eski kaydın "dün ve sonrası" günlerini birleştirir (ay başında dünün kaydı kaybolmasın)
function mergeDays(oldDays, newDays) {
  const map = new Map();
  const minKey = dnum(istanbulKey(-1));
  for (const d of oldDays || []) if (dnum(d.MiladiTarihKisaIso8601) >= minKey) map.set(d.MiladiTarihKisaIso8601, d);
  for (const d of newDays) map.set(d.MiladiTarihKisaIso8601, d);
  return Array.from(map.values()).sort((a, b) => dnum(a.MiladiTarihKisaIso8601) - dnum(b.MiladiTarihKisaIso8601));
}

// Son hata sebebini saklar ve başlığa koyar: uygulama "neden taze veri gelmedi" sorusunu gösterebilsin
async function noteError(env, stateId, msg) {
  await cset(env, "lasterr:" + stateId, { t: Date.now(), msg: String(msg).slice(0, 160) }, 24 * 60 * 60);
}
const errHdr = (msg) => ({ "X-Error": encodeURIComponent(String(msg || "").slice(0, 120)) });

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// Diyanet kota yanıtından kişisel olabilecek alanları (e-posta, kullanıcı, şifre, anahtar) ayıklar
function stripSecrets(v) {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) if (!/mail|user|pass|token|phone/i.test(k)) o[k] = stripSecrets(v[k]);
    return o;
  }
  return v;
}

// Okunaklı kota sayfası: Worker sayacı + Diyanet'in kendi kota uç noktası (varsa) denenir
async function kotaPage(env, url) {
  const sid = /^\d{3}$/.test(url.searchParams.get("stateId") || "") ? url.searchParams.get("stateId") : "539";
  const limit = num(env.DAILY_LIVE_LIMIT, 60);
  const c = await cget(env, "city2:" + sid);
  const used = c && c.id ? (Number(await cget(env, "cnt:" + c.id + ":" + istanbulKey(0))) || 0) : 0;
  const le = await cget(env, "lasterr:" + sid);

  let dq = await cget(env, "quotamy");
  if (!dq) {
    try {
      const d = await api(env, "/api/Quota/My");
      const clean = stripSecrets(d);
      dq = { ok: true, obj: clean, txt: JSON.stringify(clean, null, 2).slice(0, 1800) };
    } catch (e) {
      dq = { ok: false, txt: String((e && e.message) || e) };
    }
    await cset(env, "quotamy", dq, 120); // arka arkaya açılırsa Diyanet'e tekrar gitme
  }

  // Diyanet yanıtından okunaklı özet: rol + her hizmet için kullanılan / kalan
  let ozet = "";
  if (dq.ok && dq.obj && Array.isArray(dq.obj.daily)) {
    const satirlar = [];
    for (const h of dq.obj.daily) {
      const ad = esc(h.resultName || h.controllerName || "?");
      const hak = Number(h.benefit) || 0;
      if (Array.isArray(h.lines) && h.lines.length) {
        for (const l of h.lines) satirlar.push(`<div>${ad} <span class="s">(${esc(l.parameter || "")})</span>: <b>${Number(l.used) || 0}</b> kullanıldı, kalan <b>${l.remainingUse !== undefined ? Number(l.remainingUse) : Math.max(0, hak - (Number(l.used) || 0))}</b> / ${hak}</div>`);
      } else {
        satirlar.push(`<div>${ad}: <b>${Number(h.totalUsed) || 0}</b> kullanıldı, kalan <b>${Math.max(0, hak - (Number(h.totalUsed) || 0))}</b> / ${hak}</div>`);
      }
      if (Number(h.totalExceeded) > 0) satirlar.push(`<div style="color:#f87171">Aşım sayısı: ${Number(h.totalExceeded)}</div>`);
    }
    ozet = `<div>Rol: <b>${esc(dq.obj.role || "?")}</b> &middot; günlük hak</div>${satirlar.join("") || "<div>Bugün kullanım yok</div>"}`;
  }

  const body = `<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Diyanet kota</title>
<style>body{font:16px system-ui,sans-serif;margin:16px;background:#0f172a;color:#e2e8f0}.c{background:#1e293b;border-radius:12px;padding:14px;margin:12px 0}h1{font-size:18px}h2{font-size:15px;margin:0 0 8px;color:#fbbf24}pre{white-space:pre-wrap;word-break:break-word;font-size:13px;margin:6px 0 0}.k{font-size:22px;font-weight:700}.s{color:#94a3b8;font-size:13px}</style>
<h1>Diyanet kota durumu</h1>
<div class="c"><h2>Worker sayacı (il kodu ${esc(sid)})</h2><div class="k">${used} / ${limit}</div><div>Bugün Diyanet'e gidilen: <b>${used}</b> &middot; Kalan: <b>${Math.max(0, limit - used)}</b></div><div class="s">Sayaç gece yarısı (İstanbul saati) sıfırlanır. Aynı il için sayaç; hesabın tamamı değildir.</div></div>
<div class="c"><h2>Diyanet'in kendi kota sorgusu</h2>${dq.ok ? (ozet || "<div>Diyanet yanıt verdi:</div>") + "<details><summary class=\"s\">Ham yanıt</summary><pre>" + esc(dq.txt) + "</pre></details>" : "<div>Alınamadı: " + esc(dq.txt) + "</div><div class=\"s\">Diyanet bu uç noktayı sunmuyor ya da erişim izni yok olabilir. Yukarıdaki Worker sayacı geçerli.</div>"}</div>
<div class="c"><h2>Son hata</h2><div>${le ? esc(le.msg) + " <span class=\"s\">(" + new Date(le.t + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16) + ")</span>" : "Yok"}</div></div></html>`;
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// Günlük Diyanet çekme sınırı (kota ve hesap koruması)
async function takeLiveSlot(env, cityId, limit) {
  const key = "cnt:" + cityId + ":" + istanbulKey(0);
  const n = Number(await cget(env, key)) || 0;
  if (n >= limit) return false;
  await cset(env, key, n + 1, 2 * 24 * 60 * 60);
  return true;
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": ORIGIN,
      "Vary": "Origin",
      "Access-Control-Expose-Headers": "X-Source, X-Cached-At, X-City, X-Error",
      "Cache-Control": "no-store"
    }, extra || {})
  });
}

export default {
  async fetch(request, env) {
    const allowed = allowedList(env);
    const reqOrigin = request.headers.get("Origin") || "";
    ORIGIN = allowed.length ? (allowed.includes(reqOrigin) ? reqOrigin : allowed[0]) : "*";
    if (allowed.length && reqOrigin && !allowed.includes(reqOrigin)) {
      // izinli olmayan bir siteden gelen tarayıcı isteği: Diyanet'e hiç gidilmez, kota harcanmaz
      return json({ success: false, message: "Bu siteden erişime izin verilmiyor" }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": ORIGIN, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "GET") return json({ success: false, message: "Yalnızca GET" }, 405);

    const url = new URL(request.url);

    if (url.searchParams.get("kota") === "1") {
      if (env.KOTA_KEY && url.searchParams.get("key") !== env.KOTA_KEY) return json({ success: false, message: "Bu sayfa için anahtar gerekli" }, 403);
      try { return await kotaPage(env, url); }
      catch (e) { return json({ success: false, message: String((e && e.message) || e) }, 502); }
    }

    if (url.searchParams.get("status") === "1") { // yalnızca evet/hayır ve sayaç bilgisi verir, gizli bilgi göstermez
      const out = {
        success: true, surum: 9,
        kv_bagli: !!env.CACHE,
        giris_bilgisi_tanimli: !!(env.DIYANET_EMAIL && env.DIYANET_PASSWORD),
        izinli_site: allowed.length ? allowed.join(", ") : "*",
        nocache_dk: num(env.NOCACHE_MIN_MINUTES, 0),
        gunluk_limit: num(env.DAILY_LIVE_LIMIT, 60)
      };
      const sid = url.searchParams.get("stateId");
      if (sid && /^\d{3}$/.test(sid)) { // o il için bugün Diyanet'e kaç kez gidildi
        const c = await cget(env, "city2:" + sid);
        out.ilce = c && c.id ? c.id + " " + c.name + " (" + c.match + ")" : "henüz seçilmedi (önce bir vakit isteği yapın)";
        out.bugun_cekim = c && c.id ? (Number(await cget(env, "cnt:" + c.id + ":" + istanbulKey(0))) || 0) : 0;
        out.kalan = Math.max(0, out.gunluk_limit - out.bugun_cekim);
        const le = await cget(env, "lasterr:" + sid);
        out.son_hata = le ? { zaman: new Date(le.t + 3 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16), mesaj: le.msg } : "yok";
      }
      return json(out);
    }

    const stateId = url.searchParams.get("stateId") || "";
    const nocache = ["1", "true"].includes((url.searchParams.get("nocache") || "").toLowerCase());
    if (!/^\d{3}$/.test(stateId) || Number(stateId) < 500 || Number(stateId) > 580) {
      return json({ success: false, message: "stateId 500-580 arasında olmalı" }, 400);
    }

    try {
      const failKey = "fail:" + stateId;
      const failed = await cget(env, failKey);

      let city, cityId;
      try {
        city = await merkezCity(env, stateId);
        cityId = city.id;
      } catch (e) {
        await cset(env, failKey, 1, FAIL_COOLDOWN);
        throw e;
      }

      const key = "times:" + cityId;
      const cached = await cget(env, key);
      const age = cached ? Date.now() - cached.t : Infinity;
      const hasTomorrow = cached ? cached.data.some((d) => d.MiladiTarihKisaIso8601 === istanbulKey(1)) : false;
      const fresh = !!cached && age < FRESH_MS && (hasTomorrow || age < RECHECK_MS);
      const nocacheOk = nocache && (!cached || age >= num(env.NOCACHE_MIN_MINUTES, 0) * 60 * 1000);
      const cityTag = city.id + " " + city.name + " (" + city.match + ")";
      const meta = (src) => ({ "X-Source": src, "X-Cached-At": cached ? String(cached.t) : "", "X-City": cityTag });

      // 1) Taze önbellek (anlık canlı istenmediyse ya da çok sık isteniyorsa)
      if (fresh && !nocacheOk) return json(cached.data, 200, meta(nocache ? "cache-throttled" : "cache"));

      // 2) Yakın zamanda Diyanet hata verdiyse tekrar denemeden yedeği ver
      if (failed && !nocache) { // "anlık canlı" istekleri bu beklemeyi atlar (günlük sınır yine geçerli)
        const le = await cget(env, "lasterr:" + stateId);
        if (cached) return json(cached.data, 200, Object.assign(meta("stale"), errHdr(le ? le.msg : "Diyanet geçici olarak yanıt vermiyor")));
        return json({ success: false, message: "Diyanet geçici olarak yanıt vermiyor, biraz sonra tekrar deneyin" }, 502);
      }

      // 3) Günlük sınır
      if (!(await takeLiveSlot(env, cityId, num(env.DAILY_LIVE_LIMIT, 60)))) {
        if (cached) return json(cached.data, 200, Object.assign(meta("limit"), errHdr("Günlük sınır doldu")));
        return json({ success: false, message: "Günlük Diyanet istek sınırına ulaşıldı" }, 429);
      }

      // 4) Diyanet'ten taze veri
      try {
        const fresh2 = await loadTimes(env, cityId);
        const data = mergeDays(cached ? cached.data : [], fresh2);
        const t = Date.now();
        await cset(env, key, { t, data }, STALE_TTL);
        return json(data, 200, { "X-Source": "live", "X-Cached-At": String(t), "X-City": cityTag });
      } catch (e) {
        const em = String((e && e.message) || e);
        await cset(env, failKey, 1, FAIL_COOLDOWN);
        await noteError(env, stateId, em);
        if (cached) return json(cached.data, 200, Object.assign(meta("stale"), errHdr(em))); // Diyanet cevap vermezse son veri
        throw e;
      }
    } catch (e) {
      return json({ success: false, message: String((e && e.message) || e) }, 502);
    }
  }
};
