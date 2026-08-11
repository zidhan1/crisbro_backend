# H-5 (HIGH) — Admin console monolit dan tanpa code-splitting komponen berat

Status: **Fixed (bundle boundary dan render isolation)** — dead code sisa
refactor sudah dibersihkan dan pemecahan per-tab sudah dimulai; lihat
bagian 14 untuk lingkup yang sudah dan belum dituntaskan.

File terdampak:

- Frontend: `src/routes/admin.tsx`
- Frontend: `src/routes/marketing.tsx`
- Frontend: `src/features/admin/AdminPage.tsx`
- Frontend: `src/features/admin/AdminActivityTab.tsx` (baru)
- Frontend: `src/features/admin/AdminActivityTab.test.tsx` (baru)
- Frontend: `src/features/admin/adminUiPrimitives.tsx` (baru)

Kategori: **Performa frontend, Arsitektur, Bundle**

## 1. Masalah

Sebelum perbaikan, seluruh implementasi console berada di
`src/routes/admin.tsx`, sekitar 4.600 baris/175 KB source. File tersebut
memegang state, form, tabel, dialog, report, dan tiga chart Recharts sekaligus.

`marketing.tsx` mengimpor komponen dari route admin:

```tsx
import { AdminPage } from "./admin";
```

Recharts dan wrapper chart juga diimpor statis di bagian atas route:

```tsx
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
```

Akibatnya route, implementasi console bersama, dan dependency visualisasi
tidak memiliki boundary lazy yang eksplisit. Marketing juga bergantung pada
modul route admin, padahal route module seharusnya hanya mendefinisikan route.

Selain masalah bundle, perubahan state pada form membuat fungsi `AdminPage`
dieksekusi ulang. Pohon chart adalah bagian paling berat dari render report dan
sebelumnya tidak memiliki memoization boundary.

## 2. Dampak sebelum perbaikan

- Route admin menghasilkan chunk sekitar **83,69 KB** (gzip **19,59 KB**).
- Marketing mengimpor implementasi melalui module route admin.
- Recharts dapat ikut tertarik oleh dependency graph route console walaupun
  chart hanya dibutuhkan pada tab report.
- Tidak tersedia loading fallback khusus ketika implementasi console atau
  chart dimuat.
- Perubahan input yang tidak mengubah summary tetap dapat menyebabkan fungsi
  chart dievaluasi ulang bersama parent.
- File route mencampur metadata routing dan seluruh business UI, sehingga
  perubahan route atau marketing berisiko menarik coupling tambahan.

Angka chunk di atas berasal dari build produksi sebelum refaktor H-5, bukan
perkiraan ukuran source.

## 3. Struktur sebelum perbaikan

```text
routes/admin.tsx (~4.600 baris)
├── deklarasi route /admin
├── AdminPage
├── semua state dan handler
├── seluruh UI tab
├── seluruh chart
└── static import recharts

routes/marketing.tsx
└── import { AdminPage } from "./admin"
```

Alur pemuatan:

```text
Route admin/marketing
       │
       ▼
Module admin besar
       │
       ▼
Chart wrapper + Recharts berada pada dependency graph statis
```

## 4. Perbaikan

### 4.1 Route dipisahkan dari feature module

Implementasi bersama dipindahkan dari route module ke:

```text
src/features/admin/AdminPage.tsx
```

`src/routes/admin.tsx` sekarang hanya bertanggung jawab atas:

- metadata route;
- dynamic import feature module;
- pemberian mode `admin`;
- loading fallback.

`src/routes/marketing.tsx` melakukan hal yang sama untuk mode `marketing`.
Marketing tidak lagi mengimpor route admin.

Struktur baru:

```text
routes/admin.tsx ──────┐
                      ├──lazy──► features/admin/AdminPage.tsx
routes/marketing.tsx ─┘
```

### 4.2 `AdminPage` menjadi shared lazy module

Kedua route menggunakan `React.lazy`:

```tsx
const AdminPage = lazy(() =>
  import("@/features/admin/AdminPage").then((module) => ({
    default: module.AdminPage,
  })),
);
```

Feature module hanya diunduh ketika pengguna benar-benar membuka `/admin`
atau `/marketing`. Kedua route menunjuk chunk bersama yang sama sehingga tidak
ada duplikasi implementasi console.

### 4.3 Loading fallback yang stabil

Dynamic module dibungkus `Suspense`:

```tsx
<Suspense fallback={<ConsoleLoadingFallback />}>
  <AdminPage mode="admin" />
</Suspense>
```

Fallback memakai skeleton berukuran tetap dan `aria-busy="true"`, sehingga:

- pengguna mendapat feedback selama chunk dimuat;
- layout shift dikurangi;
- pembaca layar mengetahui halaman masih sibuk;
- kegagalan memuat tidak menghasilkan layar kosong tanpa transisi.

### 4.4 Recharts diubah menjadi dynamic imports

Tidak ada lagi runtime static import dari `recharts` di feature module.
Primitive chart dimuat melalui `React.lazy`:

```tsx
const BarChart = lazy(() =>
  import("recharts").then((module) => ({ default: module.BarChart })),
);
```

