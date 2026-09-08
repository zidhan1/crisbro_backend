/*
  Warnings:

  - You are about to drop the column `last_sync_at` on the `Customer` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Customer" DROP COLUMN "last_sync_at";
