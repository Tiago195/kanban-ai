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
