-- CreateTable
CREATE TABLE "CustomerImportSyncJob" (
    "id" SERIAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "source" TEXT NOT NULL DEFAULT 'dashboard',
    "phase" TEXT NOT NULL DEFAULT 'recent',
    "location_ids" JSONB NOT NULL,
    "current_location_index" INTEGER NOT NULL DEFAULT 0,
    "current_location" INTEGER,
    "current_page" INTEGER NOT NULL DEFAULT 1,
    "total_api" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "skipped_conflicts" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "latest_runchise_created_at" TIMESTAMP(3),
    "latest_local_created_at" TIMESTAMP(3),
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "CustomerImportSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerImportSyncJob_status_idx" ON "CustomerImportSyncJob"("status");

-- CreateIndex
CREATE INDEX "CustomerImportSyncJob_started_at_idx" ON "CustomerImportSyncJob"("started_at");
