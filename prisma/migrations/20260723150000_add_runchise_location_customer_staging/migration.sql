CREATE TABLE IF NOT EXISTS "RunchiseCustomerImportRun" (
    "id" BIGSERIAL NOT NULL,
    "source_location_id" INTEGER NOT NULL,
    "source_location_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "api_reported_total" INTEGER,
    "rows_received" INTEGER NOT NULL DEFAULT 0,
    "unique_customers" INTEGER NOT NULL DEFAULT 0,
    "inserted" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "location_mismatches" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "RunchiseCustomerImportRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RunchiseLocationCustomer" (
    "id" BIGSERIAL NOT NULL,
    "source_location_id" INTEGER NOT NULL,
    "runchise_customer_id" INTEGER NOT NULL,
    "name" TEXT,
    "phone_number" TEXT,
    "phone_number_country_code" INTEGER,
    "address" TEXT,
    "province" TEXT,
    "city" TEXT,
    "country" TEXT,
    "postal_code" TEXT,
    "email" TEXT,
    "dob" DATE,
    "gender" TEXT,
    "brand_id" INTEGER,
    "status" TEXT,
    "location_ids" JSONB NOT NULL,
    "owner_location_id" INTEGER,
    "owner_location_name" TEXT,
    "balance" DECIMAL(18,2),
    "total_point" INTEGER,
    "available_point" INTEGER,
    "customer_category_id" INTEGER,
    "customer_category_name" TEXT,
    "food_alergy" TEXT,
    "notes" TEXT,
    "customer_code" TEXT,
    "created_by_id" INTEGER,
    "last_updated_by_id" INTEGER,
    "runchise_created_at" TIMESTAMP(3),
    "runchise_updated_at" TIMESTAMP(3),
    "last_visited_date" TIMESTAMP(3),
    "raw" JSONB NOT NULL,
    "last_import_run_id" BIGINT,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunchiseLocationCustomer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RunchiseLocationCustomer_source_location_id_runchise_customer_id_key"
ON "RunchiseLocationCustomer"("source_location_id", "runchise_customer_id");
CREATE INDEX IF NOT EXISTS "RunchiseLocationCustomer_source_location_id_idx" ON "RunchiseLocationCustomer"("source_location_id");
CREATE INDEX IF NOT EXISTS "RunchiseLocationCustomer_runchise_customer_id_idx" ON "RunchiseLocationCustomer"("runchise_customer_id");
CREATE INDEX IF NOT EXISTS "RunchiseLocationCustomer_owner_location_id_idx" ON "RunchiseLocationCustomer"("owner_location_id");
CREATE INDEX IF NOT EXISTS "RunchiseLocationCustomer_last_import_run_id_idx" ON "RunchiseLocationCustomer"("last_import_run_id");
CREATE INDEX IF NOT EXISTS "RunchiseCustomerImportRun_source_location_id_started_at_idx" ON "RunchiseCustomerImportRun"("source_location_id", "started_at");
CREATE INDEX IF NOT EXISTS "RunchiseCustomerImportRun_status_idx" ON "RunchiseCustomerImportRun"("status");
