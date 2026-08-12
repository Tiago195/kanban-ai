-- AlterTable
ALTER TABLE "MemoryIndex" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "leaseId" TEXT;
