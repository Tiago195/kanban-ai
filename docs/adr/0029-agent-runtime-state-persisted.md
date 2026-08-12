# ADR-0029 — Estado de runtime do agent persistido (sobrevive a restart)

**Status:** Aceito (implementado — US-ROB2)

**Data:** 2026-08-12

## Contexto

A orquestração do loop é **in-process** ([ADR-0005](0005-in-process-orchestration.md))
e o estado de cada sessão de agent vive hoje num `Map` em memória dentro do
`AgentSessionManager` (`apps/api/src/modules/ai-engine/session-manager/`). Esse
estado é **efêmero**: um restart do processo da API o perde, e a única
reconciliação existente é no boot.

Isso já foi parcialmente mitigado para o HITL: o estado `awaiting-input` é mantido
in-process ([ADR-0018](0018-awaiting-input-in-process.md)) e a sessão HITL
sobrevive a restart reusando o `--session-id` da Copilot CLI
([ADR-0022](0022-hitl-survives-restart-via-cli-session-id.md)). Mas o **estado de
runtime mais amplo** — totais de token acumulados, último erro, sinal de liveness,
blob de estado da sessão — não é persistido.

A análise das ferramentas de referência (**Paperclip** — persistir runtime state;
liveness/recovery) mostra que sem esse substrato durável as salvaguardas do loop
ficam frágeis a crashes de host, e não há como um watchdog decidir que uma sessão
está morta com base em dados persistidos. Este é um pré-requisito natural do
stale-claim recovery por TTL (US-ROB4).

## Decisão

Adicionar um modelo Prisma **`AgentRuntimeState`** persistido, atualizado pelo
`AgentSessionManager`, que hoje é um `Map` puro.

- **Chave:** `sessionId` alinhado a `storyId` (coerente com o ADR-0022, onde a
  sessão HITL já se identifica pela story). O formato antigo `sess-…-Date.now()`
  ganha tratamento de retrocompatibilidade (ver spec).
- **Campos:** `stateJson` (blob do estado da sessão), `tokenTotals`
  (input/output acumulados), `lastError`, `livenessState` (enum `LivenessState`),
  e **colunas de lease** (`claimLock`/`claimExpires`) já embutidas para servir ao
  US-ROB4 e **evitar uma segunda migration na mesma tabela**.
- **Reidratação:** no boot e ao longo do loop, o manager lê/escreve o
  `AgentRuntimeState` em vez de depender só da memória.

O schema Prisma exato, o enum `LivenessState`, o plano de migration e os pontos de
integração no manager estão em
[`docs/specs/ep-rob-robustez.md`](../specs/ep-rob-robustez.md) (US-ROB2).

## Consequências

- **Positivas:** estado de sessão sobrevive a restart; `lastError`/liveness ficam
  consultáveis (habilita dashboard de frota, US-OBS1); as colunas de lease
  destravam o stale-claim recovery (US-ROB4) sem nova migration; casa com o
  modelo de identidade estável (`AgentId`) e com o ADR-0022.
- **Negativas / riscos:** custo de I/O por atualização de estado (mitigável com
  escrita coalescida/throttle); migration + seed obrigatórios ao tocar o banco;
  necessidade de tratar o formato de `sessionId` legado sem quebrar sessões em
  andamento no momento do deploy.
- **Invariantes preservados:** orquestração segue in-process (ADR-0005) — a
  persistência é um **espelho durável**, não um broker externo; sem Redis.
