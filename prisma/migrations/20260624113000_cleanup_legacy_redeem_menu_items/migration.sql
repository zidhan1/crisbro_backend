-- Remove legacy rows that cannot be managed because they are not linked to a MenuItem.
DELETE FROM "RedeemMenuItem" WHERE "menu_item_id" IS NULL;

ALTER TABLE "RedeemMenuItem" ALTER COLUMN "menu_item_id" SET NOT NULL;
