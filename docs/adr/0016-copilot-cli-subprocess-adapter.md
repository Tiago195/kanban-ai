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
  - `{"kind":"result","detail":...,"summary":...,"dodTouched":[...],"affectedFlows":[...],"nextStep":...,"done":bool}`
    — resultado final estruturado, mapeado para `AgentRunResult`.
  - **Linhas não-JSON** são toleradas e viram `thought` (fallback).

### Saída estruturada da AI (bloco `KANBAN_RESULT`)

O `copilot -p` real **não fala JSONL** — imprime markdown. Para que a **própria AI**
(não o backend) declare progresso, o **prompt** (montado em `Orchestrator.buildPrompt`)
instrui a CLI a terminar a resposta com um bloco sentinela:

```
<<<KANBAN_RESULT>>>
{ "summary": "...", "dodTouched": ["<dodId>"], "affectedFlows": [{"name","files","note"}],
  "nextStep": "...", "done": false }
<<<END_KANBAN_RESULT>>>
```

O `copilot-cli-adapter.mjs` extrai esse bloco (tolerante a cercas ```json) e o mapeia
para o evento `result`. **Regra de ouro:** é a AI quem marca `dodTouched` e registra
`affectedFlows` (ela sabe onde mexeu) — o orchestrator apenas **respeita** e persiste
(marca só ids válidos/pendentes da task; faz merge dos fluxos na story e emite
`flow.changed`). O `MockAgentRunner` mantém o fallback determinístico (marca o próximo
DOD pendente) só quando `runner.id === 'mock'`. Sem bloco → fallback tolerante (texto
cru, `dodTouched:[]`). O prompt também carrega **DOD real (com ids)**, **loop profile
+ fase + estratégia de validação** e o **handoff da iteração anterior**, para a AI não
se perder no loop.
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

## Como rodar o Copilot CLI real dentro do Docker (validado)

O binário `copilot` (`@github/copilot`) **não fala JSONL** e **não está instalado
na imagem** `Dockerfile.dev`. Para plugar o Copilot real sem tocar no
orquestrador, usamos duas peças:

1. **`docker/copilot-cli-adapter.mjs`** — ponte que lê o prompt (via **argv**,
   `promptMode='arg'`, ou primeira linha do stdin como fallback), invoca
   `copilot -p <prompt> --allow-all-tools --no-color [--model <id>]` e traduz a
   saída em eventos JSONL (`thought`/`output`/`result`). Detalhes:
   - Se `COPILOT_BIN` apontar para um `.js`/`.mjs` (ex.: o `index.js` do pacote
     montado read-only), é invocado via `node`.
   - Traduz os **aliases de modelo do domínio** (`opus`/`gpt`/`copilot`) para ids
     válidos da CLI (`claude-sonnet-4.5`/`gpt-5.2`/default). `COPILOT_MODEL` força
     um id explícito; `COPILOT_MODEL_MAP` (JSON) estende o mapa. Alias `opus` era
     rejeitado pela CLI (`Model "opus" ... is not available`).
   - Erros (binário ausente, auth, etc.) viram um `result` com `done:false` — o
     runner **não crasha** com `ENOENT`.
   - **Heartbeat**: emite um `{"kind":"thought"}` a cada `COPILOT_HEARTBEAT_MS`
     (default 20s) enquanto o `copilot` trabalha. O `copilot -p` agêntico fica
     **silencioso** durante o spin-up do modelo e as tool-calls; sem o heartbeat,
     o `resetIdle()` do runner estouraria `AGENT_STREAM_IDLE_TIMEOUT_MS`
     (default 120s) no meio de uma execução legítima.
   - **`AGENT_CLI_PROMPT_MODE=arg` é obrigatório** com este adapter. Em modo
     `stdin` o runner escreve o prompt mas **não fecha o stdin** (mantém aberto
     para respostas de HITL); o adapter ficaria bloqueado esperando EOF e o
     `copilot` **nunca seria invocado** (loop trava em silêncio, sem erro). Em
     modo `arg`, o prompt (mesmo multi-linha) chega como um único argv e o
     `stdinPrompt` é `null` — sem dependência de EOF.

2. **`docker-compose.copilot.yml`** — override opcional que:
   - monta `@github/copilot` do host em `/opt/copilot` (read-only);
   - aponta o runner para o adapter (`AGENT_CLI_COMMAND=node`,
     `AGENT_CLI_ARGS=/app/docker/copilot-cli-adapter.mjs {prompt}`,
     `AGENT_CLI_PROMPT_MODE=arg`, `COPILOT_BIN=/opt/copilot/index.js`);
   - autentica **via token** (`GH_TOKEN`/`COPILOT_GITHUB_TOKEN`) — **não** monta
     `~/.copilot` (evita conflito com a sessão de CLI do host e escrita read-only);
   - dá um `HOME` gravável (`/home/copilot`, volume `copilot_home`) para o Copilot
     persistir estado de sessão (sem isso: `EROFS`).

Execução:

```bash
export GH_TOKEN=$(gh auth token)
export COPILOT_PKG_DIR=$(realpath ~/.nvm/versions/node/*/lib/node_modules/@github/copilot)
docker compose -f docker-compose.yml -f docker-compose.copilot.yml up -d api
# log deve mostrar: AGENT_RUNNER ativo: copilot-cli — comando: node .../copilot-cli-adapter.mjs
# smoke do adapter (prompt via argv, promptMode=arg):
docker exec kanban-ai-api node /app/docker/copilot-cli-adapter.mjs "responda apenas com a palavra pronto"
# → {"kind":"result","detail":"pronto","summary":"pronto",...,"done":true}
```

O binário do host roda sob o `node:22` do container (mesma glibc — validado:
`GitHub Copilot CLI 1.0.55`). Sem o override, o default permanece `mock`
([ADR-0014](0014-mock-agent-runner-default.md)).
