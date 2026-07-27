-- Customer tanpa assignment lokasi eksplisit hanya berlaku di owner location.
-- Relasi multi-lokasi yang sudah ada tidak disentuh karena bisa merupakan assignment valid.
INSERT INTO "CustomerLocation" ("customer_id", "location_id")
SELECT customer."id", customer."owner_location_id"
FROM "Customer" AS customer
WHERE customer."owner_location_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "CustomerLocation" AS customer_location
    WHERE customer_location."customer_id" = customer."id"
  )
ON CONFLICT ("customer_id", "location_id") DO NOTHING;
