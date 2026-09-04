-- CreateTable
CREATE TABLE "LoyaltyProduct" (
    "loyalty_product_id" TEXT NOT NULL,
    "runchise_loyalty_product_id" TEXT NOT NULL,
    "runchise_product_id" TEXT NOT NULL,
    "point_needed" INTEGER NOT NULL,
    "product_name" TEXT NOT NULL,
    "product_sku" TEXT NOT NULL,
    "product_description" TEXT,
    "product_image_url" TEXT,
    "product_unit_name" TEXT,
    "max_redeem" INTEGER NOT NULL,
    "is_select_all_location" BOOLEAN NOT NULL,
    "location_ids" TEXT[],
    "product_locations" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyProduct_pkey" PRIMARY KEY ("loyalty_product_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyProduct_runchise_loyalty_product_id_key" ON "LoyaltyProduct"("runchise_loyalty_product_id");
