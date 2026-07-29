ALTER TABLE "CustomerSalesTransactionReport"
ADD COLUMN "source_location_id" INTEGER,
ADD COLUMN "sales_no" TEXT,
ADD COLUMN "receipt_no" TEXT,
ADD COLUMN "status" TEXT,
ADD COLUMN "is_deleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "nominal_transaksi" DECIMAL(14,2) NOT NULL DEFAULT 0.0,
ADD COLUMN "jumlah_diterima" DECIMAL(14,2) NOT NULL DEFAULT 0.0,
ADD COLUMN "jumlah_kembalian" DECIMAL(14,2) NOT NULL DEFAULT 0.0,
ADD COLUMN "sumber_nominal" TEXT,
ADD COLUMN "payment_methods" TEXT,
ADD COLUMN "customer_snapshot_at" TIMESTAMP(3),
ADD COLUMN "import_run_id" BIGINT;

-- Data lama tidak menyimpan lokasi request. Lokasi transaksi adalah fallback
-- terbaik dan tetap dapat dibedakan dari record import baru melalui import_run_id.
UPDATE "CustomerSalesTransactionReport"
SET "source_location_id" = "runchise_location_id"
WHERE "source_location_id" IS NULL;

ALTER TABLE "CustomerSalesTransactionReport"
ALTER COLUMN "source_location_id" SET NOT NULL;

CREATE TABLE "RunchiseSalesTransactionImportRun" (
  "id" BIGSERIAL NOT NULL,
  "source_location_id" INTEGER NOT NULL,
  "source_location_name" TEXT,
  "start_date" DATE NOT NULL,
  "end_date" DATE NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "pages_fetched" INTEGER NOT NULL DEFAULT 0,
  "api_reported_total" INTEGER,
  "rows_received" INTEGER NOT NULL DEFAULT 0,
  "unique_transactions" INTEGER NOT NULL DEFAULT 0,
  "inserted" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "invalid" INTEGER NOT NULL DEFAULT 0,
  "location_mismatches" INTEGER NOT NULL DEFAULT 0,
  "out_of_range" INTEGER NOT NULL DEFAULT 0,
  "last_page" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "RunchiseSalesTransactionImportRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomerSalesTransactionReport_source_location_id_runchise_sales_transaction_id_key"
ON "CustomerSalesTransactionReport"("source_location_id", "runchise_sales_transaction_id");
CREATE INDEX "CustomerSalesTransactionReport_source_location_id_tanggal_transaksi_idx"
ON "CustomerSalesTransactionReport"("source_location_id", "tanggal_transaksi");
CREATE INDEX "CustomerSalesTransactionReport_source_location_id_runchise_customer_id_idx"
ON "CustomerSalesTransactionReport"("source_location_id", "runchise_customer_id");
CREATE INDEX "CustomerSalesTransactionReport_status_idx"
ON "CustomerSalesTransactionReport"("status");
CREATE INDEX "CustomerSalesTransactionReport_import_run_id_idx"
ON "CustomerSalesTransactionReport"("import_run_id");
CREATE INDEX "RunchiseSalesTransactionImportRun_source_location_id_start_date_end_date_idx"
ON "RunchiseSalesTransactionImportRun"("source_location_id", "start_date", "end_date");
CREATE INDEX "RunchiseSalesTransactionImportRun_status_idx"
ON "RunchiseSalesTransactionImportRun"("status");
