ALTER TABLE "Customer"
  ADD COLUMN "runchise_location_id" INTEGER,
  ADD COLUMN "runchise_sync_status" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "runchise_sync_error" TEXT,
  ADD COLUMN "runchise_synced_at" TIMESTAMP(3),
  ADD COLUMN "normalized_phone_number" TEXT;

UPDATE "Customer"
SET "normalized_phone_number" = "phone_number"
WHERE "phone_number" IS NOT NULL
  AND "normalized_phone_number" IS NULL;

CREATE INDEX "Customer_normalized_phone_number_idx" ON "Customer"("normalized_phone_number");
CREATE INDEX "Customer_runchise_location_id_idx" ON "Customer"("runchise_location_id");
CREATE INDEX "Customer_runchise_sync_status_idx" ON "Customer"("runchise_sync_status");
