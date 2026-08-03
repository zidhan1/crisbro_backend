ALTER TABLE "RunchisePosRewardRedemption"
ADD COLUMN "runchise_customer_id" INTEGER,
ADD COLUMN "customer_id" INTEGER,
ADD COLUMN "customer_name" TEXT,
ADD COLUMN "customer_phone_number" TEXT;

CREATE INDEX "RunchisePosRewardRedemption_customer_id_idx"
ON "RunchisePosRewardRedemption"("customer_id");

CREATE INDEX "RunchisePosRewardRedemption_runchise_customer_id_idx"
ON "RunchisePosRewardRedemption"("runchise_customer_id");

ALTER TABLE "RunchisePosRewardRedemption"
ADD CONSTRAINT "RunchisePosRewardRedemption_customer_id_fkey"
FOREIGN KEY ("customer_id") REFERENCES "Customer"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
