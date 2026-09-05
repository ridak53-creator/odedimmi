/* ============================================================
   Ödedim mi — ortak ödeme takibi (sunucusuz web uygulaması)

   Veri     : gizli bir GitHub Gist. Her cihaz kendi dosyasını yazar
              (device-<id>.json), okurken hepsi birleştirilir.
   Bildirim : Gist'e yazılan takvim.ics dosyasına iOS Takvim'den
              abone olunur; uyarıları iOS'un kendisi verir.
   Kurlar   : tarayıcıdan CORS ile erişilebilen anahtarsız kaynaklar.
   ============================================================ */

'use strict';

/* ---------------------------------------------------------
   0. Küçük yardımcılar
   --------------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');

const TR = 'tr-TR';

// Çerçeveye alınmaya karşı koruma. CSP'nin frame-ancestors direktifi <meta>
// etiketinde çalışmıyor (yalnızca HTTP başlığıyla verilebiliyor), GitHub Pages'te
// de başlık ayarlayamıyoruz. Bu yüzden kontrolü kodda yapıyoruz: sayfa bir
// iframe içine alınmışsa kendini üst pencereye taşır.
if (typeof window !== 'undefined' && window.top && window.top !== window.self) {
  try { window.top.location = window.self.location; } catch { document.body.innerHTML = ''; }
}
const TZ = 'Europe/Istanbul';

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- tarih ---
const todayISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
const dISO = (d) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
const parseISO = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return dISO(d); };
const addMonths = (iso, n) => {
  const d = parseISO(iso), day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return dISO(d);
};
const monthKey = (iso) => String(iso).slice(0, 7);          // YYYY-MM
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

const fmtMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(TR, { month: 'long', year: 'numeric' });
};
const fmtShortMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(TR, { month: 'short' });
};
const fmtDay = (iso) => parseISO(iso).toLocaleDateString(TR, { day: 'numeric', month: 'short' });
const fmtFull = (iso) => parseISO(iso).toLocaleDateString(TR, { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
const fmtStamp = (d) => new Date(d).toLocaleString(TR, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// --- para ---
const CURRENCIES = {
  TRY: { sym: '₺', name: 'Türk Lirası', digits: 2, after: false },
  USD: { sym: '$', name: 'Amerikan Doları', digits: 2, after: false },
  EUR: { sym: '€', name: 'Euro', digits: 2, after: false },
  GBP: { sym: '£', name: 'Sterlin', digits: 2, after: false },
  XAU: { sym: 'gr', name: 'Gram Altın', digits: 3, after: true }
};

function money(v, cur = 'TRY') {
  const c = CURRENCIES[cur] || CURRENCIES.TRY;
  const n = (v || 0).toLocaleString(TR, { minimumFractionDigits: c.digits, maximumFractionDigits: c.digits });
  return c.after ? `${n} ${c.sym}` : `${c.sym}${n}`;
}

function compact(v) {
  const a = Math.abs(v || 0), s = v < 0 ? '-' : '';
  if (a >= 1e6) return `${s}${(a / 1e6).toLocaleString(TR, { maximumFractionDigits: 1 })}M₺`;
  if (a >= 1e3) return `${s}${(a / 1e3).toLocaleString(TR, { maximumFractionDigits: 0 })}B₺`;
  return `${s}${a.toLocaleString(TR, { maximumFractionDigits: 0 })}₺`;
}

/** "1.234,56" / "1234.56" / "1,00" hepsini okur. */
function parseNum(s) {
  if (typeof s === 'number') return s;
  let t = String(s ?? '').replace(/[\s\u00A0₺$€£]/g, '');
  if (!t) return 0;
  const hasC = t.includes(','), hasD = t.includes('.');
  if (hasC && hasD) {
    t = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (hasC) {
    t = t.replace(',', '.');
  }
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function toast(msg, ms = 2600) {
  const host = $('#toastHost');
  host.innerHTML = `<div class="toast">${esc(msg)}</div>`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { host.innerHTML = ''; }, ms);
}

/* ---------------------------------------------------------
   1. Durum
   --------------------------------------------------------- */

const CATS = [
  { name: 'Kredi Kartı', kind: 'expense', color: '#f2565a', icon: '💳' },
  { name: 'Konut Kredi', kind: 'expense', color: '#4c8dff', icon: '🏠' },
  { name: 'Faturalar', kind: 'expense', color: '#e3a008', icon: '⚡' },
  { name: 'Abonelikler', kind: 'expense', color: '#b07aa1', icon: '📺' },
  { name: 'Sigorta', kind: 'expense', color: '#76b7b2', icon: '🛡' },
  { name: 'Aidat', kind: 'expense', color: '#59a14f', icon: '🏢' },
  { name: 'Birikim', kind: 'expense', color: '#edc948', icon: '🪙' },
  { name: 'Market', kind: 'expense', color: '#9c755f', icon: '🛒' },
  { name: 'Ulaşım', kind: 'expense', color: '#8cd17d', icon: '🚗' },
  { name: 'Sağlık', kind: 'expense', color: '#ff9da7', icon: '🩺' },
  { name: 'Diğer', kind: 'expense', color: '#8b93a1', icon: '•' },
  { name: 'Maaş', kind: 'income', color: '#3fb950', icon: '💰' },
  { name: 'Ek Gelir', kind: 'income', color: '#8cd17d', icon: '➕' },
  { name: 'Diğer', kind: 'income', color: '#8b93a1', icon: '•' }
];

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};

const S = {
  payments: [],
  categories: [],
  members: ['Kişi 1', 'Kişi 2', 'Ortak'],   // Ayarlar → Kişiler'den değiştirilir

  deviceId: LS.get('deviceId', null) || (() => { const v = uid().slice(0, 8); LS.set('deviceId', v); return v; })(),
  deviceName: LS.get('deviceName', 'Cihaz'),

  cfg: Object.assign({
    gistId: '',
    token: '',
    passphrase: '',
    notify: true,        // false → takvim dosyası boş yazılır, uyarı gelmez
    leadDays: 2,
    overdueDays: 14,
    alarmHour: 9,
    icsPrivacy: false,   // true → takvimde başlık/tutar gizlenir
    icsGistId: '',       // boşsa takvim.ics ana Gist'e yazılır
    icsWindowDays: 31,   // takvim dosyasına kaç günlük ödeme yazılsın
    goldPremium: 1.5
  }, LS.get('cfg', {})),

  rates: LS.get('rates', { TRY: 1, USD: 0, EUR: 0, GBP: 0, XAU: 0, at: 0, fxSrc: '—', goldSrc: '—' }),

  tab: 'dash',
  month: monthKey(todayISO()),
  selDay: todayISO(),
  listKind: 'expense',   // Ödemeler ekranı: expense | income | inst
  scope: 'unpaid',
  query: '',
  syncing: false,
  syncMsg: ''
};

function saveLocal() {
  LS.set('data', { payments: S.payments, categories: S.categories, members: S.members });
  LS.set('cfg', S.cfg);
}

function loadLocal() {
  const d = LS.get('data', null);
  if (d) {
    S.payments = d.payments || [];
    S.categories = d.categories || [];
    S.members = (d.members && d.members.length) ? d.members : S.members;
  }
  if (!S.categories.length) {
    S.categories = CATS.map(c => ({ id: uid(), ...c, updatedAt: new Date().toISOString(), deleted: false }));
  }
}

const alive = () => S.payments.filter(p => !p.deleted);
const catOf = (name, kind) => S.categories.find(c => !c.deleted && c.name === name && c.kind === kind)
  || { color: '#8b93a1', icon: '•' };
const catsFor = (kind) => S.categories.filter(c => !c.deleted && c.kind === kind);

const rateOf = (cur) => (cur === 'TRY' ? 1 : (S.rates[cur] || 0));
const inTRY = (p) => (p.amount || 0) * rateOf(p.currency);
const leftTRY = (p) => Math.max(0, (p.amount || 0) - (p.paidAmount || 0)) * rateOf(p.currency);

const isOverdue = (p) => !p.isPaid && p.dueDate < todayISO();
/** Gelirde "Ödendi/Ödenmedi" tuhaf duruyor; sözcük türe göre değişir.
    Sınıf adları (paid/late/part/open) sabit — stil ve testler onlara bağlı. */
const statusOf = (p) => {
  const inc = p.kind === 'income';
  return p.isPaid ? [inc ? 'Alındı' : 'Ödendi', 'paid']
    : isOverdue(p) ? [inc ? 'Gelmedi' : 'Gecikti', 'late']
    : (p.paidAmount > 0 ? ['Kısmi', 'part'] : [inc ? 'Alınmadı' : 'Ödenmedi', 'open']);
};

function blank() {
  return {
    id: uid(), title: '', kind: 'expense', category: 'Diğer', amount: 0, paidAmount: 0,
    currency: 'TRY', dueDate: todayISO(), isPaid: false, paidDate: null, note: '',
    owner: 'Ortak', installment: null, recurrence: 'none', recurrenceEnd: null,
    seriesId: null, reminder: true, updatedAt: new Date().toISOString(),
    deleted: false, editedBy: S.deviceName
  };
}

function touch(p) { p.updatedAt = new Date().toISOString(); p.editedBy = S.deviceName; return p; }

/* ---------------------------------------------------------
   2. Şifreleme (isteğe bağlı ortak parola)
   --------------------------------------------------------- */

const b64 = {
  /** Büyük tamponlarda `String.fromCharCode(...dizi)` yığını taşırdığı için
      parça parça çeviriyoruz. Veri büyüdükçe şifreleme bunda patlıyordu. */
  enc(buf) {
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    let out = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(out);
  },
  dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0))
};

async function keyFrom(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encJSON(obj, pass) {
  if (!pass) return JSON.stringify(obj, null, 1);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({ enc: 'aes-gcm', salt: b64.enc(salt), iv: b64.enc(iv), data: b64.enc(ct) });
}

async function decJSON(text, pass) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || raw.enc !== 'aes-gcm') return raw;
  if (!pass) throw new Error('Bu veri şifreli, ortak parolayı girmen gerekiyor.');
  const key = await keyFrom(pass, b64.dec(raw.salt));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(raw.iv) }, key, b64.dec(raw.data));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* ---------------------------------------------------------
   3. Gist senkronizasyonu
   --------------------------------------------------------- */

const GIST_API = 'https://api.github.com/gists/';

