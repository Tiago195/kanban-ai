# ADR-0040 — Enriquecimento de contexto no re-dispatch (handoff estruturado, tentativa anterior & continuação bounded)

**Status:** Aceito

## Contexto

O loop engine já injeta bastante contexto no prompt (`buildPrompt`): hierarquia
épico→story→task, DOD, fluxos afetados, memória em colmeia (ADR-0027), histórico
de iterações desta task, diff acumulado e lastro das tasks irmãs/stories. Mas há
três **buracos de contexto** que fazem o agent começar "amnésico" justamente nos
re-dispatches — os momentos mais frágeis do loop:

1. **Reclaim pós-crash (M4).** Quando o watchdog re-reivindica uma story cujo
   lease expirou (crash do processo, `AgentRuntimeState.lastError` gravado pelo
   session-manager), o novo run **não vê** o que a tentativa anterior tentou nem
   por que falhou — recomeça do zero e frequentemente repete o mesmo erro.

2. **Handoff entre tasks (M3).** Quando uma task dependente é auto-acordada
   (`onTaskDone`/`wakeBlockersResolvedDependents`, ADR-0039) ou é a próxima da
   story, ela herda apenas `summary`/`nextStep` textuais das irmãs. Não há um
   **retrato estruturado** do que a task-pai mudou (arquivos, verificação,
   dependências, risco residual). O agent redescobre tudo na unha.

3. **Runs improdutivos-mas-recuperáveis.** Um run que **só planejou**
   (`nextStep`/`summary` sem diff nem DOD) ou veio **vazio** não é uma falha nem
   um avanço — hoje ele apenas gasta uma iteração e o próximo tick recomeça sem
   nenhuma direção extra. Não há um mecanismo bounded que diga "você só planejou;
   **agora execute**".

Nenhum deles justifica infra nova (Redis, filas externas): tudo já existe
in-process (ADR-0019/0032). O que falta é **coletar e reinjetar** o contexto que
já temos.

## Decisão

Adicionar **enriquecimento de contexto no re-dispatch**, aditivo e
retrocompatível, em três frentes (EP-CTX, uma story cada):

### US-CTX1 — Tentativa anterior (reclaim/continuação)

`buildContext` passa a expor `priorAttempt: { lastError, lastOutcome } | null`,
lido de `AgentRuntimeState.lastError` (já gravado no crash) + `outcome` da última
`Iteration`. `null` na 1ª execução (nada a injetar). `buildPrompt` injeta um bloco
**"⚠️ Tentativa anterior (re-dispatch)"** antes do histórico, orientando o agent a
continuar de onde parou e a **não repetir o erro**.

### US-CTX2 — Handoff estruturado (`CompletionMetadata`)

Novo contrato compartilhado em `@kanban-ai/shared`:

```ts
export interface CompletionMetadata {
  changed_files?: string[];
  verification?: string;
  dependencies?: string[];
  retry_notes?: string;
  residual_risk?: string;
}
```

Ao fechar uma task (`done`), o orchestrator grava um snapshot em
`Card.completionMetadata` (Json, nullable) — derivado do que **já temos**
(`context.files` + `evidence.filesChanged` para `changed_files`; checks/summary
para `verification`; `nextStep` para `residual_risk`). Não é um checklist e **não
reintroduz DOR/acceptance** (ADR-0007) — é um **retrato factual** do trabalho.
`buildContext` das tasks dependentes lê os `completionMetadata` das irmãs `done` e
`buildPrompt` injeta o bloco **"🔗 Handoff estruturado"**.

### US-CTX3 — Continuação bounded direcionada

Classificação pura `classifyRunLiveness(runResult, diff, touched, handoffState)`
→ `RunLivenessState` (`completed|advanced|plan_only|empty_response|blocked|
failed|needs_followup`). Runs `plan_only`/`empty_response` (recuperáveis, sem
progresso) disparam uma **continuação bounded**: grava um `livenessReason`
direcionado + incrementa `AgentRuntimeState.continuationAttempt`; injeta o bloco
**"➡️ Continuação direcionada"** no próximo prompt e re-tica (via wake
`'continuation'` quando fora do auto-play). Ao atingir `continuationCap`
(default 2, `0`=off), **cede** ao fluxo normal (auto-step/anti-thrash) limpando o
motivo. Qualquer run `advanced`/`completed` **zera** o contador.

## Contrato & migrações

- `packages/shared`: `CompletionMetadata` (domain), `RunLivenessState` +
  `CONTINUABLE_LIVENESS` (enums), `'continuation'` em `WAKEUP_REASON`.
- Schema (2 migrações aditivas): `Card.completionMetadata Json?`;
  `AgentRuntimeState.continuationAttempt Int @default(0)` + `livenessReason
  String?`; valor `continuation` no enum DB `WakeupReason`.
- Config: `AGENT_CONTINUATION_CAP` (2), `AGENT_CONTINUATION_DELAY_MS` (1500).

## Consequências

**Positivas.** Re-dispatches deixam de ser amnésicos; tasks dependentes herdam um
handoff estruturado; runs que só planejam recebem um empurrão direcionado e
bounded (sem loop infinito — o cap cede ao anti-thrash). Tudo in-process,
best-effort (nunca derruba o loop) e retrocompatível (campos nullable/default;
`null`/`0` = comportamento atual).

**Negativas / trade-offs.** `completionMetadata` é um retrato heurístico (derivado
do que já temos), não uma declaração explícita da AI — pode ficar incompleto até
os runners populaberam `dependencies`/`retry_notes` diretamente. A continuação
adiciona uma dimensão a mais de "quando parar" que precisa ficar **abaixo** do
anti-thrash para não mascará-lo (por isso o cap baixo e o clear do motivo).

## Alternativas consideradas

- **Pedir à AI o handoff estruturado no protocolo do runner** (campo dedicado no
  `AgentRunResult`): mais fiel, mas exige mudar o contrato do runner e retreinar o
  prompt — adiado; a v1 deriva do que já existe.
- **Continuação sem cap / via anti-thrash apenas**: arriscado (loop de
  planejamento) ou tardio demais (anti-thrash só age depois de N repetições sem
  direção). O cap dedicado dá um empurrão **rápido e limitado**.

Ver `docs/specs/ep-ctx.md` para o detalhamento por story e mapa de arquivos.
