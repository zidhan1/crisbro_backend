CREATE TABLE "RunchisePosRewardRedemption" (
    "id" BIGSERIAL NOT NULL,
    "sale_transaction_id" INTEGER NOT NULL,
    "sale_detail_transaction_id" INTEGER NOT NULL,
    "runchise_product_id" INTEGER NOT NULL,
    "redeem_menu_item_id" INTEGER,
    "product_name" TEXT NOT NULL,
    "location_id" INTEGER NOT NULL,
    "location_name" TEXT,
    "redeemed_at" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "point_per_item" INTEGER NOT NULL,
    "points_spent" INTEGER NOT NULL,
    "selling_price" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'valid',
    "is_managed_reward" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunchisePosRewardRedemption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RunchisePosRewardRedemption_sale_transaction_id_sale_detail_transaction_id_key"
ON "RunchisePosRewardRedemption"("sale_transaction_id", "sale_detail_transaction_id");
CREATE INDEX "RunchisePosRewardRedemption_is_managed_reward_status_redeemed_at_idx"
ON "RunchisePosRewardRedemption"("is_managed_reward", "status", "redeemed_at");
CREATE INDEX "RunchisePosRewardRedemption_runchise_product_id_redeemed_at_idx"
ON "RunchisePosRewardRedemption"("runchise_product_id", "redeemed_at");
CREATE INDEX "RunchisePosRewardRedemption_location_id_redeemed_at_idx"
ON "RunchisePosRewardRedemption"("location_id", "redeemed_at");
CREATE INDEX "RunchisePosRewardRedemption_redeem_menu_item_id_idx"
ON "RunchisePosRewardRedemption"("redeem_menu_item_id");

ALTER TABLE "RunchisePosRewardRedemption"
ADD CONSTRAINT "RunchisePosRewardRedemption_redeem_menu_item_id_fkey"
FOREIGN KEY ("redeem_menu_item_id") REFERENCES "RedeemMenuItem"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
