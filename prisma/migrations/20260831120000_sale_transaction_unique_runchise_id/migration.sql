/*
  Warnings:

  - A unique constraint covering the columns `[runchise_id]` on the table `SaleTransaction` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "SaleTransaction" ALTER COLUMN "runchise_sales_no" TYPE TEXT USING "runchise_sales_no"::TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "SaleTransaction_runchise_id_key" ON "SaleTransaction"("runchise_id");
