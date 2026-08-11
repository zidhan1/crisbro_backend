CREATE TABLE "SyncJobTelemetry" (
    "id" BIGSERIAL NOT NULL,
    "job_name" TEXT NOT NULL,
    "source_job_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "current_location" INTEGER,
    "cursor" JSONB,
    "duration_ms" INTEGER,
    "memory_rss_bytes" BIGINT,
    "memory_heap_used_bytes" BIGINT,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "synced" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "last_error_at" TIMESTAMP(3),
    "last_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncJobTelemetry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncJobTelemetry_job_name_last_started_at_idx"
ON "SyncJobTelemetry"("job_name", "last_started_at");
CREATE INDEX "SyncJobTelemetry_status_idx" ON "SyncJobTelemetry"("status");
CREATE INDEX "SyncJobTelemetry_last_success_at_idx"
ON "SyncJobTelemetry"("last_success_at");

ALTER TABLE "SyncJobTelemetry" ENABLE ROW LEVEL SECURITY;
