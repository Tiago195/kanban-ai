# ADR-0016 — Copilot CLI real via subprocesso + CliAdapter JSONL configurável

**Status:** Aceito

## Contexto

Até a Fatia 3 o loop rodava com `MockAgentRunner` determinístico
([ADR-0014](0014-mock-agent-runner-default.md)). A Fatia 4 pluga o runner **real**:
a Copilot CLI executada como **subprocesso**. O comando exato, flags e o formato
de saída da CLI **ainda não são conhecidos** — precisamos isolar essa incerteza
para plugar o comando real depois **sem tocar no orquestrador**.

## Decisão

O `CopilotCliRunner` invoca a CLI via `child_process.spawn`, atrás de uma camada
**`CliAdapter` configurável por env**:

- `AGENT_CLI_COMMAND` (default `copilot`), `AGENT_CLI_ARGS` (lista separada por
  espaço), `AGENT_CLI_PROMPT_MODE` (`stdin` | `arg`).
- O prompt/handoff é entregue por **stdin** (default) ao spawnar.
- O stdout é lido **linha a linha** e parseado por um protocolo **JSONL** — uma
  linha JSON por evento:
  - `{"kind":"thought","text":...}` — raciocínio interno (streaming).
  - `{"kind":"output","text":...}` — saída/ação (streaming).
  - `{"kind":"question","id":...,"prompt":...,"options":[...]}` — pergunta HITL.
  - `{"kind":"result","detail":...,"summary":...,"dodTouched":[...],"nextStep":...,"done":bool}`
    — resultado final estruturado, mapeado para `AgentRunResult`.
  - **Linhas não-JSON** são toleradas e viram `thought` (fallback).
- O runner respeita `input.signal` (AbortSignal): no abort mata o processo
  (`child.kill('SIGTERM')`). Um timeout de inatividade de stdout
  (`AGENT_STREAM_IDLE_TIMEOUT_MS`, default 120000ms) protege contra travas.
- Ordem preservada: os eventos de stdout são processados numa fila serializada,
  de modo que quando um `question` bloqueia aguardando resposta humana, as linhas
  subsequentes esperam.

O `AGENT_RUNNER_KIND` (`mock` | `copilot-cli`) escolhe o runner via factory no
`ai-engine.module.ts`; o **mock permanece o default** e o fallback dev/test.

## Consequências

- O comando real da CLI pluga só ajustando env (ou um shim que emita JSONL) — o
  orquestrador não muda.
- Contrato do parser é explícito e documentado (`docs/loop-engine.md`),
  testável por um **comando fake JSONL**.
- Streaming e HITL são habilitados pelo protocolo (ver
  [ADR-0017](0017-streaming-hitl-websocket.md)).
- O worktree isolado ([ADR-0008](0008-git-worktree-per-execution.md)) sai do stub
  e alimenta o `cwd` do subprocesso.
