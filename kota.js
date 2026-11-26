"use strict";
/*
 * Diyanet kota görüntüleyici — index.html'den bağımsız çalışır (kota.html + kota.css + kota.js).
 *
 * Nasıl çalışır:
 *  - Worker'dan kota verisini JSON olarak çeker (?kota=1) ve kartları kendisi çizer; görünümün mantığı bu dosyadadır.
 *  - Diyanet'in kendi kota yanıtı özetlenmeden, "Ham yanıt" altında eksiksiz gösterilir.
 *  - Şifre (KOTA_KEY) yalnızca bu cihazın tarayıcısında saklanır, dosyanın içinde yoktur.
 *  - Worker'da KOTA_KEY tanımlı değilse şifre sorulmaz, sayfa doğrudan açılır.
 *  - İstek, Worker'daki ALLOWED_ORIGIN listesinde olan adresten (github.io) yapılmalıdır.
 */

const WORKER = "https://diyanet-awqat-salah.ertantan-tr.workers.dev";
const KEY_STORE = "kota.key.v1";
const IL_STORE = "kota.il.v1";
const APP_IL_PREF = "kiyamul-leyl.ilpref.v1"; // ana uygulamanın son seçtiği il (varsa)
const PAGE_ORIGIN = "https://waterslager.github.io"; // Worker'ın izin verdiği adres (ALLOWED_ORIGIN)
const DEFAULT_STATE = "539"; // İstanbul
const TIMEOUT_MS = 15000;
const AUTO_REFRESH_MS = 30000;

// NOT: Bu liste app.js ve worker.js içindeki IL_TR ile aynıdır; il kodu = 500 + sıra.
const IL_TR = ["ADANA","ADIYAMAN","AFYONKARAHİSAR","AĞRI","AKSARAY","AMASYA","ANKARA","ANTALYA","ARDAHAN","ARTVİN","AYDIN","BALIKESİR","BARTIN","BATMAN","BAYBURT","BİLECİK","BİNGÖL","BİTLİS","BOLU","BURDUR","BURSA","ÇANAKKALE","ÇANKIRI","ÇORUM","DENİZLİ","DİYARBAKIR","DÜZCE","EDİRNE","ELAZIĞ","ERZİNCAN","ERZURUM","ESKİŞEHİR","GAZİANTEP","GİRESUN","GÜMÜŞHANE","HAKKARİ","HATAY","IĞDIR","ISPARTA","İSTANBUL","İZMİR","KAHRAMANMARAŞ","KARABÜK","KARAMAN","KARS","KASTAMONU","KAYSERİ","KİLİS","KIRIKKALE","KIRKLARELİ","KIRŞEHİR","KOCAELİ","KONYA","KÜTAHYA","MALATYA","MANİSA","MARDİN","MERSİN","MUĞLA","MUŞ","NEVŞEHİR","NİĞDE","ORDU","OSMANİYE","RİZE","SAKARYA","SAMSUN","ŞANLIURFA","SİİRT","SİNOP","ŞIRNAK","SİVAS","TEKİRDAĞ","TOKAT","TRABZON","TUNCELİ","UŞAK","VAN","YALOVA","YOZGAT","ZONGULDAK"];

const $ = (id) => document.getElementById(id);
const ilSel = $("ilSel"), refreshBtn = $("refreshBtn"), keyBtn = $("keyBtn");
const keyForm = $("keyForm"), keyInput = $("keyInput"), showKey = $("showKey"), clearKeyBtn = $("clearKeyBtn");
const msgBox = $("msg"), loadingBox = $("loading"), report = $("report"), cards = $("cards"), stampEl = $("stamp");

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* yok say */ } }
};

let memKey = ""; // depolama kullanılamazsa şifre yalnızca bu oturumda bellekte tutulur
let reqId = 0;
let activeCtl = null;
let lastLoadAt = 0;

