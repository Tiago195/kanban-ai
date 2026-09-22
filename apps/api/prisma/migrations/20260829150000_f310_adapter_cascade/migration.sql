-- US-F3.10 — Cascata de adapter (board→epic→story→task).
-- Aditiva/retrocompatível: colunas nullable espelhando o par model/defaultModel.
ALTER TABLE "Card" ADD COLUMN "adapter" TEXT;
ALTER TABLE "Board" ADD COLUMN "defaultAdapter" TEXT;
