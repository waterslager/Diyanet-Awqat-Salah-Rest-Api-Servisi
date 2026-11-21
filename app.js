/* Kıyâmü'l-Leyl — uygulama betiği (index.html) */
"use strict";

// iPhone'da 16 px'ten küçük yazılı kutuya (dakika kutusu) dokununca sayfa büyüyüp kayıyor; yalnız iOS'ta kapatılır.
// iOS bu ayarda iki parmakla büyütmeye yine izin verir. Android'e dokunulmaz.
if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name="viewport"]').content += ", maximum-scale=1";
}

const STORAGE_KEY = "kiyamul-leyl.location.v1";
const OFFSET_STORAGE_KEY = "kiyamul-leyl.sabahOffset.v1";
const CAMIDE_MODE_KEY = "kiyamul-leyl.camideMode.v1";
let camideMode = "gunes"; // "gunes": güneşten 30 dk önce · "imsak": imsaktan 30 dk sonra
const stateSelect = document.getElementById("stateSelect");
const ilCityDisplay = document.getElementById("ilCityDisplay");
const sourceSelect = document.getElementById("sourceSelect");
const srcDisplay = document.getElementById("srcDisplay");
function updateIlCityDisplay() {
  const opt = stateSelect.options[stateSelect.selectedIndex];
  ilCityDisplay.textContent = (opt && opt.value) ? opt.textContent : "Şehir seçin...";
}
const statusDiv = document.getElementById("statusDiv");
const dkInput = document.getElementById("dkInput");

let state = {
  location: null,
  times: null,
  countdownTimer: null,
  requestId: 0,
  abortController: null,
  timesIlceId: null,
  timesSource: null,
  stale: false,
  dataMode: null,
  dataAt: null
};

let lastRenderedImsakDate = null;
let retryPending = false;
let retryCount = 0;
let cachedNextEvent = null;
let lastScanAt = 0;

const TIME_ELS = ["teheccudTime", "arasiTime", "seherTime", "sabahTime", "camideTime", "imsakMiniTime", "gunesMiniTime"]
  .map((id) => document.getElementById(id));
function setLoading(on) {
  TIME_ELS.forEach((el) => el.classList.toggle("skeleton", on));
  document.querySelectorAll(".dk-rng").forEach((el) => el.classList.toggle("skeleton", on));
  document.querySelectorAll("[data-key]").forEach((el) => el.classList.toggle("skeleton", on));
}

const dataBadge = document.getElementById("dataBadge");
function setDataMode(mode, ts) {
  state.dataMode = mode;
  if (!mode) { dataBadge.classList.add("hidden"); dataBadge.textContent = ""; return; }
  const d = new Date(ts || Date.now());
  if (mode !== "last") state.dataAt = d.getTime();
  const tz = { timeZone: "Europe/Istanbul" };
  const time = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", ...tz });
  const day = d.toLocaleDateString("tr-TR", { day: "numeric", month: "short", ...tz });
  dataBadge.textContent = mode === "live"
    ? "Canlı veri · " + time + " itibarıyla"
    : (mode === "last" ? "Son veri · " : "Kayıtlı veri · ") + day + " " + time + " itibarıyla";
  dataBadge.classList.toggle("cache", mode !== "live");
  dataBadge.classList.remove("hidden");
}

function setStatus(msg, isError) {
  statusDiv.textContent = msg || "";
  statusDiv.classList.toggle("error", !!isError);
  statusDiv.classList.toggle("hidden", !msg);
}

function pad(n) { return n < 10 ? "0" + n : "" + n; }

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { console.warn("[storage] okunamadı:", e); }
  return null;
}

function saveLocation(loc) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(loc)); } catch (e) { console.warn("[storage] yazılamadı:", e); }
}

const API_BASE = "https://ezanvakti.imsakiyem.com/api";
const EMUSHAF_BASE = "https://ezanvakti.emushaf.net";
const DIYANET_PROXY = "https://diyanet-awqat-salah.ertantan-tr.workers.dev";
const ALADHAN_BASE = "https://api.aladhan.com/v1";
const TURKEY_ID = "2";

let source = "diyanet";
const IL_LIST_TIMEOUT_MS = 6000;
const SOURCE_INFO = {
  diyanet:     { note: "Diyanet İşleri Başkanlığı", domain: "awqatsalah.diyanet.gov.tr", freq: "Açılışta Worker'daki son kayıt gösterilir; sayfa yenilenince Diyanet'ten yenilenir." },
  diyanetlive: { note: "Diyanet İşleri Başkanlığı", domain: "awqatsalah.diyanet.gov.tr", freq: "Her açılışta ve yenilemede Diyanet'ten anlık alınır." },
  imsakiyem: { note: "Diyanet İşleri Başkanlığı", domain: "ezanvakti.imsakiyem.com", freq: "Her açılışta otomatik güncellenir." },
  emushaf:   { note: "Diyanet İşleri Başkanlığı", domain: "ezanvakti.emushaf.net", freq: "Her açılışta otomatik güncellenir." },
  aladhan:   { note: "AlAdhan · Diyanet yöntemi", domain: "api.aladhan.com", freq: "Her açılışta otomatik güncellenir." }
};

// NOT: Bu liste worker.js içindeki IL_TR ile aynı olmalı; birini değiştirirseniz diğerini de güncelleyin.
const IL_TR = ["ADANA","ADIYAMAN","AFYONKARAHİSAR","AĞRI","AKSARAY","AMASYA","ANKARA","ANTALYA","ARDAHAN","ARTVİN","AYDIN","BALIKESİR","BARTIN","BATMAN","BAYBURT","BİLECİK","BİNGÖL","BİTLİS","BOLU","BURDUR","BURSA","ÇANAKKALE","ÇANKIRI","ÇORUM","DENİZLİ","DİYARBAKIR","DÜZCE","EDİRNE","ELAZIĞ","ERZİNCAN","ERZURUM","ESKİŞEHİR","GAZİANTEP","GİRESUN","GÜMÜŞHANE","HAKKARİ","HATAY","IĞDIR","ISPARTA","İSTANBUL","İZMİR","KAHRAMANMARAŞ","KARABÜK","KARAMAN","KARS","KASTAMONU","KAYSERİ","KİLİS","KIRIKKALE","KIRKLARELİ","KIRŞEHİR","KOCAELİ","KONYA","KÜTAHYA","MALATYA","MANİSA","MARDİN","MERSİN","MUĞLA","MUŞ","NEVŞEHİR","NİĞDE","ORDU","OSMANİYE","RİZE","SAKARYA","SAMSUN","ŞANLIURFA","SİİRT","SİNOP","ŞIRNAK","SİVAS","TEKİRDAĞ","TOKAT","TRABZON","TUNCELİ","UŞAK","VAN","YALOVA","YOZGAT","ZONGULDAK"];
function trToEn(s) {
  return String(s || "").replace(/[İIıi]/g, "I").replace(/[Şş]/g, "S").replace(/[Ğğ]/g, "G")
    .replace(/[Üü]/g, "U").replace(/[Öö]/g, "O").replace(/[Çç]/g, "C");
}
const STATIC_ILLER = IL_TR.map((ad, i) => ({ id: String(500 + i), ad, en: trToEn(ad) }));
function sameIl(a, b) {
  const n = (x) => trToEn(String(x || "").toLocaleUpperCase("tr").trim());
  return !!a && !!b && n(a) === n(b);
}