function ghHeaders() {
  return {
    'Authorization': `Bearer ${S.cfg.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

function mergeDocs(a, b) {
  const out = { payments: [], categories: [], members: [] };
  const pick = (list1, list2) => {
    const m = new Map();
    for (const x of [...(list1 || []), ...(list2 || [])]) {
      const cur = m.get(x.id);
      if (!cur || new Date(x.updatedAt || 0) > new Date(cur.updatedAt || 0)) m.set(x.id, x);
    }
    return [...m.values()];
  };
  out.payments = pick(a.payments, b.payments).sort((x, y) => x.dueDate.localeCompare(y.dueDate));
  out.categories = pick(a.categories, b.categories);
  out.members = [...new Set([...(a.members || []), ...(b.members || [])])];
  return out;
}

async function syncNow(silent = false) {
  if (!S.cfg.gistId || !S.cfg.token) { S.syncMsg = 'Gist ayarlanmadı'; return; }
  if (S.syncing) return;
  S.syncing = true; render();

  try {
    const res = await fetch(GIST_API + S.cfg.gistId, { headers: ghHeaders(), cache: 'no-store' });
    if (!res.ok) throw new Error(`Gist okunamadı (${res.status})`);
    const gist = await res.json();

    let merged = { payments: S.payments, categories: S.categories, members: S.members };

    for (const [name, file] of Object.entries(gist.files || {})) {
      if (!/^device-.*\.json$/.test(name)) continue;
      let text = file.content;
      if (file.truncated && file.raw_url) text = await (await fetch(file.raw_url)).text();
      if (!text) continue;
      const doc = await decJSON(text, S.cfg.passphrase);
      if (doc && doc.payments) merged = mergeDocs(merged, doc);
    }

    S.payments = merged.payments;
    S.categories = merged.categories.length ? merged.categories : S.categories;
    S.members = merged.members.length ? merged.members : S.members;

    // Karşı telefondan gelen ikizler burada temizlenir. Aşağıda kendi
    // dosyamızı yazarken silme damgaları da gittiği için düzeltme öbür
    // telefona da geçer.
    dedupeOccurrences();

    const mine = {
      schema: 1, deviceId: S.deviceId, deviceName: S.deviceName,
      writtenAt: new Date().toISOString(),
      payments: S.payments, categories: S.categories, members: S.members
    };

    const files = {};
    files[`device-${S.deviceId}.json`] = { content: await encJSON(mine, S.cfg.passphrase) };

    // Takvim dosyası ayrı bir Gist'e yazılabiliyor. Sebep: takvim adresi iki
    // telefonun Takvim ayarlarında açıkta duruyor ve içinde Gist ID geçiyor.
    // Ayrı Gist kullanılırsa o adres sızsa bile veri dosyalarına ulaşılamaz.
    const icsGist = (S.cfg.icsGistId || '').trim();
    if (!icsGist) {
      files['takvim.ics'] = { content: buildICS() };
    } else if (gist.files && gist.files['takvim.ics']) {
      // Ayrı Gist'e geçildi: ana Gist'te kalan eski takvim dosyası silinmeli.
      // Yoksa o adres çalışmaya ve eski ödemeleri göstermeye devam eder.
      files['takvim.ics'] = null;
    }

    const up = await fetch(GIST_API + S.cfg.gistId, {
      method: 'PATCH', headers: ghHeaders(), body: JSON.stringify({ files })
    });
    if (!up.ok) throw new Error(`Gist yazılamadı (${up.status})`);

    if (icsGist) {
      const up2 = await fetch(GIST_API + icsGist, {
        method: 'PATCH', headers: ghHeaders(),
        body: JSON.stringify({ files: { 'takvim.ics': { content: buildICS() } } })
      });
      if (!up2.ok) throw new Error(`Takvim Gist'i yazılamadı (${up2.status})`);
    }

    saveLocal();
    S.syncMsg = 'Eşitlendi · ' + fmtStamp(Date.now());
    LS.set('lastSync', Date.now());
    if (!silent) toast('Eşitlendi');
  } catch (e) {
    S.syncMsg = 'Hata: ' + e.message;
    if (!silent) toast(e.message, 4200);
  } finally {
    S.syncing = false; render();
  }
}

let syncTimer = null;
function scheduleSync() {
  saveLocal();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), 1400);
}

/* ---------------------------------------------------------
   4. Kurlar (anahtarsız, CORS'a açık kaynaklar)
   --------------------------------------------------------- */

const OUNCE_G = 31.1034768;

async function tryJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

async function fetchFX() {
  // 1) Frankfurter (ECB verisi, anahtarsız, CORS açık)
  try {
    const j = await tryJSON('https://api.frankfurter.app/latest?from=TRY&to=USD,EUR,GBP');
    if (j && j.rates && j.rates.USD) {
      return { USD: 1 / j.rates.USD, EUR: 1 / j.rates.EUR, GBP: 1 / j.rates.GBP, src: 'Frankfurter/ECB ' + j.date };
    }
  } catch {}
  // 2) open.er-api.com
  try {
    const j = await tryJSON('https://open.er-api.com/v6/latest/TRY');
    if (j && j.rates && j.rates.USD) {
      return { USD: 1 / j.rates.USD, EUR: 1 / j.rates.EUR, GBP: 1 / j.rates.GBP, src: 'er-api' };
    }
  } catch {}
  throw new Error('Döviz kaynağına ulaşılamadı');
}

async function fetchGoldUSD() {
  try {
    const j = await tryJSON('https://api.gold-api.com/price/XAU');
    if (j && +j.price > 100) return { oz: +j.price, src: 'gold-api.com' };
  } catch {}
  try {
    const j = await tryJSON('https://xaus.com/api/');
    if (j && +j.spot_usd_oz > 100) return { oz: +j.spot_usd_oz, src: 'xaus.com' };
  } catch {}
  throw new Error('Altın kaynağına ulaşılamadı');
}

async function refreshRates(force = false) {
  if (!force && S.rates.at && Date.now() - S.rates.at < 3 * 3600e3) return;
  const errs = [];
  const next = { ...S.rates, TRY: 1 };

  try {
    const fx = await fetchFX();
    next.USD = fx.USD; next.EUR = fx.EUR; next.GBP = fx.GBP; next.fxSrc = fx.src;
  } catch (e) { errs.push('Döviz: ' + e.message); }

  if (next.USD > 0) {
    try {
      const g = await fetchGoldUSD();
      next.XAU = (g.oz / OUNCE_G) * next.USD * (1 + (S.cfg.goldPremium || 0) / 100);
      next.goldSrc = g.src;
    } catch (e) { errs.push('Altın: ' + e.message); }
  }

  if (next.USD > 0) { next.at = Date.now(); S.rates = next; LS.set('rates', next); }
  if (errs.length) S.rateErr = errs.join(' · '); else S.rateErr = '';
  render();
}

/* ---------------------------------------------------------
   5. Takvim (.ics) üretimi — bildirimlerin kaynağı
   --------------------------------------------------------- */

function icsEsc(s) {
  return String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;')
    .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545: satırlar 75 OKTET'ten uzun olamaz.
    Türkçe harfler UTF-8'de 2 bayt tuttuğu için karakter değil bayt sayılır,
    ayrıca çok baytlı bir karakter ortadan bölünmemelidir. */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 74) return line;

  const parts = [];
  let cur = '', curBytes = 0, limit = 74;      // ilk satır 75'e kadar
  for (const ch of line) {                      // kod noktası bazında dolaş
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = ch; curBytes = b; limit = 73;       // devam satırları " " ile başlar
    } else {
      cur += ch; curBytes += b;
    }
  }
  if (cur) parts.push(cur);
  return parts.join('\r\n ');
}

const icsDate = (iso) => iso.replace(/-/g, '');
const icsStamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function buildICS() {
  const H = S.cfg.alarmHour || 9;
  const lead = S.cfg.leadDays ?? 2;
  const over = S.cfg.overdueDays ?? 14;
  const priv = !!S.cfg.icsPrivacy;
  const today = todayISO();

  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Odedimmi//Web//TR',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:Ödedim mi', 'X-WR-TIMEZONE:Europe/Istanbul',
    'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H'
  ];

  // Bildirimler kapalıyken dosya SİLİNMEZ, boş takvim olarak yazılır. Sebep:
  // dosyayı silersek adres 404 verir, iOS aboneliği güncelleyemez ve en son
  // indirdiği etkinlikleri telefonda tutmaya devam eder. Geçerli ama boş bir
  // takvim gönderirsek iOS mevcut etkinlikleri siler. Böylece hem uyarılar
  // durur hem de Gist'teki dosyanın içinde tek bir ödeme bilgisi kalmaz.
  if (S.cfg.notify === false) {
    L.push('END:VCALENDAR');
    return L.join('\r\n') + '\r\n';
  }

  const open = alive().filter(p => !p.isPaid && p.reminder && p.kind === 'expense');

  // Takvim dosyası iOS tarafından saatte bir indirildiği için kayan bir
  // pencereyle sınırlı tutuluyor. Pencere dar olsun: dosya Gist'te şifresiz
  // durmak zorunda (Takvim'in okuması gerekiyor), dolayısıyla içindeki her
  // kayıt sızma anında görünür olan bir kayıttır. Dosya her eşitlemede
  // yeniden üretildiğinden pencere kendiliğinden ilerler.
  const windowEnd = addDays(today, Math.max(7, Math.min(180, S.cfg.icsWindowDays ?? 31)));
  const inWindow = open.filter(p => p.dueDate <= windowEnd);

  for (const p of inWindow) {
    const label = priv ? 'Ödeme var' : `${p.title}${p.installment ? ` (${p.installment.index}/${p.installment.total})` : ''}`;
    const left = (p.amount || 0) - (p.paidAmount || 0);
    let desc = priv ? 'Ödedim mi uygulamasını aç' : `${money(left, p.currency)}`;
    if (!priv && p.owner && p.owner !== 'Ortak') desc += ` · ${p.owner}`;
    if (!priv && p.category) desc += ` · ${p.category}`;

    // Vade günü etkinliği + kademeli alarmlar
    L.push('BEGIN:VEVENT');
    L.push(`UID:${p.id}@odedimmi`);
    L.push(`DTSTAMP:${icsStamp()}`);
    L.push(`DTSTART;VALUE=DATE:${icsDate(p.dueDate)}`);
    L.push(`DTEND;VALUE=DATE:${icsDate(addDays(p.dueDate, 1))}`);
    L.push(fold(`SUMMARY:${icsEsc('💸 ' + label)}`));
    L.push(fold(`DESCRIPTION:${icsEsc(desc)}`));
    L.push('TRANSP:TRANSPARENT');

    // Alarm zamanı = vade 00:00'a göre kaydırma.
    // n gün önce saat H  →  -(24n - H) saat
    for (let n = lead; n >= 1; n--) {
      const hours = 24 * n - H;
      if (hours > 0) {
        L.push('BEGIN:VALARM', 'ACTION:DISPLAY',
          fold(`DESCRIPTION:${icsEsc((n === 1 ? 'Yarın: ' : `${n} gün sonra: `) + label)}`),
          `TRIGGER:-PT${hours}H`, 'END:VALARM');
      }
    }
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY',
      fold(`DESCRIPTION:${icsEsc('Bugün son gün: ' + label)}`),
      `TRIGGER:PT${H}H`, 'END:VALARM');
    L.push('END:VEVENT');

    // Gecikme: her gün için ayrı etkinlik (ödendi işaretlenince kaybolur)
    if (p.dueDate < today) {
      const late = Math.min(daysBetween(p.dueDate, today), over);
      for (let n = 1; n <= over; n++) {
        const day = addDays(p.dueDate, n);
        if (day < today) continue;              // geçmiş gecikme günlerini yazma
        if (n > late + over) break;
        L.push('BEGIN:VEVENT');
        L.push(`UID:${p.id}-late${n}@odedimmi`);
        L.push(`DTSTAMP:${icsStamp()}`);
        L.push(`DTSTART;VALUE=DATE:${icsDate(day)}`);
        L.push(`DTEND;VALUE=DATE:${icsDate(addDays(day, 1))}`);
        L.push(fold(`SUMMARY:${icsEsc(`⚠️ ${n} gün gecikti: ${label}`)}`));
        L.push(fold(`DESCRIPTION:${icsEsc(desc)}`));
        L.push('TRANSP:TRANSPARENT');
        L.push('BEGIN:VALARM', 'ACTION:DISPLAY',
          fold(`DESCRIPTION:${icsEsc(`${n} gün gecikti: ${label}`)}`),
          `TRIGGER:PT${H}H`, 'END:VALARM');
        L.push('END:VEVENT');
      }
    }
  }

  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------
   6. İş mantığı
   --------------------------------------------------------- */

function upsert(p) {
  touch(p);
  const i = S.payments.findIndex(x => x.id === p.id);
  if (i >= 0) S.payments[i] = p; else S.payments.push(p);
  S.payments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  scheduleSync();
}

function removePayment(p) {
  const i = S.payments.findIndex(x => x.id === p.id);
  if (i >= 0) { S.payments[i].deleted = true; touch(S.payments[i]); }
  scheduleSync();
}

function removeGroup(gid) {
  S.payments.forEach(p => { if (p.installment && p.installment.groupId === gid) { p.deleted = true; touch(p); } });
  scheduleSync();
}

/** Koşula uyan tüm kayıtları siler. Kayıtlar dosyadan çıkmaz, "silindi"
    damgası alır — böylece silme diğer telefona da yayılır. */
