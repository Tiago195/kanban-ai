# ADR-0031 — Loop profile "orquestrador" (board-manager) com toolset restrito

**Status:** Aceito

**Data:** 2026-08-12

## Contexto

Todos os loop profiles embutidos (`feature`, `bug`, `refactor`, `__default`) em
`apps/api/src/modules/ai-engine/loop-profiles/loop-profiles.ts` assumem que o
agent **coda no working tree** do repo-alvo: a fase de `implementation` e o
`buildPrompt` (`orchestrator.ts`) instruem a AI a **editar os arquivos reais** e
o gate anti-progresso-fantasma exige `git diff` **não-vazio** para aceitar a
reivindicação de mudança em fluxos.

O EP-COLAB (colaboração multi-agent — ver
[`docs/specs/ep-colab.md`](../specs/ep-colab.md)) precisa de um perfil cujo
mandato seja **gerenciar o board** — quebrar escopo em stories/tasks, atribuir
aos agents certos e linkar dependências — e que **nunca edite arquivos** do
repo-alvo. É o "gerente de board" agent, alvo natural de `@mention`
([ADR-0033](0033-mention-delegation-backlog-chat.md)) e acordado pela wakeup
queue ([ADR-0032](0032-wakeup-queue-persistent-idempotent.md)).

O toolset do agent é **100% dirigido por PROMPT**: o runner
(`CopilotCliRunner`) apenas dá `spawn` no CLI, sem flags de allow/deny de
ferramentas. Portanto a restrição precisa ser expressa no **texto do prompt**.

## Decisão

Adicionar um loop profile embutido **`orchestrator`** (board-manager) e um campo
opcional **`toolset`** ao `LoopProfileDef` para tornar a restrição explícita e
verificável.

- **Contrato compartilhado** (`packages/shared/src/enums.ts`): estender o union
  `LoopProfileId` com `'orchestrator'` (aditivo — não remove nem renomeia os
  existentes; consumido por web **e** api).
- **`LoopToolset`** (`loop-profiles.ts`): `'full' | 'board-only'`. Campo
  `toolset?` opcional em `LoopProfileDef` — **ausente = `full` = comportamento
  atual** (retrocompat total).
- **`BUILTIN_LOOP_PROFILES.orchestrator`**: `phases: ['analysis', 'validation']`
  (sem `implementation` de código; última fase = `validation`, satisfazendo o
  normalizador de perfis), `validation: 'regression-only'` (a estratégia mais
  leve — o board-manager não produz "fluxos novos"), `toolset: 'board-only'`.
- **`Orchestrator.buildPrompt`**: quando `profile.toolset === 'board-only'`, a
  seção "## Escopo e diretório de trabalho" (que manda **editar arquivos**) e a
  seção "## ❌ PROIBIDO — operações de git" (que assume "edite os arquivos") são
  **substituídas** por um mandato de board manager: o agent ORGANIZA o board via
  ferramentas MCP (criar/atribuir/linkar cards, mover entre colunas), **NÃO PODE
  editar/criar/apagar nenhum arquivo** e, se algo precisa de código, **cria uma
  task** e delega a um agent codador (feature/bug/refactor).
- **Gate de `git diff` vazio**: neutralizado para `board-only`
  (`claimsNewCodeWithoutDiff` recebe `profile.toolset !== 'board-only'`), senão o
  board-manager — que nunca produz diff — falharia sempre. Como salvaguarda de
  auditoria, um `git diff` **não-vazio** de um perfil `board-only` é **logado
  como warning** (ele desobedeceu à restrição).

O board-manager continua sujeito às invariantes do domínio: **cria tasks apenas
em Backlog/To Do** (`TASK_CREATION_COLUMNS`, garantido em `CardsService.create`),
é acordado por **story → In Progress** e é **serializado por epic** — sem exceção.

## Consequências

- **Positivas:** destrava um agent "gerente de board" no fluxo multi-agent sem
  novo schema (o perfil embutido não precisa de coluna); mudança mínima e
  aditiva; `feature`/`bug`/`refactor`/`__default` permanecem **inalterados**
  (toolset ausente = full); o campo `toolset` deixa a intenção explícita e é
  futura-prova para runners que suportem allow/deny real de ferramentas.
- **Negativas / riscos:** a restrição é **cooperativa** — imposta por **prompt**,
  não por sandbox. O agent *poderia* desobedecer e editar arquivos; mitigação v1:
  o gate de `git diff` vazio deixa de ser falha (o board-manager não coda) e um
  diff não-vazio vira **warning** de auditoria. **Enforcement real** (allow/deny
  de tools) fica para runners futuros (`AgentRunner` é plugável via o token
  `AGENT_RUNNER`).
- **Invariantes preservados:** hierarquia Epic→Story→Task, criação de task só em
  Backlog/To Do, gatilho por story→In Progress e serialização por epic seguem
  valendo; nenhum Redis/BullMQ é introduzido; DOR/`acceptance` não retornam.

Detalhes de implementação, plano PR-a-PR e DOD verificável em
[`docs/specs/ep-colab.md`](../specs/ep-colab.md) (US-COLAB2).