const USER_ABORT_NAME = "UserAbortError";
function makeUserAbortError() {
  const err = new Error("İstek kullanıcı tarafından iptal edildi.");
  err.name = USER_ABORT_NAME;
  return err;
}
function isUserAbort(e) { return !!e && e.name === USER_ABORT_NAME; }

async function fetchJSON(url, { timeoutMs = 15000, signal, onHeaders } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const abortError = () => (timedOut ? new Error("Bağlantı zaman aşımına uğradı, tekrar deneyin.") : makeUserAbortError());
  try {
    let res;
    try {
      res = await fetch(url, { cache: "no-store", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", signal: ctl.signal });
    } catch (e) {
      if (e.name === "AbortError") throw abortError();
      throw new Error("Ağ hatası: " + (e.message || e));
    }
    if (!res.ok) {
      let detail = "";
      try { const ej = await res.json(); if (ej && typeof ej.message === "string") detail = ej.message.slice(0, 160); } catch (e) {}
      throw new Error("API hatası: " + res.status + (detail ? " – " + detail : ""));
    }
    if (onHeaders) { try { onHeaders(res.headers); } catch (e) {} }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw ctl.signal.aborted ? abortError() : new Error("Sunucudan geçersiz yanıt geldi.");
    }
    if (json && typeof json === "object" && "data" in json) {
      if (json.success === false) throw new Error(json.message || "API başarısız");
      return json.data;
    }
    return json;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function getIller() {
  const data = await fetchJSON(`${API_BASE}/locations/states?countryId=${TURKEY_ID}`, { timeoutMs: IL_LIST_TIMEOUT_MS });
  if (!Array.isArray(data)) throw new Error("Sunucudan geçersiz yanıt geldi.");
  data.sort((a, b) => (a.name || "").localeCompare(b.name || "", "tr"));
  const normalized = data.map(s => ({ SehirID: s._id, SehirAdi: s.name }));
  return normalized;
}

// İl merkezi: il adıyla aynı ilçe, yoksa adı tam "MERKEZ", yoksa adında "MERKEZ" geçen; hiçbiri yoksa ilk ilçe.
function pickMerkez(list, nameOf, ilAd) {
  const up = (x) => String(x || "").toLocaleUpperCase("tr").trim();
  const aranan = up(ilAd);
  const x = list.find((i) => up(nameOf(i)) === aranan)
    || list.find((i) => up(nameOf(i)) === "MERKEZ")
    || list.find((i) => up(nameOf(i)).includes("MERKEZ"));
  return { item: x || list[0], exact: !!x };
}

async function getIlAdindakiIlce(ilId, ilAd) {
  const data = await fetchJSON(`${API_BASE}/locations/districts?stateId=${encodeURIComponent(ilId)}`);
  if (!Array.isArray(data) || data.length === 0) return null;
  const { item, exact } = pickMerkez(data, (i) => i.name, ilAd);
  return { IlceID: item._id, IlceAdi: item.name, isExactMatch: exact };
}

const ISTANBUL_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Istanbul",
  year: "numeric", month: "2-digit", day: "2-digit"
});
function getIstanbulParts() {
  const parts = ISTANBUL_FMT.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return {
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10)
  };
}

function hm(v) {
  const m = typeof v === "string" ? v.match(/^(\d{1,2}):(\d{2})/) : null;
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? pad(Number(m[1])) + ":" + m[2] : "--:--";
}

function isoDate(d) {
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

async function getVakitlerImsakiyem(ilceId, signal) {
  const p = getIstanbulParts();
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0));
  const start = new Date(today); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(today); end.setUTCDate(end.getUTCDate() + 3);
  const url = `${API_BASE}/prayer-times/${encodeURIComponent(ilceId)}/range?startDate=${isoDate(start)}&endDate=${isoDate(end)}`;
  const data = await fetchJSON(url, { signal });
  return mapDays(data);
}

// "gg.aa.yyyy" veya "yyyy-aa-gg…" → UTC tarihi; geçersizse (31.02, 2000 öncesi vb.) null
function parseDay(raw) {
  let y, m, d;
  let r = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  if (r) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const ok = y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  return ok ? dt : null;
}

function mapDays(data) {
  if (!Array.isArray(data)) throw new Error("Sunucudan geçersiz yanıt geldi.");
  const p = getIstanbulParts();
  const byDate = new Map(); // yinelenen günde sonraki kayıt öncekinin yerini alır
  for (const d of data) {
    if (!d || typeof d !== "object") continue;
    const t = (d.times && typeof d.times === "object") ? d.times : d;
    const pick = (a, b) => hm(t[a] ?? t[b] ?? d[a] ?? d[b] ?? "");
    const raw = d.date || d.MiladiTarihKisaIso8601 || d.MiladiTarihUzunIso8601 || "";
    // Tarih alanı hiç yoksa bugün sayılır; var ama bozuksa kayıt atılır (yanlış güne yazılmasın)
    const date = raw ? parseDay(raw) : new Date(Date.UTC(p.year, p.month - 1, p.day));
    if (!date) continue;
    const day = {
      date,
      imsak:  pick("imsak",  "Imsak"),
      gunes:  pick("gunes",  "Gunes"),
      ogle:   pick("ogle",   "Ogle"),
      ikindi: pick("ikindi", "Ikindi"),
      aksam:  pick("aksam",  "Aksam"),
      yatsi:  pick("yatsi",  "Yatsi"),
      hijri:  d.HicriTarihUzun || (d.hijri_date && d.hijri_date.full_date) || d.hijriDate || ""
    };
    if (["imsak", "gunes", "ogle", "ikindi", "aksam", "yatsi"].every((k) => day[k] === "--:--")) continue;
    byDate.set(date.getTime(), day);
  }
  if (!byDate.size) throw new Error("Sunucudan geçersiz yanıt geldi.");
  return Array.from(byDate.values()).sort((a, b) => a.date - b.date);
}

