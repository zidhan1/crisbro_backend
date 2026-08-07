# L-7 (LOW) — File raksasa dan duplikasi admin

Status: **Fixed**

File backend terdampak:

- `src/controllers/adminLoyaltyController.js`
- `src/controllers/adminLoyalty/summaryController.js` (baru)
- `src/controllers/adminLoyalty/redeemAdminController.js` (baru)
- `src/controllers/adminLoyalty/redeemItemProjection.js` (baru)
- `src/routes/adminLoyaltyRoutes.js`
- `src/routes/admin/redeemAdminRoutes.js` (baru)
- `src/middleware/adminLoyaltyValidation.js` (baru)
- `test/adminLoyaltyValidation.test.js` (baru)
- `package.json` dan `package-lock.json`

File frontend terdampak:

- `src/lib/admin.ts`
- `src/lib/admin/types.ts` (baru)
- `src/features/admin/AdminPage.tsx`

## 1. Masalah

Kode admin sebelumnya menggabungkan terlalu banyak tanggung jawab:

- `adminLoyaltyController.js` berisi 2.898 baris;
- `getSummary` sendiri sekitar 360 baris dan bercampur dengan CRUD user,
  customer, reward, redeem menu, dan redemption;
- Prisma `select` response redeem item disalin identik pada list, create, dan
  update;
- route admin seluruh domain berada dalam satu router;
- `src/lib/admin.ts` frontend berisi type domain dan seluruh transport API
  dalam satu file 648 baris;
- response TypeScript hanya dicast sebagai generic `T`, sedangkan request
  mutasi belum memiliki runtime schema di boundary backend;
- satu effect admin mematikan `react-hooks/exhaustive-deps`, sehingga perubahan
  dependency tidak dapat diperiksa lint;
- model admin harus dipastikan tidak kembali menggunakan explicit `any`.

Risikonya adalah perubahan kecil pada satu domain mudah memengaruhi domain
lain, projection response dapat berbeda antar-operasi, payload liar baru
terdeteksi jauh di dalam controller, dan dependency effect dapat menjadi
stale tanpa terdeteksi.

## 2. Kondisi sebelum perbaikan

### Controller dan route monolitik

```text
adminLoyaltyController.js (2.898 baris)
├── users/activity
├── customers/sales
├── loyalty summary (~360 baris)
├── rewards
├── redeem catalog/category/item
└── redemption state machine
```

### Projection redeem diduplikasi

```js
prisma.redeemMenuItem.findMany({ select: { /* projection panjang */ } });
prisma.redeemMenuItem.create({ select: { /* salinan identik */ } });
prisma.redeemMenuItem.update({ select: { /* salinan identik */ } });
```

Satu field baru harus ditambahkan tiga kali. Jika satu lokasi terlewat,
response list dan response create/update memiliki bentuk berbeda.

### Boundary belum memiliki runtime schema

Payload langsung diteruskan dari route ke parser/controller. Unknown field,
body update kosong, tipe ID, atau tanggal baru ditolak secara ad-hoc.

### Exhaustive deps dimatikan

```tsx
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [canAccess, canViewActivityLogs, isMarketingConsole, navigate, tab]);
```

## 3. Perbaikan backend

### 3.1 Controller dipisah per domain

Struktur baru:

```text
src/controllers/
├── adminLoyaltyController.js              # facade + customer/user domain
└── adminLoyalty/
    ├── summaryController.js               # query dan projection summary
    ├── redeemAdminController.js           # catalog/redeem/redemption
    └── redeemItemProjection.js            # projection Prisma bersama
```

`summaryController` dan `redeemAdminController` dibuat melalui factory dengan
dependency injection. Hasilnya:

- dependency tiap domain eksplisit;
- module dapat diuji tanpa hidden global;
- kontrak export `adminLoyaltyController.js` tetap sama, sehingga caller lama
  dan route lain tidak perlu migrasi serentak;
- tidak ada circular business dependency antar-domain.

Ukuran setelah refactor:

| File | Sebelum | Sesudah |
|---|---:|---:|
| `adminLoyaltyController.js` | 2.898 baris | 2.008 baris |
| `summaryController.js` | — | 373 baris |
| `redeemAdminController.js` | — | 530 baris |

Controller utama berkurang sekitar 31%. Domain summary dan redeem sekarang
berubah secara independen tanpa menambah kembali file utama.

### 3.2 Route redeem dipisah

`src/routes/admin/redeemAdminRoutes.js` menangani:

- `/catalog/menu-items`;
- `/redeem-menu/categories*`;
- `/redeem-menu/items*`;
- `/redemptions*`.

`adminLoyaltyRoutes.js` tetap memasang `auth` lebih dahulu kemudian memasang
router domain. Middleware role dan urutan endpoint tidak berubah.

### 3.3 Projection Prisma satu sumber

Projection response sekarang didefinisikan sekali:

```js
const REDEEM_ITEM_SELECT = Object.freeze({
  id: true,
  menu_item_id: true,
  // ...
  category: { select: { /* ... */ } },
  menu_item: { include: { category: { select: { id: true, name: true } } } },
});
```

List, create, dan update semuanya memakai `REDEEM_ITEM_SELECT`. Projection
audit sebelum update/delete memakai `REDEEM_ITEM_AUDIT_INCLUDE` bersama.

`Object.freeze` mencegah mutation tidak sengaja pada object konfigurasi level
atas selama proses berjalan.

### 3.4 Validasi Zod di boundary

Zod ditambahkan sebagai dependency backend. Middleware schema berjalan setelah
auth/role dan sebelum controller pada endpoint redeem item.

Schema memvalidasi:

