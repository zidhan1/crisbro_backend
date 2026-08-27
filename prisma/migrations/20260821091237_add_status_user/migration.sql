-- CreateEnum
CREATE TYPE "StatusUser" AS ENUM ('active', 'inactive');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "status" "StatusUser" NOT NULL DEFAULT 'inactive';