Wrapper `@/components/ui/chart` juga dimuat secara dinamis karena module
tersebut mengimpor `recharts` secara internal.

Hasil build menunjukkan boundary terpisah:

```text
ResponsiveContainer-*.js  88,79 KB (gzip 27,67 KB)
chart-*.js                  4,53 KB (gzip  1,93 KB)
```

Chunk tersebut diminta saat komponen report chart dirender, bukan menjadi isi
route wrapper admin/marketing.

### 4.5 Suspense boundary khusus chart

Setiap chart dibungkus `ReportChartBoundary` dengan skeleton setinggi chart:

```tsx
<ReportChartBoundary>
  <MemoTopRewardsChart rewards={summary.top_rewards ?? []} />
</ReportChartBoundary>
```

Pemuatan Recharts tidak mengganti seluruh console dengan fallback route.
Header, navigasi tab, metrik, dan tabel tetap terlihat sementara chunk chart
diselesaikan.

### 4.6 Render chart diisolasi dengan `memo`

Tiga chart report dibungkus `React.memo`:

```tsx
const MemoTopRewardsChart = memo(TopRewardsChart);
const MemoTopRedeemOutletsChart = memo(TopRedeemOutletsChart);
const MemoRedemptionHistoryChart = memo(RedemptionHistoryChart);
```

Ketikan atau perubahan state form lain masih membuat parent console menjalankan
render React, tetapi tiga subtree Recharts yang mahal tidak dirender ulang
selama referensi data summary tidak berubah. Ini membatasi biaya render pada
bagian yang benar-benar berubah.

## 5. Alur setelah perbaikan

```text
Pengguna membuka /admin atau /marketing
              │
              ▼
Route wrapper kecil (~0,87 KB)
              │
              ├── tampilkan ConsoleLoadingFallback
              │
              └── dynamic import shared AdminPage
                            │
                            ▼
                  Console interaktif tersedia
                            │
                            ▼
                    Tab report dirender
                            │
                            ├── tampilkan skeleton chart
                            └── dynamic import Recharts/chart UI
```

## 6. Output build sebelum dan sesudah

### Sebelum

```text
assets/admin-*.js       83,69 KB │ gzip 19,59 KB
assets/marketing-*.js    0,11 KB │ gzip  0,13 KB
```

Marketing terlihat kecil sebagai entry, tetapi memiliki dependency langsung
ke module route admin yang membawa implementasi console.

### Sesudah

```text
assets/admin-*.js                 0,87 KB │ gzip  0,48 KB
assets/marketing-*.js             0,87 KB │ gzip  0,48 KB
assets/AdminPage-*.js            93,42 KB │ gzip 22,38 KB
assets/ResponsiveContainer-*.js  88,79 KB │ gzip 27,67 KB
assets/chart-*.js                 4,53 KB │ gzip  1,93 KB
```

Interpretasi:

- route admin turun sekitar **98,96%** dari 83,69 KB menjadi 0,87 KB;
- admin dan marketing kini memiliki route wrapper simetris;
- implementasi bersama terlihat eksplisit sebagai `AdminPage` chunk;
- library chart terlihat eksplisit sebagai dynamic chunk terpisah;
- perubahan ini mengoptimalkan urutan download/evaluasi, bukan mengklaim semua
  byte aplikasi hilang.

Nama hash file berubah pada setiap build dan tidak boleh dipakai sebagai API.

## 7. Output UI setelah perbaikan

Perilaku bisnis tidak berubah:

```text
/admin     -> AdminPage mode="admin"
/marketing -> AdminPage mode="marketing"
```

Saat koneksi lambat, pengguna melihat skeleton console. Saat chart belum siap,
pengguna melihat skeleton chart di dalam panel report. Setelah chunk selesai,
chart tampil dengan data dan interaksi yang sama seperti sebelumnya.

Tidak ada perubahan pada:

- endpoint API;
- payload admin/marketing;
- pemeriksaan role;
- data report;
- aksi CRUD;
- URL route;
- struktur database.

## 8. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Isi `routes/admin.tsx` | Route + seluruh console | Route wrapper kecil |
| Shared implementation | Marketing mengimpor route admin | Feature module bersama |
| Loading `AdminPage` | Import langsung | `React.lazy` + `Suspense` |
| Import Recharts | Statis | Dynamic `import("recharts")` |
| Chart loading state | Tidak ada boundary khusus | Skeleton per chart |
| Render chart saat state lain berubah | Mengikuti render parent | Dibatasi `React.memo` |
| Chunk route admin | 83,69 KB | 0,87 KB |
| Chunk Recharts | Tidak terlihat sebagai boundary route yang disengaja | Terpisah 88,79 KB |
| Admin/marketing coupling | Route-to-route | Route-to-feature |

## 9. Verifikasi

### Formatter

```text
npx prettier --write \
  src/routes/admin.tsx \
  src/routes/marketing.tsx \
  src/features/admin/AdminPage.tsx

Berhasil
```

### ESLint

```text
npx eslint \
  src/routes/admin.tsx \
  src/routes/marketing.tsx \
  src/features/admin/AdminPage.tsx

0 error
4 warning react-hooks/exhaustive-deps yang sudah ada pada logic lama
```

