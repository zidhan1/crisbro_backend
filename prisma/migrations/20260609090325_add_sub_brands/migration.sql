-- CreateTable
CREATE TABLE "SubBrand" (
    "id" SERIAL NOT NULL,
    "runchise_id" INTEGER NOT NULL,
    "brand_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "image_url" TEXT,
    "location_type" TEXT,
    "is_select_all_location" BOOLEAN NOT NULL DEFAULT false,
    "enable_online_order" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubBrand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubBrand_runchise_id_key" ON "SubBrand"("runchise_id");

-- AddForeignKey
ALTER TABLE "SubBrand" ADD CONSTRAINT "SubBrand_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
