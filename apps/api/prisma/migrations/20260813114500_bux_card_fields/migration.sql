-- bux_card_fields: US-BUX1 + US-BUX2 + US-BUX3 (aditiva)
ALTER TABLE "Card"
  ADD COLUMN "priority" INTEGER,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "startInPlanMode" BOOLEAN NOT NULL DEFAULT false;

-- Prisma schema contém @@unique([boardId, idempotencyKey]) para client typing,
-- mas o índice efetivo precisa ser PARCIAL (apenas quando not null).
CREATE UNIQUE INDEX "Card_boardId_idempotencyKey_unique_not_null"
  ON "Card"("boardId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
