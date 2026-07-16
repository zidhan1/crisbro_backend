-- CreateTable
CREATE TABLE "CustomerSalesTransactionReport" (
    "id" SERIAL NOT NULL,
    "runchise_sales_transaction_id" INTEGER NOT NULL,
    "runchise_customer_id" INTEGER,
    "customer_id" INTEGER,
    "runchise_location_id" INTEGER,
    "nama_pelanggan" TEXT,
    "no_telepon" TEXT,
    "lokasi_dibuat" TEXT,
    "pelanggan_sejak" TIMESTAMP(3),
    "poin_pelanggan" INTEGER NOT NULL DEFAULT 0,
    "tanggal_transaksi" TIMESTAMP(3),
    "nama_outlet" TEXT,
    "tipe_order" TEXT,
    "pembelian_per_order" DECIMAL(12,2) NOT NULL DEFAULT 0.0,
    "penambahan_poin" INTEGER NOT NULL DEFAULT 0,
    "penggunaan_poin" DECIMAL(12,2) NOT NULL DEFAULT 0.0,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerSalesTransactionReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerSalesTransactionReport_runchise_sales_transaction_id_key" ON "CustomerSalesTransactionReport"("runchise_sales_transaction_id");

-- CreateIndex
CREATE INDEX "CustomerSalesTransactionReport_customer_id_idx" ON "CustomerSalesTransactionReport"("customer_id");

-- CreateIndex
CREATE INDEX "CustomerSalesTransactionReport_runchise_customer_id_idx" ON "CustomerSalesTransactionReport"("runchise_customer_id");

-- CreateIndex
CREATE INDEX "CustomerSalesTransactionReport_runchise_location_id_idx" ON "CustomerSalesTransactionReport"("runchise_location_id");

-- CreateIndex
CREATE INDEX "CustomerSalesTransactionReport_tanggal_transaksi_idx" ON "CustomerSalesTransactionReport"("tanggal_transaksi");

-- CreateIndex
CREATE INDEX "CustomerSalesTransactionReport_nama_outlet_idx" ON "CustomerSalesTransactionReport"("nama_outlet");

-- AddForeignKey
ALTER TABLE "CustomerSalesTransactionReport" ADD CONSTRAINT "CustomerSalesTransactionReport_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
