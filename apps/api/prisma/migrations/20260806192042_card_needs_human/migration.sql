-- AlterTable
ALTER TABLE "Card" ADD COLUMN     "needsHuman" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "needsHumanReason" TEXT;
