CREATE TABLE "CatalogSyncJob" (
  "id" SERIAL NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "source" TEXT NOT NULL DEFAULT 'cron',
  "current_page" INTEGER NOT NULL DEFAULT 1,
  "reported_total" INTEGER,
  "pages_processed" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "synced" INTEGER NOT NULL DEFAULT 0,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "seen_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "metrics" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error" TEXT,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeat_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "CatalogSyncJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CatalogSyncJob_kind_check" CHECK ("kind" IN ('products','promos','brands','locations')),
  CONSTRAINT "CatalogSyncJob_status_check" CHECK ("status" IN ('queued','running','completed','failed')),
  CONSTRAINT "CatalogSyncJob_cursor_check" CHECK ("current_page" > 0 AND "pages_processed" >= 0 AND "processed" >= 0 AND "synced" >= 0 AND "consecutive_failures" >= 0)
);

CREATE INDEX "CatalogSyncJob_kind_status_idx" ON "CatalogSyncJob"("kind", "status");
CREATE INDEX "CatalogSyncJob_started_at_idx" ON "CatalogSyncJob"("started_at");
CREATE UNIQUE INDEX "CatalogSyncJob_one_active_per_kind_idx"
  ON "CatalogSyncJob"("kind") WHERE "status" IN ('queued', 'running');
ALTER TABLE "CatalogSyncJob" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "CatalogSyncJob" FROM anon, authenticated;
REVOKE ALL ON SEQUENCE "CatalogSyncJob_id_seq" FROM anon, authenticated;
