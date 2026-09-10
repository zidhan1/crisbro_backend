/*
  Warnings:

  - Existing checkpoint rows were created before checkpoints were scoped per
    runchise location, so they cannot be mapped to the new schema. They are
    deleted here; the next sync run will simply start from scratch.

*/
-- AlterTable
ALTER TABLE "SyncCheckpoints" ADD COLUMN     "runchise_location_id" INTEGER NOT NULL DEFAULT 0;

-- Delete stale global checkpoints that predate per-location scoping
DELETE FROM "SyncCheckpoints" WHERE "runchise_location_id" = 0;

-- AlterTable
ALTER TABLE "SyncCheckpoints" ALTER COLUMN "runchise_location_id" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "SyncCheckpoints_job_category_runchise_location_id_key" ON "SyncCheckpoints"("job_category", "runchise_location_id");
