-- H-4 / M-7 privacy retention policy:
-- Historical financial/point facts remain available for audit, while identity
-- snapshots and raw upstream payloads are removed once no Customer owns them.
UPDATE "CustomerSalesTransactionReport"
SET
  "nama_pelanggan" = NULL,
  "no_telepon" = NULL,
  "raw" = NULL
WHERE "customer_id" IS NULL
  AND (
    "nama_pelanggan" IS NOT NULL
    OR "no_telepon" IS NOT NULL
    OR "raw" IS NOT NULL
  );

UPDATE "RunchisePosRewardRedemption"
SET
  "customer_name" = NULL,
  "customer_phone_number" = NULL,
  "raw" = NULL
WHERE "customer_id" IS NULL
  AND (
    "customer_name" IS NOT NULL
    OR "customer_phone_number" IS NOT NULL
    OR "raw" IS NOT NULL
  );

-- Versi lama deleteAdminCustomer menyalin snapshot lengkap customer ke JSON
-- audit. Pertahankan event/actor/entity_id, hapus hanya payload `before` yang
-- bertentangan dengan penghapusan PII.
UPDATE "AdminActivityLog"
SET "before" = NULL
WHERE "action" = 'delete_customer'
  AND "before" IS NOT NULL;
