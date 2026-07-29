# AGENTS.md — módulo `ai-engine` (NÚCLEO)

> Este é o **coração** do produto. Leia
> [docs/loop-engine.md](../../../../../docs/loop-engine.md) antes de mexer aqui.

## Propósito

Orquestrar o ciclo de vida das sessões de agent: acordar um agent quando uma story
entra em **In Progress**, encadear **iterações**, marcar o **DOD**, rodar a
**validação final** e criar **tasks derivadas** em caso de falha.

## Estrutura

```
ai-engine/
├── orchestrator.ts            # Orchestrator: onStoryEnterInProgress, watchdog, stop
├── session-manager/           # AgentSessionManager (in-process: running|idle|dead)
├── runners/                   # AgentRunner (interface, token AGENT_RUNNER) + CopilotCliRunner
├── loop-profiles/             # feature | bug | refactor | __default (+ resolveLoopProfile)
├── iterations/                # diário de iterações
├── validators/                # ValidationRunner (validação final dos affectedFlows)
└── ai-engine.module.ts        # DI: AGENT_RUNNER → CopilotCliRunner (useExisting)
```

## Contratos / interfaces (não quebrar assinaturas sem atualizar consumidores)

- **`AgentRunner`** (`runners/agent-runner.interface.ts`): `run(input) => AgentRunResult`.
  Token de DI: `AGENT_RUNNER`. v1: `CopilotCliRunner` (subprocess da Copilot CLI).
- **`AgentSessionManager`**: `start`, `get`, `abort`, `canStart` — estados
  `running|idle|dead`. **Interface plugável** (ponto de extensão para BullMQ+Redis).
- **`Orchestrator`**: `onStoryEnterInProgress(storyId)`, `stop(storyId, mode)`,
  `reconcileOnBoot()`.
- **`ValidationRunner`**: valida os `affectedFlows` quando o DOD fecha.
- **Loop profiles**: `resolveLoopProfile(labelProfileId)` com fallback `__default`.

## Invariantes (NUNCA violar)

1. O loop **só** dispara em **story → In Progress**.
2. **DOD é o único gate** para a validação final (sem DOR/`acceptance` — [ADR-0007](../../../../../docs/adr/0007-remove-dor-and-acceptance.md)).
3. As **4 salvaguardas** são obrigatórias: reconciliação no boot; limite de
   concorrência; idempotência do watchdog; encerramento limpo via AbortSignal.
4. **Estado de verdade é o Postgres**, não a memória — sempre reconcilie no boot.
5. Falha na validação **cria task derivada** com `derivedFrom`/`dependsOn`.

## O que NÃO mexer

- Não remova as salvaguardas nem torne o watchdog não-idempotente.
- Não acople o `Orchestrator` a uma implementação concreta de session manager ou
  runner — use os tokens/interfaces.
- Não introduza Redis/BullMQ no v1 (é ponto de extensão futuro).

## Estado atual

**Stub com contratos definidos.** `orchestrator.ts` tem TODOs para: `runIteration`,
retomada pelo watchdog, gate de DOD → validação, e criação de task derivada. Ao
implementar, remova os TODOs e mantenha este arquivo em dia.

## Como testar

- `npx nest build` (a partir de `apps/api`) deve passar.
- Ao implementar `runIteration`, adicione testes cobrindo: encadeamento de
  iterações, idempotência do watchdog, stop graceful vs hard, e reconciliação no
  boot.
