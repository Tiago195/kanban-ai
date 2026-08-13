-- AlterTable
ALTER TABLE "AgentRuntimeState" ADD COLUMN     "continuationAttempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "livenessReason" TEXT;

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "completionMetadata" JSONB;
