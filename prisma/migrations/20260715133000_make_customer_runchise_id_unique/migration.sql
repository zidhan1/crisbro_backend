DO $$
DECLARE
  duplicate_ids TEXT;
BEGIN
  SELECT string_agg("runchise_id"::TEXT, ', ' ORDER BY "runchise_id")
  INTO duplicate_ids
  FROM (
    SELECT "runchise_id"
    FROM "Customer"
    WHERE "runchise_id" IS NOT NULL
    GROUP BY "runchise_id"
    HAVING COUNT(*) > 1
  ) duplicates;

  IF duplicate_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create unique index Customer_runchise_id_key. Duplicate Customer.runchise_id values exist: %',
      duplicate_ids;
  END IF;
END $$;

DROP INDEX IF EXISTS "Customer_runchise_id_idx";

CREATE UNIQUE INDEX "Customer_runchise_id_key" ON "Customer"("runchise_id");
