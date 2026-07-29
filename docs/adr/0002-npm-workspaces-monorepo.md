# ADR-0002 — Monorepo com npm workspaces

**Status:** Aceito

## Contexto

Web, api e contratos compartilhados evoluem juntos. Precisamos compartilhar tipos
(enums de status, DTOs, eventos WS) entre frontend e backend sem publicar pacotes.

## Decisão

Usar um **monorepo com npm workspaces** (`apps/web`, `apps/api`, `packages/shared`).
Usar **npm** — não pnpm nem yarn.

`packages/shared` é emitido como **CommonJS** (imports internos sem extensão, sem
`type: module`), porque o NestJS usa CJS + decorators e consome o pacote
diretamente; o web (Vite, `moduleResolution: Bundler`) consome via imports
type-only sem problema.

## Consequências

- Uma única `node_modules` na raiz; `npm install` resolve os 3 workspaces.
- Mudanças de contrato em `packages/shared` refletem imediatamente nos dois apps.
- Escolha de **npm** mantém o setup simples e sem dependências externas de gerenciador.
- Restrição: o shared não pode usar recursos que exijam ESM puro.
