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
| `/products` | GET | `MenuItem`, `MenuCategory` |
| `/sub_brands` | GET | `Brand`, `SubBrand`, `SubBrandProductCategory` |
| `/locations` | GET | `Location` |
| `/promos` | GET | `Promo` |

## Sync entrypoints

- Cron worker: `src/jobs/runchiseSyncCron.js`
- Default schedule: every 30 minutes (`*/30 * * * *`)
- Disable cron: `RUNCHISE_SYNC_CRON_ENABLED=false`
- Change schedule: `RUNCHISE_SYNC_CRON="*/15 * * * *"`
- Disable initial boot sync: `RUNCHISE_SYNC_ON_START=false`
- Manual admin endpoints:
  - `POST /api/admin/sync/customers`
  - `POST /api/admin/sync/points`
  - `POST /api/admin/sync/products`
  - `POST /api/admin/sync/redeem-menu`
  - `POST /api/admin/sync/brands`
  - `POST /api/admin/sync/locations`
  - `POST /api/admin/sync/promos`

## Current direct Runchise callers

Only these backend modules should import or call Runchise functions:

- `src/services/runchiseService.js`
- `src/services/syncService.js`

If a route/controller imports `runchiseService`, that is a regression against the DB-only boundary.
