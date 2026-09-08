/*
  Warnings:

  - You are about to drop the column `last_sync_at` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "last_sync_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" DROP COLUMN "last_sync_at";