- path `id` harus integer positif;
- create wajib memiliki `menu_item_id` dan `points_required` positif;
- update harus membawa minimal satu field;
- boolean hanya boolean atau string `true`/`false`;
- tanggal harus dapat diparse;
- limit/string mengikuti batas panjang;
- unknown field pada body ditolak melalui `.strict()`.

Contoh response payload liar:

```http
POST /api/admin/redeem-menu/items
Content-Type: application/json

{"menu_item_id":10,"points_required":2000,"is_admin":true}
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"message":"Request tidak valid — request: Unrecognized key(s) in object: 'is_admin'"}
```

Controller dan database tidak dijalankan setelah schema gagal.

## 4. Perbaikan frontend

### 4.1 Type domain dipisah dari transport API

Struktur baru:

```text
src/lib/
├── admin.ts          # request transport + adminApi (297 baris)
└── admin/types.ts    # seluruh model admin (409 baris)
```

`admin.ts` tetap me-re-export seluruh type, sehingga import lama berikut tetap
valid tanpa perubahan massal:

```ts
import { adminApi, type AdminCustomer } from '@/lib/admin';
```

Pencarian statis memastikan tidak ada explicit `any` di `admin.ts` maupun
file admin yang berubah. Data JSON pada transport tetap dimulai sebagai
`unknown`; request mutasi yang berisiko divalidasi runtime oleh Zod backend.

### 4.2 Suppression exhaustive-deps dihapus

Effect pemuatan tab memakai React `useEffectEvent` agar:

- callback selalu melihat loader/filter terbaru;
- perubahan input filter tidak otomatis memicu fetch sebelum tombol filter
  ditekan;
- effect tetap hanya bereaksi terhadap akses dan tab;
- tidak membutuhkan komentar disable lint.

Dependency lain yang ditemukan lint ikut diperbaiki:

- `customerEmailStatus` ditambahkan pada callback/poll customer;
- `redeemSort` ditambahkan pada loader redeem;
- `searchCustomers` dibuat stabil dengan `useCallback`.

## 5. Output dan kompatibilitas

Output sukses endpoint tidak berubah. Contoh create redeem tetap:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "id": 21,
  "menu_item_id": 10,
  "category_id": 2,
  "points_required": 2000,
  "pb1_rate": 0.1,
  "pb1_amount": 1500,
  "price_with_pb1": 16500,
  "is_active": true,
  "category": {"id":2,"name":"Redeem Menu"},
  "menu_item": {"id":10,"name":"..."}
}
```

Perubahan yang disengaja hanya pada request invalid: payload liar, ID tidak
positif, tanggal invalid, atau update kosong sekarang konsisten menghasilkan
HTTP 400 sebelum query database.

## 6. Perbandingan sebelum dan sesudah

| Aspek | Sebelum | Sesudah |
|---|---|---|
| Controller utama | 2.898 baris, banyak domain | 2.008 baris + module summary/redeem |
| `getSummary` | Menyatu di controller utama | `summaryController.js` |
| Controller redeem | Menyatu di controller utama | `redeemAdminController.js` |
| Route redeem | Menyatu di router admin | `redeemAdminRoutes.js` |
| Select redeem item | Disalin 3 kali | `REDEEM_ITEM_SELECT` tunggal |
| Validasi runtime boundary | Parser ad-hoc di controller | Zod middleware sebelum controller |
| Unknown body field | Bisa masuk ke controller | Ditolak HTTP 400 |
| `admin.ts` | 648 baris type + transport | 297 baris; type di module 409 baris |
| Explicit `any` | Harus diawasi manual | Tidak ditemukan pada file admin terkait |
| Exhaustive deps | Satu suppression | Tidak ada suppression; lint bersih |
| Kompatibilitas import frontend | — | Dipertahankan lewat barrel re-export |

## 7. Verifikasi

### Backend

Test Zod mencakup payload valid, unknown field, update kosong, dan ID tidak
positif. Test state machine redemption dan controller lain memastikan factory
extraction tidak mengubah perilaku.

```text
npm test
46 tests passed, 0 failed
```

### Frontend

```text
eslint AdminPage.tsx admin.ts admin/types.ts
Exit code: 0

npm run build
Exit code: 0
2584 client modules transformed
100 SSR modules transformed
2596 Nitro modules transformed
```

Production build menampilkan warning dependency TanStack/Radix yang sudah ada,
tetapi tidak ada error TypeScript, React Hooks, atau bundling dari perubahan
ini.

## 8. Panduan pengembangan berikutnya

- Endpoint domain baru harus masuk module controller/route domain terkait,
  bukan menambah kembali `adminLoyaltyController.js`.
- Semua operasi list/create/update redeem harus memakai projection bersama.
- Request body mutasi baru wajib mempunyai Zod schema `.strict()` pada route
  boundary.
- Gunakan `unknown` untuk data yang belum tervalidasi; jangan memakai `any`.
- Jangan mematikan `react-hooks/exhaustive-deps`. Stabilkan callback dengan
  `useCallback` atau gunakan `useEffectEvent` ketika event effect memang tidak
  boleh menjadi dependency reaktif.

## 9. Checklist deployment

1. Jalankan `npm install` backend agar dependency Zod tersedia.
2. Tidak ada migration atau environment variable baru.
3. Smoke-test list/create/update/delete redeem item dengan role admin dan
   marketing sesuai aturan lama.
4. Pastikan payload invalid menghasilkan 400 dan payload valid menghasilkan
   bentuk response yang sama seperti sebelum refactor.
5. Pantau HTTP 400 endpoint redeem setelah deploy; lonjakan dapat menunjukkan
   client lama mengirim unknown field yang sebelumnya terabaikan.
