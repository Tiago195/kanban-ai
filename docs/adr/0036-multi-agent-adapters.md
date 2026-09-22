# ADR-0036 — Registry de adapters multi-agente (copilot-cli default)

**Status:** Aceito (implementado — US-OBS4)

**Data:** 2026-08-12

## Contexto

O loop engine já abstrai a execução do agent atrás do contrato `AgentRunner`
(`run(input) => AgentRunResult`, token de DI `AGENT_RUNNER`). Havia duas
implementações: `CopilotCliRunner` (`id='copilot-cli'`, subprocesso da Copilot
CLI via `CliAdapter` JSONL — ADR-0016) e `MockAgentRunner` (`id='mock'`,
determinístico para dev/testes — ADR-0014). A seleção era binária, feita no
`useFactory` do `AiEngineModule` a partir de `AGENT_RUNNER_KIND` (`mock|copilot-cli`).

Faltava uma camada para **suportar múltiplos vendors** (Claude/Codex/Gemini),
cada um com seu próprio CLI/formato, **sem mudar o `AgentRunner`** e **sem
regredir o default** (`copilot-cli`). Também faltava um jeito de a UI **listar**
os adapters disponíveis — o que exige derivar disponibilidade de credencial
**sem jamais expor o segredo**.

## Decisão

Introduzir um **registry de adapters** que mapeia `AgentAdapterKind → AgentRunner`
e resolve o runner ativo a partir de uma nova env `AGENT_ADAPTER` (default
`copilot-cli`). Tudo aditivo e retrocompatível.

- **Contratos shared** (`packages/shared/src/domain.ts`, re-exportados por
  `index.ts`): `AgentAdapterKind` (`'copilot-cli' | 'claude' | 'codex' | 'gemini'
  | 'mock'`) e `AgentAdapterDescriptor` (`kind`, `displayName`, `isDefault`,
  `available: boolean`). Aditivos e type-safe (consumidos por api **e** web).
- **Config** (`apps/api/src/shared/config/config.ts`): novo campo `agentAdapter`
  lido de `AGENT_ADAPTER` via `resolveAgentAdapter(...)` — ausente/vazio/
  desconhecido cai no default `copilot-cli`. `.env.example` documenta a env.
- **Registry** (`apps/api/src/modules/ai-engine/runners/agent-adapter.registry.ts`,
  `AgentAdapterRegistry`): `resolve(kind)`, `resolveActive()` e
  `listDescriptors()`. Nesta fatia estão **wired** `copilot-cli` e `mock`; os
  vendors `claude`/`codex`/`gemini` são **declarados** como descritores (para a
  UI listar) mas ainda não têm runner dedicado — resolver um kind não-wired ou
  desconhecido cai no default `copilot-cli`, com warning. Cada vendor entrará em
  um PR próprio reusando o `CliAdapter` (PR-3 do plano de US-OBS4).
- **DI** (`ai-engine.module.ts`): o provider `AGENT_RUNNER` passa a resolver via
  `registry.resolveActive()`. Retrocompat: `AGENT_RUNNER_KIND=mock` (sem
  `AGENT_ADAPTER` setado) continua forçando o mock em dev/testes. O contrato
  `AgentRunner` **não muda** e o orchestrator segue injetando o mesmo token.
- **Endpoint** (`modules/models/models.controller.ts`, `@Controller('agents')`):
  novo `GET /agents/adapters` → `{ adapters: AgentAdapterDescriptor[] }`, servido
  pelo registry (o `ModelsModule` importa o `AiEngineModule`, que exporta o
  registry). Espelha o padrão de `GET /agents/models`.

### Invariante de segredo

`available` é derivado apenas da **presença** de binário/credencial no ambiente
(ex.: `GITHUB_TOKEN` para copilot-cli, `ANTHROPIC_API_KEY` para claude), retornando
**sempre um booleano** — o valor do segredo **nunca** é lido para o payload nem
logado. `mock` é sempre `available`. Um teste serializa os descritores e assere
que nenhum valor de token aparece.

## Consequências

- **Positivas:** a frota fica pronta para múltiplos vendors sem tocar no
  `AgentRunner`/orchestrator; o default `copilot-cli` é preservado (não-regressão
  coberta por spec); a UI ganha um catálogo listável e seguro de adapters.
- **Negativas / riscos:** claude/codex/gemini aparecem como descritores antes de
  terem runner — mitigado pelo fallback ao default com warning e por serem PRs
  incrementais. A heurística de `available` por env é aproximada (presença ≠
  validade da credencial), mas suficiente para a UI e sem risco de vazamento.
- **Invariantes preservados:** contrato `AgentRunner`/`AgentRunResult` inalterado;
  sem Redis; sem DOR/`acceptance`; `available` nunca expõe segredo.

## Alternativas consideradas

- **Manter só `AGENT_RUNNER_KIND`:** não escala para N vendors nem separa
  disponibilidade de seleção. Rejeitada.
- **Um controller solto para adapters:** a spec pede reusar o `@Controller('agents')`
  existente (`GET /agents/models`) para não multiplicar controllers. Adotado.

## Emenda — 2026-08-29 (US-F3.1): `AGENT_ADAPTER` é a ÚNICA fonte de verdade