Warning lama tidak diubah secara spekulatif karena menambah dependency pada
effect/callback dapat mengubah frekuensi request dan perilaku pagination.
Warning tersebut dicatat sebagai debt terpisah, bukan disembunyikan.

### Build produksi

```text
npm run build

Client: 2511 modules transformed
SSR: 97 modules transformed
Nitro/Vercel output: berhasil
Exit code: 0
```

Build membuktikan tersedianya chunk terpisah untuk route, `AdminPage`, chart UI,
dan Recharts. Tidak ada error TypeScript atau bundling.

### Diff check

```text
git diff --check

Exit code: 0
```

Pengukuran browser seperti LCP, INP, Total Blocking Time, dan request waterfall
belum dijalankan pada production. Dokumen ini hanya memakai ukuran artifact
build yang benar-benar dihasilkan.

## 10. Pemetaan ke rekomendasi issue

| Rekomendasi | Implementasi |
|---|---|
| Jadikan `AdminPage` modul lazy yang dipakai kedua route | Kedua route dynamic-import `@/features/admin/AdminPage` |
| Hindari marketing mengimpor route admin | Dependency diubah menjadi route-to-feature |
| Muat Recharts di balik report | Recharts dan chart UI menggunakan dynamic import dan Suspense boundary |
| Kurangi render ulang subtree berat | Tiga chart dibungkus `React.memo` |
| Sediakan code-splitting terukur | Artifact build menampilkan route, feature, dan Recharts sebagai chunk berbeda |

## 11. Risiko residual dan tindak lanjut

- `AdminPage.tsx` masih merupakan feature module besar yang memegang state dan
  handler lintas tab. Perbaikan ini memecahkan boundary route/dependency berat
  dan mengisolasi render chart, tetapi pemisahan controller/state per tab dapat
  dilakukan bertahap sebagai peningkatan arsitektur berikutnya.
- Karena tab default adalah report, chunk chart akan segera diminta setelah
  data report dirender pada kunjungan default. Keuntungannya tetap berupa
  parsing/evaluasi bertahap dan boundary terpisah; pengguna yang diarahkan ke
  tab lain sebelum report selesai tidak membutuhkan render chart.
- Dynamic import menambah request chunk. HTTP/2/HTTP/3 dan cache immutable
  membuat trade-off ini wajar, tetapi waterfall harus diverifikasi pada CDN
  production.
- Empat warning dependency hook lama perlu diperbaiki melalui audit behavior
  request, bukan sekadar menambahkan dependency otomatis.
- Pemisahan penuh setiap tab menjadi module lazy tersendiri masih merupakan
  langkah lanjutan bernilai tinggi. Disarankan memulai dari tab customer dan
  redeem karena memiliki state/form terbesar, dengan query hook atau reducer
  per tab agar state update benar-benar terlokalisasi.

## 12. Checklist deployment dan monitoring

1. Deploy frontend dan pastikan chunk `AdminPage`, chart, dan Recharts tersedia
   di CDN.
2. Uji hard refresh `/admin` dan `/marketing` secara langsung, bukan hanya
   navigasi client-side.
3. Uji semua tab dan seluruh dialog CRUD untuk memastikan pemindahan module
   tidak mengubah behavior.
4. Throttle jaringan browser dan pastikan skeleton console/chart terlihat.
5. Pastikan role marketing tetap tidak melihat tab/aksi admin-only.
6. Periksa Network panel: route wrapper dimuat lebih dulu, lalu `AdminPage`, dan
   chunk Recharts ketika report dirender.
7. Bandingkan LCP, INP, Total Blocking Time, heap, dan long task sebelum/sesudah
   pada perangkat mobile kelas menengah.
8. Pantau error pemuatan chunk setelah deployment; CDN harus mempertahankan
   artifact versi lama selama rollout agar tab browser lama tidak terkena
   `ChunkLoadError`.

## 13. Koreksi regresi kompatibilitas Recharts

Implementasi awal H-5 membungkus primitive Recharts (`Bar`, `Line`, `XAxis`,
`YAxis`, dan lainnya) dengan `React.lazy` satu per satu. Pendekatan tersebut
berhasil membuat chunk terpisah saat build, tetapi tidak kompatibel dengan cara
Recharts memeriksa tipe child menggunakan `findAllByType()` dan `displayName`.
Akibatnya container chart tampil tanpa batang, garis, atau axis meskipun array
data sudah terisi.

Koreksi final memindahkan ketiga chart ke:

```text
src/features/admin/AdminReportCharts.tsx
```

`AdminReportCharts` di-lazy-load sebagai satu modul utuh. Di dalam modul itu,
primitive Recharts diimpor secara normal sehingga identitas component tetap
asli:

```tsx
import { Bar, BarChart, Line, LineChart, XAxis, YAxis } from "recharts";
```

Boundary yang benar:

```text
AdminPage
   └── React.lazy(AdminReportCharts module)
            ├── BarChart + Bar asli
            ├── BarChart + Bar asli
            └── LineChart + Line/Axis asli
```

Build produksi setelah koreksi menghasilkan chunk eksplisit:

```text
AdminReportCharts-*.js   4,51 KB │ gzip 1,57 KB
```

