# How to plug an external agent into the hive (memory)

> Guia de integração para conectar um **agent de AI externo** (Claude Desktop,
> Cursor, Copilot CLI, um script próprio — qualquer cliente MCP ou HTTP) à
> **colmeia de memória** do `kanban-ai`, de forma **segura**. Refere-se a
> [ADR-0027 — Memória como serviço vivo (colmeia)](adr/0027-memory-as-a-living-service.md)
> e [ADR-0020 — MCP Server como segundo plano de controle](adr/0020-mcp-server-second-control-plane.md).

A colmeia é a **memória compartilhada** entre sessões de AI: neurônios `.md`
versionados em git (a fonte da verdade — ADR-0027) que os agents leem antes de
trabalhar e alimentam com o que aprenderam. Este documento cobre **como um agent
de fora** faz o ciclo `acquire → read → write → release` com autenticação.

## Dois caminhos de entrada

| Caminho | Quando usar | Transporte |
|---|---|---|
| **MCP HTTP** (US-C1) | Cliente MCP (Claude/Cursor/CLI) que fala o protocolo | `StreamableHTTPServerTransport` em `apps/mcp` (`MCP_HTTP_PORT`) |
| **REST direto** (US-C2) | Script/serviço próprio que só quer o control plane de memória | `POST/GET /memory/*` na API (`apps/api`) com `Authorization: Bearer` |

Ambos terminam no **mesmo control plane REST** (`/memory/*`): o MCP HTTP é uma
fachada de protocolo que chama a API; o REST direto fala com ela sem intermediário.

## Autenticação (obrigatória para agents externos)

O control plane de memória é protegido por **token por agent** (guard
`MemoryAuthGuard`). Configure a env `MEMORY_API_TOKENS` na API como uma lista
`csv` de `token:agentId:scope`:

```bash
# token           agentId         scope
MEMORY_API_TOKENS=tok-abc:ai:claude-1:memory,tok-xyz:ai:cursor-2:*
```

- **token** — segredo que o agent envia em `Authorization: Bearer <token>`.
- **agentId** — identidade **estável** do agent (ex.: `ai:claude-1`). Vira o
  `holder` dos leases e o autor lógico dos commits. O `sessionId` do ramo efêmero
  é derivado dele (remove o prefixo `ai:`).
- **scope** — módulo do escopo de escrita (ex.: `memory`): escrita **fora** de
  `modules/<scope>/` vai a **REVIEW** (ver contrato de erros). Use `*` para escopo
  **GLOBAL** (escreve em qualquer neurônio, sem enforcement).

> **Fecha o buraco:** com auth ligada, `agentId` e `scope` vêm do **token**, não
> de um `sessionId` livre no body — um agent não consegue mais escrever "como
> qualquer sessão". Os campos `sessionId`/`holder`/`module` do body ainda são
> exigidos pelo schema, mas são **ignorados/sobrescritos** pela identidade do
> token quando a auth está ligada.

> **Retrocompat (dev local):** se `MEMORY_API_TOKENS` estiver **ausente/vazia**, a
> auth fica **desligada** e o controller mantém o comportamento antigo baseado no
> body (o loop engine interno continua funcionando). Ligue a auth só configurando
> a env. Requisição sem token válido **com auth ligada** → `401`.

## O ciclo: `acquire → read → write → release`

A memória usa **lease advisory** (EP-78) + **compare-and-swap anti-stale**
(EP-79). O padrão de um write seguro:

1. **`acquire`** — pega o lease do neurônio e recebe o `baseCommit` (o HEAD que
   você vai usar como âncora do CAS) + `leaseId`/`expiresAt`.
2. **`read`** — lê o conteúdo atual do neurônio (a leitura é sempre **global**, do
   HEAD do `main`; não exige lease). Retorna também o `headCommit`.
3. **`write`** — envia o novo conteúdo com o `baseCommit`. Se o HEAD do path tiver
   avançado além do `baseCommit`, a escrita é **stale** → o serviço faz
   `reread → rebase → rewrite`; se esgotar as tentativas, falha anti-stale (409).
4. **`release`** — libera o lease e dispara o merge do ramo efêmero
   `mem/ai/<sessao>/<path>` no `main`.

Em trabalhos longos, mande **`heartbeat`** periodicamente para renovar o TTL do
lease antes de `expiresAt`, senão o sweeper auto-libera o lease vencido.

### Endpoints REST

| Método | Rota | Corpo (principais) | Retorno |
|---|---|---|---|
| `GET` | `/memory/read?path=...` | — | `{ path, content, headCommit }` |
| `POST` | `/memory/acquire` | `path, holder, ttlMs?` | `{ baseCommit, leaseId, expiresAt }` |
| `POST` | `/memory/heartbeat` | `path, holder, ttlMs?` | `{ path, holder, expiresAt }` |
| `POST` | `/memory/write` | `path, content, sessionId, baseCommit, message, module?` | commit **ou** item de REVIEW |
| `POST` | `/memory/release` | `path, holder` | `{ path, released: true }` |
| `POST` | `/memory/resolve` | `path, baseCommit, content?, arbiter?, sessionId?` | resultado da arbitragem |

## Formato do neurônio `.md`

Um **neurônio** é um arquivo Markdown versionado, identificado pelo seu `path`
lógico (ex.: `modules/memory/lock-lease.md`). Não há esquema rígido; a convenção é
um `.md` legível por humano E por AI, tipicamente com:

