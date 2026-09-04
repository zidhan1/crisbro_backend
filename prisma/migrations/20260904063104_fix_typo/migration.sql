/*
  Warnings:

  - You are about to drop the column `locations_ids` on the `LoyaltyProduct` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LoyaltyProduct" DROP COLUMN "locations_ids",
ADD COLUMN     "location_ids" TEXT[];
