-- Merge duplicate Runchise brands before enforcing uniqueness.
-- Canonical brand is the smallest local Brand.id for each non-null runchise_id.
WITH duplicate_brands AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY "runchise_id") AS "canonical_id"
  FROM "Brand"
  WHERE "runchise_id" IS NOT NULL
)
UPDATE "Customer"
SET "brand_id" = duplicate_brands."canonical_id"
FROM duplicate_brands
WHERE "Customer"."brand_id" = duplicate_brands."id"
  AND duplicate_brands."id" <> duplicate_brands."canonical_id";

WITH duplicate_brands AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY "runchise_id") AS "canonical_id"
  FROM "Brand"
  WHERE "runchise_id" IS NOT NULL
)
UPDATE "Location"
SET "brand_id" = duplicate_brands."canonical_id"
FROM duplicate_brands
WHERE "Location"."brand_id" = duplicate_brands."id"
  AND duplicate_brands."id" <> duplicate_brands."canonical_id";

WITH duplicate_brands AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY "runchise_id") AS "canonical_id"
  FROM "Brand"
  WHERE "runchise_id" IS NOT NULL
)
UPDATE "MenuCategory"
SET "brand_id" = duplicate_brands."canonical_id"
FROM duplicate_brands
WHERE "MenuCategory"."brand_id" = duplicate_brands."id"
  AND duplicate_brands."id" <> duplicate_brands."canonical_id";

WITH duplicate_brands AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY "runchise_id") AS "canonical_id"
  FROM "Brand"
  WHERE "runchise_id" IS NOT NULL
)
UPDATE "MenuItem"
SET "brand_id" = duplicate_brands."canonical_id"
FROM duplicate_brands
WHERE "MenuItem"."brand_id" = duplicate_brands."id"
  AND duplicate_brands."id" <> duplicate_brands."canonical_id";

WITH duplicate_brands AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY "runchise_id") AS "canonical_id"
  FROM "Brand"
  WHERE "runchise_id" IS NOT NULL
)
UPDATE "RewardsCatalog"
SET "brand_id" = duplicate_brands."canonical_id"
FROM duplicate_brands
WHERE "RewardsCatalog"."brand_id" = duplicate_brands."id"
  AND duplicate_brands."id" <> duplicate_brands."canonical_id";

WITH duplicate_brands AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY "runchise_id") AS "canonical_id"
  FROM "Brand"
  WHERE "runchise_id" IS NOT NULL
)
UPDATE "SubBrand"
SET "brand_id" = duplicate_brands."canonical_id"
FROM duplicate_brands
WHERE "SubBrand"."brand_id" = duplicate_brands."id"
  AND duplicate_brands."id" <> duplicate_brands."canonical_id";

WITH duplicate_brands AS (
  SELECT
    "id",
    MIN("id") OVER (PARTITION BY "runchise_id") AS "canonical_id"
  FROM "Brand"
  WHERE "runchise_id" IS NOT NULL
)
DELETE FROM "Brand"
USING duplicate_brands
WHERE "Brand"."id" = duplicate_brands."id"
  AND duplicate_brands."id" <> duplicate_brands."canonical_id";

CREATE UNIQUE INDEX "Brand_runchise_id_key" ON "Brand"("runchise_id");
