# Runchise API Usage

Audit date: 2026-06-24

## Boundary

- `RUNCHISE_API_KEY` hanya dibaca oleh backend di `src/services/runchiseService.js`.
- Frontend tidak memanggil `https://api.runchise.com` dan tidak menyimpan `RUNCHISE_API_KEY`.
- Endpoint publik Crisbro membaca database lokal. Request publik tidak lagi fetch Runchise langsung.
- API Runchise hanya dipakai oleh sync service, admin sync endpoint, dan cron worker.

## Endpoint publik yang sudah DB-only

| Crisbro endpoint | Data source |
| --- | --- |
| `POST /api/register` | `User`, `Customer`, `CustomerPoint` lokal hasil sync |
| `GET /api/catalog/products` | `MenuItem`, `MenuCategory`, `SubBrandProductCategory` lokal |
| `GET /api/catalog/products/categories` | `MenuItem`, `MenuCategory`, `SubBrandProductCategory` lokal |
| `GET /api/promos` | `Promo` lokal hasil sync |
| `GET /api/locations` | `Location` lokal hasil sync |
| `GET /api/catalog/redeem-menu` | `MenuItem`, `MenuCategory` lokal hasil sync |

## Runchise endpoints used by sync only

Base URL:

```text
https://api.runchise.com/api/public
```

Headers:

```text
Accept: application/json
Authorization: process.env.RUNCHISE_API_KEY
Content-Type: application/json
```

| Runchise endpoint | Method | Local sync target |
| --- | --- | --- |
| `/locations/{locationId}/customers` | GET | `User`, `Customer`, `CustomerPoint` |
| `/sale_transactions` | GET | `CustomerSalesTransactionReport` |
| `/products` | GET | `MenuItem`, `MenuCategory` |
| `/sub_brands` | GET | `Brand`, `SubBrand`, `SubBrandProductCategory` |
| `/locations` | GET | `Location` |
| `/promos` | GET | `Promo` |

## Sync entrypoints

- Cron worker: `src/jobs/runchiseSyncCron.js`
- Default master-data schedule: twice daily at 12:00 and 18:00 (`0 12,18 * * *`)
- Default customer-points schedule: every 30 minutes (`*/30 * * * *`)
- Disable cron: `RUNCHISE_SYNC_CRON_ENABLED=false`
- Change master-data schedule: `RUNCHISE_MASTER_SYNC_CRON="0 1,13 * * *"`
- Legacy master-data override still supported: `RUNCHISE_SYNC_CRON="0 1,13 * * *"`
- Change customer-points schedule: `RUNCHISE_POINTS_SYNC_CRON="*/15 * * * *"`
- Sales transaction sync uses Runchise params: `start_date`, `end_date`, `location_id`, `payment_method_ids`, `status`
- Historical sales import (customer snapshot + transactions):
  `npm run import:runchise-sales -- <locationId> <YYYY-MM-DD> <YYYY-MM-DD> [locationName]`
- Historical sales are requested in daily windows because Runchise caps a broad
  date-range response at 500 rows. Every page inside every daily window is read,
  validated against the source location/date, and batch-upserted with an import run.
- Add `--skip-customers` only when the location customer snapshot was refreshed by
  an immediately preceding run.
- Reusable multi-location/period job list:
  `npm run import:runchise-sales-periods`. Edit `IMPORT_JOBS` in
  `scripts/importRunchiseSalesTransactionPeriods.js`; jobs run sequentially and
  customer snapshots are refreshed only once per location per execution.
- Validate a configured job list without calling the API or database:
  `npm run import:runchise-sales-periods -- --dry-run`.
- Override sales transaction endpoint path if needed: `RUNCHISE_SALES_TRANSACTIONS_PATH="/sale_transactions"`
- Disable initial boot sync: `RUNCHISE_SYNC_ON_START=false`
- Product/catalog response cache TTL: `CATALOG_RESPONSE_CACHE_TTL_MS=300000`
- Promo response cache TTL: `PROMO_RESPONSE_CACHE_TTL_MS=300000`
- Manual admin endpoints:
  - `POST /api/admin/sync/customers`
  - `POST /api/admin/sync/points`
  - `POST /api/admin/sync/products`
  - `POST /api/admin/sync/brands`
  - `POST /api/admin/sync/locations`
  - `POST /api/admin/sync/promos`
  - `POST /api/admin/sync/sales-transactions`

## Current direct Runchise callers

Only these backend modules should import or call Runchise functions:

- `src/services/runchiseService.js`
- `src/services/syncService.js`

If a route/controller imports `runchiseService`, that is a regression against the DB-only boundary.

## Performance notes

- Public catalog and promo responses are cached in memory for 5 minutes by default.
- Master sync memperbarui katalog produk; konfigurasi redeem hanya dikelola melalui dashboard admin/marketing.
- Database indexes exist for common catalog, promo, and registration lookup paths.