A decisão original deixou **duas chaves para a mesma decisão**: `AGENT_ADAPTER`
e o legado `AGENT_RUNNER_KIND` (o trecho "Retrocompat: `AGENT_RUNNER_KIND=mock`
… continua forçando o mock" no bullet de DI). Esta emenda **supersede esse
trecho**: a seleção de runner tem uma única fonte de verdade.

- **Precedência (implementada em `resolveAgentAdapter`, `config.ts`):**
  1. `AGENT_ADAPTER` explícito (não-vazio) **vence** — valor desconhecido cai
     no default de **catálogo** `copilot-cli` (`DEFAULT_AGENT_ADAPTER`, o mesmo
     fallback do registry para kinds não-wired);
  2. ausente/vazio, o alias **DEPRECADO** `AGENT_RUNNER_KIND`
     (`mock|copilot-cli`) é honrado — com **um** warning de deprecação no boot
     (não a cada resolução), dizendo para usar `AGENT_ADAPTER`;
  3. sem os dois → default do **processo** `mock`
     (`DEFAULT_PROCESS_AGENT_ADAPTER`), preservando o ADR-0014 (emendado na
     mesma data): dev sem `.env` fica no runner determinístico, sem
     subprocesso real/quota/login.
- **Config:** `config.agentAdapter` é o único campo de seleção;
  `config.agent.runnerKind` vira campo **legado DERIVADO** de `agentAdapter`
  (`mock` sse `agentAdapter === 'mock'`) — os dois não podem mais divergir.
- **DI:** o `useFactory` de `AGENT_RUNNER` não consulta mais
  `AGENT_RUNNER_KIND`/`runnerKind`; resolve sempre via
  `registry.resolveActive()`.
- **Janela de deprecação:** `AGENT_RUNNER_KIND` (e o campo derivado
  `agent.runnerKind`) permanecem por **uma versão** e serão removidos na
  seguinte. `.env.example` documenta `AGENT_ADAPTER` como a chave; o compose
  base faz **passthrough puro** das duas envs com default vazio
  (`${AGENT_ADAPTER:-}` / `${AGENT_RUNNER_KIND:-}`, vazio conta como ausente)
  — o compose não tem opinião própria sobre a seleção: quem só tem o alias no
  `.env` segue honrado (com o warning), e sem nada setado o boot cai no
  default do processo `mock` sem warning.
- **Nenhuma mudança de comportamento:** a matriz completa (nenhuma env / só
  legado / só `AGENT_ADAPTER` / ambos / valores desconhecidos) resolve
  exatamente como antes da unificação. O `isDefault` de `GET /agents/adapters`
  segue refletindo o adapter **ativo efetivo** (`config.agentAdapter`), não um
  default de catálogo.

## Emenda — 2026-08-29 (US-F3.10): cascata de adapter por card

O épico EP-F3 tem foco declarado em **custo**: trocar de vendor globalmente não
basta — é preciso rodar task simples em adapter barato e task difícil em caro.
Esta emenda torna a seleção de adapter **por card**, em cascata, mantendo
`AGENT_ADAPTER` como a cauda global da resolução (a emenda US-F3.1 permanece:
é a única fonte de verdade **global**).

- **Schema (aditivo):** `Card.adapter String?` e `Board.defaultAdapter String?`,
  espelhando o par `model`/`defaultModel`. Escrita validada contra o catálogo
  de kinds (`AGENT_ADAPTER_KINDS`) nos schemas Zod da API; valores desconhecidos
  que porventura estejam no banco são IGNORADOS na leitura (a cascata continua).
- **Resolução (espelho de `resolveCardModel`):** task → story → epic →
  `board.defaultAdapter` → `config.agentAdapter` (que já embute `AGENT_ADAPTER`
  → default do processo `mock`). Implementada em
  `Orchestrator.resolveCardAdapter` (dispatch) e `CardsService.resolveAdapter`/
  `attachResolvedModel` (leitura da API: `resolvedAdapter` no card).
- **Runner por card:** `runIteration` resolve o runner pelo adapter efetivo via
  `AgentAdapterRegistry.resolve(kind)` (instâncias cacheadas pelo registry). O
  token `AGENT_RUNNER` **permanece** como estava (resolvido no boot) e é o
  fallback quando o registry não está injetado — specs que instanciam o
  `Orchestrator` posicionalmente seguem válidas (o registry entra como último
  parâmetro `@Optional()`).
- **Recovery lane VENCE a cascata** (`resolveDispatchAdapter`): wake de
  recuperação status-only roda no adapter **global** com o `AGENT_CHEAP_MODEL_ID`
  (como antes). Racional: o cheap model id vive no namespace de modelos do
  adapter global (em outro vendor seria 404), e a recuperação nunca pode ficar
  mais cara do que hoje — nem herdar o adapter caro do card.
- **Modelo × vendor (débito da US-F3.9):** o `TanStackRunner` valida CEDO (antes
  de rede/ESM) o modelo por-card contra o vendor, via `vendorModelIssue` — só
  acusa mismatch **certo** (alias do domínio como 'opus', id no formato do
  catálogo Copilot/org, ou id que casa o padrão de OUTRO vendor); id neutro/
  desconhecido passa (o provider é quem valida — mapear aliases exigiria um
  catálogo vivo por vendor, com risco de drift e substituição silenciosa
  errada). Mismatch vira `fatalError` legível (BUG-A7): escala a humano com
  instrução acionável em vez de 404 opaco no meio do loop. O override
  `<VENDOR>_MODEL` é escolha explícita do operador e não passa pela checagem.
- **`GET /agents/adapters` inalterado:** `isDefault` segue marcando o adapter
  global efetivo — que agora é, precisamente, a cauda da cascata. O adapter
  efetivo POR CARD é exposto pelos endpoints de cards (`resolvedAdapter`).