const getKey = () => store.get(KEY_STORE) || memKey;
const trUpper = (s) => String(s || "").trim().toLocaleUpperCase("tr");
const titleCase = (s) => {
  const low = String(s).toLocaleLowerCase("tr");
  return low.charAt(0).toLocaleUpperCase("tr") + low.slice(1);
};

function fillIller() {
  const frag = document.createDocumentFragment();
  IL_TR.forEach((ad, i) => {
    const o = document.createElement("option");
    o.value = String(500 + i);
    o.textContent = titleCase(ad);
    frag.appendChild(o);
  });
  ilSel.appendChild(frag);
}

function pickInitialIl() {
  const saved = store.get(IL_STORE);
  if (saved && /^5\d\d$/.test(saved) && Number(saved) >= 500 && Number(saved) <= 580) return saved;
  const pref = trUpper(store.get(APP_IL_PREF));
  if (pref) {
    const i = IL_TR.findIndex((ad) => trUpper(ad) === pref);
    if (i >= 0) return String(500 + i);
  }
  return DEFAULT_STATE;
}

function showMsg(text, kind) {
  msgBox.textContent = text;
  msgBox.className = kind || "info";
  msgBox.hidden = false;
}
function hideMsg() { msgBox.hidden = true; msgBox.textContent = ""; }

function setBusy(on) {
  $("app").setAttribute("aria-busy", String(on));
  refreshBtn.disabled = on;
  loadingBox.hidden = !on;
}

// Küçük DOM yardımcısı: metinler textContent olarak eklenir, HTML olarak yorumlanmaz.
function h(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}

const fmtTime = (ms) => new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Istanbul" }).slice(0, 16);
const asNum = (x) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

// "Ham yanıt" açılınca kart ekranın tepesine gelir (altta boşluk olduğu için her zaman kayabilir); kapanınca başa dön.
function onRawToggle(e) {
  const d = e.currentTarget;
  document.body.classList.toggle("rawopen", d.open);
  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (d.open) d.closest(".card").scrollIntoView({ behavior, block: "start" });
  else window.scrollTo({ top: 0, behavior });
}

function workerCard({ il, ilce, sayac }) {
  const kim = il.ad + " (" + (ilce ? ilce.ad + " · " + ilce.id : "henüz vakit istenmedi") + ")";
  const card = h("div", "card",
    h("h3", "", "Worker Sayacı"),
    h("div", "hl fit", kim + " · Kalan " + sayac.kalan + " / " + sayac.limit),
    h("div", "", "Bugün Diyanet’e Gidilen: ", h("b", "", String(sayac.kullanilan))),
    h("div", "note", "Sayaç 00:00’da (Türkiye saatiyle “UTC+3”) sıfırlanır."));
  // Toplam sınır tanımlıysa önemlidir, gösterilir; değilse her ilin kendi hakkı yeterli bilgidir.
  card.append(sayac.toplamLimit
    ? h("div", "gap", "Tüm İller Toplamı: ", h("b", "", String(sayac.tumIller)), " / " + sayac.toplamLimit)
    : h("div", "note", "(her il için " + sayac.limit + "’" + dagitimEki(sayac.limit) + " kota hakkı vardır)"));
  return card;
}

// Türkçe dağıtım eki (5’er, 6’şar, 10’ar, 20’şer…): son okunan sayı sözcüğünün sesine göre
function dagitimEki(n) {
  const BIRLER = ["", "er", "şer", "er", "er", "er", "şar", "şer", "er", "ar"]; // bir … dokuz
  const ONLAR = ["", "ar", "şer", "ar", "ar", "şer", "ar", "er", "er", "ar"];   // on … doksan
  if (n % 10) return BIRLER[n % 10];
  return n % 100 ? ONLAR[(n % 100) / 10] : n ? "er" : "ar"; // yüz/bin → er, sıfır → ar
}

