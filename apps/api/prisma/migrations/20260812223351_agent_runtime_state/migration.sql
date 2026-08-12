-- CreateTable
CREATE TABLE "AgentRuntimeState" (
    "sessionId" TEXT NOT NULL,
    "storyId" TEXT NOT NULL,
    "stateJson" TEXT NOT NULL DEFAULT '{}',
    "tokenTotals" TEXT NOT NULL DEFAULT '{"input":0,"output":0}',
    "lastError" TEXT,
    "livenessState" TEXT NOT NULL DEFAULT 'starting',
    "claimLock" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRuntimeState_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRuntimeState_storyId_key" ON "AgentRuntimeState"("storyId");

-- CreateIndex
CREATE INDEX "AgentRuntimeState_livenessState_idx" ON "AgentRuntimeState"("livenessState");

-- CreateIndex
CREATE INDEX "AgentRuntimeState_claimExpiresAt_idx" ON "AgentRuntimeState"("claimExpiresAt");
