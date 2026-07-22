CREATE TABLE "CustomerTimestampSyncJob" (
  "id" SERIAL NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "location_ids" JSONB NOT NULL,
  "current_location_index" INTEGER NOT NULL DEFAULT 0,
  "current_location" INTEGER,
  "current_page" INTEGER NOT NULL DEFAULT 1,
  "target_total" INTEGER NOT NULL DEFAULT 0,
  "total_api" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "updated" INTEGER NOT NULL DEFAULT 0,
  "unchanged" INTEGER NOT NULL DEFAULT 0,
  "unmatched" INTEGER NOT NULL DEFAULT 0,
  "invalid" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "CustomerTimestampSyncJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerTimestampSyncJob_status_idx"
ON "CustomerTimestampSyncJob"("status");

CREATE INDEX "CustomerTimestampSyncJob_started_at_idx"
ON "CustomerTimestampSyncJob"("started_at");

-- Menjamin hanya ada satu job aktif, termasuk pada deployment multi-instance.
CREATE UNIQUE INDEX "CustomerTimestampSyncJob_one_active_idx"
ON "CustomerTimestampSyncJob" ((1))
WHERE "status" IN ('queued', 'running');
