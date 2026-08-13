-- US-SCHED1: Deferred wakeup monitors (time-gated)
-- Additive: adds nullable scheduledFor + monitor metadata to WakeupQueue
-- Items with scheduledFor = null are immediate (existing behavior preserved)
-- Items with future scheduledFor are "monitors" that fire only when now >= scheduledFor

ALTER TABLE "WakeupQueue" ADD COLUMN "scheduledFor" TIMESTAMP(3);
ALTER TABLE "WakeupQueue" ADD COLUMN "notes" TEXT;
ALTER TABLE "WakeupQueue" ADD COLUMN "timeoutAt" TIMESTAMP(3);
ALTER TABLE "WakeupQueue" ADD COLUMN "maxAttempts" INTEGER;

-- Index for efficient due monitor queries (scheduledFor <= now)
CREATE INDEX "WakeupQueue_scheduledFor_idx" ON "WakeupQueue"("scheduledFor");
