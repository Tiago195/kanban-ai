-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT,
    "phase" "IterationPhase",
    "text" TEXT NOT NULL,
    "questionId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMessage_cardId_idx" ON "AgentMessage"("cardId");

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;
