# Promo API

All promo routes require authentication and the `admin` or `marketing` role.
Paths below are relative to the application's API prefix.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/promos` | Paginated local list |
| GET | `/promos/:promo_id` | Local detail, including stored codes |
| POST | `/promos` | Create in Runchise and synchronize locally |
| POST | `/promos/:promo_id/promo-codes/generate` | Generate additional codes and synchronize locally |
| PATCH | `/promos/:promo_id` | Update in Runchise and synchronize locally |
| PATCH | `/promos/:promo_id/activate` | Activate and refresh from Runchise |
| PATCH | `/promos/:promo_id/deactivate` | Deactivate and refresh from Runchise |
| POST | `/promos/sync/:runchise_id` | Recover local synchronization without creating or updating the remote promo |

`promo_id` is a local UUID. `runchise_id` is a positive integer from Runchise.

## Response contract

Create, detail, update, status changes, and sync use the existing create response shape:

```json
{
  "success": true,
  "message": "Promo retrieved successfully",
  "data": {
    "promo": { "promo_id": "local-uuid", "runchise_id": 42, "status": "active" },
    "promo_rule": {},
    "promo_reward": {},
    "promo_codes": []
  }
}
```

List returns `data: { data: [<same item shape>], meta: { page, limit, total, total_pages } }`.
List items omit `promo_codes` to avoid loading all codes on each list request.
Missing rule/reward relations are `null`. Rule `order_types` and
`maximum_qty_applied_to_products` remain JSON strings matching the current database schema.

**Compatibility:** list/detail previously returned flat promo fields and camelCase
relations. Consumers must now read `item.promo`, `item.promo_rule`, and
`item.promo_reward`. Status endpoints now return the synchronized detail object.

## Recovery and consistency

All remote reads and response validation finish before the local write transaction.
Promo, rule, reward and all returned codes commit together or roll back together.
Codes absent from the remote response are retained; absence is not treated as deletion.
New codes are inserted in batches of 100, and existing code fields are updated.

A failed sync returns HTTP 502 with structured `message`:

```json
{
  "message": {
    "code": "PROMO_SYNC_FAILED",
    "message": "Sinkronisasi lokal gagal; ulangi hanya sinkronisasi menggunakan runchise_id, jangan ulangi create atau generate promo code",
    "runchise_id": 42
  },
  "error_id": "request-error-id"
}
```

Recover with `POST /promos/sync/42`. Repeating this operation updates the same local
promo via its unique Runchise ID. Fix missing local locations before retrying when
location mapping fails. Validation/database errors remain available in the server-side
Error `cause` chain.

Remote mutations cannot be rolled back by a local transaction. Do not retry POST
create automatically: no upstream idempotency contract has been verified. If an
upstream timeout occurs before its ID is received, inspect Runchise before retrying.
Concurrent remote modifications can still race with synchronization; explicit sync
refreshes the current remote state.

The read adapter expects `GET /promos/:runchise_id` to return `{ promo: ... }` with
locations, rule and reward, and the codes endpoint to return `{ promo_codes: [...] }`.
These contracts must be integration-tested against Runchise. Code-list pagination
has not been verified; only codes returned by the current adapter are synchronized.

Response dates support `DD/MM/YYYY`, `YYYY-MM-DD`, or ISO timestamps with a timezone.
Date-only values are stored at UTC midnight. Invalid calendar dates, missing required
arrays, missing local locations, and invalid numbers fail validation before writing.
Explicit null product arrays become empty arrays; omitted required arrays are rejected.

## Local verification

Run `node --test tests/promo.test.cjs`. Tests mock external APIs and Prisma, including
transaction rollback behavior; they do not perform integration testing or migrations.

## Generate codes separately

```http
POST /promos/:promo_id/promo-codes/generate
Content-Type: application/json

{ "total_code": 10 }
```

Use the local promo UUID. `total_code` is required and must be a JSON integer
between 1 and 1000. Unknown body fields are rejected. The promo must already have
`use_promotion_code: true`; otherwise the endpoint returns 409. Invalid input
returns 422 and an unknown local promo returns 404.

The existing generator creates 7-character codes with `maximum_usage: 1` and
submits them to Runchise. The endpoint then refreshes the promo and stored codes,
returning HTTP 201 with the detail response shape. `promo_codes` contains the
stored codes, including pre-existing ones, rather than only the newly generated batch.

Create/update services do not call `generatePromoCode`. They still synchronize
codes from Runchise. Existing Runchise create/update payload options, including
remote automatic-generation settings, are forwarded unchanged.

If generation succeeds but synchronization fails, recover through
`POST /promos/sync/:runchise_id`; do not repeat generation, which would create another
batch. An upstream timeout also has an uncertain result and must not be retried blindly.