Build client, SSR, dan Nitro berhasil tanpa error. Dengan desain ini,
code-splitting tetap dipertahankan tanpa mengubah identitas child yang
dibutuhkan Recharts.

## 14. Update — dead code dibersihkan dan pemecahan per-tab dimulai

Audit lanjutan menemukan tiga hal yang belum tuntas dari perbaikan H-5
awal: (a) `AdminPage.tsx` masih 4.652 baris/176 KB, nyaris tidak berkurang;
(b) ~360 baris kode chart lama yang sudah mati masih tertinggal di file;
(c) pemecahan per-tab belum dilakukan sama sekali.

### 14.1 Dead code dari koreksi bagian 13 dibersihkan

Koreksi Recharts di bagian 13 memindahkan ketiga chart ke
`AdminReportCharts.tsx`, tetapi implementasi lamanya **tidak ikut dihapus**
dari `AdminPage.tsx`. Yang tertinggal dan kini dihapus:

```text
TopRewardsChart           (~120 baris)  - versi lama, tidak dirujuk siapa pun
TopRedeemOutletsChart     (~130 baris)  - idem
RedemptionHistoryChart    (~ 95 baris)  - idem
useMediaQuery             (~ 18 baris)  - hanya dipakai ketiga fungsi di atas
9 lazy import primitive Recharts        - Bar, BarChart, CartesianGrid, Cell,
                                          LabelList, Line, LineChart, XAxis, YAxis
5 lazy import @/components/ui/chart     - ChartContainer, ChartLegend,
                                          ChartLegendContent, ChartTooltip,
                                          ChartTooltipContent
import `memo` yang tidak terpakai
```

Ketiga fungsi chart lama itu `export`, jadi statusnya diverifikasi lewat
`grep` menyeluruh dulu (tidak ada satu pun pemakai di `src/`) sebelum
dihapus — bukan diasumsikan mati karena "kelihatannya tidak dipakai".
Ke-9 lazy import primitive Recharts adalah persis pola yang bagian 13
nyatakan **rusak** (memecah identitas component yang dibutuhkan
`findAllByType()`); pola itu kini benar-benar hilang dari codebase, bukan
sekadar tidak dipakai lagi.

Efek samping yang menguntungkan: satu error TypeScript pre-existing
(`Type 'typeof Bar' is not assignable to type 'ComponentType<any>'` pada
`lazy(Bar)`) ikut hilang karena penyebabnya adalah kode mati itu sendiri.

### 14.2 Pemecahan per-tab dimulai: tab Activity Log

Tab Activity Log dipecah jadi modul lazy tersendiri
(`AdminActivityTab.tsx`) sebagai percontohan pola. Dipilih sebagai tab
pertama karena paling terisolasi: murni read-only, tidak punya form CRUD,
dan tidak menulis state tab lain — sehingga risiko regresinya paling kecil
untuk memvalidasi polanya.

Ikut dipindah ke modul itu: seluruh JSX tab, plus 9 helper yang hanya
dipakai tab ini (`metadataLabels`, `actualCustomerChangedFields`,
`auditValuesEqual`, `sortedAuditLocationIds`, `isRecord`, `compactJson`,
dan komponen `ActivityMetadata`) — total ~190 baris yang sebelumnya
dimuat semua pengguna console meski tidak pernah membuka tab activity.

Primitif UI yang dipakai lebih dari satu tab (`Panel`, `FormInput`,
`TableScrollArea`, `RequiredLabel`, `numberFormat`, `dateTimeFormat`)
diekstrak ke `adminUiPrimitives.tsx` agar modul tab tidak perlu
meng-import balik dari `AdminPage.tsx` (yang akan membuat siklus impor)
maupun menduplikasi implementasinya.

**Batasan yang disengaja:** state tab activity (`activityLogs`, filter,
halaman) dan `loadActivityLogs()` **tetap** di `AdminPage.tsx`; komponen
baru murni presentational dan menerima semuanya lewat props. Artinya
langkah ini mengurangi ukuran bundle awal dan jumlah baris file, **tetapi
belum** mengurangi jumlah `useState` di `AdminPage` (masih 63) maupun
biaya re-render lintas tab. Memindahkan state per tab juga menuntut
penyesuaian orkestrasi `loading`/`error`/`loadedTabs` di `AdminPage` —
sengaja tidak dilakukan sekaligus agar pola dasarnya terbukti aman dulu.

Perbaikan kecil yang ikut terbawa: `FormInput` sekarang benar-benar
mendukung prop `placeholder`. Sebelumnya beberapa pemanggil sudah
melewatkan `placeholder`, tetapi prop itu tidak ada di tipe komponen
sehingga diam-diam dibuang dan placeholder tidak pernah tampil (3 error
TypeScript pre-existing ikut hilang).

### 14.3 Hasil terukur

Ukuran file:

```text
AdminPage.tsx   4.652 baris  ->  3.904 baris   (-748 baris, -16%)
```

Chunk client hasil `vite build`:

```text
AdminPage-*.js           169 KB  ->  163,7 KB
AdminActivityTab-*.js       (baru)     6,8 KB   <- hanya diunduh saat tab dibuka
AdminReportCharts-*.js             401,3 KB     <- tetap terpisah (recharts)
admin-*.js / marketing-*.js       0,9 KB each   <- route wrapper tetap tipis
```