async function getVakitlerEmushaf(ilceId, signal) {
  const data = await fetchJSON(`${EMUSHAF_BASE}/vakitler/${encodeURIComponent(ilceId)}`, { signal, timeoutMs: 10000 });
  return mapDays(data);
}
async function getIlMerkezEmushaf(ilId, ilAd) {
  const data = await fetchJSON(`${EMUSHAF_BASE}/ilceler/${encodeURIComponent(ilId)}`, { timeoutMs: 10000 });
  if (!Array.isArray(data) || data.length === 0) return null;
  const { item, exact } = pickMerkez(data, (i) => i.IlceAdi, ilAd);
  return { IlceID: String(item.IlceID), IlceAdi: item.IlceAdi, isExactMatch: exact };
}

const HIJRI_TR = ["Muharrem","Safer","Rebiülevvel","Rebiülahir","Cemaziyelevvel","Cemaziyelahir","Recep","Şaban","Ramazan","Şevval","Zilkade","Zilhicce"];
async function getVakitlerAladhan(ilEn, signal) {
  const p = getIstanbulParts();
  const dim = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  const months = [[p.year, p.month]];
  if (p.day <= 1) months.unshift(p.month === 1 ? [p.year - 1, 12] : [p.year, p.month - 1]);
  if (dim - p.day < 3) months.push(p.month === 12 ? [p.year + 1, 1] : [p.year, p.month + 1]);
  const city = encodeURIComponent(String(ilEn || "").toLowerCase().replace(/(^|[ \-])([a-z])/g, (_, a, b) => a + b.toUpperCase()));
  const lists = await Promise.all(months.map(([y, m]) =>
    fetchJSON(`${ALADHAN_BASE}/calendarByCity/${y}/${m}?city=${city}&country=Turkey&method=13`, { signal, timeoutMs: 10000 })));
  const out = [];
  for (const data of lists) {
    if (!Array.isArray(data)) throw new Error("Sunucudan geçersiz yanıt geldi.");
    for (const d of data) {
      const t = d && d.timings ? d.timings : {};
      const g = d && d.date && d.date.gregorian;
      const h = d && d.date && d.date.hijri;
      const gm = g && typeof g.date === "string" ? g.date.match(/^(\d{2})-(\d{2})-(\d{4})$/) : null;
      if (!gm) continue;
      out.push({
        date:   new Date(Date.UTC(Number(gm[3]), Number(gm[2]) - 1, Number(gm[1]))),
        imsak:  hm(t.Fajr),
        gunes:  hm(t.Sunrise),
        ogle:   hm(t.Dhuhr),
        ikindi: hm(t.Asr),
        aksam:  hm(t.Maghrib),
        yatsi:  hm(t.Isha),
        hijri:  (h && h.month && h.day && h.year)
          ? Number(h.day) + " " + (HIJRI_TR[Number(h.month.number) - 1] || h.month.en || "") + " " + h.year : ""
      });
    }
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

let forceLiveNext = false;
try { const nav = performance.getEntriesByType("navigation")[0]; forceLiveNext = !!(nav && nav.type === "reload"); } catch (e) {}

let proxyMeta = null;
async function getVakitlerProxy(loc, signal, live) {
  const url = DIYANET_PROXY + "/?stateId=" + encodeURIComponent(loc.ilId) +
    "&il=" + encodeURIComponent(loc.ilAd || "") + (live ? "&nocache=1" : "");
  proxyMeta = null;
  const data = await fetchJSON(url, {
    signal, timeoutMs: 25000,
    onHeaders: (h) => { proxyMeta = { src: h.get("X-Source") || "", at: Number(h.get("X-Cached-At")) || 0, city: h.get("X-City") || "", err: (() => { try { return decodeURIComponent(h.get("X-Error") || ""); } catch (e) { return ""; } })() }; }
  });
  return mapDays(data);
}

function getVakitler(src, loc, signal, forceLive) {
  if (src === "diyanet" || src === "diyanetlive") return getVakitlerProxy(loc, signal, src === "diyanetlive" || !!forceLive);
  if (src === "emushaf") return getVakitlerEmushaf(loc.ilceId, signal);
  if (src === "aladhan") return getVakitlerAladhan(loc.ilEn, signal);
  return getVakitlerImsakiyem(loc.ilceId, signal);
}

function toTitle(s) {
  if (!s) return s;
  return s.toLocaleLowerCase("tr").replace(/(^|[ \-'])([a-zçğıöşüâî])/gu, (_, p1, p2) => p1 + p2.toLocaleUpperCase("tr"));
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function makeOption(value, label, dataAd, opts) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  if (dataAd !== undefined) o.dataset.ad = dataAd;
  if (opts) {
    if (opts.disabled) o.disabled = true;
    if (opts.selected) o.selected = true;
  }
  return o;
}

async function populateIller() {
  clearChildren(stateSelect);
  const mySrc = source;
  if (mySrc !== "imsakiyem") {
    stateSelect.appendChild(makeOption("", "Şehir seçin...", undefined, { selected: true }));
    for (const il of STATIC_ILLER) stateSelect.appendChild(makeOption(il.id, toTitle(il.ad), il.ad));
    stateSelect.disabled = false;
    return true;
  }
  try {
    const iller = await getIller();
    if (mySrc !== source) return true;
    stateSelect.appendChild(makeOption("", "Şehir seçin...", undefined, { selected: true }));
    for (const il of iller) {
      stateSelect.appendChild(makeOption(il.SehirID, toTitle(il.SehirAdi), il.SehirAdi));
    }
    stateSelect.disabled = false;
    return true;
  } catch (e) {
    if (mySrc !== source) return true;
    stateSelect.appendChild(makeOption("", "Yüklenemedi", undefined, { disabled: true, selected: true }));
    if (!state.location) setStatus("İl listesi alınamadı: " + (e.message || "Bağlantı hatası"), true);
    return false;
  }
}

const TR_UTC_OFFSET_HOURS = 3;
function parseTime(hhmm, baseDate) {
  if (typeof hhmm !== "string" || !/^\d{1,2}:\d{2}$/.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), h - TR_UTC_OFFSET_HOURS, m, 0, 0));
}

const TR_MONTHS = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
const TR_DAYS   = ["Pazar","Pazartesi","Salı","Çarşamba","Perşembe","Cuma","Cumartesi"];
function formatDate(d) { return `${d.getUTCDate()} ${TR_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${TR_DAYS[d.getUTCDay()]}`; }

const SABAH_OFFSET_MIN = 1;
let offsetDayMax = null;
function getOffsetMax() { return offsetDayMax || Infinity; }
function applyOffsetLimit(period) {
  const day = period && period.imsakDay;
  const imsak = day ? parseTime(day.imsak, day.date) : null;
  const gunes = day ? parseTime(day.gunes, day.date) : null;
  const diff = (imsak && gunes) ? Math.floor((gunes.getTime() - imsak.getTime()) / 60000) : 0;
  offsetDayMax = diff >= SABAH_OFFSET_MIN ? diff : null;
  if (offsetDayMax) {
    dkInput.max = String(offsetDayMax);
    dkInput.title = "Bugün için en fazla " + offsetDayMax + " dk (imsak vaktine kadar)";
  } else {
    dkInput.removeAttribute("max");
    dkInput.removeAttribute("title");
  }
  if (offsetDayMax && document.activeElement !== dkInput) {
    const v = parseInt(dkInput.value, 10);
    if (!isNaN(v) && v > offsetDayMax) {
      dkInput.value = String(offsetDayMax);
      try { localStorage.setItem(OFFSET_STORAGE_KEY, dkInput.value); } catch (e) { console.warn("[storage] yazılamadı:", e); }
    }
  }
}
function showOffsetLimitNote() {
  if (!offsetDayMax) return;
  if (statusDiv.textContent.trim()) return;
  const msg = "Bugün için en fazla " + offsetDayMax + " dk girilebilir (imsak vaktine kadar).";
  setStatus(msg, false);
  setTimeout(() => { if (statusDiv.textContent === msg) setStatus(""); }, 4000);
}
function getSabahOffset() {
  const v = parseInt(dkInput.value, 10);
  if (isNaN(v) || v <= 0) return null;
  return Math.min(Math.max(v, SABAH_OFFSET_MIN), getOffsetMax());
}
function clampOffsetInput(el, final) {
  const v = parseInt(el.value, 10);
  if (isNaN(v)) return false;
  let c = v;
  if (v > getOffsetMax()) c = getOffsetMax();
  else if (final && v < SABAH_OFFSET_MIN) c = SABAH_OFFSET_MIN;
  if (c === v) return false;
  el.value = c;
  return true;
}

function todayIndex(list) {
  const p = getIstanbulParts();
  return list.findIndex((t) =>
    t.date.getUTCFullYear() === p.year && t.date.getUTCMonth() === p.month - 1 && t.date.getUTCDate() === p.day);
}

function findActivePeriod(timesList) {
  const todayIdx = todayIndex(timesList);
  if (todayIdx < 0) return null;

  const todayData = timesList[todayIdx];
  const todayGunes = parseTime(todayData.gunes, todayData.date);
  const now = new Date();

  if (todayGunes && now < todayGunes) {
    if (todayIdx > 0) return { aksamDay: timesList[todayIdx - 1], imsakDay: todayData };
    return null;
  }
  const next = timesList[todayIdx + 1];
  if (next) return { aksamDay: todayData, imsakDay: next };
  return { aksamDay: timesList[todayIdx - 1] || todayData, imsakDay: todayData };
}

function ceilMin(d) { if(!d) return d; const s=d.getUTCSeconds(); return s===0 ? d : new Date(d.getTime()+(60-s)*1000); }
const TR_TIME_FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23" });
function fmt(d) {
  if (!d) return "--:--";
  const c = ceilMin(d);
  const parts = TR_TIME_FMT.formatToParts(c);
  const hh = parts.find(p => p.type === "hour").value;
  const mm = parts.find(p => p.type === "minute").value;
  return hh + ":" + mm;
}

function calcDerived(period) {
  if (!period || !period.aksamDay || !period.imsakDay) return null;
  const aksam = parseTime(period.aksamDay.aksam, period.aksamDay.date);
  const imsak = parseTime(period.imsakDay.imsak, period.imsakDay.date);
  const gunes = parseTime(period.imsakDay.gunes, period.imsakDay.date);
  if (!aksam || !imsak || !gunes) return null;
  const nightMs = imsak - aksam;
  if (!Number.isFinite(nightMs) || nightMs <= 0) return null;
  const seher    = new Date(imsak.getTime() - Math.floor(nightMs / 6));
  const teheccud = new Date(imsak.getTime() - Math.floor(nightMs / 3));
  const sabahOnce = getSabahOffset();
  const sabahRaw = sabahOnce ? new Date(gunes.getTime() - sabahOnce * 60 * 1000) : imsak;
  const sabah    = sabahRaw < imsak ? imsak : sabahRaw;
  const cami     = camideMode === "imsak" ? new Date(imsak.getTime() + 30 * 60 * 1000) : new Date(gunes.getTime() - 30 * 60 * 1000);
  return { teheccud, seher, sabah, cami, imsak, aksam, gunes };
}

async function loadAndRender(forceLive) {
  if (!state.location) { setStatus("Lütfen il seçin."); return; }
  if (!state.location.ilceId) {
    setStatus("Vakit verisi hazırlanıyor…"); return;
  }
  const myRequestId = ++state.requestId;
  const mySource = source;
  const myLoc = state.location;
  const live = !!forceLive || forceLiveNext;
  forceLiveNext = false;

  if (state.abortController) state.abortController.abort();
  state.abortController = new AbortController();
  const myAbortController = state.abortController;

  const haveShown = !!(state.times && state.timesIlceId === myLoc.ilceId && state.timesSource === mySource);
  if (!haveShown) setLoading(true);
  setStatus(haveShown ? "Güncel vakitler alınıyor…" : "Vakitler çekiliyor…");

  try {
    const times = await getVakitler(mySource, myLoc, myAbortController.signal, live);

    if (myRequestId !== state.requestId) return;

    state.times = times;
    state.timesIlceId = myLoc.ilceId;
    state.timesSource = mySource;
    state.stale = false;
    const period = findActivePeriod(times);
    if (!period) throw new Error("Bugün için veri bulunamadı.");

    const ok = render(period);
    if (ok) {
      setStatus("");
      startCountdown();
      const pm = (mySource === "diyanet" || mySource === "diyanetlive") ? proxyMeta : null;
      if (pm && pm.src && pm.src !== "live" && pm.at) {
        setDataMode("cache", pm.at);
        if (pm.src === "stale" || pm.src === "limit") {
          setStatus((pm.src === "limit"
            ? "Günlük canlı veri sınırına ulaşıldı: Worker'daki son kayıt gösteriliyor."
            : "Diyanet'ten taze veri alınamadı: Worker'daki son kayıt gösteriliyor.") +
            (pm.err ? " (" + pm.err + ")" : ""), true);
        }
      } else {
        setDataMode("live", pm && pm.at ? pm.at : Date.now());
      }
      updateLocationLine();
    } else {
      // Vakit verisi eksik geldi: yarım veriyle sayaçsız kalmasın, bir sonraki açılışta yeniden çekilsin
      resetTimes();
      highlightCurrentVakit(null);
    }
  } catch (e) {
    if (myRequestId !== state.requestId) return;
    if (isUserAbort(e)) { setLoading(false); return; }
    console.error(e);

    const msg = String((e && e.message) || e);
    const isTransient = /Ağ hatası|zaman aşımı|Failed to fetch|API hatası: (?:5\d\d|429|408)|geçersiz yanıt/i.test(msg);

    // Ekrandaki vakitler aynı il ve kaynağa aitse geçerlidir: geri sayım durmadan devam eder
    // (önceden yalnız "Kayıtlı veri"de devam ediyordu; internet gidince "Kalan Süre" donuyordu).
    const keepTimes = !!state.times && state.timesIlceId === myLoc.ilceId && state.timesSource === mySource;
    if (!keepTimes) {
      resetTimes();
      highlightCurrentVakit(null);
    }

    if (state.times && state.dataMode === "live") setDataMode("last", state.dataAt);

    if (isTransient) {
      setStatus(
        "Vakitler alınamadı." + (state.times ? " Ekrandaki vakitler son çekilen verilerdir." : "") +
        " İnternet bağlantınızı kontrol edin; " +
        "bazı işyeri/kurumsal ağlar bu veri kaynağına erişimi engelleyebilir. " +
        "Yukarıdan farklı bir veri kaynağı seçebilirsiniz." +
        (msg.includes(" – ") ? " (" + msg.split(" – ")[1] + ")" : ""),
        true
      );
    } else {
      setStatus("Vakitler alınamadı: " + msg, true);
    }
    if (keepTimes && isTransient) scheduleReload();
    setLoading(false);
  }
}

function resetTimes() {
  state.times = null; state.timesIlceId = null; state.timesSource = null;
  stopCountdown();
  clearDisplay();
  setLoading(false);
}

function clearDisplay() {
  TIME_ELS.forEach((el) => { el.textContent = "--:--"; });
  document.querySelectorAll("#prayerGrid .p-time").forEach((el) => { el.textContent = "--:--"; });
  const setT = (id, t) => { document.getElementById(id).textContent = t; };
  setT("gregDate", "-"); setT("hijriDate", ""); setT("prayerDate", "-"); setT("prayerHijriDate", "");
  setT("nextName", "—"); setT("nextTime", "--:--"); setT("nextRaw", ""); setT("nextRemain", "--:--:--");
  lastGridDateKey = null;
  refreshDuhaKerahat();
  cachedNextEvent = null;
  setDataMode(null);
  updateLocationLine();
}

function render(period) {
  applyOffsetLimit(period);
  setLoading(false);
  lastRenderedImsakDate = period.imsakDay.date.getTime();
  const { imsakDay } = period;

  document.getElementById("gregDate").textContent = formatDate(imsakDay.date);
  document.getElementById("hijriDate").textContent = imsakDay.hijri ? "Hicrî: " + imsakDay.hijri : "";

  refreshVakitList(true);
  refreshDuhaKerahat();

  const d = calcDerived(period);
  if (d) {
    document.getElementById("teheccudTime").textContent = fmt(d.teheccud);
    const arasiMs = d.teheccud.getTime() + (d.seher.getTime() - d.teheccud.getTime()) / 2;
    document.getElementById("arasiTime").textContent = fmt(new Date(arasiMs));
    document.getElementById("seherTime").textContent = fmt(d.seher);
    document.getElementById("sabahTime").textContent = fmt(d.sabah);
    document.getElementById("camideTime").textContent = fmt(d.cami);
    document.getElementById("imsakMiniTime").textContent = fmt(d.imsak);
    document.getElementById("gunesMiniTime").textContent = fmt(d.gunes);
  } else {
    TIME_ELS.forEach((el) => { el.textContent = "--:--"; });
    setStatus("Vakit verisi eksik geldi, sayfayı yenileyin.", true);
    return false;
  }

  return true;
}

function stopCountdown() {
  if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
}

function startCountdown() {
  stopCountdown();
  cachedNextEvent = null;
  lastScanAt = 0;
  tickCountdown();
  state.countdownTimer = setInterval(tickCountdown, 1000);
}

const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60000;

function scheduleReload() {
  if (retryPending) return;
  retryPending = true;
  const delay = Math.min(RETRY_BASE_MS * Math.pow(2, retryCount), RETRY_MAX_MS);
  retryCount++;
  setTimeout(() => { retryPending = false; loadAndRender(); }, delay);
}

function findNext(events) {
  const now = new Date();
  for (const e of events) if (e.time > now) return e;
  return null;
}

function getEvents() {
  if (!state.times || !state.times.length) return [];
  const todayIdx = todayIndex(state.times);
  if (todayIdx < 0) return [];
  const today = state.times[todayIdx];
  const list = [
    { key: "sabah",  name: "Sabah Namazı", time: parseTime(today.imsak,   today.date) },
    { key: "ogle",   name: "Öğle",         time: parseTime(today.ogle,    today.date) },
    { key: "ikindi", name: "İkindi",       time: parseTime(today.ikindi,  today.date) },
    { key: "aksam",  name: "Akşam",        time: parseTime(today.aksam,   today.date) },
    { key: "yatsi",  name: "Yatsı",        time: parseTime(today.yatsi,   today.date) }
  ];
  const tomorrow = state.times[todayIdx + 1];
  if (tomorrow) {
    list.push({ key: "sabah", name: "Sabah Namazı", time: parseTime(tomorrow.imsak, tomorrow.date) });
  }
  return list.filter((e) => e.time instanceof Date);
}

function formatRemain(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  return pad(hh) + ":" + pad(mm) + ":" + pad(ss);
}

const GRID_KEYS = ["imsak", "gunes", "ogle", "ikindi", "aksam", "yatsi"];
let lastHighlightKey = null;
let lastGridDateKey = null;

function getTodayData() {
  if (!state.times || !state.times.length) return null;
  return state.times[todayIndex(state.times)] || null;
}
function getActiveVakitInfo() {
  const today = getTodayData();
  if (!today) return null;
  const nowMs = Date.now();
  const todayImsak = parseTime(today.imsak, today.date);
  if (todayImsak && nowMs < todayImsak.getTime()) return { day: today, key: null };
  let current = null;
  for (const key of GRID_KEYS) {
    const t = parseTime(today[key], today.date);
    if (t && t.getTime() <= nowMs) current = key;
  }
  return { day: today, key: current };
}
function highlightCurrentVakit(info) {
  const key = info ? info.key : null;
  if (key === lastHighlightKey) return;
  lastHighlightKey = key;
  document.querySelectorAll("#prayerGrid .p-time").forEach((el) => {
    if (el.parentElement) el.parentElement.classList.toggle("is-current", el.dataset.key === key);
  });
}
function refreshVakitList(force) {
  const info = getActiveVakitInfo();
  if (!info) { highlightCurrentVakit(null); return; }
  const day = info.day;
  const dateKey = day.date.getTime();
  if (force || dateKey !== lastGridDateKey) {
    lastGridDateKey = dateKey;
    document.querySelectorAll("#prayerGrid .p-time").forEach((el) => {
      el.textContent = day[el.dataset.key] || "--:--";
    });
    document.getElementById("prayerDate").textContent = formatDate(day.date);
    document.getElementById("prayerHijriDate").textContent = day.hijri ? "Hicrî: " + day.hijri : "";
  }
  highlightCurrentVakit(info);
}

/* Duha ve kerahat kartları (s/e: vaktin başı/sonu, u: bu andan sonra yarın gösterilir (varsayılan akşam),
   show: görünen saat(ler), k: kerahat → vakit sürerken kırmızı ve ⛔; Duha'da tersi: vakit dışında sarı, vakit içinde yeşil) */
const DK_LIST = [
  { id: "dkDuha",   s: "duha",    e: "duhaEnd",  u: "duhaEnd", show: ["duha", "duhaEnd"] },
  { id: "dkSabah",  s: "gunes",   e: "sabahEnd", show: ["sabahEnd"], k: 1 },
  { id: "dkOgle",   s: "ogleK",   e: "ogle",     show: ["ogleK"],    k: 1 },
  { id: "dkIkindi", s: "ikindiK", e: "aksam",    show: ["ikindiK"],  k: 1 }
];

/* Duha başlangıcı = imsak + (akşam − imsak)/4; artık saniyeler dakikaya ileri yuvarlanır (8:19:15 → 8:20)
   Sabah/ikindi kerahatı takvim saatinden 52 dk. (7 dk. temkin dahil; gerçek doğuş/batıştan en az 45 dk.), öğle kerahatı 20 dk. */
function dkDay(d) {
  const t = (k) => { const x = parseTime(d[k], d.date); return x && x.getTime(); };
  const imsak = t("imsak"), gunes = t("gunes"), ogle = t("ogle"), aksam = t("aksam");
  if (!imsak || !gunes || !ogle || !aksam) return null;
  const ogleK = ogle - 20 * 60000;
  return {
    duha: ceilMin(new Date(imsak + (aksam - imsak) / 4)).getTime(), duhaEnd: ogleK,
    gunes, sabahEnd: gunes + 52 * 60000, ogleK, ogle, ikindiK: aksam - 52 * 60000, aksam
  };
}

function refreshDuhaKerahat() {
  const today = getTodayData();
  const next = today && state.times.find((x) => x.date.getTime() === today.date.getTime() + 864e5);
  const T0 = today && dkDay(today), T1 = (next && dkDay(next)) || T0;
  const now = Date.now();
  for (const c of DK_LIST) {
    const el = document.getElementById(c.id), rng = el.querySelector(".dk-rng"), cd = el.querySelector(".dk-cd");
    const day = T0 && (now >= T0[c.u || "aksam"] ? T1 : T0);
    const on = !!day && now >= day[c.s] && now < day[c.e];
    el.classList.toggle("red", !!day && !!c.k === on);
    if (c.k) el.querySelector(".dk-no").hidden = !on;
    rng.textContent = day ? c.show.map((k) => fmt(new Date(day[k]))).join(" – ") : "--:--";
    if (cd) {
      cd.hidden = !on;
      if (on) cd.querySelector("b").textContent = formatRemain(day[c.e] - now);
    }
  }
}

const TEMKIN_MIN = { ogle: 5, ikindi: 4, aksam: 7 };

const nameEl = document.getElementById("nextName");
const timeEl = document.getElementById("nextTime");
const rawEl = document.getElementById("nextRaw");
const remainEl = document.getElementById("nextRemain");
function updateNextBar(next) {
  nameEl.textContent = (next.key === "sabah" ? "Sabah" : next.name) + " Vakti";
  timeEl.textContent = fmt(next.time);
  const temkin = source === "aladhan" ? 0 : TEMKIN_MIN[next.key];
  rawEl.textContent = temkin ? "/" + fmt(new Date(next.time.getTime() - temkin * 60000)) : "";
  remainEl.textContent = formatRemain(next.time.getTime() - Date.now());
  refreshVakitList();
  refreshDuhaKerahat();
}

function tickCountdown() {
  if (!state.times) return;
  const now = Date.now();
  const needsScan = !cachedNextEvent
    || now >= cachedNextEvent.time.getTime()
    || (now - lastScanAt) >= 60000;

  if (needsScan) {
    lastScanAt = now;
    const period = findActivePeriod(state.times);
    if (!period) {
      scheduleReload();
      return;
    }

    if (lastRenderedImsakDate !== period.imsakDay.date.getTime()) {
      lastRenderedImsakDate = period.imsakDay.date.getTime();
      render(period);
    }

    const events = getEvents();
    cachedNextEvent = findNext(events);

    if (!cachedNextEvent) {
      scheduleReload();
      return;
    }
    retryCount = 0; // geri sayım gerçekten sürdürülebiliyor: bekleme süresi sıfırlanır
  }

  updateNextBar(cachedNextEvent);
}

function onOffsetChange() {
  if (clampOffsetInput(dkInput)) showOffsetLimitNote();
  try { localStorage.setItem(OFFSET_STORAGE_KEY, dkInput.value); } catch (e) { console.warn("[storage] yazılamadı:", e); }
  if (state.times) {
    const period = findActivePeriod(state.times);
    if (period) render(period);
  }
}

function setCamideMode(mode, save) {
  camideMode = mode === "imsak" ? "imsak" : "gunes";
  document.querySelector(".sabah-camide-card").classList.toggle("camide-imsak", camideMode === "imsak");
  document.querySelectorAll(".camide-opt").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === camideMode)));
  if (save) {
    try { localStorage.setItem(CAMIDE_MODE_KEY, camideMode); } catch (e) { console.warn("[storage] yazılamadı:", e); }
    const period = state.times && findActivePeriod(state.times);
    if (period) render(period);
  }
}

