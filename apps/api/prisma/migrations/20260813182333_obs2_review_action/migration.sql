-- CreateTable
CREATE TABLE "ReviewAction" (
    "id" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snoozedUntil" TIMESTAMP(3),

    CONSTRAINT "ReviewAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewAction_cardId_kind_ts_idx" ON "ReviewAction"("cardId", "kind", "ts");

-- AddForeignKey
ALTER TABLE "ReviewAction" ADD CONSTRAINT "ReviewAction_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "Card"("id") ON DELETE CASCADE ON UPDATE CASCADE;
