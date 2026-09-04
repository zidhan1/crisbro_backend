/*
  Warnings:

  - You are about to drop the column `product_locations` on the `LoyaltyProduct` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LoyaltyProduct" DROP COLUMN "product_locations",
ADD COLUMN     "product_location_ids" TEXT[];
