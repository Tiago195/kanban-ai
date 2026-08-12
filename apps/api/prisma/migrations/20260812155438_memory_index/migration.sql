-- CreateTable
CREATE TABLE "MemoryIndex" (
    "path" TEXT NOT NULL,
    "headCommit" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT NOT NULL DEFAULT '',
    "searchText" TEXT NOT NULL DEFAULT '',
    "lockState" TEXT NOT NULL DEFAULT 'FREE',
    "holder" TEXT,
    "baseCommit" TEXT,
    "activeBranch" TEXT,
    "reviewQueued" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryIndex_pkey" PRIMARY KEY ("path")
);

-- CreateIndex
CREATE INDEX "MemoryIndex_lockState_idx" ON "MemoryIndex"("lockState");

-- CreateIndex
CREATE INDEX "MemoryIndex_holder_idx" ON "MemoryIndex"("holder");
