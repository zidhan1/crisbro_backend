-- Create category table if it does not exist yet.
CREATE TABLE IF NOT EXISTS "RedeemMenuCategory" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RedeemMenuCategory_pkey" PRIMARY KEY ("id")
);

-- Ensure at least one category exists for legacy RedeemMenuItem rows.
INSERT INTO "RedeemMenuCategory" ("name", "sort_order", "is_active", "updated_at")
SELECT 'Redeem Menu', 0, true, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "RedeemMenuCategory");

-- Create item table if it does not exist yet.
CREATE TABLE IF NOT EXISTS "RedeemMenuItem" (
    "id" SERIAL NOT NULL,
    "menu_item_id" INTEGER,
    "category_id" INTEGER,
    "points_required" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "badge" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "stock_limit" INTEGER,
    "daily_limit" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RedeemMenuItem_pkey" PRIMARY KEY ("id")
);

-- Bring an older RedeemMenuItem table up to the current shape.
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "menu_item_id" INTEGER;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "category_id" INTEGER;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "points_required" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "badge" TEXT;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "start_at" TIMESTAMP(3);
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "end_at" TIMESTAMP(3);
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "stock_limit" INTEGER;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "daily_limit" INTEGER;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "RedeemMenuItem" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "RedeemMenuItem"
SET "category_id" = (SELECT "id" FROM "RedeemMenuCategory" ORDER BY "sort_order", "id" LIMIT 1)
WHERE "category_id" IS NULL;

ALTER TABLE "RedeemMenuItem" ALTER COLUMN "category_id" SET NOT NULL;
ALTER TABLE "RedeemMenuItem" ALTER COLUMN "points_required" SET NOT NULL;
ALTER TABLE "RedeemMenuItem" ALTER COLUMN "is_active" SET NOT NULL;
ALTER TABLE "RedeemMenuItem" ALTER COLUMN "sort_order" SET NOT NULL;
ALTER TABLE "RedeemMenuItem" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "RedeemMenuItem" ALTER COLUMN "updated_at" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "RedeemMenuCategory_is_active_idx" ON "RedeemMenuCategory"("is_active");
CREATE INDEX IF NOT EXISTS "RedeemMenuCategory_sort_order_idx" ON "RedeemMenuCategory"("sort_order");
CREATE UNIQUE INDEX IF NOT EXISTS "RedeemMenuItem_menu_item_id_key" ON "RedeemMenuItem"("menu_item_id");
CREATE INDEX IF NOT EXISTS "RedeemMenuItem_category_id_idx" ON "RedeemMenuItem"("category_id");
CREATE INDEX IF NOT EXISTS "RedeemMenuItem_is_active_idx" ON "RedeemMenuItem"("is_active");
CREATE INDEX IF NOT EXISTS "RedeemMenuItem_sort_order_idx" ON "RedeemMenuItem"("sort_order");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RedeemMenuItem_menu_item_id_fkey'
  ) THEN
    ALTER TABLE "RedeemMenuItem"
    ADD CONSTRAINT "RedeemMenuItem_menu_item_id_fkey"
    FOREIGN KEY ("menu_item_id") REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'RedeemMenuItem_category_id_fkey'
  ) THEN
    ALTER TABLE "RedeemMenuItem"
    ADD CONSTRAINT "RedeemMenuItem_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "RedeemMenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
