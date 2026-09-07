-- CreateTable
CREATE TABLE "PromoCode" (
    "promo_code_id" TEXT NOT NULL,
    "promo_id" TEXT NOT NULL,
    "runchise_promo_id" INTEGER,
    "code" TEXT,
    "usage_type" TEXT,
    "status" TEXT,
    "maximum_usage" INTEGER,
    "number_of_usage" INTEGER,
    "last_usage" TIMESTAMP(3),
    "deactivate_at" TIMESTAMP(3),
    "deactivate_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("promo_code_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_runchise_promo_id_key" ON "PromoCode"("runchise_promo_id");

-- AddForeignKey
ALTER TABLE "PromoCode" ADD CONSTRAINT "PromoCode_promo_id_fkey" FOREIGN KEY ("promo_id") REFERENCES "Promo"("promo_id") ON DELETE RESTRICT ON UPDATE CASCADE;
