/*
  Warnings:

  - You are about to drop the column `runchise_promo_code_id` on the `PromoCode` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[runchise_id]` on the table `PromoCode` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "PromoCode_runchise_promo_code_id_key";

-- AlterTable
ALTER TABLE "PromoCode" DROP COLUMN "runchise_promo_code_id",
ADD COLUMN     "runchise_id" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_runchise_id_key" ON "PromoCode"("runchise_id");
