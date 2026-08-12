-- AlterTable
ALTER TABLE "MemoryIndex" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "lastSeenCommit" TEXT,
ADD COLUMN     "stale" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "MemoryIndex_stale_idx" ON "MemoryIndex"("stale");
