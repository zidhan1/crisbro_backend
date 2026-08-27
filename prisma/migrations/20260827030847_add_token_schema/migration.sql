/*
  Warnings:

  - Added the required column `location_id` to the `SaleTransaction` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SaleTransaction" ADD COLUMN     "location_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Token" (
    "token_id" TEXT NOT NULL,
    "token_code" TEXT NOT NULL,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("token_id")
);
