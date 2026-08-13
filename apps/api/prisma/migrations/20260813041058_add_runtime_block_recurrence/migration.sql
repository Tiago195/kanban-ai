-- AlterTable
ALTER TABLE "AgentRuntimeState" ADD COLUMN     "consecutiveBlockCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastBlockReason" TEXT;

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "blockedDescriptor" JSONB,
ADD COLUMN     "blockedOwnerNotifiedAt" TIMESTAMP(3);
