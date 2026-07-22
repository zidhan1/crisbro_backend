ALTER TABLE "Customer"
ADD COLUMN "runchise_created_at" TIMESTAMP(3),
ADD COLUMN "runchise_updated_at" TIMESTAMP(3);

CREATE INDEX "Customer_runchise_created_at_idx"
ON "Customer"("runchise_created_at");

CREATE INDEX "Customer_runchise_updated_at_idx"
ON "Customer"("runchise_updated_at");
