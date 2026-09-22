# ADR-0042 — HITL do TanStack runner fica na variante `question`; interrupt nativo descartado (US-F3.6)

**Status:** Aceito

**Relaciona-se com:** [ADR-0018](0018-awaiting-input-in-process.md) (espera
in-process), [ADR-0022](0022-hitl-survives-restart-via-cli-session-id.md)
(HITL sobrevive a restart), [ADR-0036](0036-multi-agent-adapters.md) (EP-F3).

## Contexto

A US-F3.6 mandava avaliar trocar o HITL do `TanStackRunner` — hoje a variante
`question` do `outputSchema` (US-F3.5), que devolve a pergunta e **encerra o
turno**, imitando o one-shot do Copilot — pelo **interrupt nativo** do TanStack
AI. A restrição inegociável: a retomada pós-restart do ADR-0022 não pode ser
perdida. Se o interrupt nativo não atravessa um restart do processo, ele é um
downgrade e a resposta certa é não trocar.

A investigação foi feita contra o pacote instalado (`@tanstack/ai@0.52.0`,
`dist/esm/*.d.ts` e `*.js`) — a skill embarcada
(`node_modules/@tanstack/ai/skills/ai-core/tool-calling/SKILL.md`) mira v0.42 e
foi conferida contra os types reais.

## O que o interrupt nativo do TanStack é (evidência, 0.52)

1. **Quem levanta o interrupt é middleware/tool — nunca o modelo.** Generic
   interrupts nascem SOMENTE de `ChatMiddleware.onInterruptBoundary`, que
   dispara nas fases `INTERRUPT_BOUNDARY_PHASES = ['beforeModel', 'afterModel',
   'beforeTools', 'afterTools']` (`activities/chat/middleware/types.d.ts`); tool
   approvals nascem de `needsApproval: true` numa tool. A fase
   `'structuredOutput'` — onde a nossa resposta estruturada materializa — **não
   é** um interrupt boundary. A pergunta HITL do kanban-ai é uma **decisão do
   modelo**, entregue como a variante `question` da união discriminada
   `result | question` (R12/R13/R14). Para virar interrupt nativo, a pergunta
   teria de ser reprojetada como tool call (`ask_user` com `needsApproval`) —
   uma reescrita do protocolo do prompt, não uma troca de mecanismo.

