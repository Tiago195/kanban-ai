#!/bin/sh
# Entrypoint de desenvolvimento do web (dentro do container).
# Rebuilda o shared (bind mount) e sobe o Vite dev server com hot-reload.
set -e

echo "[web-entrypoint] build shared..."
npm run build -w @kanban-ai/shared

echo "[web-entrypoint] vite dev"
exec npm run dev -w @kanban-ai/web
