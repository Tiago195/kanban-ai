-- CreateEnum
CREATE TYPE "WakeupStatus" AS ENUM ('pending', 'claimed', 'done', 'failed');

-- CreateEnum
CREATE TYPE "WakeupReason" AS ENUM ('story_in_progress', 'task_added', 'hitl_answered', 'manual_step', 'reconcile');

-- CreateTable
CREATE TABLE "WakeupQueue" (
    "id" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "status" "WakeupStatus" NOT NULL DEFAULT 'pending',
    "reason" "WakeupReason" NOT NULL DEFAULT 'story_in_progress',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "epicId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WakeupQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WakeupQueue_status_idx" ON "WakeupQueue"("status");

-- CreateIndex
CREATE INDEX "WakeupQueue_epicId_idx" ON "WakeupQueue"("epicId");

-- CreateIndex
CREATE INDEX "WakeupQueue_storyId_idx" ON "WakeupQueue"("storyId");

-- AddForeignKey
ALTER TABLE "WakeupQueue" ADD CONSTRAINT "WakeupQueue_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- US-COLAB3: índice único PARCIAL — garante coalescing (no máx. 1 wakeup ativo por story).
-- Prisma v6 não expressa índices parciais no schema, então este statement é adicionado à mão.
-- ATENÇÃO: `prisma migrate reset` regenera esta migration e PERDE esta edição (ver ADR-0032).
CREATE UNIQUE INDEX "WakeupQueue_storyId_active_key" ON "WakeupQueue"("storyId") WHERE "status" IN ('pending', 'claimed');