function bulkDelete(match) {
  let n = 0;
  for (const p of S.payments) {
    if (!p.deleted && match(p)) { p.deleted = true; touch(p); n++; }
  }
  if (n) scheduleSync();
  return n;
}

// ---- Seri (tekrarlayan kayıt zinciri) işlemleri ----

/** Bir kaydın hangi seriye ait olduğu. Tekil kayıtlarda kendi id'si. */
const seriesKey = (p) => p.seriesId || p.id;

/** Bu kayıt bir tekrar zincirinin parçası mı? */
function inSeries(p) {
  if (p.recurrence && p.recurrence !== 'none') return true;
  if (!p.seriesId) return false;
  return alive().some(x => x.id !== p.id && seriesKey(x) === seriesKey(p));
}

/** Aynı serideki, verilen tarihten SONRAKİ ödenmemiş kayıtlar. */
function futureOfSeries(p) {
  const key = seriesKey(p);
  return alive().filter(x =>
    x.id !== p.id && seriesKey(x) === key && x.dueDate > p.dueDate && !x.isPaid);
}

/**
 * Tekrar zincirinde üretilen kaydın kimliği.
 *
 * Rastgele uid() KULLANILMAZ — kasıtlı. İki telefon da açılışta materialize()
 * çalıştırıyor ve bunu senkrondan ÖNCE yapıyor. Rastgele kimlikle, ikisi de
 * aynı ayın kaydını kendi kimliğiyle üretiyor; birleştirme kimliğe baktığı
 * için ikisi de hayatta kalıyor ve kayıt ikileniyor. Kimlik seriden ve
 * vadeden türetilirse iki telefon aynı kimliği üretir, birleştirme de
 * kendiliğinden tek kayda indirir.
 */
const occId = (seriesId, dueDate) => `${seriesId}~${dueDate}`;

/** Ayın gün sayısını aşmayacak şekilde tarihin gününü değiştirir. */
function setDayOfMonth(iso, day) {
  const [y, m] = iso.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${iso.slice(0, 7)}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/**
 * Düzenlemeyi kaydeder.
 * mode 'one'    → yalnızca bu kayıt
 * mode 'future' → bu kayıt + serinin sonraki (ödenmemiş) kayıtları
 * Ödenmiş geçmiş kayıtlara asla dokunulmaz.
 */
function saveEdit(edited, original, mode) {
  upsert(edited);
  if (mode !== 'future') return 0;

  const FIELDS = ['title', 'kind', 'category', 'subcategory', 'amount', 'currency',
                  'owner', 'note', 'reminder', 'recurrence', 'recurrenceEnd'];
  const changes = {};
  for (const f of FIELDS) {
    if (JSON.stringify(edited[f]) !== JSON.stringify(original[f])) changes[f] = edited[f];
  }

  const oldDay = +original.dueDate.slice(8, 10);
  const newDay = +edited.dueDate.slice(8, 10);
  const dayMoved = oldDay !== newDay;

  let n = 0;
  for (const p of S.payments) {
    if (p.deleted || p.id === edited.id || p.isPaid) continue;
    if (seriesKey(p) !== seriesKey(edited)) continue;
    if (p.dueDate <= original.dueDate) continue;
    Object.assign(p, changes);
    if (dayMoved) p.dueDate = setDayOfMonth(p.dueDate, newDay);
    touch(p);
    n++;
  }
  if (n) scheduleSync();
  return n;
}

/** Seriden silme. mode 'one' | 'future' | 'all' */
function deleteScoped(p, mode) {
  if (mode === 'one') { removePayment(p); return 1; }
  const key = seriesKey(p);
  if (mode === 'future') {
    return bulkDelete(x => seriesKey(x) === key && x.dueDate >= p.dueDate);
  }
  return bulkDelete(x => seriesKey(x) === key);
}

function markPaid(p, on = true) {
  const t = S.payments.find(x => x.id === p.id);
  if (!t) return;
  t.isPaid = on;
  t.paidAmount = on ? t.amount : 0;
  t.paidDate = on ? todayISO() : null;
  touch(t);
  if (on && t.recurrence !== 'none') spawnNext(t);
  scheduleSync();
}

const STEP = { weekly: (d) => addDays(d, 7), monthly: (d) => addMonths(d, 1), quarterly: (d) => addMonths(d, 3), yearly: (d) => addMonths(d, 12) };

function spawnNext(p) {
  const step = STEP[p.recurrence];
  if (!step) return;
  const next = step(p.dueDate);
  if (p.recurrenceEnd && next > p.recurrenceEnd) return;
  const series = p.seriesId || p.id;
  if (S.payments.some(x => (x.seriesId === series || x.id === series) && x.dueDate === next)) return;
  S.payments.push(touch({ ...p, id: occId(series, next), seriesId: series, dueDate: next, isPaid: false, paidAmount: 0, paidDate: null }));
}

/** Uygulama açılışında eksik tekrarları tamamlar (3 ay ilerisine kadar). */
function materialize(untilISO) {
  // Kalemlerin çoğu her ay döndüğü için bir yıl ileriyi hazır tutuyoruz;
  // analiz ekranındaki 12 aylık projeksiyon da buna dayanıyor.
  const horizon = untilISO || addMonths(todayISO(), 12);
  for (let guard = 0; guard < 400; guard++) {
    let added = false;
    // Silinmiş kayıtların üzerinden de adımlanır — zincirin ortasındaki bir ayı
    // sildiğinde sonraki aylar üretilmeye devam etsin diye. Ama dolu slot
    // kontrolü silinmişleri DE sayar, yoksa sildiğin ay geri geliyor.
    for (const p of S.payments.filter(x => x.recurrence !== 'none')) {
      const step = STEP[p.recurrence];
      if (!step) continue;
      const next = step(p.dueDate);
      if (next > horizon) continue;
      if (p.recurrenceEnd && next > p.recurrenceEnd) continue;
      const series = p.seriesId || p.id;
      if (S.payments.some(x => (x.seriesId === series || x.id === series) && x.dueDate === next)) continue;
      S.payments.push(touch({ ...p, id: occId(series, next), seriesId: series, dueDate: next, isPaid: false, paidAmount: 0, paidDate: null }));
      added = true;
    }
    if (!added) break;
  }
  dedupeOccurrences();
  S.payments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

/**
 * Aynı slotu (aynı seri + aynı vade, ya da aynı taksit planının aynı sırası)
 * dolduran birden fazla kaydı teke indirir. Eskiden rastgele kimlikle üretilmiş
 * ikizleri temizler; deterministik kimliğe geçtikten sonra yenisi oluşmaz.
 *
 * Ödenmiş kayda dokunulmaz: bir slotta ödenmiş ve ödenmemiş kopya varsa
 * ödenmiş olan kalır. İkisi de ödenmişse hiçbiri silinmez, yalnızca sayılır —
 * gerçek bir çift ödeme olabilir, karar kullanıcının.
 */
function dedupeOccurrences({ apply = true } = {}) {
  const slots = new Map();
  for (const p of S.payments) {
    if (p.deleted) continue;
    let key = null;
    if (p.installment && p.installment.groupId) {
      key = `inst:${p.installment.groupId}:${p.installment.index}`;
    } else if (p.seriesId) {
      key = `ser:${seriesKey(p)}:${p.dueDate}`;
    }
    if (!key) continue;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(p);
  }

  let removed = 0, conflicts = 0;
  for (const [, group] of slots) {
    if (group.length < 2) continue;
    const paid = group.filter(p => p.isPaid);
    if (paid.length > 1) { conflicts++; continue; }

    // Tutulacak kayıt: ödenmiş olan; yoksa deterministik kimliğe sahip olan;
    // o da yoksa en eski (ilk yazılan) kayıt.
    const keep = paid[0]
      || group.find(p => p.id === occId(seriesKey(p), p.dueDate))
      || group.slice().sort((a, b) =>
           String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))[0];

    for (const p of group) {
      if (p === keep) continue;
      removed++;
      if (apply) { p.deleted = true; touch(p); }
    }
  }
  return { removed, conflicts };
}

function createInstallments(base, count, splitTotal) {
  const gid = uid();
  const per = splitTotal ? Math.round((base.amount / count) * 100) / 100 : base.amount;
  const drift = splitTotal ? Math.round((base.amount - per * count) * 100) / 100 : 0;
  for (let i = 0; i < count; i++) {
    S.payments.push(touch({
      ...base, id: uid(), amount: per + (i === 0 ? drift : 0),
      paidAmount: 0, isPaid: false, paidDate: null, recurrence: 'none',
      installment: { groupId: gid, index: i + 1, total: count },
      dueDate: addMonths(base.dueDate, i)
    }));
  }
  S.payments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  scheduleSync();
}

const hasRecurring = () => alive().some(p => p.recurrence && p.recurrence !== 'none');

function monthPayments(ym) { return alive().filter(p => monthKey(p.dueDate) === ym); }

function summary(ym) { return summaryOf(monthPayments(ym)); }

function summaryOf(list) {
  const s = { income: 0, expense: 0, paidExp: 0, gotInc: 0, openExp: 0, lateN: 0, lateAmt: 0 };
  for (const p of list) {
    const v = inTRY(p);
    if (p.kind === 'income') { s.income += v; if (p.isPaid) s.gotInc += v; }
    else {
      s.expense += v;
      if (p.isPaid) s.paidExp += v;
      else { s.openExp += leftTRY(p); if (isOverdue(p)) { s.lateN++; s.lateAmt += leftTRY(p); } }
    }
  }
  s.net = s.income - s.expense;
  return s;
}

function catBreakdown(ym, kind = 'expense') {
  const m = {};
  for (const p of monthPayments(ym)) if (p.kind === kind) m[p.category] = (m[p.category] || 0) + inTRY(p);
  return Object.entries(m).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([name, total]) => ({ name, total, color: catOf(name, kind).color }));
}