async function init() {
  try { setCamideMode(localStorage.getItem(CAMIDE_MODE_KEY)); } catch (e) { console.warn("[storage] okunamadı:", e); }
  document.querySelectorAll(".camide-opt").forEach((b) => b.addEventListener("click", () => setCamideMode(b.dataset.mode, true)));
  stateSelect.addEventListener("change", updateIlCityDisplay);
  stateSelect.addEventListener("change", onIlChange);

  try {
    const savedOffset = localStorage.getItem(OFFSET_STORAGE_KEY);
    if (savedOffset !== null) {
      dkInput.value = savedOffset;
      if (clampOffsetInput(dkInput, true)) {
        try { localStorage.setItem(OFFSET_STORAGE_KEY, dkInput.value); } catch (e) { console.warn("[storage] yazılamadı:", e); }
      }
    }
  } catch (e) { console.warn("[storage] okunamadı:", e); }

  dkInput.addEventListener("input", onOffsetChange);
  dkInput.addEventListener("change", () => {
    if (clampOffsetInput(dkInput, true)) dkInput.dispatchEvent(new Event("input"));
  });

  sourceSelect.addEventListener("change", () => activateSource(sourceSelect.value));
  const s0 = readSession(SESSION_SRC_KEY);
  await activateSource(SOURCE_INFO[s0] ? s0 : "diyanet", true);
}

