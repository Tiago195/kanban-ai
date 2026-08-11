-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "backlogChatSessionId" TEXT;

-- CreateIndex
CREATE INDEX "Card_backlogChatSessionId_idx" ON "Card"("backlogChatSessionId");

-- AddForeignKey
ALTER TABLE "Card" ADD CONSTRAINT "Card_backlogChatSessionId_fkey" FOREIGN KEY ("backlogChatSessionId") REFERENCES "BacklogChatSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
