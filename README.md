# Ödedim mi

Sunucusuz, iki kişilik ortak ödeme ve bütçe takibi. iOS'ta ana ekrana eklenen PWA.
Çerçeve yok, derleme adımı yok, bağımlılık yok — düz HTML/CSS/JS.

**Sürüm 1.3** · Arayüz dili Türkçe.

Bu depoda yalnızca kod var. Veri burada değil, kullanıcının kendi gizli Gist'inde.

---

## Mimari

| Katman | Nasıl |
|---|---|
| Barındırma | GitHub Pages (public depo) |
| Veri deposu | Gizli GitHub Gist — cihaz başına bir JSON dosyası |
| Çakışma çözümü | Kayıt bazında son-yazan-kazanır (`updatedAt`) |
| Şifreleme | İsteğe bağlı ortak parola → AES-256-GCM + PBKDF2 (150.000 tur) |
| Bildirim | Gist'e yazılan `takvim.ics` → iOS Takvim aboneliği |
| Kur | Frankfurter (ECB) → yedek er-api; altın gold-api → yedek xaus |

**Senkron:** Her cihaz Gist'e yalnızca kendi `device-<id>.json` dosyasını yazar.
Okurken tüm `device-*.json` dosyaları okunup kayıt bazında birleştirilir.
Silme kaydı dosyadan çıkarmaz, `deleted: true` damgası koyar — yoksa karşı cihaz
"bende var onda yok" deyip silineni geri yükler.

**Bildirim:** Web push sunucu gerektirdiği için kullanılmıyor. Uygulama Gist'e bir
ICS dosyası yazar, telefonlar bu adrese abone olur, uyarıları iOS'un kendisi verir.
Kademe: vade−2 gün, vade−1 gün, vade günü, sonra ödenene kadar her gün "N gün gecikti".

**Kur:** TCMB'nin XML servisi tarayıcıdan CORS ile çağrılamıyor, bu yüzden ECB tabanlı
kaynak kullanılıyor. Gram altın = (XAU/USD ÷ 31,1034768) × USD/TRY × (1 + prim%).

---

## Dosyalar

```
index.html            uygulama kabuğu + CSP (63 satır)
app.js                tüm mantık (1886 satır), bölümler numaralı
styles.css            karanlık/aydınlık tema
sw.js                 çevrimdışı önbellek — CACHE sürümü elle artırılır
manifest.webmanifest  ana ekrana ekleme tanımı
icons/                192 ve 512 px
```

`app.js` bölümleri: 0 yardımcılar · 1 durum · 2 şifreleme · 3 Gist senkronu ·
4 kurlar · 5 ICS üretimi · 6 iş mantığı · 7 CSV · 8 görünümler · 9 kayıt düzenleme ·
10 içe aktarma · 11 yönlendirme/olaylar · 12 başlangıç.

---

## Veri modeli

```js
{
  id, title, kind: 'expense'|'income', category, subcategory,
  amount, paidAmount, currency: 'TRY'|'USD'|'EUR'|'GBP'|'XAU',
  dueDate: 'YYYY-MM-DD', isPaid, paidDate, note, owner,
  installment: { groupId, index, total } | null,
  recurrence: 'none'|'weekly'|'monthly'|'quarterly'|'yearly',
  recurrenceEnd, seriesId, reminder,
  updatedAt, deleted, editedBy
}
```

`XAU` tutarı **gram** cinsindendir. Tekrarlayan kayıtlar `seriesId` ile zincirlenir;
her tekrar ayrı kayıt olarak somutlaştırılır (`materialize()`, 12 ay ileriye kadar).

Ayarlar `localStorage`'da `cfg` anahtarında: `gistId`, `gistUser`, `token`,
`passphrase`, `leadDays`, `overdueDays`, `alarmHour`, `icsPrivacy`, `icsGistId`,
`icsWindowDays`, `goldPremium`.

---

## Değiştirirken uyulacak kurallar

1. **Veri şemasını bozma.** Alan eklemek serbest; mevcut alanın adını veya anlamını
   değiştirmek yasak — iki telefonda yaşayan veri var, eski kayıtlar okunmaya devam etmeli.