function updateLocationLine() {
  const el = document.getElementById("srcLoc");
  let text = "";
  const loc = state.location;
  if (loc && state.times && state.timesSource === source) {
    const il = toTitle(loc.ilAd || "");
    if (source === "diyanet" || source === "diyanetlive") {
      const m = proxyMeta && proxyMeta.city ? /^(\d+)\s+(.+?)\s+\((\w+)\)$/.exec(proxyMeta.city) : null;
      if (m) {
        const id = m[1], name = m[2], kind = m[3];
        text = (kind === "exact" || kind === "merkez")
          ? il + " (Merkez · " + id + ")"
          : il + " (" + toTitle(name) + " · " + id + ") – merkez ilçe bulunamadı";
      }
    } else if (source === "imsakiyem" && loc.ilceAd) {
      text = il + (sameIl(loc.ilceAd, loc.ilAd) ? " (Merkez)" : " (" + toTitle(loc.ilceAd) + ")");
    }
  }
  el.textContent = text ? "Konum: " + text : "";
  el.classList.toggle("hidden", !text);
}

function updateSourceUI() {
  const info = SOURCE_INFO[source];
  sourceSelect.value = source;
  srcDisplay.textContent = sourceSelect.options[sourceSelect.selectedIndex].textContent;
  srcDisplay.classList.toggle("small", srcDisplay.textContent.length > 36);
  document.getElementById("srcNote").textContent = info.note;
  document.getElementById("srcDomain").textContent = info.domain;
  document.getElementById("srcFreq").textContent = info.freq;
  // Kota bağlantısı yalnızca Diyanet kaynaklarında görünür (kota.html aynı klasörde, uygulama içinde açılır)
  document.getElementById("kotaLink").classList.toggle("hidden", !(source === "diyanet" || source === "diyanetlive"));
}

