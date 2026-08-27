/*
  Warnings:

  - You are about to drop the column `otp` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `otp_expires` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `otp_id` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[no_referensi]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Referral_referred_id_key";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "otp",
DROP COLUMN "otp_expires",
DROP COLUMN "otp_id",
ADD COLUMN     "no_referensi" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_no_referensi_key" ON "User"("no_referensi");
