-- CreateTable
CREATE TABLE "SaleTransaction" (
    "transaction_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "runchise_id" INTEGER,
    "runchise_brand_id" INTEGER,
    "runchise_sales_no" INTEGER,
    "runchise_customer_id" INTEGER,
    "runchise_location_id" INTEGER,
    "gross_sales" DOUBLE PRECISION,
    "net_sales" DOUBLE PRECISION,
    "location_name" TEXT,
    "order_type_name" TEXT,
    "subtotal" DOUBLE PRECISION,
    "net_sales_after_tax" DOUBLE PRECISION,
    "sales_time" TIMESTAMP(3),
    "note" TEXT,
    "applied_promos_redeemed_point" INTEGER,
    "loyalty_discount_fee" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3),

    CONSTRAINT "SaleTransaction_pkey" PRIMARY KEY ("transaction_id")
);

-- AddForeignKey
ALTER TABLE "SaleTransaction" ADD CONSTRAINT "SaleTransaction_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("customer_id") ON DELETE RESTRICT ON UPDATE CASCADE;