function ensureCat(name, kind) {
  if (!name) return;
  if (S.categories.some(c => !c.deleted && c.name === name && c.kind === kind)) return;
  const palette = ['#4c8dff', '#e3a008', '#f2565a', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#8b93a1'];
  const h = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  S.categories.push({ id: uid(), name, kind, color: palette[h % palette.length], icon: '•', updatedAt: new Date().toISOString(), deleted: false });
}

/* ---------------------------------------------------------
   7. CSV
   --------------------------------------------------------- */

function splitCSVLine(line) {
  const delim = line.includes(';') ? ';' : ',';
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseAnyDate(s) {
  s = String(s).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return null;
}

/**
 * @param {string} text        CSV metni
 * @param {boolean} replaceAll mevcut kayıtları sil
 * @param {boolean} recurring  sütunda aksi yazmıyorsa kayıtları aylık tekrar kabul et
 */
function importCSV(text, replaceAll, recurring = true) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { added: 0, skipped: 0, warns: ['Dosya boş.'] };

  const head = splitCSVLine(lines[0]).map(h => h.replace(/"/g, '').trim().toLocaleLowerCase(TR));
  const find = (...names) => { for (const n of names) { const i = head.indexOf(n.toLocaleLowerCase(TR)); if (i >= 0) return i; } return -1; };

  const I = {
    date: find('tarih', 'date'), title: find('başlık', 'baslik', 'title', 'açıklama'),
    kind: find('tür', 'tur', 'type'), cat: find('kategori', 'category'),
    amt: find('tutar', 'amount'), paid: find('ödenen tutar', 'odenen tutar', 'paid'),
    cur: find('para birimi', 'currency'), stat: find('durum', 'status'),
    own: find('kişi', 'kisi', 'owner'), inst: find('taksit', 'installment'),
    rep: find('tekrar', 'recurrence'), note: find('not', 'note')
  };

  if (I.date < 0 || I.title < 0 || I.amt < 0) {
    return { added: 0, skipped: 0, warns: ['Zorunlu sütunlar bulunamadı (Tarih / Başlık / Tutar).'] };
  }

  if (replaceAll) S.payments.forEach(p => { p.deleted = true; touch(p); });

  let added = 0, skipped = 0; const warns = [];

  for (let i = 1; i < lines.length; i++) {
    const c = splitCSVLine(lines[i]);
    const g = (idx) => (idx >= 0 && idx < c.length ? c[idx].trim() : '');

    const date = parseAnyDate(g(I.date));
    if (!date) { skipped++; if (warns.length < 5) warns.push(`Satır ${i + 1}: tarih okunamadı`); continue; }
    const title = g(I.title);
    if (!title) { skipped++; continue; }

    const kind = /gelir|income/i.test(g(I.kind)) ? 'income' : 'expense';
    const amount = parseNum(g(I.amt));
    const paidAmount = parseNum(g(I.paid));
    const statTxt = g(I.stat).toLocaleLowerCase(TR);
    const isPaid = statTxt ? /ödendi|odendi|paid/.test(statTxt) : (paidAmount > 0 && paidAmount >= amount);

    if (alive().some(p => p.title === title && p.dueDate === date && Math.abs(p.amount - amount) < 0.01)) continue;

    let owner = g(I.own);
    if (!owner) {
      // Kişi sütunu boşsa başlıkta geçen bir kişi adı aranır. Adlar kodda sabit
      // değil, kullanıcının kendi kişi listesinden gelir (Ayarlar → Kişiler).
      const hit = S.members.find(m =>
        m && m !== 'Ortak' && title.toLocaleLowerCase(TR).includes(m.toLocaleLowerCase(TR)));
      owner = hit || 'Ortak';
    }

    let installment = null;
    const im = g(I.inst).match(/^(\d+)\s*\/\s*(\d+)$/);
    if (im && +im[2] > 1) installment = { groupId: uid(), index: +im[1], total: +im[2] };

    // Tekrar sütunu doluysa o kazanır. Boşsa "recurring" tercihine göre
    // aylık kabul edilir — Excel'den gelen kalemlerin çoğu her ay tekrarlar.
    const rt = g(I.rep).toLocaleLowerCase(TR);
    let recurrence;
    if (/tekrarlamaz|tek sefer|yok|hayır|hayir/.test(rt)) recurrence = 'none';
    else if (/hafta/.test(rt)) recurrence = 'weekly';
    else if (/3 ay|çeyrek/.test(rt)) recurrence = 'quarterly';
    else if (/yıl|yil/.test(rt)) recurrence = 'yearly';
    else if (/ay/.test(rt)) recurrence = 'monthly';
    else recurrence = (recurring && !installment) ? 'monthly' : 'none';

    const cur = (g(I.cur) || 'TRY').toUpperCase();
    const category = g(I.cat) || 'Diğer';
    ensureCat(category, kind);
    if (!S.members.includes(owner)) S.members.push(owner);

    S.payments.push(touch({
      ...blank(), title, kind, category, amount,
      paidAmount: isPaid ? Math.max(paidAmount, amount) : paidAmount,
      currency: CURRENCIES[cur] ? cur : 'TRY',
      dueDate: date, isPaid, paidDate: isPaid ? date : null,
      owner, note: g(I.note), installment, recurrence
    }));
    added++;
  }

  S.payments.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  scheduleSync();
  return { added, skipped, warns };
}

function exportCSV() {
  const n = (v) => (v || 0).toLocaleString(TR, { minimumFractionDigits: 2, maximumFractionDigits: 3, useGrouping: false });
  const q = (s) => (/[;"\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s ?? ''));
  let out = 'Tarih;Başlık;Tür;Kategori;Tutar;Ödenen tutar;Para birimi;Durum;Kişi;Taksit;Tekrar;Not\n';
  for (const p of alive().slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
    out += [
      p.dueDate, q(p.title), p.kind === 'income' ? 'Gelir' : 'Gider', q(p.category),
      n(p.amount), n(p.paidAmount), p.currency, p.isPaid ? 'Ödendi' : 'Ödenmedi',
      q(p.owner), p.installment ? `${p.installment.index}/${p.installment.total}` : '',
      p.recurrence === 'none' ? '' : p.recurrence, q(p.note)
    ].join(';') + '\n';
  }
  return out;
}

function download(name, text, mime = 'text/csv') {
  const blob = new Blob(['\uFEFF' + text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

/* ---------------------------------------------------------
   8. Görünümler
   --------------------------------------------------------- */

function rowHTML(p, opts = {}) {
  const c = catOf(p.category, p.kind);
  const [txt, cls] = statusOf(p);
  const conv = (p.currency !== 'TRY' && rateOf(p.currency) > 0)
    ? `≈ ${money(inTRY(p), 'TRY')}` : '';
  const meta = [opts.noDate ? '' : fmtDay(p.dueDate), p.category,
    (p.owner && p.owner !== 'Ortak') ? p.owner : ''].filter(Boolean).join(' · ');
  const inst = p.installment ? ` <span style="color:var(--muted)">(${p.installment.index}/${p.installment.total})</span>` : '';

  return `<div class="row" data-id="${p.id}">
    <div class="ico" style="background:${c.color}22;color:${c.color}">${c.icon}</div>
    <div class="main js-edit">
      <div class="t">${esc(p.title)}${inst}</div>
      <div class="m">${esc(meta)}</div>
    </div>
    <div class="amt js-edit">
      <div class="a" style="color:${p.kind === 'income' ? 'var(--green)' : 'inherit'}">
        ${p.kind === 'income' ? '+' : '−'}${money(p.amount, p.currency)}</div>
      <div class="b">${conv || `<span class="pill ${cls}">${txt}</span>`}</div>
    </div>
    ${opts.tick !== false
      ? `<button class="tick ${p.isPaid ? 'done' : ''} js-tick" aria-label="${p.kind === 'income' ? 'Alındı' : 'Ödendi'}">✓</button>` : ''}
  </div>`;
}

function viewDash() {
  const s = summary(S.month);
  const late = alive().filter(isOverdue).slice(0, 6);
  const soon = alive().filter(p => !p.isPaid && !isOverdue(p) && daysBetween(todayISO(), p.dueDate) <= 15).slice(0, 8);
  const cats = catBreakdown(S.month);
  const total = cats.reduce((a, b) => a + b.total, 0);
  const r = S.rates;

  return `
  ${monthNav()}
  <div class="chips">
    ${chip('USD', r.USD, '#3fb950')}${chip('EUR', r.EUR, '#58a6ff')}
    ${chip('GBP', r.GBP, '#b07aa1')}${chip('Gram Altın', r.XAU, '#e3a008')}
    <button class="chip js-rates">${S.ratesLoading ? '<span class="spin"></span>' : '⟳ Kur'}</button>
  </div>

  <div class="grid2">
    ${tile('Gelir', compact(s.income), `Alınan ${compact(s.gotInc)}`, 'var(--green)')}
    ${tile('Gider', compact(s.expense), `Ödenen ${compact(s.paidExp)}`, 'var(--red)')}
    ${tile('Kalan ödeme', compact(s.openExp), 'Bu ay bekleyen', 'var(--orange)')}
    ${tile('Ay sonu net', compact(s.net), s.net >= 0 ? 'Fazla veriyorsun' : 'Açık var', s.net >= 0 ? 'var(--green)' : 'var(--red)')}
  </div>

  ${late.length ? `<div class="card">
    <h2 style="color:var(--red)">Gecikmiş ödemeler <span class="sub">${compact(s.lateAmt)}</span></h2>
    ${late.map(p => rowHTML(p)).join('')}
  </div>` : ''}

  <div class="card">
    <h2>Yaklaşan 15 gün <span class="sub">${soon.length} kayıt</span></h2>
    ${soon.length ? soon.map(p => rowHTML(p)).join('') : '<div class="empty">Yaklaşan ödeme yok. Rahat ol.</div>'}
  </div>

  <div class="card">
    <h2>Kategori dağılımı</h2>
    ${cats.length ? cats.slice(0, 8).map(c => `
      <div class="bar-wrap">
        <div class="bar-head">
          <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${c.color}"></span>
          <span class="name">${esc(c.name)}</span>
          <span class="val">${compact(c.total)}</span>
          <span class="pct">%${total ? Math.round(c.total / total * 100) : 0}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${total ? c.total / total * 100 : 0}%;background:${c.color}"></div></div>
      </div>`).join('') : '<div class="empty">Bu ay için gider yok.</div>'}
  </div>`;
}

const chip = (name, v, color) =>
  `<div class="chip"><span class="dot" style="background:${color}"></span>${name}<b>${v > 0 ? money(v, 'TRY') : '—'}</b></div>`;

const tile = (label, value, hint, color) =>
  `<div class="tile"><div class="label"><span class="dot" style="width:7px;height:7px;border-radius:50%;background:${color}"></span>${label}</div>
   <div class="value">${value}</div><div class="hint">${esc(hint)}</div></div>`;

function monthNav() {
  const isNow = S.month === monthKey(todayISO());
  return `<div class="month-nav">
    <button class="js-m" data-d="-1">‹</button>
    <div class="title">${fmtMonth(S.month)}${isNow ? '' : '<small class="js-m" data-d="0">Bu aya dön</small>'}</div>
    <button class="js-m" data-d="1">›</button>
  </div>`;
}

function viewList() {
  const kindTabs = `<div class="seg" style="margin-bottom:8px">
    ${[['expense', 'Gider'], ['income', 'Gelir'], ['inst', 'Taksitler']]
      .map(([k, v]) => `<button class="js-kind ${S.listKind === k ? 'on' : ''}" data-k="${k}">${v}</button>`).join('')}
  </div>`;

  if (S.listKind === 'inst') return kindTabs + installmentGroups();

  const scopes = { all: 'Tümü', unpaid: 'Ödenmemiş', paid: 'Ödenmiş', late: 'Gecikmiş' };
  const scopeTabs = `<div class="seg" style="margin-bottom:10px">
    ${Object.entries(scopes).map(([k, v]) =>
      `<button class="js-scope ${S.scope === k ? 'on' : ''}" data-k="${k}">${v}</button>`).join('')}
  </div>`;

  const monthAll = monthPayments(S.month).filter(p => p.kind === S.listKind);

  let list = monthAll;
  if (S.scope === 'unpaid') list = list.filter(p => !p.isPaid);
  else if (S.scope === 'paid') list = list.filter(p => p.isPaid);
  else if (S.scope === 'late') list = list.filter(isOverdue);

  const q = S.query.trim().toLocaleLowerCase(TR);
  if (q) list = list.filter(p => (p.title + p.category + p.owner + p.note).toLocaleLowerCase(TR).includes(q));
  list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const total = monthAll.reduce((a, p) => a + inTRY(p), 0);
  const done = monthAll.filter(p => p.isPaid).reduce((a, p) => a + inTRY(p), 0);
  const left = monthAll.filter(p => !p.isPaid).reduce((a, p) => a + leftTRY(p), 0);
  const word = S.listKind === 'income' ? 'Alınan' : 'Ödenen';

  const strip = `<div class="month-sum">
    <div><span>Toplam</span><b>${compact(total)}</b></div>
    <div><span>${word}</span><b style="color:var(--green)">${compact(done)}</b></div>
    <div><span>Kalan</span><b style="color:${left > 0 ? 'var(--orange)' : 'var(--muted)'}">${compact(left)}</b></div>
  </div>`;

  const body = list.length
    ? `<div class="card">${list.map(p => rowHTML(p)).join('')}</div>`
    : `<div class="empty">${q ? 'Aramaya uyan kayıt yok.'
        : (monthAll.length ? 'Bu filtrede kayıt yok.'
          : `${fmtMonth(S.month)} ayında ${S.listKind === 'income' ? 'gelir' : 'gider'} kaydı yok.`)}
        ${(!q && !monthAll.length && S.month > monthKey(todayISO()) && hasRecurring())
          ? '<button class="btn js-fill" style="margin-top:14px">Tekrarlayan kayıtları bu aya kadar oluştur</button>' : ''}
      </div>`;

  return monthNav() + kindTabs + scopeTabs + strip
    + `<input class="search" id="q" type="text" placeholder="Ara…" value="${esc(S.query)}">`
    + body
    + `<div class="swipe-hint">← sağa sola kaydırarak ay değiştir →</div>`;
}

/** Taksit planları aya bağlı değildir, hepsi bir arada gösterilir. */
function installmentGroups() {
  const groups = {};
  for (const p of alive().filter(x => x.installment)) (groups[p.installment.groupId] ||= []).push(p);
  const keys = Object.keys(groups)
    .sort((a, b) => groups[a][0].dueDate.localeCompare(groups[b][0].dueDate));

  if (!keys.length) {
    return '<div class="empty">Taksitli kayıt yok.<br>Yeni kayıt eklerken taksit sayısı girerek plan oluşturabilirsin.</div>';
  }

  return keys.map(gid => {
    const g = groups[gid].sort((a, b) => a.installment.index - b.installment.index);
    const paid = g.filter(p => p.isPaid).length;
    const sum = g.reduce((a, p) => a + p.amount, 0);
    const paidSum = g.reduce((a, p) => a + p.paidAmount, 0);
    return `<div class="card">
      <h2>${esc(g[0].title)} <span class="sub">${paid}/${g.length}</span></h2>
      <div class="bar-track" style="margin-bottom:8px"><div class="bar-fill" style="width:${paid / g.length * 100}%;background:var(--accent)"></div></div>
      <div class="note" style="margin:0 0 8px">Ödenen ${money(paidSum, g[0].currency)} / ${money(sum, g[0].currency)}</div>
      ${g.map(p => rowHTML(p)).join('')}
      <button class="btn danger js-delgroup" data-g="${gid}" style="margin-top:10px">Taksit planını sil</button>
    </div>`;
  }).join('');
}

function viewCal() {
  const [y, m] = S.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7;  // Pazartesi = 0

  const byDay = {};
  for (const p of monthPayments(S.month)) (byDay[p.dueDate] ||= []).push(p);

  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<button class="cal-cell other"></button>';
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${S.month}-${String(d).padStart(2, '0')}`;
    const items = byDay[iso] || [];
    const dots = [];
    if (items.some(isOverdue)) dots.push('var(--red)');
    if (items.some(p => !p.isPaid && p.kind === 'expense' && !isOverdue(p))) dots.push('var(--orange)');
    if (items.some(p => p.isPaid)) dots.push('var(--green)');
    if (items.some(p => p.kind === 'income')) dots.push('var(--blue)');
    const cls = [
      'cal-cell',
      iso === todayISO() ? 'today' : '',
      iso === S.selDay ? 'sel' : '',
      items.some(isOverdue) ? 'has-late' : (items.some(p => !p.isPaid && p.kind === 'expense') ? 'has-open' : '')
    ].join(' ');
    cells += `<button class="${cls} js-day" data-d="${iso}">${d}
      <span class="cal-dots">${dots.slice(0, 3).map(c => `<i style="background:${c}"></i>`).join('')}</span></button>`;
  }

  const sel = (byDay[S.selDay] || alive().filter(p => p.dueDate === S.selDay));
  const inc = sel.filter(p => p.kind === 'income').reduce((a, p) => a + inTRY(p), 0);
  const exp = sel.filter(p => p.kind === 'expense').reduce((a, p) => a + inTRY(p), 0);

  return `${monthNav()}
    <div class="card">
      <div class="cal-head">${['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'].map(d => `<div>${d}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </div>
    <div class="card">
      <h2>${fmtFull(S.selDay)}</h2>
      ${sel.length ? `<div class="note" style="margin:0 0 8px">
          ${inc ? `<span style="color:var(--green)">↓ ${compact(inc)}</span> ` : ''}
          ${exp ? `<span style="color:var(--red)">↑ ${compact(exp)}</span>` : ''}
        </div>${sel.map(p => rowHTML(p, { noDate: true })).join('')}`
      : '<div class="empty">Bu güne kayıt yok.</div>'}
    </div>`;
}

function viewStats() {
  const months = [];
  let ym = monthKey(todayISO());
  for (let i = 0; i < 12; i++) { months.push(ym); ym = monthKey(addMonths(ym + '-01', 1)); }
  const data = months.map(m => ({ m, ...summary(m) }));
  const max = Math.max(1, ...data.map(d => Math.max(d.income, d.expense)));
  const tI = data.reduce((a, d) => a + d.income, 0);
  const tE = data.reduce((a, d) => a + d.expense, 0);

  const cats = catBreakdown(S.month);
  const catMax = Math.max(1, ...cats.map(c => c.total));

  const owners = {};
  for (const p of monthPayments(S.month)) if (p.kind === 'expense') owners[p.owner] = (owners[p.owner] || 0) + inTRY(p);
  const oList = Object.entries(owners).sort((a, b) => b[1] - a[1]);
  const oTotal = oList.reduce((a, b) => a + b[1], 0);

  const curTot = {};
  for (const p of monthPayments(S.month)) if (p.kind === 'expense') curTot[p.currency] = (curTot[p.currency] || 0) + p.amount;

  const openInst = alive().filter(p => p.installment && !p.isPaid).reduce((a, p) => a + leftTRY(p), 0);
  const instGroups = new Set(alive().filter(p => p.installment).map(p => p.installment.groupId)).size;

  return `${monthNav()}
    <div class="card">
      <h2>Önümüzdeki 12 ay <span class="sub">net ${compact(tI - tE)}</span></h2>
      <div class="proj">
        ${data.map(d => `<div class="col">
          <div class="pair">
            <div class="b" style="height:${d.income / max * 100}%;background:var(--green)"></div>
            <div class="b" style="height:${d.expense / max * 100}%;background:var(--red)"></div>
          </div>
          <div class="lbl">${fmtShortMonth(d.m)}</div>
        </div>`).join('')}
      </div>
      <div class="note" style="margin:0">🟩 gelir · 🟥 gider</div>
    </div>

    <div class="card">
      <h2>${fmtMonth(S.month)} — kategori</h2>
      ${cats.length ? cats.map(c => `
        <div class="bar-wrap">
          <div class="bar-head"><span class="name">${esc(c.name)}</span><span class="val">${compact(c.total)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${c.total / catMax * 100}%;background:${c.color}"></div></div>
        </div>`).join('') : '<div class="empty">Kayıt yok.</div>'}
    </div>

    <div class="card">
      <h2>Kim ne kadar ödüyor</h2>
      ${oList.length ? oList.map(([n, v]) => `
        <div class="bar-head" style="padding:5px 0"><span class="name">${esc(n)}</span>
          <span class="val">${compact(v)}</span><span class="pct">%${oTotal ? Math.round(v / oTotal * 100) : 0}</span></div>`).join('')
      : '<div class="empty">Kayıt yok.</div>'}
    </div>

    <div class="card">
      <h2>Para birimine göre gider</h2>
      ${Object.keys(curTot).length ? Object.entries(curTot).map(([c, v]) => `
        <div class="bar-head" style="padding:5px 0"><span class="name">${c} — ${money(v, c)}</span>
          <span class="val">${c === 'TRY' ? '' : '≈ ' + compact(v * rateOf(c))}</span></div>`).join('')
      : '<div class="empty">Kayıt yok.</div>'}
      <div class="note" style="margin-bottom:0">Döviz: ${esc(S.rates.fxSrc)} · Altın: ${esc(S.rates.goldSrc)}</div>
    </div>

    <div class="card">
      <h2>Taksit yükü</h2>
      ${instGroups ? `<div class="bar-head" style="padding:5px 0"><span class="name">Açık taksit planı</span><span class="val">${instGroups}</span></div>
        <div class="bar-head" style="padding:5px 0"><span class="name">Kalan toplam borç</span><span class="val">${compact(openInst)}</span></div>`
      : '<div class="empty">Aktif taksit yok.</div>'}
    </div>`;
}

function viewSettings() {
  // Takvim adresi ayrı Gist ayarlıysa ondan, değilse ana Gist'ten üretilir.
  const notifOn = S.cfg.notify !== false;
  const off = notifOn ? '' : ' disabled';
  const icsHost = (S.cfg.icsGistId || '').trim() || S.cfg.gistId;
  const icsURL = icsHost && S.cfg.gistUser
    ? `https://gist.githubusercontent.com/${S.cfg.gistUser}/${icsHost}/raw/takvim.ics` : '';

  return `
  <div class="card">
    <h2>Ortak veri (GitHub Gist)</h2>
    <label class="field"><span>Gist ID</span>
      <input type="text" id="cfgGist" value="${esc(S.cfg.gistId)}" placeholder="a1b2c3d4e5f6..." autocapitalize="off" spellcheck="false"></label>
    <label class="field"><span>GitHub kullanıcı adı</span>
      <input type="text" id="cfgUser" value="${esc(S.cfg.gistUser || '')}" placeholder="kullaniciadi" autocapitalize="off" spellcheck="false"></label>
    <label class="field"><span>Erişim anahtarı (token) ${S.cfg.token ? '<em class="ok">kayıtlı</em>' : ''}</span>
      <input type="password" id="cfgToken" value="" placeholder="${S.cfg.token ? '•••• kayıtlı — değiştirmek için yeni anahtar yaz' : 'github_pat_… veya ghp_…'}" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
    <label class="field"><span>Ortak parola (şifreleme — isteğe bağlı) ${S.cfg.passphrase ? '<em class="ok">kayıtlı</em>' : ''}</span>
      <input type="password" id="cfgPass" value="" placeholder="${S.cfg.passphrase ? '•••• kayıtlı — değiştirmek için yeni parola yaz' : 'ikinizin bildiği bir parola'}" autocapitalize="off" autocomplete="off" spellcheck="false"></label>
    ${(S.cfg.token || S.cfg.passphrase)
      ? '<button class="btn ghost js-forget">Anahtarı bu cihazdan sil</button>' : ''}
    <label class="field"><span>Bu cihazın adı</span>
      <input type="text" id="cfgDevice" value="${esc(S.deviceName)}" placeholder="iPhone"></label>
    <button class="btn js-savecfg">Kaydet ve eşitle</button>
    <div class="status-line ${/Hata/.test(S.syncMsg) ? 'err' : ''}">${esc(S.syncMsg || 'Henüz eşitlenmedi')}</div>
    <div class="note">Her cihaz Gist'e yalnızca kendi dosyasını yazar; okurken hepsi birleştirilir, aynı kaydın en son değiştirilen hali kazanır. <strong>Ortak parola girersen</strong> veri şifrelenir — Gist'in linkini ele geçiren bile okuyamaz. İkinizde de aynı parola olmalı.</div>
  </div>

  <div class="card">
    <h2>Bildirimler (Takvim aboneliği)</h2>
    <div class="switch"><div class="lbl">Bildirimler açık
      <small>${notifOn
        ? 'Yaklaşan ödemeler takvim dosyasına yazılır'
        : '<strong>Kapalı.</strong> Takvim dosyası boş yazılıyor — içinde hiçbir ödeme bilgisi yok'}</small></div>
      <input type="checkbox" id="cfgNotify" ${notifOn ? 'checked' : ''}></div>
    ${notifOn ? '' : '<div class="note">Kapalıyken Gist\'teki <code>takvim.ics</code> dosyası boş bir takvim olarak yazılmaya devam eder. Dosyayı silmek yerine boşaltmak gerekiyor: adres 404 verirse iOS aboneliği güncelleyemez ve en son indirdiği ödemeleri telefonda göstermeye devam eder. Boş takvimde ise iOS eski etkinlikleri temizler. Aboneliği telefondan kaldırmana gerek yok, tekrar açtığında kendiliğinden dolar.</div>'}
    ${icsURL ? `<div class="note">Takvim adresin:<br><code>${esc(icsURL)}</code></div>
      <button class="btn ghost js-copyics">Adresi kopyala</button>`
    : '<div class="note">Önce yukarıdan Gist ID ve kullanıcı adını kaydet.</div>'}
    <div class="note"><strong>iPhone'da:</strong> Ayarlar → Uygulamalar → Takvim → Takvim Hesapları → Hesap Ekle → Diğer → <strong>Abone Olunan Takvim Ekle</strong> → adresi yapıştır. <strong>“Uyarıları Sil” kapalı olmalı</strong>, yoksa hatırlatma gelmez.</div>
    <label class="field"><span>Kaç gün önce başlasın</span>
      <input type="number" id="cfgLead" min="0" max="7" value="${S.cfg.leadDays}"${off}></label>
    <label class="field"><span>Gecikince kaç gün devam etsin</span>
      <input type="number" id="cfgOver" min="1" max="30" value="${S.cfg.overdueDays}"${off}></label>
    <label class="field"><span>Hatırlatma saati</span>
      <input type="number" id="cfgHour" min="0" max="23" value="${S.cfg.alarmHour}"${off}></label>
    <label class="field"><span>Takvime kaç günlük ödeme yazılsın</span>
      <input type="number" id="cfgWin" min="7" max="180" value="${S.cfg.icsWindowDays ?? 31}"${off}></label>
    <div class="note">Takvim dosyası Gist'te <strong>şifresiz</strong> durmak zorunda — iOS Takvim'in okuyabilmesi için. Bu yüzden içine yalnızca yakın vadeli ödemeler yazılıyor. 31 gün, bildirimlerden bir şey kaybettirmeden listeyi kısa tutar.</div>
    <label class="field"><span>Takvim için ayrı Gist ID <em class="ok">isteğe bağlı</em></span>
      <input type="text" id="cfgIcsGist" value="${esc(S.cfg.icsGistId || '')}" placeholder="boş bırakırsan ana Gist kullanılır" autocapitalize="off" spellcheck="false"></label>
    <div class="note">Takvim adresi iki telefonun Takvim ayarlarında açıkta duruyor ve içinde Gist ID geçiyor. Ayrı bir gizli Gist açıp ID'sini buraya yazarsan, o adres sızsa bile <strong>veri dosyalarına ulaşılamaz</strong> — sızan şey yalnızca yaklaşan ödemelerin listesi olur.<br><br><strong>Değiştirirsen:</strong> iki telefonda da eski takvim aboneliğini <strong>sil</strong>, yeni adresle yeniden ekle. Eski aboneliği silmezsen o adres çalışmaya devam eder.</div>
    <div class="switch"><div class="lbl">Takvimde detay gizle
      <small>Başlık ve tutar yerine sadece “Ödeme var” yazar</small></div>
      <input type="checkbox" id="cfgPriv" ${S.cfg.icsPrivacy ? 'checked' : ''}${off}></div>
    <button class="btn js-savenotif" style="margin-top:12px">Kaydet</button>
  </div>

  <div class="card">
    <h2>Kurlar</h2>
    <div class="bar-head" style="padding:5px 0"><span class="name">Dolar</span><span class="val">${S.rates.USD ? money(S.rates.USD) : '—'}</span></div>
    <div class="bar-head" style="padding:5px 0"><span class="name">Euro</span><span class="val">${S.rates.EUR ? money(S.rates.EUR) : '—'}</span></div>
    <div class="bar-head" style="padding:5px 0"><span class="name">Sterlin</span><span class="val">${S.rates.GBP ? money(S.rates.GBP) : '—'}</span></div>
    <div class="bar-head" style="padding:5px 0"><span class="name">Gram altın</span><span class="val">${S.rates.XAU ? money(S.rates.XAU) : '—'}</span></div>
    <label class="field" style="margin-top:10px"><span>Altın primi (%)</span>
      <input type="number" id="cfgPrem" step="0.5" min="0" max="15" value="${S.cfg.goldPremium}"></label>
    <button class="btn ghost js-rates">Kurları güncelle</button>
    <button class="btn ghost js-manual">Elle kur gir</button>
    <div class="note">Döviz: ${esc(S.rates.fxSrc)} · Altın: ${esc(S.rates.goldSrc)}${S.rates.at ? ' · ' + fmtStamp(S.rates.at) : ''}
      ${S.rateErr ? `<br><span style="color:var(--red)">${esc(S.rateErr)}</span>` : ''}
      <br>Tarayıcıdan TCMB'ye doğrudan erişilemediği için kurlar ECB tabanlı kaynaktan gelir; TCMB satış kurundan bir miktar farklı olabilir. Kesin rakam istersen elle gir.</div>
  </div>

  <div class="card">
    <h2>Kişiler</h2>
    ${S.members.map(m => `<div class="bar-head" style="padding:6px 0"><span class="name">${esc(m)}</span>
      <button class="iconbtn js-delmember" data-m="${esc(m)}" style="width:30px;height:30px">✕</button></div>`).join('')}
    <label class="field" style="margin-top:8px"><span>Yeni kişi</span><input type="text" id="newMember" placeholder="İsim"></label>
    <button class="btn ghost js-addmember">Ekle</button>
  </div>

  <div class="card">
    <h2>Veri <span class="sub">${alive().length} kayıt</span></h2>
    <button class="btn ghost js-import">Metin yapıştırarak içe aktar</button>
    <button class="btn ghost js-importfile">CSV dosyası seç</button>
    <button class="btn ghost js-export">CSV olarak dışa aktar</button>
    <input type="file" id="fileIn" accept=".csv,.txt,text/*" style="display:none">
    <button class="btn ghost js-dedupe">İkilenmiş kayıtları denetle</button>
    ${(() => {
      const r = dedupeOccurrences({ apply: false });
      if (r.conflicts) return `<div class="note err">${r.conflicts} slotta <strong>iki kopya da ödenmiş</strong> görünüyor. Bunlara dokunulmadı — gerçekten iki kez ödenmiş olabilir. Ödemeler ekranından bakıp gereksiz olanı elle sil.</div>`;
      return '<div class="note">Aynı ayın tekrar kaydı ya da aynı taksit sırası iki kez oluşmuşsa kendiliğinden teke indirilir.</div>';
    })()}
    <div class="note">Beklenen sütunlar: <code>Tarih;Başlık;Tür;Kategori;Tutar;Ödenen tutar;Para birimi;Durum</code> — isteğe bağlı <code>Kişi;Taksit;Tekrar;Not</code>. Aynı gün + aynı başlık + aynı tutar iki kez eklenmez.</div>
  </div>

  <div class="card">
    <h2>Tekrar düzeni</h2>
    <button class="btn ghost js-makerec">Tüm kayıtları aylık tekrara çevir
      <span style="opacity:.6">· ${alive().filter(p => p.recurrence === 'none' && !p.installment).length} kayıt</span></button>
    <div class="note">Daha önce tek seferlik olarak aktardığın kayıtları her ay dönen hale getirir. Taksitler etkilenmez. Sonrasında tek tek "Tekrarlamaz" yapabilirsin.</div>
  </div>

  <div class="card">
    <h2>Tekrar ayarı</h2>
    <button class="btn ghost js-recurtool">Kayıtları aylık tekrara çevir
      <span style="opacity:.6">· ${monthPayments(S.month).filter(p => p.recurrence === 'none').length} tekrarsız kayıt</span></button>
    <div class="note">Yedekten yüklenen eski kayıtlar tek seferlik olarak gelmiş olabilir. Buradan toplu olarak aylık tekrara çevirebilirsin. <strong>Tapu harcı, borç ödemesi gibi gerçekten tek seferlik kalemlerin işaretini kaldır</strong> — yoksa her ay tekrar eder.</div>
  </div>

  <div class="card">
    <h2>Toplu silme</h2>
    <button class="btn ghost js-delmonth">${fmtMonth(S.month)} ayını sil
      <span style="opacity:.6">· ${monthPayments(S.month).length} kayıt</span></button>
    <button class="btn ghost js-delpaid">Geçmiş ödenmişleri temizle
      <span style="opacity:.6">· ${alive().filter(p => p.isPaid && p.dueDate < Calendar_monthStart()).length} kayıt</span></button>
    <button class="btn danger js-delall">Tüm verileri sil
      <span style="opacity:.6">· ${alive().length} kayıt</span></button>
    <div class="note">Silinen kayıtlar dosyada "silindi" damgasıyla kalır; bu sayede silme diğer telefona da geçer. Yanlışlıkla sildiysen Gist'in <strong>revisions</strong> sayfasından eski hale dönebilirsin — her yazma ayrı sürüm olarak saklanıyor.</div>
  </div>

  <div class="card">
    <h2>Hakkında</h2>
    <div class="note" style="margin:0">Sürüm 1.2 · Cihaz kimliği <code>${esc(S.deviceId)}</code><br>
    Bu uygulama tarayıcıda çalışır, ana ekrana eklenebilir, süresi dolmaz.</div>
  </div>`;
}

/** Bu ayın ilk günü (geçmiş ödenmişleri ayıklamak için). */
function Calendar_monthStart() { return S.month + '-01'; }

/* ---------------------------------------------------------
   9. Kayıt düzenleme sayfası
   --------------------------------------------------------- */

function openEditor(p, isNew) {
  const draft = JSON.parse(JSON.stringify(p));
  let instCount = 1, splitTotal = true;

  function html() {
    const cats = catsFor(draft.kind);
    return `<div class="modal"><div class="sheet">
      <div class="sheet-bar">
        <button class="js-cancel">Vazgeç</button>
        <div class="ttl">${isNew ? 'Yeni Kayıt' : 'Kaydı Düzenle'}</div>
        <button class="primary js-save">Kaydet</button>
      </div>

      <label class="field"><span>Başlık</span>
        <input type="text" id="fTitle" value="${esc(draft.title)}" placeholder="Kredi kartı"></label>

      <div class="seg" style="margin-bottom:12px">
        <button class="js-kind ${draft.kind === 'expense' ? 'on' : ''}" data-k="expense">Gider</button>
        <button class="js-kind ${draft.kind === 'income' ? 'on' : ''}" data-k="income">Gelir</button>
      </div>

      <label class="field"><span>Kategori</span>
        <select id="fCat">${cats.map(c => `<option ${c.name === draft.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        <option value="__new">+ Yeni kategori…</option></select></label>

      <label class="field"><span>Kişi</span>
        <select id="fOwner">${S.members.map(m => `<option ${m === draft.owner ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>

      <label class="field"><span>Vade tarihi</span>
        <input type="date" id="fDate" value="${draft.dueDate}"></label>

      <label class="field"><span>Para birimi</span>
        <select id="fCur">${Object.entries(CURRENCIES).map(([k, v]) =>
          `<option value="${k}" ${k === draft.currency ? 'selected' : ''}>${k} — ${v.name}</option>`).join('')}</select></label>

      <label class="field"><span>Tutar${draft.currency === 'XAU' ? ' (gram)' : ''}</span>
        <input type="text" inputmode="decimal" id="fAmt" value="${draft.amount || ''}"></label>
      ${draft.currency !== 'TRY' && rateOf(draft.currency) > 0
        ? `<div class="note" style="margin-top:-6px">TL karşılığı ≈ ${money(draft.amount * rateOf(draft.currency))}</div>` : ''}

      ${isNew ? `
      <label class="field"><span>Taksit sayısı</span>
        <input type="number" id="fInst" min="1" max="60" value="${instCount}"></label>
      <div id="instBox">${instCount > 1 ? `
        <div class="seg" style="margin-bottom:8px">
          <button class="js-split ${splitTotal ? 'on' : ''}" data-v="1">Girdiğim toplam</button>
          <button class="js-split ${!splitTotal ? 'on' : ''}" data-v="0">Girdiğim aylık</button>
        </div>
        <div class="note">Aylık ${money(splitTotal ? draft.amount / instCount : draft.amount, draft.currency)} ·
          Toplam ${money(splitTotal ? draft.amount : draft.amount * instCount, draft.currency)} ·
          Son taksit ${fmtDay(addMonths(draft.dueDate, instCount - 1))}</div>` : ''}</div>` : ''}

      ${draft.installment ? `<div class="note">Bu kayıt ${draft.installment.index}/${draft.installment.total}. taksit.</div>` : ''}

      <label class="field"><span>Tekrar</span>
        <select id="fRep">
          ${[['none', 'Tekrarlamaz'], ['weekly', 'Her hafta'], ['monthly', 'Her ay'], ['quarterly', '3 ayda bir'], ['yearly', 'Her yıl']]
            .map(([k, v]) => `<option value="${k}" ${draft.recurrence === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></label>

      <div class="switch"><div class="lbl">Ödendi</div>
        <input type="checkbox" id="fPaid" ${draft.isPaid ? 'checked' : ''}></div>
      <div class="switch"><div class="lbl">Hatırlatma gönder
        <small>${S.cfg.leadDays} gün önce başlar, ödenene kadar devam eder</small></div>
        <input type="checkbox" id="fRem" ${draft.reminder ? 'checked' : ''}></div>

      <label class="field" style="margin-top:12px"><span>Not</span>
        <textarea id="fNote">${esc(draft.note)}</textarea></label>

      ${!isNew ? `<button class="btn danger js-del">Kaydı sil</button>
        ${draft.installment ? '<button class="btn danger js-delg">Tüm taksit planını sil</button>' : ''}
        <div class="note">Son düzenleyen: ${esc(draft.editedBy || '—')} · ${fmtStamp(draft.updatedAt)}</div>` : ''}
    </div></div>`;
  }

  function collect() {
    const g = (id) => $('#' + id);
    draft.title = g('fTitle').value.trim();
    draft.category = g('fCat').value === '__new' ? draft.category : g('fCat').value;
    draft.owner = g('fOwner').value;
    draft.dueDate = g('fDate').value || todayISO();
    draft.currency = g('fCur').value;
    draft.amount = parseNum(g('fAmt').value);
    draft.recurrence = g('fRep').value;
    draft.note = g('fNote').value;
    draft.reminder = g('fRem').checked;
    const paid = g('fPaid').checked;
    if (paid !== draft.isPaid) {
      draft.isPaid = paid;
      draft.paidAmount = paid ? draft.amount : 0;
      draft.paidDate = paid ? todayISO() : null;
    } else if (paid) { draft.paidAmount = draft.amount; }
    if (isNew && g('fInst')) instCount = Math.max(1, Math.min(60, parseInt(g('fInst').value) || 1));
  }

  function draw() {
    $('#modalHost').innerHTML = html();
    const host = $('#modalHost');

    host.querySelector('.js-cancel').onclick = () => { host.innerHTML = ''; };

    host.querySelectorAll('.js-kind').forEach(b => b.onclick = () => {
      collect(); draft.kind = b.dataset.k;
      const list = catsFor(draft.kind);
      if (!list.some(c => c.name === draft.category)) draft.category = list[0] ? list[0].name : 'Diğer';
      draw();
    });

    host.querySelectorAll('.js-split').forEach(b => b.onclick = () => { collect(); splitTotal = b.dataset.v === '1'; draw(); });

    const cur = $('#fCur'); if (cur) cur.onchange = () => { collect(); draw(); };
    const inst = $('#fInst'); if (inst) inst.onchange = () => { collect(); draw(); };

    const catSel = $('#fCat');
    if (catSel) catSel.onchange = () => {
      if (catSel.value === '__new') {
        const name = prompt('Yeni kategori adı');
        collect();
        if (name && name.trim()) { ensureCat(name.trim(), draft.kind); draft.category = name.trim(); }
        draw();
      }
    };

    const delBtn = host.querySelector('.js-del');
    if (delBtn) delBtn.onclick = () => {
      const future = futureOfSeries(draft).length;
      if (!isNew && inSeries(draft) && future > 0) {
        askScope('Kaydı sil', `“${draft.title}” tekrarlayan bir kayıt. Sonrasında ${future} ay daha planlı.`, [
          ['one', 'Yalnızca bu ay', fmtMonth(monthKey(draft.dueDate)) + ' ayındaki kayıt silinir'],
          ['future', 'Bu ay ve sonrakiler', `Bu ay dahil ${future + 1} kayıt silinir`],
          ['all', 'Tüm geçmişiyle birlikte', 'Serinin tamamı silinir, geçmiş aylar dahil']
        ], (mode) => {
          const n = deleteScoped(draft, mode);
          host.innerHTML = ''; render(); toast(n + ' kayıt silindi');
        });
        return;
      }
      if (!confirm('Bu kaydı silmek istediğine emin misin?')) return;
      removePayment(draft); host.innerHTML = ''; render();
    };
    const delG = host.querySelector('.js-delg');
    if (delG) delG.onclick = () => {
      if (!confirm('Tüm taksit planı silinecek. Emin misin?')) return;
      removeGroup(draft.installment.groupId); host.innerHTML = ''; render();
    };

    host.querySelector('.js-save').onclick = () => {
      collect();
      if (!draft.title) { toast('Başlık boş olamaz'); return; }
      ensureCat(draft.category, draft.kind);

      if (isNew) {
        if (instCount > 1) createInstallments(draft, instCount, splitTotal);
        else upsert(draft);
        host.innerHTML = ''; render();
        return;
      }

      // Tekrarlayan bir kaydın içeriği değiştiyse kapsamı sor.
      const future = futureOfSeries(draft).length;
      const contentChanged = ['title', 'kind', 'category', 'amount', 'currency', 'owner',
                              'note', 'reminder', 'recurrence', 'dueDate']
        .some(f => JSON.stringify(draft[f]) !== JSON.stringify(p[f]));

      if (inSeries(draft) && future > 0 && contentChanged) {
        askScope('Değişikliği nereye uygulayalım?',
          `“${draft.title}” her ay tekrarlıyor. Sonrasında ${future} ay daha planlı.`, [
          ['one', 'Yalnızca bu ay', 'Sonraki aylar eski haliyle kalır'],
          ['future', 'Bu ay ve sonraki aylar', `${future} ay güncellenir. Ödenmiş geçmiş aylara dokunulmaz`]
        ], (mode) => {
          const n = saveEdit(draft, p, mode);
          host.innerHTML = ''; render();
          toast(mode === 'future' ? `Bu ay ve sonraki ${n} ay güncellendi` : 'Yalnızca bu ay güncellendi');
        });
        return;
      }

      upsert(draft);
      host.innerHTML = '';
      render();
    };
  }

  draw();
}

/** Seçenek soran alt sayfa. seçenekler: [değer, başlık, açıklama][] */
function askScope(title, detail, options, onPick) {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal"><div class="sheet">
    <div class="sheet-bar"><div class="ttl">${esc(title)}</div>
      <button class="js-x">Vazgeç</button></div>
    <div class="note" style="margin-top:0">${esc(detail)}</div>
    ${options.map(([v, t, d]) => `
      <button class="btn ghost js-pick" data-v="${v}" style="text-align:left;padding:14px">
        <div style="font-weight:600">${esc(t)}</div>
        <div style="font-size:11.5px;color:var(--muted);margin-top:3px;font-weight:400">${esc(d)}</div>
      </button>`).join('')}
  </div></div>`;
  host.querySelector('.js-x').onclick = () => { host.innerHTML = ''; };
  host.querySelectorAll('.js-pick').forEach(b => b.onclick = () => onPick(b.dataset.v));
}

/* ---------------------------------------------------------
   10. İçe aktarma sayfası
   --------------------------------------------------------- */

function openImport() {
  const host = $('#modalHost');
  host.innerHTML = `<div class="modal"><div class="sheet">
    <div class="sheet-bar">
      <button class="js-cancel">Vazgeç</button>
      <div class="ttl">Metinden içe aktar</div>
      <button class="primary js-go">Aktar</button>
    </div>
    <div class="switch"><div class="lbl">Mevcut kayıtları sil ve değiştir</div>
      <input type="checkbox" id="repl"></div>
    <div class="switch"><div class="lbl">Her ay tekrarlansın
      <small>Excel'deki kalemler genelde her ay döner. Tekrar sütununda "Tekrarlamaz" yazan satırlar tek seferlik kalır.</small></div>
      <input type="checkbox" id="rec" checked></div>
    <label class="field" style="margin-top:12px"><span>Excel satırlarını buraya yapıştır</span>
      <textarea id="csvText" style="min-height:240px;font-family:ui-monospace,monospace;font-size:12px"
        placeholder="Tarih;Başlık;Tür;Kategori;Tutar;Ödenen tutar;Para birimi;Durum"></textarea></label>
  </div></div>`;
  host.querySelector('.js-cancel').onclick = () => { host.innerHTML = ''; };
  host.querySelector('.js-go').onclick = () => {
    const r = importCSV($('#csvText').value, $('#repl').checked, $('#rec').checked);
    host.innerHTML = '';
    materialize();
    render();
    toast(`${r.added} kayıt eklendi${r.skipped ? `, ${r.skipped} satır atlandı` : ''}`, 4000);
  };
}

/**
 * Seçili aydaki kayıtların tekrar ayarını toplu değiştirir.
 * Tek seferlik olması gerekenler kullanıcı tarafından işaretten çıkarılır.
 */
function openRecurrenceTool() {
  const host = $('#modalHost');

  // Tek seferlik olma ihtimali yüksek kalemler baştan işaretsiz gelsin
  const ONE_OFF_HINTS = /harc|harç|borç|borc|tapu|ceza|peşinat|pesinat|masraf|devir|puan aktar/i;

  const list = monthPayments(S.month)
    .filter(p => p.recurrence === 'none')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  if (!list.length) {
    toast(`${fmtMonth(S.month)} ayında tekrarsız kayıt yok`);
    return;
  }

  const rows = list.map(p => `
    <label class="pick-row">
      <input type="checkbox" data-rid="${p.id}" ${ONE_OFF_HINTS.test(p.title) ? '' : 'checked'}>
      <span class="pick-main">
        <span class="pick-t">${esc(p.title)}</span>
        <span class="pick-m">${fmtDay(p.dueDate)} · ${esc(p.category)} · ${p.kind === 'income' ? 'Gelir' : 'Gider'}</span>
      </span>
      <span class="pick-a">${money(p.amount, p.currency)}</span>
    </label>`).join('');

  host.innerHTML = `<div class="modal"><div class="sheet">
    <div class="sheet-bar">
      <button class="js-cancel">Vazgeç</button>
      <div class="ttl">Aylık tekrara çevir</div>
      <button class="primary js-apply">Uygula</button>
    </div>
    <div class="note" style="margin-top:0">${fmtMonth(S.month)} ayındaki ${list.length} tekrarsız kayıt.
      İşaretli olanlar <strong>her ay</strong> tekrarlanacak. Tek seferlik olanların işaretini kaldır.</div>
    <div class="seg" style="margin-bottom:10px">
      <button class="js-all">Hepsini seç</button>
      <button class="js-none">Hiçbirini seçme</button>
    </div>
    ${rows}
    <div class="note">Çevirdiğin kayıtlar bugünden 3 ay ilerisine kadar otomatik oluşturulur; sonrası siz uygulamayı açtıkça eklenir. Sonradan fikrini değiştirirsen kaydı açıp Tekrar alanını "Tekrarlamaz" yapman yeterli.</div>
  </div></div>`;

  const boxes = () => host.querySelectorAll('input[data-rid]');
  host.querySelector('.js-cancel').onclick = () => { host.innerHTML = ''; };
  host.querySelector('.js-all').onclick = () => boxes().forEach(b => b.checked = true);
  host.querySelector('.js-none').onclick = () => boxes().forEach(b => b.checked = false);

  host.querySelector('.js-apply').onclick = () => {
    const chosen = new Set([...boxes()].filter(b => b.checked).map(b => b.dataset.rid));
    if (!chosen.size) { toast('Hiçbir kayıt seçilmedi'); return; }

    let n = 0;
    for (const p of S.payments) {
      if (!p.deleted && chosen.has(p.id) && p.recurrence === 'none') {
        p.recurrence = 'monthly';
        touch(p);
        n++;
      }
    }
    materialize();
    scheduleSync();
    host.innerHTML = '';
    render();
    toast(`${n} kayıt her ay tekrarlanacak şekilde ayarlandı`, 4000);
  };
}

/* ---------------------------------------------------------
   11. Yönlendirme ve olaylar
   --------------------------------------------------------- */

const TITLES = { dash: 'Özet', list: 'Ödemeler', cal: 'Takvim', stats: 'Analiz', set: 'Ayarlar' };

function render() {
  $('#pageTitle').textContent = TITLES[S.tab];
  $('#btnSync').innerHTML = S.syncing ? '<span class="spin"></span>' : '⟳';
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));

  app.innerHTML =
    S.tab === 'dash' ? viewDash() :
    S.tab === 'list' ? viewList() :
    S.tab === 'cal' ? viewCal() :
    S.tab === 'stats' ? viewStats() : viewSettings();

  bind();
}

function bind() {
  // Ay ileri/geri
  app.querySelectorAll('.js-m').forEach(b => b.onclick = () => {
    const d = parseInt(b.dataset.d);
    if (d === 0) { S.month = monthKey(todayISO()); S.selDay = todayISO(); render(); }
    else shiftMonth(d);
  });

  // Satır: düzenle / ödendi
  app.querySelectorAll('.row').forEach(row => {
    const p = S.payments.find(x => x.id === row.dataset.id);
    if (!p) return;
    row.querySelectorAll('.js-edit').forEach(el => el.onclick = () => openEditor(p, false));
    const tick = row.querySelector('.js-tick');
    if (tick) tick.onclick = (e) => { e.stopPropagation(); markPaid(p, !p.isPaid); render(); };
  });

  app.querySelectorAll('.js-fill').forEach(b => b.onclick = () => {
    const before = alive().length;
    materialize(S.month + '-28');
    scheduleSync();
    render();
    toast((alive().length - before) + ' kayıt oluşturuldu');
  });

  app.querySelectorAll('.js-scope').forEach(b => b.onclick = () => { S.scope = b.dataset.k; render(); });
  app.querySelectorAll('.js-kind').forEach(b => b.onclick = () => {
    S.listKind = b.dataset.k;
    window.scrollTo(0, 0);
    render();
  });
  app.querySelectorAll('.js-day').forEach(b => b.onclick = () => { S.selDay = b.dataset.d; render(); });
  app.querySelectorAll('.js-delgroup').forEach(b => b.onclick = () => {
    if (confirm('Taksit planı silinsin mi?')) { removeGroup(b.dataset.g); render(); }
  });
  app.querySelectorAll('.js-rates').forEach(b => b.onclick = async () => {
    S.ratesLoading = true; render();
    await refreshRates(true);
    S.ratesLoading = false; render();
  });

  const q = $('#q');
  if (q) {
    q.oninput = () => {
      S.query = q.value;
      const pos = q.selectionStart;
      render();
      const nq = $('#q');
      if (nq) { nq.focus(); nq.setSelectionRange(pos, pos); }
    };
  }

  if (S.tab === 'set') bindSettings();
}

/** Yatay kaydırma ile ay değiştirme.
    Dinleyiciler yalnızca bir kez bağlanır — her çizimde yeniden bağlanırsa
    birikir ve tek kaydırma birden çok ay atlatır. */
function attachSwipe() {
  let x0 = null, y0 = null;

  const allowed = () => S.tab !== 'set' && !(S.tab === 'list' && S.listKind === 'inst');

  app.addEventListener('touchstart', (e) => {
    if (!allowed() || e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });

  app.addEventListener('touchend', (e) => {
    if (x0 === null || !allowed()) { x0 = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70) return;                 // kısa dokunuşları yok say
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return; // dikey kaydırmayı bozma
    shiftMonth(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function shiftMonth(delta) {
  S.month = monthKey(addMonths(S.month + '-01', delta));
  // Takvimde seçili gün yeni ayın dışında kalmasın
  if (monthKey(S.selDay) !== S.month) {
    S.selDay = (S.month === monthKey(todayISO())) ? todayISO() : S.month + '-01';
  }
  window.scrollTo(0, 0);
  render();
}

function bindSettings() {
  const on = (sel, fn) => { const el = app.querySelector(sel); if (el) el.onclick = fn; };

  on('.js-savecfg', async () => {
    S.cfg.gistId = $('#cfgGist').value.trim();
    S.cfg.gistUser = $('#cfgUser').value.trim();
    // Anahtar/parola artık ekrana basılmıyor. Alan boşsa "değiştirme" demektir,
    // "sil" değil — silmek için "Anahtarı bu cihazdan sil" düğmesi var.
    const tokenIn = $('#cfgToken').value.trim();
    const passIn = $('#cfgPass').value;
    if (tokenIn) S.cfg.token = tokenIn;
    if (passIn) S.cfg.passphrase = passIn;
    S.deviceName = $('#cfgDevice').value.trim() || 'Cihaz';
    LS.set('deviceName', S.deviceName);
    saveLocal();
    await syncNow();
  });

  on('.js-forget', () => {
    if (!confirm('Erişim anahtarı ve ortak parola bu cihazdan silinsin mi?\n\nKayıtların silinmez — bu telefonda ve Gist\'te durmaya devam eder. Yeniden eşitlemek için anahtarı tekrar girmen gerekir.')) return;
    S.cfg.token = '';
    S.cfg.passphrase = '';
    saveLocal();
    S.syncMsg = 'Anahtar silindi';
    render();
    toast('Anahtar ve parola bu cihazdan silindi');
  });

  on('.js-savenotif', async () => {
    S.cfg.notify = $('#cfgNotify').checked;
    S.cfg.leadDays = Math.max(0, Math.min(7, parseInt($('#cfgLead').value) || 0));
    S.cfg.overdueDays = Math.max(1, Math.min(30, parseInt($('#cfgOver').value) || 14));
    S.cfg.alarmHour = Math.max(0, Math.min(23, parseInt($('#cfgHour').value) || 9));
    S.cfg.icsWindowDays = Math.max(7, Math.min(180, parseInt($('#cfgWin').value) || 31));
    S.cfg.icsGistId = $('#cfgIcsGist').value.trim();
    S.cfg.icsPrivacy = $('#cfgPriv').checked;
    saveLocal();
    await syncNow();
    toast(S.cfg.notify ? 'Kaydedildi, takvim güncellendi'
                       : 'Bildirimler kapatıldı, takvim boşaltıldı', 4000);
  });

  on('.js-copyics', async () => {
    const url = `https://gist.githubusercontent.com/${S.cfg.gistUser}/${S.cfg.gistId}/raw/takvim.ics`;
    try { await navigator.clipboard.writeText(url); toast('Adres kopyalandı'); }
    catch { prompt('Adresi kopyala:', url); }
  });

  on('.js-manual', () => {
    const ask = (n, cur) => parseNum(prompt(n, cur ? String(cur.toFixed(4)) : '') || '0');
    const u = ask('USD/TRY', S.rates.USD);
    const e = ask('EUR/TRY', S.rates.EUR);
    const g = ask('GBP/TRY', S.rates.GBP);
    const a = ask('Gram altın TL', S.rates.XAU);
    const r = { ...S.rates, TRY: 1 };
    if (u > 0) r.USD = u; if (e > 0) r.EUR = e; if (g > 0) r.GBP = g; if (a > 0) r.XAU = a;
    r.at = Date.now(); r.fxSrc = 'Elle girildi'; r.goldSrc = 'Elle girildi';
    S.rates = r; LS.set('rates', r); render(); toast('Kurlar güncellendi');
  });

  on('.js-addmember', () => {
    const v = $('#newMember').value.trim();
    if (!v || S.members.includes(v)) return;
    S.members.push(v); scheduleSync(); render();
  });

  app.querySelectorAll('.js-delmember').forEach(b => b.onclick = () => {
    S.members = S.members.filter(m => m !== b.dataset.m);
    scheduleSync(); render();
  });

  on('.js-makerec', () => {
    const list = alive().filter(p => p.recurrence === 'none' && !p.installment);
    if (!list.length) { toast('Çevrilecek kayıt yok'); return; }
    if (!confirm(`${list.length} kayıt her ay tekrarlayacak şekilde ayarlanacak. Emin misin?`)) return;
    list.forEach(p => { p.recurrence = 'monthly'; if (!p.seriesId) p.seriesId = p.id; touch(p); });
    materialize();
    scheduleSync();
    render();
    toast(list.length + ' kayıt aylık tekrara çevrildi');
  });

  on('.js-delmonth', () => {
    const n = monthPayments(S.month).length;
    if (!n) { toast('Bu ayda kayıt yok'); return; }
    if (!confirm(`${fmtMonth(S.month)} ayındaki ${n} kayıt silinecek. Emin misin?`)) return;
    const ym = S.month;
    toast(bulkDelete(p => monthKey(p.dueDate) === ym) + ' kayıt silindi');
    render();
  });

  on('.js-delpaid', () => {
    const start = Calendar_monthStart();
    const n = alive().filter(p => p.isPaid && p.dueDate < start).length;
    if (!n) { toast('Temizlenecek kayıt yok'); return; }
    if (!confirm(`${fmtMonth(S.month)} öncesindeki ${n} ödenmiş kayıt silinecek. Emin misin?`)) return;
    toast(bulkDelete(p => p.isPaid && p.dueDate < start) + ' kayıt silindi');
    render();
  });

  on('.js-delall', () => {
    const n = alive().length;
    if (!n) { toast('Zaten boş'); return; }
    if (!confirm(`TÜM kayıtlar silinecek (${n} adet). Bu işlem diğer telefona da yansır. Emin misin?`)) return;
    if (!confirm('Son kez soruyorum: gerçekten hepsi silinsin mi?')) return;
    toast(bulkDelete(() => true) + ' kayıt silindi');
    render();
  });

  on('.js-recurtool', openRecurrenceTool);
  on('.js-dedupe', async () => {
    const r = dedupeOccurrences();
    if (r.removed) { scheduleSync(); render(); }
    toast(r.removed
      ? `${r.removed} ikiz kayıt silindi${r.conflicts ? `, ${r.conflicts} tanesi elle bakmanı bekliyor` : ''}`
      : (r.conflicts ? `${r.conflicts} slotta iki kopya da ödenmiş — elle bak` : 'İkilenmiş kayıt yok'), 4000);
  });

  const nt = $('#cfgNotify');
  if (nt) nt.onchange = async () => {
    S.cfg.notify = nt.checked;
    saveLocal();
    render();
    await syncNow();
  };

  on('.js-import', openImport);
  on('.js-export', () => download(`odedimmi-${todayISO()}.csv`, exportCSV()));
  on('.js-importfile', () => $('#fileIn').click());

  const f = $('#fileIn');
  if (f) f.onchange = () => {
    const file = f.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      const r = importCSV(String(rd.result), false, true);
      materialize();
      render();
      toast(`${r.added} kayıt eklendi${r.skipped ? `, ${r.skipped} atlandı` : ''}`, 4000);
    };
    rd.readAsText(file, 'utf-8');
  };

  const prem = $('#cfgPrem');
  if (prem) prem.onchange = async () => {
    S.cfg.goldPremium = parseFloat(prem.value) || 0;
    saveLocal();
    await refreshRates(true);
  };
}

/* ---------------------------------------------------------
   12. Başlangıç
   --------------------------------------------------------- */

document.querySelectorAll('nav.tabs button').forEach(b => {
  b.onclick = () => { S.tab = b.dataset.tab; window.scrollTo(0, 0); render(); };
});
$('#btnAdd').onclick = () => openEditor(blank(), true);
$('#btnSync').onclick = () => syncNow();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    materialize();
    refreshRates(false);
    syncNow(true);
  }
});

(async function init() {
  loadLocal();
  materialize();
  render();
  attachSwipe();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch {}
  }
  refreshRates(false);
  if (S.cfg.gistId && S.cfg.token) syncNow(true);
})();
