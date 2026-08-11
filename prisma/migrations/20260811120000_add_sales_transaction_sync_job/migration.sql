CREATE TABLE "SalesTransactionSyncJob" (
    "id" SERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "source" TEXT NOT NULL DEFAULT 'cron',
    "location_ids" JSONB NOT NULL,
    "current_location_index" INTEGER NOT NULL DEFAULT 0,
    "current_location" INTEGER,
    "current_page" INTEGER NOT NULL DEFAULT 1,
    "start_date" TEXT,
    "end_date" TEXT,
    "filters" JSONB,
    "pages_processed" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "synced" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),

    CONSTRAINT "SalesTransactionSyncJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SalesTransactionSyncJob_status_idx" ON "SalesTransactionSyncJob"("status");
CREATE INDEX "SalesTransactionSyncJob_started_at_idx" ON "SalesTransactionSyncJob"("started_at");

ALTER TABLE "SalesTransactionSyncJob" ENABLE ROW LEVEL SECURITY;