2. **Şifreleme yöntemine dokunma.** AES-GCM ve zarf yapısı (`{enc, salt, iv, data}`)
   sabit kalmalı. PBKDF2 tur sayısını değiştirmek de dahil — iki telefon aynı anda
   güncellenmezse eski sürüm yeni veriyi açamaz ve senkron kırılır.
3. **Ödenmiş geçmiş kayıtlara asla dokunma.** Toplu güncellemeler yalnızca ödenmemiş
   ve ileri tarihli kayıtlara uygulanır.
4. **Her güncellemede `sw.js` içindeki `CACHE` sürümünü artır** (şu an `odedimmi-v4`),
   yoksa telefonlar eski kodu göstermeye devam eder.
5. **Kişisel veri koyma.** Bu depo public. İsim, tutar, Gist ID, token, örnek veri —
   hiçbiri koda veya depoya girmemeli. Kişi adları kullanıcının kendi listesinden okunur.
6. **Yeni bir dış adres eklersen `index.html` içindeki CSP `connect-src` listesine de ekle,**
   yoksa istek sessizce engellenir.
7. **Testleri çalıştır.** Aşağıya bak. `node --check app.js` tek başına yeterli değil.

---

## Test

Ortamda tarayıcı yok, Node var. Yöntem: sahte bir DOM (`document`, `localStorage`,
`fetch`, `crypto`) kurulur, `app.js` yüklenir, sonuna `module.exports` eklenerek
fonksiyonlar dışa açılır.

Kapsam (**194 test**): sayı ayrıştırma (Türkçe ondalık), tarih aritmetiği (ay sonu
kırpma dahil), CSV içe/dışa aktarma, taksit bölme, tekrar üretimi, LWW birleştirme,
şifreleme (gidiş-dönüş, yanlış parola, büyük veri), ICS üretimi (ayrıca `icalendar`
python kütüphanesiyle bağımsız doğrulanıyor), oktet bazlı satır katlama, toplu silme,
kapsamlı düzenleme, XSS kaçırma, CSP–kod tutarlılığı, kişisel veri sızıntısı.

---

## Güvenlik notları

- **CSP** `index.html` içinde. `default-src 'none'`, `script-src 'self'`,
  `connect-src` yalnızca kullanılan altı adres. Test, koddaki adreslerle CSP'yi
  karşılaştırıp eksik/fazla varsa uyarır.
- `frame-ancestors` **bilerek yok** — bu direktif `<meta>` etiketinde çalışmıyor,
  yalnızca HTTP başlığıyla verilebiliyor. GitHub Pages'te başlık ayarlanamadığı için
  koruma `app.js` başındaki frame-buster ile yapılıyor.
- **Token ve ortak parola DOM'a basılmaz.** Ayarlar'da alanlar boş gelir, yanlarında
  "kayıtlı" rozeti durur. Boş bırakılıp kaydedilirse mevcut değer korunur.
  Silmek için ayrı düğme var.
- **`takvim.ics` şifresiz durmak zorunda** — iOS Takvim'in okuyabilmesi için. Bu yüzden
  pencere dar tutulur (varsayılan 31 gün) ve isteğe bağlı olarak ayrı bir Gist'e
  yazılabilir (`icsGistId`). Ayrı Gist'e geçildiğinde ana Gist'teki eski dosya silinir.
- Erişim anahtarı `localStorage`'da düz durur. Yetkisi yalnızca Gist okuma/yazma.

---

## Bilinen sınırlar

- Hatırlatma Takvim uygulamasından gelir; bildirime basılı tutup "Ödedim" denemez.
- Takvim aboneliği en sık saatte bir yenilenir.
- ECB tabanlı kur, TCMB satış kurundan bir miktar sapabilir (elle kur girme seçeneği var).
- Face ID kilidi, widget, Apple Watch yok.

---

## Yapılabilecekler

- Listede çoklu seçip toplu silme/düzenleme
- Kategori ve kişi bazlı toplu silme
- 12 aylık projeksiyonun somutlaştırılmamış ayları da hesaba katması
- Bütçe/limit uyarısı (kategori bazlı aylık tavan)
- Gist revizyonlarından uygulama içinden geri alma
- Açılış kilidi: token'ı ortak parolayla şifreleyip açılışta sormak
