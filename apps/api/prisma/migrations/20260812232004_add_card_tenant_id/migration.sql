-- US-COLAB1: isolamento multi-tenant por coluna nullable (ADR-0030).
-- Coluna nullable sem default → não reescreve linhas existentes (retrocompat).

-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "tenantId" TEXT;

-- CreateIndex
CREATE INDEX "Card_boardId_tenantId_idx" ON "Card"("boardId", "tenantId");
