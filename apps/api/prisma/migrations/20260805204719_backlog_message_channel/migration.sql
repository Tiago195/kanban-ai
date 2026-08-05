-- AlterTable
ALTER TABLE "BacklogChatMessage" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'main';

-- CreateIndex
CREATE INDEX "BacklogChatMessage_sessionId_channel_idx" ON "BacklogChatMessage"("sessionId", "channel");