```markdown
# <título do neurônio> (ex.: Locks advisory da memória)

## Contexto
Por que este conhecimento existe; o problema que ele resolve.

## Decisões / convenções
- Regras aprendidas, invariantes, "sempre faça X", "nunca faça Y".

## Becos sem saída
- Abordagens já tentadas que NÃO funcionaram (evita re-descobrir).

## Histórico
- AAAA-MM-DD — o que mudou e por quê (curto; o git guarda o resto).
```

Escreva **incrementalmente**: leia o conteúdo atual, acrescente/edite, e commite
com uma `message` semântica. O git preserva o histórico completo.

## Contrato de erros

| Situação | Sinal | O que fazer |
|---|---|---|
| Sem token válido (auth ligada) | `401 Unauthorized` | Configure `Authorization: Bearer <token>` com um token de `MEMORY_API_TOKENS`. |
| Escrita **stale** (HEAD avançou além do `baseCommit`, retry esgotado) | falha **anti-stale (409)** | Refaça `read` para pegar o novo `headCommit` e reenvie o `write` com o `baseCommit` atualizado. |
| **Conflito de merge real** (não é só stale) | vira **proposta em REVIEW** (EP-80) | Um árbitro resolve via `POST /memory/resolve` (com `content` = aceitar; sem = descartar). |
| Escrita **fora do escopo** do token/`module` | vira **proposta em REVIEW** | Idem: aguarda arbitragem. Use um token de escopo adequado (ou `*`) se for legítimo. |

> A **leitura é sempre global** (qualquer agent lê qualquer neurônio). O
> enforcement incide só na **escrita**: fora do escopo → REVIEW, nunca commit
> direto.

## Heartbeat em trabalhos longos

O lease tem TTL. Se seu write demora (ex.: uma sessão inteira de análise), mande
`heartbeat` antes de `expiresAt` para renovar:

```bash
curl -sS -X POST "$API/memory/heartbeat" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"path":"modules/memory/lock-lease.md","holder":"ignored-com-auth","ttlMs":60000}'
```

Se o lease vencer sem heartbeat, o sweeper periódico (EP-B) auto-libera; seu
próximo `write` provavelmente será stale e você terá que refazer o `read`.

## Exemplo mínimo — agent externo via REST (curl)

```bash
API=http://127.0.0.1:3333
TOKEN=tok-abc                     # de MEMORY_API_TOKENS -> ai:claude-1:memory
NEURON=modules/memory/lock-lease.md
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

# 1) acquire — pega o lease e o baseCommit (holder do body é ignorado sob auth)
BASE=$(curl -sS -X POST "$API/memory/acquire" "${AUTH[@]}" \
  -d "{\"path\":\"$NEURON\",\"holder\":\"x\"}" | jq -r .baseCommit)

# 2) read — lê o conteúdo atual (global; headCommit deve bater com o baseCommit)
curl -sS "$API/memory/read?path=$NEURON" "${AUTH[@]}"

# 3) write — envia o novo conteúdo ancorado no baseCommit
#    (sessionId/module do body são sobrescritos pela identidade do token)
curl -sS -X POST "$API/memory/write" "${AUTH[@]}" \
  -d "{\"path\":\"$NEURON\",\"content\":\"# Locks\n\n## Decisões\n- ...\",\"sessionId\":\"x\",\"baseCommit\":\"$BASE\",\"message\":\"docs(memory): aprende regra de lease\"}"

# 4) release — libera o lease e dispara o merge no main
curl -sS -X POST "$API/memory/release" "${AUTH[@]}" \
  -d "{\"path\":\"$NEURON\",\"holder\":\"x\"}"
```

## Exemplo mínimo — cliente MCP via HTTP (US-C1)

Suba o MCP com o transporte HTTP (o stdio local segue funcionando):

```bash
MCP_HTTP_PORT=39217 npm run start -w @kanban-ai/mcp
# escuta em http://127.0.0.1:39217/mcp  (host configurável via MCP_HTTP_HOST)
```

Um cliente MCP faz o handshake `initialize` (recebe um `mcp-session-id` no header
da resposta), reusa esse header nas chamadas seguintes, e então lista/chama as
tools de memória (`memory_acquire`, `memory_read`, `memory_write`,
`memory_release`, `memory_heartbeat`, `memory_resolve`, ...). Smoke com curl:

```bash
MCP=http://127.0.0.1:39217/mcp
HDR=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

# initialize — o mcp-session-id volta no header da resposta
curl -sS -D - -o /dev/null "${HDR[@]}" -X POST "$MCP" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ext","version":"0.0.0"}}}'

# reuse o header em chamadas seguintes: -H "mcp-session-id: <id>"
# notifications/initialized  ->  depois  tools/list  ->  depois  tools/call
```

> A auth de **escrita na memória** é do control plane REST (Bearer). O MCP HTTP
> repassa suas chamadas à API usando `KANBAN_API_TOKEN` — configure-o com um token
> de `MEMORY_API_TOKENS` para que os writes via MCP herdem a identidade/escopo
> corretos.

## Invariantes que você NÃO deve violar

- **Leitura é global; escrita é escopada.** Não tente contornar o REVIEW.
- **Sempre ancore o write no `baseCommit`** que veio do `acquire`/`read` (CAS).
- **Identidade estável:** reuse o mesmo `agentId` (token) entre sessões — é o que
  faz a colmeia acumular conhecimento por autor.
- **`stdout` do MCP é sagrado** (JSON-RPC); logs vão para `stderr`.
