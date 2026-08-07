# L-5 (LOW) — Response cache in-memory tidak efektif di serverless

Status: **Fixed**

File terdampak:

- `src/lib/responseCache.js`
- `src/routes/productCatalogRoutes.js`
- `src/routes/promoRoutes.js`
- `test/responseCache.test.js` (baru)

## 1. Masalah

Katalog produk dan promo sebelumnya hanya memakai cache berupa `Map` di
memori proses:

```js
function createResponseCache(defaultTtlMs) {
  const store = new Map();

  return {
    get(key) { /* ... */ },
    set(key, value, ttlMs = defaultTtlMs) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    clear() { store.clear(); },
  };
}
```

Pendekatan tersebut bermasalah pada deployment serverless:

- setiap instance memiliki `Map` sendiri sehingga hit pada satu instance
  tidak membantu instance lain;
- seluruh cache hilang saat cold start;
- tidak ada batas jumlah entry atau eviction;
- variasi query seperti `category_id` dan halaman promo dapat terus menambah
  entry selama instance hidup;
- TTL environment yang tidak valid dapat menghasilkan `NaN` dan entry yang
  tidak pernah dikenali sebagai kedaluwarsa.

## 2. Kondisi sebelum perbaikan

Respons sukses tidak memberikan instruksi cache HTTP:

```http
GET /api/catalog/products HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json

[{"id":1,"name":"..."}]
```

Request yang masuk ke instance serverless lain atau instance baru selalu
mengakses database kembali meskipun URL dan hasilnya sama.

## 3. Perbaikan

Perbaikan menggunakan dua lapis yang saling melengkapi:

```text
Client/browser
  -> shared HTTP cache / CDN (lintas instance)
    -> bounded LRU cache (maksimal 100 entry per instance)
      -> PostgreSQL
```

### 3.1 Cache HTTP lintas-instance

Setiap respons sukses katalog produk dan promo sekarang mengirim:

```http
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=60
```

Arti directive:

| Directive | Fungsi |
|---|---|
| `public` | Respons endpoint publik boleh disimpan shared cache |
| `max-age=60` | Browser boleh memakai respons selama maksimal 60 detik |
| `s-maxage=300` | Shared cache/CDN boleh memakai respons selama 300 detik |
| `stale-while-revalidate=60` | Shared cache dapat melayani data lama selama revalidasi singkat |

Shared cache berada di depan fungsi serverless, sehingga cache hit tidak
bergantung pada instance yang menangani request sebelumnya dan tetap efektif
ketika instance mengalami cold start.

TTL `s-maxage` mengikuti `CATALOG_RESPONSE_CACHE_TTL_MS` atau
`PROMO_RESPONSE_CACHE_TTL_MS`. Nilai default tetap 5 menit. Bila konfigurasi
kosong, bukan angka, nol, atau negatif, helper memakai default aman 5 menit.

Header hanya dipasang pada jalur respons sukses. Error validasi atau server
tidak diberi kebijakan public cache oleh perubahan ini.

### 3.2 Cache lokal dibatasi dengan LRU

Cache lokal tetap dipertahankan untuk menghindari query database berulang
ketika request memang mencapai instance yang sama. Sekarang kedua route
membuat cache dengan batas eksplisit:

```js
createResponseCache(ttlMs, { maxEntries: 100 });
```

Aturan eviction:

1. entry kedaluwarsa dibersihkan saat penulisan;
2. pembacaan entry memindahkannya menjadi entry terbaru;
3. ketika batas tercapai, entry yang paling lama tidak digunakan
   (*least recently used*) dihapus;
4. `maxEntries` selalu dinormalisasi minimal 1 agar konfigurasi abnormal tidak
   menimbulkan loop atau cache tanpa batas.

Dengan batas 100 entry per cache, pertumbuhan jumlah object cache menjadi
terukur. Katalog dan promo memakai instance cache berbeda, sehingga batas
masing-masing adalah 100 entry.

## 4. Output setelah perbaikan

### Katalog produk

```http
GET /api/catalog/products?category_id=12 HTTP/1.1

HTTP/1.1 200 OK
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=60
Content-Type: application/json

[{"id":101,"name":"Crisbar ...","category_id":12}]
```