2. **Interrupt encerra o run; a retomada é um NOVO `chat()`.** O run termina
   com `RUN_FINISHED.outcome.type === 'interrupt'`; a continuação exige nova
   chamada `chat({ resume, messages, ... })`. A validação da retomada
   (`validateInterruptResumeBatch`, `interrupt-resume.d.ts`) é "persistence-
   neutral": o resume "ephemeral" reconstrói o estado pendente **a partir das
   `messages` reenviadas** (`getToolCallsForEphemeralResume`, chat `index.js`)
   mais o binding que viaja em `Interrupt.metadata`
   (`tanstack:interruptBinding`) e a continuação em `ResumeEntry.metadata`
   (`tanstack:interruptContinuation` — "The original request rides here so an
   ephemeral server can rebuild it", `generic-interrupt-continuation.d.ts`).

3. **Logo: o interrupt nativo SÓ atravessa restart se persistirmos o histórico
   AG-UI completo** (mensagens do run interrompido + descritores de interrupt
   com metadata) para reenviá-lo no `chat()` de retomada. O run em si vive na
   memória do `chat()`; nada disso é persistido pelo pacote sem uma camada
   durável (`@tanstack/ai-persistence`/`InterruptStore` ou equivalente).

## Por que NÃO trocar

- **O runner não tem tools.** O `TanStackRunner` faz UMA chamada de texto com
  `outputSchema` por iteração. O valor do interrupt nativo é pausar um run
  preservando estado de tools no meio dele — estado que aqui **não existe**.
  Pausar após a resposta final do modelo ≡ encerrar o turno, que é exatamente o
  que a variante `question` já faz.
- **Restart: o desenho atual persiste NADA a mais e sobrevive.** A pergunta
  (com opções) e a resposta vivem em `AgentMessage` (par por `questionId`); o
  prompt de cada iteração é auto-suficiente (reconstruído do banco). O caminho
  de resiliência do `answerQuestion` (ADR-0022) é runner-agnóstico. Adotar o
  interrupt nativo exigiria uma NOVA persistência (histórico AG-UI +
  descritores) que duplica isso — e o `InterruptStore` genérico não tem o
  CAS/lease/coalescing que `AgentRuntimeState` (US-ROB4) e `enqueueWakeup`
  (US-COLAB3) já fazem. Por isso `@tanstack/ai-persistence` **não** entra.
- **O contrato `onQuestion` não muda.** O orquestrador segue sem saber qual
  runner está ativo; `hitlTimeoutMs` governa a espera via `waitForAnswer`
  (ADR-0018) e o idle timeout do stream morre com o stream — a espera humana
  nunca é morta por idle (paridade com o Copilot one-shot).

## O que a US-F3.6 corrigiu de verdade (a lacuna encontrada)

Auditando o cenário de restart, a retomada do TanStack tinha um furo real: no
caminho de resiliência do ADR-0022 a **resposta humana** é persistida e a
iteração é re-disparada, mas o texto da resposta **não chegava ao prompt
reconstruído** — no fluxo sem restart ele viaja pelo `hitlExchange` in-process
(vira `handoffNextStep` da iteração), e no restart o Copilot recupera ao menos
a pergunta pela sessão em disco (`--session-id`), coisa que o TanStack não tem
(o `threadId` não dá memória).

Correção (runner-agnóstica, no orquestrador):

- `buildContext` ganhou `hitlResume` (`loadHitlResume`): o par
  pergunta+resposta cuja resposta é **posterior à última `Iteration`** da task
  (i.e. respondida via caminho de resiliência e ainda não consumida). No fluxo
  normal a resposta é anterior à iteração que a consumiu ⇒ `null` (sem dupla
  injeção). Defensivo: falha de leitura ⇒ `null`.
- `buildPrompt` injeta a seção "Decisão humana recebida (HITL) — retome a
  partir dela" com o par, depois do histórico (é a palavra mais recente).

Para o Copilot isso é redundância inofensiva — o mesmo espírito do "prompt
auto-suficiente como fallback" registrado no ADR-0022. Beneficia também as
perguntas sintéticas de escalação (`needsHuman`), cuja resposta tampouco
chegava ao prompt.

## O que sobrevive a um restart (TanStack runner)

| Estado | Antes | Depois |
| --- | --- | --- |
| Pergunta + opções (chips na UI) | ✅ `AgentMessage` | ✅ idem |
| Aceitar a resposta (sem 404) | ✅ `answerQuestion` resiliente | ✅ idem |
| Intenção de acordar a story | ✅ `enqueueWakeup` | ✅ idem |
| **Resposta humana no prompt da retomada** | ❌ (só in-process/Copilot) | ✅ `hitlResume` |
| Promise de `waitForAnswer` / sessão in-process | ❌ (por desenho, ADR-0018) | ❌ (dispensável: turno one-shot) |

## O que seria preciso para o interrupt nativo (se um dia fizer sentido)

Só reavaliar se o `TanStackRunner` ganhar **tools de servidor** com estado
no meio do run (aí um pause/resume nativo passa a preservar algo real). O
custo: reprojetar a pergunta como tool `needsApproval`, persistir o histórico
AG-UI do run interrompido + descritores (via `InterruptStore` ou tabela
própria), e reconciliar essa persistência com `AgentRuntimeState` (CAS/lease) e
com a idempotência do `answerQuestion` — nada disso paga o custo hoje.

## Specs

`apps/api/src/modules/ai-engine/runners/tanstack.runner.hitl.spec.ts` fixa:
HITL e2e contra o fake (pergunta → `onQuestion` → resposta → turno encerra,
UMA chamada ao provider), propagação do `hitlTimeoutMs`, idle timeout suspenso
na espera humana, abort na espera, e o cenário de restart simulado pelo estado
persistido (`loadHitlResume` + injeção no `buildPrompt`, incluindo o guard
anti-dupla-injeção).
