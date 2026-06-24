-- Older RedeemMenuItem versions had a required sku column.
-- The current admin-managed redeem menu derives SKU from MenuItem, so this
-- legacy column must not block inserts from Prisma.
ALTER TABLE "RedeemMenuItem" ALTER COLUMN "sku" DROP NOT NULL;
