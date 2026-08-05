# ADR-0022 — HITL sobrevive a restart via `--session-id` da Copilot CLI

**Status:** Aceito

**Supera parcialmente:** [ADR-0018](0018-awaiting-input-in-process.md) (na parte
"uma pergunta pendente não sobrevive a um restart da API").

## Contexto

O fluxo HITL ([ADR-0017](0017-streaming-hitl-websocket.md)) pausa a iteração
quando a AI faz uma pergunta e aguarda a resposta humana. O [ADR-0018](0018-awaiting-input-in-process.md)
decidiu manter esse estado de espera **in-process**: a pergunta pendente e o
`resolve` da Promise (`waitForAnswer`) vivem num `Map` em memória. Aquele ADR
reconhecia explicitamente o trade-off — *"uma pergunta pendente **não sobrevive**
a um restart da API"* — e deixava para um ADR próprio a evolução de retomar após
restart ("persistir o transcript e re-spawnar com contexto"). **Este é esse ADR.**

O sintoma que forçou a evolução (relatado no **backlog-chat**, ver
[ADR-0020](0020-mcp-server-second-control-plane.md)): o usuário clicava numa opção
de resposta e recebia **HTTP 404 `nenhuma pergunta pendente para essa
sessão/questionId`**. Duas causas se somavam num restart da API:

1. **Promise em memória some.** O turno estava parado em
   `await waitForAnswer(sessionId, questionId)` — uma Promise guardada num `Map`.
   Restart mata o `Map`; `answerQuestion` não achava a promise e retornava
   `false` → o controller lançava `NotFoundException`.
2. **Child process do Copilot CLI morre.** O subprocesso do `copilot` é filho do
   processo Node da API; quando a API cai, ele cai junto — não há a quem entregar
   a resposta.

Enquanto isso, o banco **já** persistia a pergunta com as opções, então o
frontend re-renderizava os chips na hidratação (F5) — dando a falsa impressão de
que dava para responder, quando não havia mais nada vivo do outro lado.

## Decisão

Reusar o **UUID da sessão** como `--session-id` da Copilot CLI, tornando o HITL
resiliente a restart **sem nova coluna/migration**.

A Copilot CLI persiste cada sessão em `~/.copilot/session-state/<uuid>/`. Passar
`--session-id <uuid>` numa invocação **retoma a mesma sessão com todo o
contexto** (validado ao vivo: um turno gravou "número favorito 42" e um turno
seguinte, invocação separada, lembrou "42"). Como `BacklogChatSession.id` **já**
é um UUID (`@default(uuid())` no schema), reusamos esse id como o `--session-id`
do Copilot — **nenhuma coluna nova**.

Três pontos de mudança (backlog-chat):

- **`docker/copilot-cli-adapter.mjs`** — lê `COPILOT_SESSION_ID` do env e, se
  presente, adiciona `--session-id <id>` aos args do `copilot`.
- **`runner/backlog-cli.runner.ts`** — `BacklogRunInput.cliSessionId?`; o `spawn`
  injeta `COPILOT_SESSION_ID` no env do subprocesso.
- **`backlog-chat.orchestrator.ts`** — `runner.run` recebe `cliSessionId:
  sessionId`; `answerQuestion` virou `async` **resiliente**, com dois caminhos
  mutuamente exclusivos:
  - **Caminho rápido:** existe uma Promise viva de `waitForAnswer` (mesmo
    processo, sem restart) → resolve como antes.
  - **Caminho de resiliência:** sem promise viva (houve restart) → busca a AI
    question no banco por `questionId`, confirma que ainda **não** há resposta do
    usuário para aquele `questionId`, persiste a resposta, faz broadcast
    `backlog.answered` e re-dispara `void runTurn(...)`. O CLI **resume** o
    contexto (a pergunta inclusa) via `--session-id` e continua a conversa.

O controller (`@Post(':cid/answer')`) virou `async` + `await`; **404 só** se a
pergunta nem existe no banco (`answerQuestion` → `false`), não mais por restart.

## Rationale

- A intuição registrada no ADR-0018 (estado efêmero atado a um processo vivo)
  continua correta **dentro de um mesmo processo**; o que mudou é que a **própria
  Copilot CLI** oferece durabilidade de sessão em disco. Reaproveitá-la é mais
  barato que persistir/re-spawnar transcript manualmente.
- Reusar o `id` da sessão (que já é UUID) evita migration e mantém o schema
  estável — coerente com a restrição de "preferir não exigir migration"
  (ADR-0018).
- O prompt de cada turno já é **auto-suficiente** (rebuilda histórico + protocolo
  JSONL). Com resume isso é redundante, mas inofensivo — e serve de fallback caso
  o resume falhe.

## Consequências

- **Pergunta HITL sobrevive a restart.** Validado end-to-end: sessão criada → AI
  perguntou → **API reiniciada** (matando promise + CLI child) → resposta →
  `{"accepted":true}` HTTP 201 (não mais 404) → a AI **continuou a conversa**
  emitindo nova pergunta coerente. Sequência no banco limpa
  (user→q1→user(answer q1)→q2), sem duplicação de resposta.
- **Sem migration.** O `id` da sessão faz dupla função (PK + Copilot session-id).
- **Dependência de disco.** A resiliência depende de `~/.copilot/session-state/`
  persistir entre restarts (mesmo host — coerente com
  [ADR-0019](0019-api-runs-on-host-not-docker.md), a API roda no host). Se esse
  diretório for limpo, o resume degrada para o prompt auto-suficiente.
- **Sessões antigas (pré-fix).** Perguntas feitas antes do fix não tiveram
  `--session-id` no spawn original; ao responder, o CLI **cria** uma sessão com
  aquele id e o prompt auto-suficiente carrega o contexto — recuperável, ainda
  que sem o histórico interno original do CLI.
- **Loop-engine (concluído).** O runner do loop autônomo
  (`ai-engine/runners/copilot-cli.runner.ts`) tinha o mesmo padrão de
  promise-em-memória e o mesmo bug HITL. O padrão foi estendido para lá: o
  `AgentRunInput.cliSessionId` recebe o `taskId` (UUID); o `CopilotCliRunner`
  injeta `COPILOT_SESSION_ID`; o `Orchestrator.answerQuestion` virou `async`
  resiliente (caminho rápido via `AgentSessionManager.resolveQuestion` OU
  caminho de resiliência que busca a AI question por `questionId`, persiste a
  resposta do usuário — com guarda de idempotência — e re-dispara
  `runIteration(taskId)`). O `AiEngineController` faz `await`. Validado:
  pergunta órfã → 201 (não 404), idempotência (2 POSTs = 1 resposta),
  pergunta inexistente → 404 legítimo mantido.