let sourceToken = 0;
const SESSION_SRC_KEY = "kiyamul-leyl.session.source";
const SESSION_IL_KEY = "kiyamul-leyl.session.il";
const IL_PREF_KEY = "kiyamul-leyl.ilpref.v1";
let lastIlAd = null;
function rememberIl(ilAd) {
  if (!ilAd) return;
  lastIlAd = ilAd;
  try { sessionStorage.setItem(SESSION_IL_KEY, ilAd); } catch (e) {}
  try { localStorage.setItem(IL_PREF_KEY, ilAd); } catch (e) {}
}
function readSession(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
async function activateSource(newSrc, initial) {
  const myToken = ++sourceToken;
  if (initial && !lastIlAd) lastIlAd = readSession(SESSION_IL_KEY);
  if (initial && !lastIlAd) { try { lastIlAd = localStorage.getItem(IL_PREF_KEY); } catch (e) {} }
  if (initial && !lastIlAd) { const sv = loadSaved(); if (sv && sv.ilAd) lastIlAd = sv.ilAd; }
  const prevIlAd = (state.location && state.location.ilAd) || lastIlAd;
  try { sessionStorage.setItem(SESSION_SRC_KEY, newSrc); } catch (e) {}
  source = newSrc;
  updateSourceUI();

  state.requestId++;
  if (state.abortController) { state.abortController.abort(); state.abortController = null; }
  ilChangeToken++;
  if (!initial) {
    state.location = null;
    resetTimes();
    setStatus("");
  }

  const listPromise = populateIller();
  updateIlCityDisplay();

  let loc = null;
  if (newSrc === "imsakiyem") {
    const saved = loadSaved();
    const savedOk = !!(saved && saved.ilId && saved.ilceId);
    if (savedOk && (!prevIlAd || sameIl(prevIlAd, saved.ilAd))) {
      loc = saved;
    } else if (prevIlAd) {
      const ok = await listPromise;
      if (myToken !== sourceToken) return;
      const opt = ok ? Array.from(stateSelect.options).find((o) => o.value && sameIl(o.dataset.ad, prevIlAd)) : null;
      if (opt) { stateSelect.value = opt.value; updateIlCityDisplay(); await selectIl(opt.value, opt.dataset.ad); return; }
      loc = savedOk ? saved : null;
    } else if (savedOk) {
      loc = saved;
    }
  } else if (prevIlAd) {
    const il = STATIC_ILLER.find((x) => sameIl(x.ad, prevIlAd));
    if (il) { stateSelect.value = il.id; updateIlCityDisplay(); await selectIl(il.id, il.ad); return; }
  }

  if (!loc) {
    state.location = null;
    updateIlCityDisplay();
    setStatus(initial ? "İl seçerek başlayın. Bu seçim hatırlanacaktır." : "Bu kaynak için il seçin.");
    listPromise.then((ok) => { if (myToken === sourceToken) illerLoaded = ok; });
    return;
  }

  state.location = loc;
  rememberIl(loc.ilAd);
  if (loc.ilAd) ilCityDisplay.textContent = toTitle(loc.ilAd);
  listPromise.then((ok) => {
    if (myToken !== sourceToken) return;
    illerLoaded = ok;
    if (!ok || !state.location) return;
    stateSelect.value = state.location.ilId;
    if (stateSelect.value !== state.location.ilId) {
      state.requestId++;
      if (state.abortController) { state.abortController.abort(); state.abortController = null; }
      state.location = null;
      resetTimes();
      updateIlCityDisplay();
      setStatus("Kayıtlı şehriniz artık bulunamadı, lütfen tekrar seçin.", true);
      return;
    }
    updateIlCityDisplay();
  });
  await loadAndRender();
}

let ilChangeToken = 0;
function onIlChange(e) {
  const sel = e.target;
  const ilId = sel.value;
  if (!ilId) return;
  selectIl(ilId, sel.options[sel.selectedIndex].dataset.ad);
}

async function selectIl(ilId, ilAd) {
  const myToken = ++ilChangeToken;
  const mySource = source;
  rememberIl(ilAd);

  setStatus("Vakit verisi alınıyor…");

  try {
    let loc;
    let exact = true;
    if (mySource === "aladhan" || mySource === "diyanet" || mySource === "diyanetlive") {
      const il = STATIC_ILLER.find((x) => x.id === String(ilId));
      loc = { ilId: String(ilId), ilAd, ilceId: String(ilId), ilceAd: "", ilEn: il ? il.en : trToEn(ilAd) };
    } else {
      const ilce = mySource === "emushaf" ? await getIlMerkezEmushaf(ilId, ilAd) : await getIlAdindakiIlce(ilId, ilAd);
      if (myToken !== ilChangeToken || mySource !== source) return;
      if (!ilce) {
        state.location = null;
        resetTimes();
        setStatus("Bu il için veri bulunamadı.", true);
        return;
      }
      exact = ilce.isExactMatch;
      loc = { ilId, ilAd, ilceId: ilce.IlceID, ilceAd: ilce.IlceAdi };
    }
    if (myToken !== ilChangeToken || mySource !== source) return;
    state.location = loc;
    if (mySource === "imsakiyem") saveLocation(loc);
    retryCount = 0;
    await loadAndRender();
    if (myToken === ilChangeToken && exact === false) {
      setStatus(
        `"${toTitle(ilAd)}" için merkez ilçe otomatik seçilemedi, "${loc.ilceAd}" ilçesinin vakitleri gösteriliyor. ` +
        "Farklı bir ilçe istiyorsanız il listesinden tekrar seçim yapın.",
        false
      );
    }
  } catch (err) {
    if (myToken !== ilChangeToken) return;
    if (state.location && state.location.ilId) stateSelect.value = state.location.ilId;
    else stateSelect.value = "";
    updateIlCityDisplay();
    setStatus("Vakit verisi alınamadı: " + (err.message || err), true);
  }
}

let lastResumeAt = 0;
let illerLoaded = true;
async function retryIllerIfNeeded() {
  if (illerLoaded) return;
  illerLoaded = true;
  const ok = await populateIller();
  illerLoaded = ok;
  if (!ok) return;
  if (state.location && state.location.ilId) stateSelect.value = state.location.ilId;
  updateIlCityDisplay();
  if (statusDiv.textContent.startsWith("İl listesi alınamadı")) setStatus("");
}
function resumeRefresh() {
  if (!illerLoaded) retryIllerIfNeeded();
  if (!state.location || !state.location.ilceId) return;
  const nowMs = Date.now();
  if (nowMs - lastResumeAt < 2000) return;
  lastResumeAt = nowMs;
  const period = state.times ? findActivePeriod(state.times) : null;
  if (!period || (state.stale && navigator.onLine !== false)) {
    retryCount = 0;
    loadAndRender();
    return;
  }
  if (render(period)) startCountdown();
}
function onVisible() {
  resumeRefresh();
  if (state.times && !state.countdownTimer) startCountdown();
}
// Sayfa görünmezken saniyelik sayaç boşuna çalışmasın; görününce yeniden başlar.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") onVisible();
  else stopCountdown();
});
window.addEventListener("online", resumeRefresh);
window.addEventListener("offline", () => {
  if (!state.times) return;
  state.stale = true;
  if (state.dataMode === "live") setDataMode("last", state.dataAt);
  setStatus("Çevrimdışı: ekrandaki vakitler son çekilen verilerdir. Bağlantı gelince yenilenir.", false);
});
window.addEventListener("pageshow", (e) => { if (e.persisted) onVisible(); });