Error TypeScript (`tsc --noEmit`), seluruh proyek:

```text
sebelum: 8 error   sesudah: 5 error   (semua sisa adalah pre-existing dan
                                       tidak berhubungan dengan H-5)
```

### 14.4 Pengujian terukur

`src/features/admin/AdminActivityTab.test.tsx` (11 test, seluruhnya lulus
lewat `npm test`) mengunci perilaku tab agar pemecahan modul tidak
mengubahnya secara diam-diam:

- kolom tabel (waktu, actor, action, entity, metadata, IP) dan keadaan
  kosong;
- fallback identitas actor: email → nomor telepon → `User #<id>`;
- peringkasan metadata `runchise_sync` dan `activation_email` jadi label,
  bukan JSON mentah;
- cabang khusus log lama: metadata yang menandai `last_updated_by_id`
  (noise) memicu penghitungan ulang daftar field berubah dari
  `before`/`after`;
- fallback JSON ringkas untuk metadata yang polanya tidak dikenali;
- tombol Filter memuat dari halaman 1; navigasi Sebelumnya/Berikutnya
  memanggil halaman yang benar; tombol nonaktif di batas dan saat loading;
- perubahan input filter diteruskan ke handler induk (membuktikan state
  memang masih dikelola `AdminPage`, sesuai batasan di 14.2).

Test ini diverifikasi **tidak vacuous** lewat mutation check: menghapus
satu baris `changedFields.push()` di cabang penghitungan ulang membuat
test terkait gagal, lalu kode dikembalikan.

Verifikasi lain: `eslint src/features/admin/` bersih (exit 0), `vite build`
(client + SSR + Nitro) sukses, seluruh suite frontend 14/14 lulus.

Catatan: verifikasi lewat browser sungguhan tidak dapat dilakukan karena
console admin memerlukan login akun admin; karena itu perilaku tab dikunci
lewat test komponen di atas, bukan lewat klik manual.

### 14.5 Sisa pekerjaan H-5

- Lima tab lain (`report`, `sales-transactions`, `users`, `customers`,
  `redeem`) belum dipecah; JSX-nya sudah digate kondisional sehingga tab
  nonaktif tidak ikut dirender, tetapi kodenya masih satu chunk dengan
  `AdminPage`.
- 63 `useState` masih terpusat di `AdminPage`, sehingga setiap perubahan
  state (termasuk ketikan di satu input) masih menjalankan ulang fungsi
  komponen ~2.900 baris itu. Menuntaskannya perlu memindahkan state per
  tab, bukan hanya JSX-nya.

## 15. Update lanjutan — tab Sales Transactions dipecah + bug kontrol paginasi

### 15.1 Bug ditemukan: form "Pergi" berada di tab yang salah

Saat menyiapkan pemecahan tab `sales-transactions`, ditemukan bug
pre-existing yang juga menghalangi pemisahan bersih: blok paginasi tab
**Customers** memanggil `jumpToSalesTransactionPage()` dan membaca
`salesTransactionPageInput` / `salesTransactionTotalPages`.

Ditelusuri lewat `git log -S`, penyebabnya commit `7bc6edd`
("feat(admin): improve customer transaction pagination"). Tombol halaman
untuk sales-transaction ditambahkan di lokasi yang benar, tetapi form
lompat-ke-halaman-nya tersisip pada hunk `@@ -2653,6 +2701,24 @@` — tepat
sebelum form lompat-ke-halaman milik Customers, sehingga masuk ke blok tab
yang salah.

Akibatnya, selama ini:

- tab **Customers** menampilkan **dua** tombol "Pergi" berdampingan; yang
  pertama justru memindahkan halaman tab Transaksi (tab yang sedang tidak
  dilihat pengguna), yang kedua baru memindahkan halaman Customers;
- tab **Crisbro Transaction Report** tidak punya kontrol lompat-ke-halaman
  sama sekali, padahal `jumpToSalesTransactionPage()` memang ditulis
  untuknya dan state `salesTransactionPageInput` sudah disiapkan.

Perbaikan: form tersebut dihapus dari blok paginasi Customers dan
dikembalikan ke tab Transaksi. `jumpToCustomerPage()` milik Customers tidak
disentuh.

### 15.2 Tab Sales Transactions dipecah

`AdminSalesTransactionsTab.tsx` (baru) memuat seluruh JSX tab: filter
(cari/outlet/rentang tanggal), tabel 13 kolom, ringkasan rentang baris,
pemilih baris-per-halaman, tombol halaman, dan form lompat-ke-halaman yang
sudah dikembalikan. Dipilih sebagai tab kedua karena juga read-only —
risikonya setara dengan tab activity yang polanya sudah divalidasi.

Sama seperti `AdminActivityTab`: state dan `loadSalesTransactions()` tetap
di `AdminPage.tsx`; komponen baru murni presentational.

### 15.3 Modul bersama dirapikan

Primitif yang kini dipakai lebih dari satu modul dipindahkan agar tidak ada
duplikasi maupun siklus impor:

