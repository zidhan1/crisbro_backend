/*
  Warnings:

  - The primary key for the `Promo` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `discount_amount` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `discount_is_percentage` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `is_all_outlets` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `is_online_only` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `is_pos_channel` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `is_visible` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `locations` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `raw` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `start_at` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `sub_brand` on the `Promo` table. All the data in the column will be lost.
  - You are about to drop the column `template` on the `Promo` table. All the data in the column will be lost.
  - The `start_date` column on the `Promo` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `end_date` column on the `Promo` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[runchise_id]` on the table `Promo` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `owner_location_id` to the `Promo` table without a default value. This is not possible if the table is not empty.
  - The required column `promo_id` was added to the `Promo` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Made the column `status` on table `Promo` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Promo_is_visible_idx";

-- DropIndex
DROP INDEX "Promo_is_visible_start_at_idx";

-- DropIndex
DROP INDEX "Promo_start_at_idx";

-- AlterTable
ALTER TABLE "Promo" DROP CONSTRAINT "Promo_pkey",
DROP COLUMN "discount_amount",
DROP COLUMN "discount_is_percentage",
DROP COLUMN "id",
DROP COLUMN "is_all_outlets",
DROP COLUMN "is_online_only",
DROP COLUMN "is_pos_channel",
DROP COLUMN "is_visible",
DROP COLUMN "locations",
DROP COLUMN "raw",
DROP COLUMN "start_at",
DROP COLUMN "sub_brand",
DROP COLUMN "template",
ADD COLUMN     "goal" TEXT,
ADD COLUMN     "location_ids" TEXT[],
ADD COLUMN     "location_type" TEXT,
ADD COLUMN     "owner_location_id" TEXT NOT NULL,
ADD COLUMN     "promo_id" TEXT NOT NULL,
ALTER COLUMN "name" DROP NOT NULL,
ALTER COLUMN "status" SET NOT NULL,
DROP COLUMN "start_date",
ADD COLUMN     "start_date" TIMESTAMP(3),
DROP COLUMN "end_date",
ADD COLUMN     "end_date" TIMESTAMP(3),
ADD CONSTRAINT "Promo_pkey" PRIMARY KEY ("promo_id");

-- CreateTable
CREATE TABLE "PromoRule" (
    "promo_rule_id" TEXT NOT NULL,
    "promo_id" TEXT NOT NULL,
    "runchise_promo_rule_id" INTEGER NOT NULL,
    "order_types" TEXT NOT NULL,
    "maximum_qty_applied_to_products" TEXT NOT NULL,
    "use_promotion_code" BOOLEAN,
    "promotion_code_usage_type" TEXT,
    "promotion_code_source" TEXT,
    "promotion_code_number_of_generated_code" INTEGER,
    "promotion_code_maximum_usage" INTEGER,
    "combine_promo_rule" TEXT,
    "member_only" BOOLEAN,
    "maximum_redemption_location_setting" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoRule_pkey" PRIMARY KEY ("promo_rule_id")
);

-- CreateTable
CREATE TABLE "PromoReward" (
    "promo_reward_id" TEXT NOT NULL,
    "promo_id" TEXT NOT NULL,
    "runchise_promo_reward_id" INTEGER,
    "template" TEXT,
    "free_of_charge" BOOLEAN,
    "reward_product_condition" TEXT,
    "discount_amount" TEXT,
    "discount_is_percentage" BOOLEAN,
    "discount_maximum" TEXT,
    "discount_in_house_cost" TEXT,
    "discount_external_cost" TEXT,
    "apply_to_option_set" BOOLEAN,
    "get_products" TEXT[],
    "get_product_allow_multiple" BOOLEAN,
    "special_price_product_price" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoReward_pkey" PRIMARY KEY ("promo_reward_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoRule_promo_id_key" ON "PromoRule"("promo_id");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRule_runchise_promo_rule_id_key" ON "PromoRule"("runchise_promo_rule_id");

-- CreateIndex
CREATE INDEX "PromoRule_promo_id_idx" ON "PromoRule"("promo_id");

-- CreateIndex
CREATE UNIQUE INDEX "PromoReward_promo_id_key" ON "PromoReward"("promo_id");

-- CreateIndex
CREATE UNIQUE INDEX "PromoReward_runchise_promo_reward_id_key" ON "PromoReward"("runchise_promo_reward_id");

-- CreateIndex
CREATE INDEX "PromoReward_promo_id_idx" ON "PromoReward"("promo_id");

-- CreateIndex
CREATE INDEX "PromoReward_template_idx" ON "PromoReward"("template");

-- CreateIndex
CREATE UNIQUE INDEX "Promo_runchise_id_key" ON "Promo"("runchise_id");

-- CreateIndex
CREATE INDEX "Promo_name_idx" ON "Promo"("name");

-- CreateIndex
CREATE INDEX "Promo_status_idx" ON "Promo"("status");

-- AddForeignKey
ALTER TABLE "PromoRule" ADD CONSTRAINT "PromoRule_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "Promo"("promo_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoReward" ADD CONSTRAINT "PromoReward_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "Promo"("promo_id") ON DELETE RESTRICT ON UPDATE CASCADE;