(function () {
  let startY = null, maxPull = 0, lastRefreshAt = 0;
  const atTop = () => (window.scrollY || (document.scrollingElement && document.scrollingElement.scrollTop) || 0) <= 0;
  window.addEventListener("touchstart", (e) => {
    startY = (e.touches.length === 1 && atTop()) ? e.touches[0].clientY : null;
    maxPull = 0;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (startY === null || !e.touches.length) return;
    if (!atTop()) { startY = null; return; }
    maxPull = Math.max(maxPull, e.touches[0].clientY - startY);
  }, { passive: true });
  window.addEventListener("touchend", () => {
    const pulled = startY !== null && maxPull >= 90;
    startY = null; maxPull = 0;
    if (!pulled || !state.location || !state.location.ilceId) return;
    const now = Date.now();
    if (now - lastRefreshAt < 1500) return;
    lastRefreshAt = now;
    retryCount = 0;
    loadAndRender(true);
  }, { passive: true });
})();

init();

if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) location.reload(); });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .catch((err) => console.warn("[SW] Kayıt başarısız:", err));
}

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

(function () {
  function fitTitle() {
    const h = document.querySelector('header h1');
    h.style.fontSize = '';
    let fs = parseFloat(getComputedStyle(h).fontSize);
    while (h.scrollWidth > h.clientWidth && fs > 10) {
      fs -= 0.5;
      h.style.fontSize = fs + 'px';
    }
  }
  fitTitle();
  window.addEventListener('resize', fitTitle);
  window.addEventListener('load', fitTitle);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTitle);
})();