```text
adminFormatters.ts    (baru)  numberFormat, currencyFormat, toNumber,
                              dateFormat, dateTimeFormat, paginationItems
adminUiPrimitives.tsx         RequiredLabel, Panel, FormInput, Select,
                              TableScrollArea
```

Pemisahan fungsi murni ke file `.ts` tersendiri dilakukan karena aturan
`react-refresh/only-export-components`: file yang mengekspor komponen
**dan** helper membuat Fast Refresh jatuh ke full reload saat dev. Setelah
dipisah, `eslint src/features/admin/` bersih **tanpa error maupun
warning** (sebelumnya 6 warning).

Komponen `Select` (pembungkus Radix, dipakai 12 tempat) ikut pindah ke
modul bersama, sehingga import `@radix-ui/react-select` tidak lagi
diperlukan di `AdminPage.tsx`.

### 15.4 Hasil terukur

```text
AdminPage.tsx   4.652 baris (awal)  ->  3.904  ->  3.624 baris
                                        (-1.028 baris / -22% dari awal)
```

Chunk client hasil `vite build`:

```text
AdminPage-*.js                169,4 KB -> 159,3 KB
AdminActivityTab-*.js                       6,8 KB
AdminSalesTransactionsTab-*.js  (baru)      5,4 KB
AdminReportCharts-*.js                    401,3 KB   (recharts, tak berubah)
admin-*.js / marketing-*.js                 0,9 KB
```

Error TypeScript seluruh proyek tetap **5** (semua pre-existing dan tidak
berhubungan) — tidak ada error baru dari pemecahan ini.

### 15.5 Pengujian terukur

`AdminSalesTransactionsTab.test.tsx` (13 test, lulus semua):

- keadaan kosong; kolom transaksi; nominal `pembelian_per_order` yang
  dikirim API sebagai **string** tetap diformat rupiah dengan benar;
- field `null` tampil sebagai `-`, bukan tulisan `null`;
- rincian reward yang ditukar (`2× Kopi Gratis`, `50 poin`);
- tombol Terapkan memuat dari halaman 1; navigasi Sebelumnya/Berikutnya;
  tombol nonaktif di batas halaman;
- **regresi bug 15.1**: form lompat-ke-halaman ada di tab ini dan memicu
  `onJumpToPage`, serta hanya ada **satu** tombol "Pergi";
- pemilih baris-per-halaman meneruskan `number`, bukan `string`;
- ringkasan rentang baris benar (halaman 3 × 50 = `101–150 dari 450`) dan
  menampilkan `0–0 dari 0` saat kosong.

Diverifikasi **tidak vacuous** lewat mutation check: melumpuhkan
`onJumpToPage()` dan menggeser perhitungan `Math.min` membuat tepat 2 test
terkait gagal, lalu kode dikembalikan.

Seluruh suite frontend: **27/27 lulus** (3 file test). `vite build` (client
+ SSR + Nitro) sukses.

### 15.6 Sisa pekerjaan H-5

- Empat tab tersisa (`report`, `users`, `customers`, `redeem`) belum
  dipecah. Ketiga tab CRUD (`users`, `customers`, `redeem`) jauh lebih
  terikat ke state form dan dialog `AdminPage`, jadi perlu penanganan lebih
  hati-hati daripada dua tab read-only ini.
- Jumlah `useState` di `AdminPage` masih 63; kedua pemecahan sejauh ini
  sengaja tidak memindahkan state, sehingga biaya re-render lintas tab
  belum berubah.

## 16. Update lanjutan — tab Report dipecah (tab read-only terakhir)

### 16.1 Yang dipindahkan

`AdminReportTab.tsx` (baru) memuat seluruh JSX tab report: enam kartu metrik,
tabel customer-per-outlet, dua panel grafik, filter riwayat redemption, dan
tabel riwayatnya.

Tiga komponen ikut pindah **seluruhnya** ke modul ini karena diverifikasi
lewat `grep` hanya dipakai tab report — jadi tidak perlu menghuni modul
bersama, dan bobotnya benar-benar keluar dari chunk utama:

| Komponen | Pemakai |
|---|---|
| `Metric` + `metricToneClasses` | hanya tab report (6 kartu) |
| `DataTable` + `compareTableCell` + `parseTableNumber` | hanya tab report (2 tabel) |
| `ReportChartBoundary` | hanya tab report (3 grafik) |

Ketiga `lazy()` wrapper ke `AdminReportCharts` juga ikut pindah, sehingga
chunk recharts (401 KB) tetap terpisah dan baru diunduh ketika grafiknya
benar-benar dirender — bukan sekadar saat tab report dibuka.

Sebaliknya, dua hal yang **dipakai lebih dari satu tab** dinaikkan ke modul
bersama agar tidak terduplikasi:

```text
adminFormatters.ts   + nextSortState, type SortState
adminUiPrimitives.tsx + SortableHeader   (dipakai 20 tempat: users/customers/redeem)
```

Setelah tab report keluar, delapan import yang tidak lagi terpakai di
`AdminPage.tsx` (`ArrowDown`, `ArrowUp`, `ArrowUpDown`, `Coins`, `Gift`,
`TicketCheck`, `UserCheck`, `WalletCards`, plus `type SortOrder`) ikut
dibersihkan.

