#!/bin/sh
# Entrypoint de desenvolvimento da API (dentro do container).
# 1) Rebuilda o pacote shared (reflete o bind mount do host).
# 2) Gera o Prisma Client.
# 3) Aplica migrations (deploy = idempotente, seguro para reboot).
# 4) Roda o seed apenas se o board ainda não existir.
# 5) Sobe o Nest em watch (hot-reload).
set -e

echo "[api-entrypoint] build shared..."
npm run build -w @kanban-ai/shared

echo "[api-entrypoint] prisma generate..."
npm run db:generate -w @kanban-ai/api

echo "[api-entrypoint] prisma migrate deploy..."
npm run db:migrate:deploy -w @kanban-ai/api

# Seed apenas quando o banco está VAZIO. O seed.ts faz deleteMany no board
# (destrutivo), então NUNCA rodamos em banco já populado para não apagar dados.
BOARD_COUNT=$(cd apps/api && node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.board.count().then(n=>{console.log(n);return p.\$disconnect();}).catch(()=>{console.log(0);})" 2>/dev/null || echo 0)
if [ "$BOARD_COUNT" = "0" ]; then
  echo "[api-entrypoint] banco vazio → rodando seed..."
  npm run db:seed -w @kanban-ai/api
else
  echo "[api-entrypoint] banco já populado ($BOARD_COUNT board(s)) → seed pulado"
fi

echo "[api-entrypoint] nest start --watch"
exec npm run dev -w @kanban-ai/api