### Promo dengan pagination

```http
GET /api/promos?page=1&limit=8&status=active HTTP/1.1

HTTP/1.1 200 OK
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=60
Content-Type: application/json

{"items":[],"page":1,"limit":8,"total":0,"total_pages":1}
```

### Error tetap tidak di-cache publik

```http
GET /api/promos?status=invalid HTTP/1.1

HTTP/1.1 400 Bad Request
Content-Type: application/json
(tidak ada Cache-Control public dari responseCache)
```

## 5. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Cache lintas-instance | Tidak ada | HTTP shared cache/CDN melalui `s-maxage` |
| Dampak cold start | Cache selalu kosong | Shared cache tetap dapat melayani respons |
| Batas cache lokal | Tidak terbatas | Maksimal 100 entry per route cache |
| Kebijakan eviction | Hanya hapus saat entry itu dibaca setelah expired | Expiry cleanup + LRU eviction |
| TTL invalid | Dapat menjadi `NaN` | Fallback aman 5 menit |
| Browser cache | Tidak didefinisikan | Maksimal 60 detik |
| Respons error | Tidak memiliki kebijakan dari cache | Tetap tidak di-cache publik |
| Dependency/infrastruktur baru | — | Tidak ada; memanfaatkan HTTP cache standar |

## 6. Pertimbangan keamanan dan stabilitas

- Hanya endpoint publik dengan bentuk respons sama untuk semua pengguna yang
  diberi `public`; endpoint customer/admin tidak diubah.
- Data katalog dan promo memang sebelumnya sudah di-cache selama 5 menit,
  sehingga batas freshness bisnis tidak diperlonggar.
- Browser diberi TTL lebih pendek daripada shared cache agar pengguna dapat
  memperoleh pembaruan lebih cepat.
- `stale-while-revalidate` mengurangi lonjakan query serentak ketika entry
  shared cache kedaluwarsa.
- Cache lokal tetap merupakan optimasi, bukan sumber kebenaran. PostgreSQL
  tetap menjadi sumber data utama.

## 7. Verifikasi otomatis

`test/responseCache.test.js` memverifikasi:

1. eviction benar-benar LRU, bukan sekadar FIFO;
2. entry kedaluwarsa dihapus;
3. TTL invalid memakai default 5 menit;
4. helper menghasilkan `Cache-Control` yang tepat;
5. route katalog nyata mengirim header shared-cache;
6. route promo nyata mengirim header shared-cache.

Perintah verifikasi:

```text
node --test test/responseCache.test.js
npm test
node --check src/lib/responseCache.js
node --check src/routes/productCatalogRoutes.js
node --check src/routes/promoRoutes.js
```

## 8. Pengukuran operasional

Setelah deployment, ukur:

- rasio cache `HIT`/`MISS` pada CDN atau reverse proxy;
- penurunan jumlah query `menuItem.findMany`, `promo.findMany`, dan
  `promo.count`;
- latensi p50/p95 untuk `/api/catalog/products*` dan `/api/promos*`;
- freshness data setelah proses sinkronisasi katalog/promo;
- penggunaan memori function untuk memastikan batas lokal bekerja sesuai
  ekspektasi.

Target keberhasilan utamanya adalah request cache-hit tidak menjalankan fungsi
serverless/database, sementara jumlah entry lokal tidak pernah melewati 100
per cache.

## 9. Checklist deployment

1. Tidak ada migration, dependency, Redis, atau environment variable baru.
2. Pastikan platform/CDN menghormati directive standar `s-maxage`.
3. Setelah deploy, panggil URL katalog/promo yang sama dua kali dan periksa
   header cache platform untuk memastikan request kedua menjadi cache hit.
4. Bila platform tidak menyediakan shared HTTP cache, tempatkan CDN/reverse
   proxy yang menghormati `Cache-Control` di depan API; bounded LRU lokal tetap
   mencegah pertumbuhan memori sambil konfigurasi tersebut dilakukan.
5. Jika kebutuhan invalidasi berubah menjadi real-time, gunakan purge CDN atau
   turunkan TTL; jangan mengubah endpoint berisi data privat menjadi `public`.
