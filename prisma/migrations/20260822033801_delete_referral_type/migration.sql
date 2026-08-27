/*
  Warnings:

  - You are about to drop the column `referral_type` on the `ReferralProgram` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "ReferralProgram_referral_type_key";

-- AlterTable
ALTER TABLE "ReferralProgram" DROP COLUMN "referral_type";