function diyanetCard(dq) {
  const card = h("div", "card", h("h3", "", "Diyanet’in Kendi Kota Sorgusu"));
  if (!dq.ok) {
    card.append(
      h("div", "", "Alınamadı: " + (dq.hata || "bilinmeyen hata")),
      h("div", "note", "Diyanet bu uç noktayı sunmuyor ya da erişim izni yok olabilir. Yukarıdaki Worker sayacı geçerli."));
    return card;
  }
  const v = dq.veri || {};
  if (Array.isArray(v.daily)) {
    card.append(h("div", "", "Rol: ", h("b", "", v.role || "?"), " · Günlük Hak"));
    for (const d of v.daily) {
      const ad = d.resultName || d.controllerName || "?";
      const hak = Number(d.benefit) || 0;
      for (const l of Array.isArray(d.lines) && d.lines.length ? d.lines : [null]) {
        const used = Number(l ? l.used : d.totalUsed) || 0;
        const left = l && asNum(l.remainingUse) !== null ? asNum(l.remainingUse) : Math.max(0, hak - used);
        card.append(h("div", "fit", ad + (l ? " " : ""), l ? h("b", "note blue", "(" + (l.parameter || "") + ")") : "",
          ": ", h("b", "hl", "Kalan " + left + " / " + hak)));
      }
      if (Number(d.totalExceeded) > 0) card.append(h("div", "err", "Aşım sayısı: " + Number(d.totalExceeded)));
    }
    if (!v.daily.length) card.append(h("div", "", "Bugün kullanım yok"));
  } else {
    card.append(h("div", "", "Diyanet yanıt verdi:"));
  }
  const raw = h("details", "",
    h("summary", "", h("span", "o", "Ham yanıtı göster ▾"), h("span", "g", "Ham yanıtı gizle ▴")),
    h("pre", "", JSON.stringify(v, null, 2)));
  raw.addEventListener("toggle", onRawToggle);
  card.append(raw);
  return card;
}

function errorCard(le) {
  return h("div", "card line", h("h3", "", "Son Hata"),
    h("div", "", ...(le ? [le.mesaj, " ", h("span", "note", "(" + fmtTime(le.zaman) + ")")] : ["Yok"])));
}

// Tek satır kalması gereken metinler sığmazsa kartlardaki bütün ana satırlar birlikte küçülür (en az 10px; yine sığmazsa alt satıra geçer).
function fitLines() {
  const fits = cards.querySelectorAll(".fit");
  const over = () => Array.from(fits).some((el) => el.scrollWidth > el.clientWidth);
  let size = 16;
  cards.style.setProperty("--ls", size + "px");
  for (const el of fits) el.style.whiteSpace = "";
  while (size > 10 && over()) cards.style.setProperty("--ls", (size -= 0.5) + "px");
  for (const el of fits) if (el.scrollWidth > el.clientWidth) el.style.whiteSpace = "normal";
}
window.addEventListener("resize", fitLines);

function showReport(d) {
  document.body.classList.remove("rawopen"); // yeni kartlardaki "Ham yanıt" kapalı başlar
  cards.replaceChildren(workerCard(d), diyanetCard(d.diyanet), ...(d.sonHata ? [errorCard(d.sonHata)] : []));
  keyForm.hidden = true;
  report.hidden = false;
  fitLines(); // görünür olduktan sonra ölçülmeli
}

function hideReport() {
  document.body.classList.remove("rawopen");
  report.hidden = true;
  cards.replaceChildren();
}

function openKeyForm(hint) {
  hideReport();
  keyForm.hidden = false;
  clearKeyBtn.hidden = !getKey();
  keyInput.value = "";
  if (hint) showMsg(hint, "info");
  keyInput.focus();
}

function stamp() {
  lastLoadAt = Date.now();
  const t = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  stampEl.textContent = "Son güncelleme: " + t;
}