### 16.2 Hasil terukur

```text
AdminPage.tsx   4.652 baris (awal)  ->  3.624  ->  3.220 baris
                                        (-1.432 baris / -31% dari awal)
```

Chunk client hasil `vite build`:

```text
AdminPage-*.js                 169,4 KB -> 159,3 KB -> 152,4 KB
AdminReportTab-*.js  (baru)                             7,9 KB
AdminSalesTransactionsTab-*.js                          5,4 KB
AdminActivityTab-*.js                                   6,8 KB
AdminReportCharts-*.js                                401,3 KB  (recharts, tak berubah)
admin-*.js / marketing-*.js                             0,9 KB
```

Ketiga tab read-only kini sudah dipecah. Error TypeScript seluruh proyek
tetap **5** (semua pre-existing, di `AdminActivityTab`/`menu.tsx`/`promo.tsx`
dan tidak berhubungan dengan pemecahan ini). `eslint` pada seluruh file yang
disentuh: **bersih**; 45 error ESLint yang tersisa di `src/routes/` sudah ada
sebelum perubahan ini (diverifikasi dengan menjalankan lint pada working tree
yang di-stash).

### 16.3 Polyfill matchMedia di lingkungan test

`vitest.setup.ts` ditambahi polyfill `window.matchMedia`. JSDOM tidak
mengimplementasikannya, sedangkan komponen responsif memanggilnya saat mount
(`useMediaQuery` di modul grafik, dan `useIsMobile` yang dipakai
`AdminPage`), sehingga sebelumnya komponen tersebut melempar `TypeError` di
test. Ini melengkapi polyfill Radix/ResizeObserver yang sudah ada.

### 16.4 Pengujian terukur

`AdminReportTab.test.tsx` (11 test, lulus semua):

- keenam kartu metrik tampil dengan angka terformat `id-ID` (`18.330`,
  `250.000`, dst) — di-query dengan `{ selector: "p" }` karena beberapa
  judul metrik (mis. "Customer Berpoin") kebetulan sama persis dengan nama
  kolom tabel di tab yang sama;
- ketiga grafik lazy selesai dimuat (3 container `[data-chart]`) dan
  skeleton Suspense-nya hilang;
- status outlet dipetakan ke label Indonesia (`capped` -> "Dibatasi API",
  `empty` -> "Belum ada data"), dan field `null` tampil sebagai `-`;
- pesan kosong untuk tabel outlet maupun riwayat redemption;
- riwayat redemption: `menu_price` terformat rupiah, outlet berkota tampil
  `Nama (Kota)`, `menu_price: null` tidak jadi "Rp 0";
- `DataTable` benar-benar mengurutkan baris saat header diklik, dan
  menandai arah urutan lewat `aria-sort` (`none` -> `ascending` ->
  `descending`) untuk pembaca layar;
- tombol "Terapkan Filter" memanggil handler induk dan nonaktif saat
  `loading`.

**Catatan metodologis.** Percobaan awal me-mock `./AdminReportCharts` lewat
`vi.mock` membuat hanya grafik pertama yang ter-render di jsdom. Ditelusuri
dan dipastikan itu **artefak mocking, bukan cacat komponen**: dengan modul
aslinya ketiga grafik muncul lengkap (3 container `[data-chart]`, nol
skeleton tersisa). Karena itu mock dibuang dan test memakai modul asli —
yang justru lebih tepat, karena wiring `React.lazy`/`Suspense` itulah inti
perubahan H-5. Durasi file test tetap ~10 detik.

Diverifikasi **tidak vacuous** lewat mutation check: mengubah pemetaan status
outlet, melumpuhkan `compareTableCell`, dan mengganti `numberFormat` dengan
`String()` membuat tepat 3 test terkait gagal, lalu kode dikembalikan.

Seluruh suite frontend: **38/38 lulus** (4 file test). `vite build` (client +
SSR + Nitro) sukses.

### 16.5 Sisa pekerjaan H-5

- Tiga tab CRUD (`users`, `customers`, `redeem`) belum dipecah. Ketiganya
  jauh lebih terikat ke state form, dialog konfirmasi, dan alur simpan/hapus
  di `AdminPage`, jadi bukan sekadar memindahkan JSX seperti tiga tab
  read-only ini.
- Jumlah `useState` di `AdminPage` masih 63: ketiga pemecahan sejauh ini
  sengaja mempertahankan state di induk agar pola pemisahannya bisa
  diverifikasi aman lebih dulu. Selama state masih di induk, biaya
  re-render lintas tab belum berkurang — itu langkah berikutnya, bukan
  sesuatu yang sudah tercapai.

## 17. Update — inti keluhan ditangani: mengetik tidak lagi me-render induk

### 17.1 Yang belum tersentuh sampai bagian 16

Pemecahan tab di bagian 14-16 berhasil mengecilkan file dan bundle, tetapi
**tidak menyentuh keluhan aslinya**: "setiap ketikan di input mana pun
me-render ulang seluruh pohon". Penyebabnya bukan besarnya file, melainkan
**letak state**: nilai ketikan disimpan sebagai state di `AdminPage`.

