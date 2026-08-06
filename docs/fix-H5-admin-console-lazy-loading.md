# H-5 (HIGH) — Admin console monolit dan tanpa code-splitting komponen berat

Status: **Fixed (bundle boundary dan render isolation)**

File terdampak:

- Frontend: `src/routes/admin.tsx`
- Frontend: `src/routes/marketing.tsx`
- Frontend: `src/features/admin/AdminPage.tsx`

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