async function load() {
  const myId = ++reqId;
  if (activeCtl) activeCtl.abort();
  const ctl = new AbortController();
  activeCtl = ctl;
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  setBusy(true);
  hideMsg();

  const params = new URLSearchParams({ kota: "1", stateId: ilSel.value });
  const key = getKey();
  const headers = key ? { Authorization: "Bearer " + key } : {};

  try {
    const res = await fetch(WORKER + "/?" + params.toString(), { headers, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal });
    if (myId !== reqId) return;
    let data = null;
    try { data = await res.json(); } catch (e) { /* JSON değil: eski Worker ya da bozuk yanıt */ }
    if (myId !== reqId) return;
    if (res.ok && data && data.success && data.sayac) {
      showReport(data);
      stamp();
    } else if (res.ok) {
      hideReport();
      showMsg("Worker’dan beklenmeyen yanıt geldi. Worker’ı güncelle ya da biraz sonra yeniden dene.", "err");
    } else {
      handleError(res.status, (data && data.message) || "", !!key);
    }
  } catch (e) {
    if (myId !== reqId) return;
    hideReport();
    if (e && e.name === "AbortError") showMsg("Bağlantı zaman aşımına uğradı. Birazdan Yenile’ye bas.", "err");
    else if (location.origin !== PAGE_ORIGIN) showMsg("Bu sayfa " + location.origin + " adresinden açılmış. Worker yalnızca " + PAGE_ORIGIN + " adresinden gelen isteklere cevap verir; sayfayı oradan aç.", "err");
    else showMsg("Worker’a ulaşılamadı. İnternet bağlantını kontrol et.", "err");
  } finally {
    clearTimeout(timer);
    if (myId === reqId) setBusy(false);
  }
}

function handleError(status, msg, hadKey) {
  if (status === 403 && /anahtar/i.test(msg)) {
    if (hadKey) { store.del(KEY_STORE); memKey = ""; }
    openKeyForm(hadKey ? "Şifre yanlış. Tekrar dene." : "Bu sayfa için şifre gerekli.");
    return;
  }
  hideReport();
  if (status === 403) {
    showMsg("Bu adres Worker’da izinli değil. Sayfayı waterslager.github.io üzerinden aç (ALLOWED_ORIGIN).", "err");
    return;
  }
  showMsg(msg ? msg : "Sunucu hatası (" + status + ").", "err");
}

ilSel.addEventListener("change", () => { store.set(IL_STORE, ilSel.value); load(); });
refreshBtn.addEventListener("click", load);
keyBtn.addEventListener("click", () => {
  if (keyForm.hidden) {
    clearKeyBtn.hidden = !getKey();
    keyInput.value = "";
    keyForm.hidden = false;
    keyInput.focus();
  } else {
    keyForm.hidden = true;
  }
});
showKey.addEventListener("change", () => { keyInput.type = showKey.checked ? "text" : "password"; });
clearKeyBtn.addEventListener("click", () => {
  store.del(KEY_STORE); memKey = "";
  clearKeyBtn.hidden = true;
  showMsg("Şifre bu cihazdan silindi.", "info");
});
keyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = keyInput.value.trim();
  if (!v) { showMsg("Şifre boş olamaz.", "err"); return; }
  if (!store.set(KEY_STORE, v)) memKey = v;
  keyInput.value = "";
  load();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !report.hidden && Date.now() - lastLoadAt > AUTO_REFRESH_MS) load();
});

// "Uygulamaya dön": ana uygulamadan geldiysen önceki sayfaya dön (ana ekran durumu korunur, geçmiş şişmez);
// başka yerden açıldıysa (ör. Chrome kısayolu) normal bağlantı olarak ana sayfaya gider.
$("backLink").addEventListener("click", (e) => {
  try {
    if (history.length > 1 && document.referrer) {
      const ref = new URL(document.referrer);
      const dir = (p) => p.replace(/[^/]*$/, "");
      if (ref.origin === location.origin && dir(ref.pathname) === dir(location.pathname)) {
        e.preventDefault();
        history.back();
      }
    }
  } catch (err) { /* normal bağlantı çalışır */ }
});

fillIller();
ilSel.value = pickInitialIl();
load();
