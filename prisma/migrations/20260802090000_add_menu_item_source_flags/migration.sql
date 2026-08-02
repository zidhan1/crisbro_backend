ALTER TABLE "MenuItem"
ADD COLUMN "is_modifier" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "is_selectable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "variance_parent_product_id" INTEGER;

CREATE INDEX "MenuItem_is_selectable_idx" ON "MenuItem"("is_selectable");
