DELETE FROM "CustomerLocation" cl
USING "CustomerLocation" duplicate
WHERE cl."customer_id" = duplicate."customer_id"
  AND cl."location_id" = duplicate."location_id"
  AND cl."id" > duplicate."id";

ALTER TABLE "CustomerLocation"
ADD CONSTRAINT "CustomerLocation_customer_id_location_id_key"
UNIQUE ("customer_id", "location_id");