Satu ketikan pada kotak pencarian customer memicu:

```text
setCustomerSearch(nilai)
  -> badan AdminPage dieksekusi ulang (64 useState, puluhan useCallback/useMemo)
  -> seluruh JSX tab aktif dibuat ulang, termasuk tabel puluhan baris
  -> React merekonsiliasi seluruh subtree itu
```

Padahal nilai yang berubah **hanya dipakai input itu sendiri** sampai
pencarian benar-benar dijalankan (lewat debounce 400 ms, tombol Cari, atau
Enter).

### 17.2 Perbaikan

`DebouncedSearchInput.tsx` (baru) menahan nilai ketikan sebagai state
**lokal**, dan memberi tahu induk hanya ketika pencarian perlu dijalankan:

- setelah jeda `debounceMs` berhenti mengetik (bila > 0), atau
- saat Enter ditekan / tombol "Cari" diklik (langsung, membatalkan jeda).

Detail yang penting agar tidak menukar satu bug dengan bug lain:

- `onSearch` disimpan di `ref`, tidak masuk dependency efek. Tanpa ini, induk
  yang membuat ulang callback tiap render akan me-restart timer terus-menerus
  dan pencarian tidak pernah jalan.
- Handle imperatif (`clear()`, `submit()`) memakai `valueRef`, bukan `value`,
  supaya handle tidak dibuat ulang tiap huruf — membuat ulang handle akan
  menulis ke ref induk dan justru memicu render yang ingin dihindari.
- Timer dibersihkan saat unmount.
- Dibungkus `memo`.

Dipasang pada dua pencarian paling sering dipakai:

| Input | Perilaku |
|---|---|
| Cari customer | debounce 400 ms (sama seperti sebelumnya) + Enter/tombol |
| Cari user admin | tanpa auto-search; Enter/tombol saja (sama seperti sebelumnya) |

Efek sampingnya: `useState` di `AdminPage` turun 64 → **62**, dan effect
debounce manual untuk pencarian customer ikut dihapus karena sudah ditangani
komponennya.

### 17.3 Pengukuran

`DebouncedSearchInput.test.tsx` (9 test) **menghitung render induk secara
nyata**, bukan mengasumsikan perbaikannya bekerja. Dua test membentuk
perbandingan terkontrol dengan harness dan cara ukur identik:

| Test | Pola | Mengetik | Render induk |
|---|---|---|---|
| PEMBANDING | lama (state di induk) | 4 huruf | **+4** |
| PENGUKURAN | baru (state lokal) | 11 huruf | **+0** |

Test lain mengunci: nilai tetap tampil utuh walau induk tidak render, debounce
memanggil `onSearch` sekali dengan nilai ter-trim, Enter menembak seketika dan
membatalkan jeda tertunda, `debounceMs=0` tidak auto-search, callback yang
identitasnya berubah tiap render tidak me-restart jeda, `clear()` dari luar
membatalkan jeda, dan tidak ada timer menggantung setelah unmount.

Diverifikasi **tidak vacuous** lewat mutation check: mengangkat nilai ketikan
ke induk setiap huruf (persis pola lama) membuat 6 test gagal.

**Catatan metodologis.** Percobaan awal memakai fake timer membuat SELURUH
test menggantung — `vi.useFakeTimers()` juga memalsukan API yang dipakai
scheduler React dan userEvent. Membatasi `toFake` tidak menolong. Akhirnya
dipakai timer asli. Konsekuensinya test jadi sensitif waktu: satu kegagalan
flaky sempat muncul saat suite penuh berjalan paralel, karena pengetikan
userEvent bisa memakan lebih dari 400 ms di bawah beban sehingga debounce
menembak di tengah. Diperbaiki dengan memakai jeda `NEVER_FIRES_MS` (10 detik)
pada test yang memang mensyaratkan debounce tidak menembak selama interaksi,
dan memendekkan string ketikan pada test yang mensyaratkan sebaliknya.
Setelah itu suite dijalankan 3× berturut-turut: 47/47 lulus konsisten.

Seluruh suite frontend: **47/47 lulus** (5 file). `vite build` sukses.
`eslint src/features/admin/` bersih. `tsc` tetap 5 error pre-existing.

### 17.4 Yang MASIH tersisa di H-5

Perbaikan ini menutup keluhan untuk **input pencarian**, yang paling sering
diketik. Yang belum:

1. **Field form CRUD** (`customerForm` ~18 field, `userForm`, `redeemForm`)
   masih memakai state di induk, sehingga mengetik di form edit customer masih
   me-render ulang tab beserta tabelnya. Ini beban terbesar berikutnya.
2. **Pencarian katalog menu** (`catalogSearch`) sengaja belum diubah: nilainya
   dipakai **dua** input sekaligus (dialog mobile dan panel redeem desktop)
   yang berbagi satu state. Memindahkannya ke state lokal akan membuat kedua
   input itu diverge, jadi perlu penanganan tersendiri.
3. **Tiga tab CRUD** (`users`, `customers`, `redeem`) masih inline di
   `AdminPage`; belum dipecah jadi modul lazy seperti tiga tab read-only.
4. `useState` masih **62**.
