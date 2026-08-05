-- CreateTable
CREATE TABLE "BacklogChatSession" (
    "id" TEXT NOT NULL,
    "boardId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Novo backlog',
    "status" TEXT NOT NULL DEFAULT 'open',
    "currentProposalVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BacklogChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacklogChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT,
    "text" TEXT NOT NULL,
    "questionId" TEXT,
    "options" JSONB,
    "proposal" JSONB,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacklogChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacklogProposalRevision" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "proposal" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacklogProposalRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BacklogChatSession_boardId_idx" ON "BacklogChatSession"("boardId");

-- CreateIndex
CREATE INDEX "BacklogChatMessage_sessionId_idx" ON "BacklogChatMessage"("sessionId");

-- CreateIndex
CREATE INDEX "BacklogProposalRevision_sessionId_idx" ON "BacklogProposalRevision"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "BacklogProposalRevision_sessionId_version_key" ON "BacklogProposalRevision"("sessionId", "version");

-- AddForeignKey
ALTER TABLE "BacklogChatSession" ADD CONSTRAINT "BacklogChatSession_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacklogChatMessage" ADD CONSTRAINT "BacklogChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "BacklogChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BacklogProposalRevision" ADD CONSTRAINT "BacklogProposalRevision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "BacklogChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
