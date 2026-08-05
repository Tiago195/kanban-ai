-- AlterTable
ALTER TABLE "Iteration" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "evidence" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "outcome" TEXT,
ADD COLUMN     "outputTokens" INTEGER;
