# ADR-0006 — AgentRunner plugável (Copilot CLI no v1)

**Status:** Aceito

## Contexto

O trabalho de cada iteração é executado por um agent de AI. Queremos poder
**escolher qual agent/modelo roda** por task/loop (opus, gpt, ...) e trocar a forma
de execução no futuro sem reescrever o orquestrador.

## Decisão

Definir **`AgentRunner`** como uma **interface** (token de DI `AGENT_RUNNER`), com
`run(input): Promise<AgentRunResult>`. A implementação v1 é o **`CopilotCliRunner`**,
que invoca a **Copilot CLI como subprocesso** e captura o resultado.

`AgentRunInput` carrega `cwd` (git worktree), `model`, `phase`, `prompt` (handoff do
diário) e um `AbortSignal` (stop hard). `AgentRunResult` retorna `detail`,
`summary`, `dodTouched`, `nextStep` e `done`.

## Consequências

- Trocar por um runner via SDK ou API remota não afeta o `Orchestrator`.
- Escolha de modelo por execução fica no `AgentRunInput.model`.
- **Em aberto (a resolver na implementação):** formato exato do payload enviado à
  CLI e como **detectar "iteração terminou"** (stdout/exit code/arquivo). Stub por
  ora.
