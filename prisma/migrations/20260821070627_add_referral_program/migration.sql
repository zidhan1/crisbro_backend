/*
  Warnings:

  - The primary key for the `Brand` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `Brand` table. All the data in the column will be lost.
  - You are about to drop the column `logo_url` on the `Brand` table. All the data in the column will be lost.
  - You are about to drop the column `tagline` on the `Brand` table. All the data in the column will be lost.
  - The primary key for the `Customer` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `brand_id` on the `Customer` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `Customer` table. All the data in the column will be lost.
  - The primary key for the `CustomerLocation` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `CustomerLocation` table. All the data in the column will be lost.
  - The primary key for the `Location` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `Location` table. All the data in the column will be lost.
  - The primary key for the `MenuCategory` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `PointHistory` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `phone_number` on the `User` table. All the data in the column will be lost.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `CustomerPoint` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MenuItem` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RewardRedemption` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Session` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[runchise_id]` on the table `Brand` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[runchise_id]` on the table `Customer` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[customer_id,location_id]` on the table `CustomerLocation` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[phone]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - The required column `brand_id` was added to the `Brand` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - The required column `customer_id` was added to the `Customer` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - The required column `customer_location_id` was added to the `CustomerLocation` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - The required column `location_id` was added to the `Location` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - The required column `user_id` was added to the `User` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `username` to the `User` table without a default value. This is not possible if the table is not empty.
  - Made the column `email` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('admin', 'marketing', 'customer');

-- CreateEnum
CREATE TYPE "StatusReferral" AS ENUM ('pending', 'completed');

-- DropForeignKey
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_created_by_id_fkey";

-- DropForeignKey
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_last_updated_by_id_fkey";

-- DropForeignKey
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_owner_location_id_fkey";

-- DropForeignKey
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_user_id_fkey";

-- DropForeignKey
ALTER TABLE "CustomerLocation" DROP CONSTRAINT "CustomerLocation_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "CustomerLocation" DROP CONSTRAINT "CustomerLocation_location_id_fkey";

-- DropForeignKey
ALTER TABLE "CustomerPoint" DROP CONSTRAINT "CustomerPoint_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "Location" DROP CONSTRAINT "Location_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "MenuCategory" DROP CONSTRAINT "MenuCategory_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "MenuItem" DROP CONSTRAINT "MenuItem_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "MenuItem" DROP CONSTRAINT "MenuItem_category_id_fkey";

-- DropForeignKey
ALTER TABLE "PointHistory" DROP CONSTRAINT "PointHistory_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "PointHistory" DROP CONSTRAINT "PointHistory_reward_redemption_id_fkey";

-- DropForeignKey
ALTER TABLE "RewardRedemption" DROP CONSTRAINT "RewardRedemption_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "RewardRedemption" DROP CONSTRAINT "RewardRedemption_reward_id_fkey";

-- DropForeignKey
ALTER TABLE "RewardsCatalog" DROP CONSTRAINT "RewardsCatalog_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_user_id_fkey";

-- DropIndex
DROP INDEX "User_phone_number_key";

-- AlterTable
ALTER TABLE "Brand" DROP CONSTRAINT "Brand_pkey",
DROP COLUMN "id",
DROP COLUMN "logo_url",
DROP COLUMN "tagline",
ADD COLUMN     "brand_id" TEXT NOT NULL,
ADD CONSTRAINT "Brand_pkey" PRIMARY KEY ("brand_id");

-- AlterTable
ALTER TABLE "Customer" DROP CONSTRAINT "Customer_pkey",
DROP COLUMN "brand_id",
DROP COLUMN "id",
ADD COLUMN     "available_point" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customer_id" TEXT NOT NULL,
ADD COLUMN     "normalized_phone_number" TEXT,
ADD COLUMN     "runchise_location_id" INTEGER,
ADD COLUMN     "runchise_synced_at" TIMESTAMP(3),
ADD COLUMN     "total_point" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "user_id" SET DATA TYPE TEXT,
ALTER COLUMN "owner_location_id" SET DATA TYPE TEXT,
ALTER COLUMN "created_by_id" SET DATA TYPE TEXT,
ALTER COLUMN "last_updated_by_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Customer_pkey" PRIMARY KEY ("customer_id");

-- AlterTable
ALTER TABLE "CustomerLocation" DROP CONSTRAINT "CustomerLocation_pkey",
DROP COLUMN "id",
ADD COLUMN     "customer_location_id" TEXT NOT NULL,
ALTER COLUMN "customer_id" SET DATA TYPE TEXT,
ALTER COLUMN "location_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "CustomerLocation_pkey" PRIMARY KEY ("customer_location_id");

-- AlterTable
ALTER TABLE "Location" DROP CONSTRAINT "Location_pkey",
DROP COLUMN "id",
ADD COLUMN     "is_outlet" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "location_id" TEXT NOT NULL,
ADD COLUMN     "phone" TEXT,
ALTER COLUMN "brand_id" DROP NOT NULL,
ALTER COLUMN "brand_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "Location_pkey" PRIMARY KEY ("location_id");

-- AlterTable
ALTER TABLE "MenuCategory" DROP CONSTRAINT "MenuCategory_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "brand_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "MenuCategory_id_seq";

-- AlterTable
ALTER TABLE "PointHistory" DROP CONSTRAINT "PointHistory_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "customer_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "PointHistory_pkey" PRIMARY KEY ("id");
DROP SEQUENCE "PointHistory_id_seq";

-- AlterTable
ALTER TABLE "RewardsCatalog" ALTER COLUMN "brand_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "User" DROP CONSTRAINT "User_pkey",
DROP COLUMN "id",
DROP COLUMN "phone_number",
ADD COLUMN     "email_verification_expires" TIMESTAMP(3),
ADD COLUMN     "email_verification_token" TEXT,
ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "otp" TEXT,
ADD COLUMN     "otp_expires" TIMESTAMP(3),
ADD COLUMN     "otp_id" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "phone_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "referral_id" TEXT,
ADD COLUMN     "user_id" TEXT NOT NULL,
ADD COLUMN     "username" TEXT NOT NULL,
ALTER COLUMN "email" SET NOT NULL,
DROP COLUMN "role",
ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'marketing',
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("user_id");

-- DropTable
DROP TABLE "CustomerPoint";

-- DropTable
DROP TABLE "MenuItem";

-- DropTable
DROP TABLE "RewardRedemption";

-- DropTable
DROP TABLE "Session";

-- CreateTable
CREATE TABLE "AdminActivityLog" (
    "activity_id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_role" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" INTEGER,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminActivityLog_pkey" PRIMARY KEY ("activity_id")
);

-- CreateTable
CREATE TABLE "ReferralProgram" (
    "referral_id" TEXT NOT NULL,
    "referral_name" TEXT NOT NULL,
    "referral_code" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "point_reward" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralProgram_pkey" PRIMARY KEY ("referral_id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "referral_id" TEXT NOT NULL,
    "referral_program_id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "referred_id" TEXT NOT NULL,
    "point_awarded" INTEGER NOT NULL,
    "status" "StatusReferral" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("referral_id")
);

-- CreateTable
CREATE TABLE "SubBrand" (
    "sub_brand_id" TEXT NOT NULL,
    "runchise_id" INTEGER NOT NULL,
    "brand_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image_url" TEXT,
    "location_type" TEXT,
    "is_select_all_location" BOOLEAN NOT NULL DEFAULT false,
    "enable_online_order" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubBrand_pkey" PRIMARY KEY ("sub_brand_id")
);

-- CreateTable
CREATE TABLE "Promo" (
    "id" TEXT NOT NULL,
    "runchise_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "start_date" TEXT,
    "end_date" TEXT,
    "channel" TEXT,
    "is_online_only" BOOLEAN NOT NULL DEFAULT false,
    "is_all_outlets" BOOLEAN NOT NULL DEFAULT false,
    "locations" JSONB,
    "discount_amount" DECIMAL(12,2),
    "discount_is_percentage" BOOLEAN NOT NULL DEFAULT false,
    "template" TEXT,
    "sub_brand" TEXT,
    "is_pos_channel" BOOLEAN NOT NULL DEFAULT false,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "start_at" TIMESTAMP(3),
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminActivityLog_actor_user_id_idx" ON "AdminActivityLog"("actor_user_id");

-- CreateIndex
CREATE INDEX "AdminActivityLog_action_idx" ON "AdminActivityLog"("action");

-- CreateIndex
CREATE INDEX "AdminActivityLog_entity_type_entity_id_idx" ON "AdminActivityLog"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "AdminActivityLog_created_at_idx" ON "AdminActivityLog"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgram_referral_name_key" ON "ReferralProgram"("referral_name");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgram_referral_code_key" ON "ReferralProgram"("referral_code");

-- CreateIndex
CREATE INDEX "Referral_referrer_id_idx" ON "Referral"("referrer_id");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_referred_id_key" ON "Referral"("referred_id");

-- CreateIndex
CREATE UNIQUE INDEX "SubBrand_runchise_id_key" ON "SubBrand"("runchise_id");

-- CreateIndex
CREATE INDEX "Promo_is_visible_idx" ON "Promo"("is_visible");

-- CreateIndex
CREATE INDEX "Promo_start_at_idx" ON "Promo"("start_at");

-- CreateIndex
CREATE INDEX "Promo_is_visible_start_at_idx" ON "Promo"("is_visible", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_runchise_id_key" ON "Brand"("runchise_id");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_runchise_id_key" ON "Customer"("runchise_id");

-- CreateIndex
CREATE INDEX "Customer_phone_number_idx" ON "Customer"("phone_number");

-- CreateIndex
CREATE INDEX "Customer_normalized_phone_number_idx" ON "Customer"("normalized_phone_number");

-- CreateIndex
CREATE INDEX "Customer_runchise_location_id_idx" ON "Customer"("runchise_location_id");

-- CreateIndex
CREATE INDEX "Customer_created_at_idx" ON "Customer"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerLocation_customer_id_location_id_key" ON "CustomerLocation"("customer_id", "location_id");

-- CreateIndex
CREATE INDEX "MenuCategory_name_idx" ON "MenuCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "ReferralProgram"("referral_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminActivityLog" ADD CONSTRAINT "AdminActivityLog_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "User"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referral_program_id_fkey" FOREIGN KEY ("referral_program_id") REFERENCES "ReferralProgram"("referral_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referred_id_fkey" FOREIGN KEY ("referred_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_owner_location_id_fkey" FOREIGN KEY ("owner_location_id") REFERENCES "Location"("location_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_last_updated_by_id_fkey" FOREIGN KEY ("last_updated_by_id") REFERENCES "User"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubBrand" ADD CONSTRAINT "SubBrand_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "Brand"("brand_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Location" ADD CONSTRAINT "Location_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "Brand"("brand_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLocation" ADD CONSTRAINT "CustomerLocation_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerLocation" ADD CONSTRAINT "CustomerLocation_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "Location"("location_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "Brand"("brand_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointHistory" ADD CONSTRAINT "PointHistory_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardsCatalog" ADD CONSTRAINT "RewardsCatalog_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "Brand"("brand_id") ON DELETE RESTRICT ON UPDATE CASCADE;
