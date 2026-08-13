-- CreateEnum
CREATE TYPE "BlockKind" AS ENUM ('dependency', 'needs_input', 'capability', 'transient');

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "blockKind" "BlockKind";
