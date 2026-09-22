-- US-F1.3: estado do build do grafo de conhecimento (graphify) por Project
-- Aditiva e retrocompatível: enum novo + colunas com default/nullable.
-- Linhas existentes nascem com graphState='pending' (grafo ainda não construído).

CREATE TYPE "ProjectGraphState" AS ENUM ('pending', 'building', 'ready', 'failed');

ALTER TABLE "Project" ADD COLUMN "graphState" "ProjectGraphState" NOT NULL DEFAULT 'pending';
ALTER TABLE "Project" ADD COLUMN "graphBuiltAt" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN "graphLastError" TEXT;
