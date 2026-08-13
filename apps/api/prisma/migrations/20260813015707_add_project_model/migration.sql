-- CreateEnum
CREATE TYPE "ProjectAuthKind" AS ENUM ('none', 'https', 'ssh');

-- CreateEnum
CREATE TYPE "ProjectCloneState" AS ENUM ('pending', 'cloning', 'ready', 'failed');

-- AlterTable
ALTER TABLE "Board" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "authKind" "ProjectAuthKind" NOT NULL DEFAULT 'none',
    "credentialRef" TEXT,
    "localPath" TEXT,
    "cloneState" "ProjectCloneState" NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Board" ADD CONSTRAINT "Board_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
