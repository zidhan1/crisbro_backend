-- Identitas transaksi untuk importer multi-lokasi harus menyertakan lokasi
-- sumber. Composite unique sudah dibuat oleh migration audit import.
DROP INDEX IF EXISTS "CustomerSalesTransactionReport_runchise_sales_transaction_id_key";
