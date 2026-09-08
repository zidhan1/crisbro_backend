-- CreateEnum
CREATE TYPE "JobCategory" AS ENUM ('sale_transactions');

-- CreateTable
CREATE TABLE "SyncCheckpoints" (
    "sync_id" TEXT NOT NULL,
    "job_category" "JobCategory" NOT NULL,
    "last_sync_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncCheckpoints_pkey" PRIMARY KEY ("sync_id")
);
