/*
  Warnings:

  - Changed the type of `runchise_loyalty_product_id` on the `LoyaltyProduct` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `runchise_product_id` on the `LoyaltyProduct` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- AlterTable
ALTER TABLE "LoyaltyProduct" DROP COLUMN "runchise_loyalty_product_id",
ADD COLUMN     "runchise_loyalty_product_id" INTEGER NOT NULL,
DROP COLUMN "runchise_product_id",
ADD COLUMN     "runchise_product_id" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyProduct_runchise_loyalty_product_id_key" ON "LoyaltyProduct"("runchise_loyalty_product_id");
