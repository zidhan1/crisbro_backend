/*
  Warnings:

  - You are about to drop the column `address` on the `Location` table. All the data in the column will be lost.
  - You are about to drop the column `brand_id` on the `Location` table. All the data in the column will be lost.
  - You are about to drop the column `is_active` on the `Location` table. All the data in the column will be lost.
  - You are about to drop the column `is_outlet` on the `Location` table. All the data in the column will be lost.
  - You are about to drop the column `phone` on the `Location` table. All the data in the column will be lost.
  - You are about to drop the column `brand_id` on the `MenuCategory` table. All the data in the column will be lost.
  - You are about to drop the column `brand_id` on the `RewardsCatalog` table. All the data in the column will be lost.
  - You are about to drop the column `brand_id` on the `SubBrand` table. All the data in the column will be lost.
  - You are about to drop the `Brand` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `CustomerLocation` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CustomerLocation" DROP CONSTRAINT "CustomerLocation_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "CustomerLocation" DROP CONSTRAINT "CustomerLocation_location_id_fkey";

-- DropForeignKey
ALTER TABLE "Location" DROP CONSTRAINT "Location_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "MenuCategory" DROP CONSTRAINT "MenuCategory_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "RewardsCatalog" DROP CONSTRAINT "RewardsCatalog_brand_id_fkey";

-- DropForeignKey
ALTER TABLE "SubBrand" DROP CONSTRAINT "SubBrand_brand_id_fkey";

-- AlterTable
ALTER TABLE "Location" DROP COLUMN "address",
DROP COLUMN "brand_id",
DROP COLUMN "is_active",
DROP COLUMN "is_outlet",
DROP COLUMN "phone",
ADD COLUMN     "branch_type" TEXT,
ADD COLUMN     "contact_number" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "gmap_address" TEXT,
ADD COLUMN     "postal_code" TEXT,
ADD COLUMN     "shipping_address" TEXT,
ADD COLUMN     "status" TEXT,
ADD COLUMN     "sub_brands" TEXT[],
ALTER COLUMN "latitude" SET DATA TYPE TEXT,
ALTER COLUMN "longitude" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "MenuCategory" DROP COLUMN "brand_id";

-- AlterTable
ALTER TABLE "RewardsCatalog" DROP COLUMN "brand_id";

-- AlterTable
ALTER TABLE "SubBrand" DROP COLUMN "brand_id";

-- DropTable
DROP TABLE "Brand";

-- DropTable
DROP TABLE "CustomerLocation";
