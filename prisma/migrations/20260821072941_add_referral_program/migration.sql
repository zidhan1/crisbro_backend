/*
  Warnings:

  - You are about to drop the column `referral_code` on the `ReferralProgram` table. All the data in the column will be lost.
  - You are about to drop the column `referral_name` on the `ReferralProgram` table. All the data in the column will be lost.
  - You are about to drop the column `referral_id` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[owner_referral]` on the table `ReferralProgram` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[referral_type]` on the table `ReferralProgram` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[referral_code]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `owner_referral` to the `ReferralProgram` table without a default value. This is not possible if the table is not empty.
  - Added the required column `point_given` to the `ReferralProgram` table without a default value. This is not possible if the table is not empty.
  - Added the required column `referral_type` to the `ReferralProgram` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_referral_id_fkey";

-- DropIndex
DROP INDEX "ReferralProgram_referral_code_key";

-- DropIndex
DROP INDEX "ReferralProgram_referral_name_key";

-- AlterTable
ALTER TABLE "ReferralProgram" DROP COLUMN "referral_code",
DROP COLUMN "referral_name",
ADD COLUMN     "owner_referral" TEXT NOT NULL,
ADD COLUMN     "point_given" INTEGER NOT NULL,
ADD COLUMN     "referral_type" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "referral_id",
ADD COLUMN     "referral_code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgram_owner_referral_key" ON "ReferralProgram"("owner_referral");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgram_referral_type_key" ON "ReferralProgram"("referral_type");

-- CreateIndex
CREATE UNIQUE INDEX "User_referral_code_key" ON "User"("referral_code");

-- AddForeignKey
ALTER TABLE "ReferralProgram" ADD CONSTRAINT "ReferralProgram_owner_referral_fkey" FOREIGN KEY ("owner_referral") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
