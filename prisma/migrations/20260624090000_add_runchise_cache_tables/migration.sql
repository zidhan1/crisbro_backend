-- CreateTable
CREATE TABLE "SubBrandProductCategory" (
    "id" SERIAL NOT NULL,
    "sub_brand_id" INTEGER NOT NULL,
    "menu_category_id" INTEGER NOT NULL,

    CONSTRAINT "SubBrandProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promo" (
    "id" SERIAL NOT NULL,
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
CREATE UNIQUE INDEX "SubBrandProductCategory_sub_brand_id_menu_category_id_key" ON "SubBrandProductCategory"("sub_brand_id", "menu_category_id");

-- CreateIndex
CREATE UNIQUE INDEX "Promo_runchise_id_key" ON "Promo"("runchise_id");

-- AddForeignKey
ALTER TABLE "SubBrandProductCategory" ADD CONSTRAINT "SubBrandProductCategory_sub_brand_id_fkey" FOREIGN KEY ("sub_brand_id") REFERENCES "SubBrand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubBrandProductCategory" ADD CONSTRAINT "SubBrandProductCategory_menu_category_id_fkey" FOREIGN KEY ("menu_category_id") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
