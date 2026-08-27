/*
  Warnings:

  - Added the required column `token_type` to the `Token` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Token" ADD COLUMN     "token_type" TEXT NOT NULL;
