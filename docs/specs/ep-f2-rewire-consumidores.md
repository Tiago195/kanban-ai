# EP-F2 / US-F2.8 — Rewire dos consumidores da memória

> **STATUS (US-F2.3, 2026-08-30): EXECUTADO.** A deleção descrita abaixo
> aconteceu; ver a emenda da US-F2.3 no ADR-0027 para o estado final e as
> duas correções factuais ao §5.4 (marcadas "CORREÇÃO US-F2.3" abaixo).
>
> **Público-alvo:** quem for executar a **US-F2.3** (deleção do módulo
> `memory/`, depois do cutover da F2.10). Este documento mapeia **cada
> consumidor vivo** do módulo `apps/api/src/modules/memory/` para um destino
> explícito — **morre**, **vira outra coisa** ou **fica** — de forma que a
> deleção seja mecânica. Nenhum consumidor sem destino. Verificado no código em
> `HEAD` na data desta US.
>
> Decisões do dono que definem o alvo (registradas no épico):
> 1. O control plane `/memory/*` + as 12 tools MCP `memory_*` + o
>    `MEMORY_API_TOKENS` **morrem**. Agents externos passam a consultar o MCP
>    do **graphify** diretamente.
> 2. O **git da memória sai** — os `.md` viram arquivos simples no clone
>    (`<clone>/.hive/**.md`, já materializados pela US-F2.4).
> 3. Perda **consciente**: o graphify tem UMA `--api-key`, sem identidade nem
>    escopo por agent (o que o EP-C dava via token).

---

## 1. Doutrina

**Strangler-fig, remoção deferida.** Esta US **não apaga nada**: ela faz os
consumidores pararem de depender do substrato velho (git da memória +
`MemoryIndex` global) e marca como **deprecado** o que morre mas ainda pode ter
consumidor externo. A ordem do épico:

- **US-F2.8 (esta):** rewire do Project Explorer para o `.hive/` + deprecações.
- **US-F2.10:** cutover do recall (`GRAPHIFY_MEMORY_RECALL` default true) +
  emenda do ADR-0027.
- **US-F2.3:** deleção do módulo `memory/`, das tools, do guard/token e de tudo
  marcado "morre" abaixo.

---

## 2. A tabela de destino

### 2.1 Os 11 endpoints REST `/memory/*` (`memory.controller.ts`)

O controller inteiro está marcado `@deprecated` (US-F2.8). O loop engine
interno **não** passa por HTTP (usa os serviços direto), então remover os
endpoints não toca o orchestrator.

| Endpoint | Destino | Motivo / o que usar no lugar |
|---|---|---|
| `GET /memory/read` | **morre** (F2.3) | O neurônio é arquivo simples em `<clone>/.hive/**.md` — o agent lê do worktree; recall semântico via MCP do graphify (`query_graph`/`get_neighbors`). O `headCommit` (âncora do CAS) perde o sentido sem git. |
| `POST /memory/write` | **morre** | A escrita durável vira o canal `learnings` do resultado da iteração (o orchestrator persiste via `appendLearning`, US-F2.6). Sem escritores externos, o CAS/rebase não tem mais o que proteger. |
| `POST /memory/acquire` | **morre, sem substituto** | Lease advisory existia para coordenar escritores **concorrentes externos**. No alvo a API é a ÚNICA escritora (serializa por task); o graphify não tem locks. Perda consciente — se um dia houver múltiplos escritores, o problema volta e precisa de solução nova. |
| `POST /memory/heartbeat` | **morre, sem substituto** | Só renova o TTL do lease acima. |
| `POST /memory/release` | **morre, sem substituto** | Só libera o lease/merge do ramo efêmero — sem git, não há ramo. |
| `POST /memory/resolve` | **morre, sem substituto** | Arbitragem de REVIEW pressupõe proposta em conflito de escritor externo fora de escopo. Sem escritores externos e sem escopo por agent (decisão 3), não nasce REVIEW. A fila `MemoryReview*` sai na F2.3. |
| `POST /memory/bootstrap` | ~~vira interno~~ **morre sem substituto** (revisado pela US-F2.9 — ver §5) | Com o recall por grafo (cutover F2.10), semear 1 neurônio vazio por módulo deixou de fazer sentido; o orchestrator já não chama `bootstrapFromRepo`. |
| `POST /memory/ensure-neuron` | ~~vira interno~~ **morre sem substituto** (revisado pela US-F2.9 — ver §5) | CORREÇÃO factual: o orchestrator NUNCA chamou `ensureNeuronForFile` direto (único caller é este endpoint deprecado + a tool MCP). A criação lazy já é coberta pelo `appendLearning(null, …)` do caminho de learnings. |
| `POST /memory/gc/sweep-stale` | **morre** | Staleness era reconciliação índice↔repo-alvo. No alvo, o `materialize()` da US-F2.4 já REMOVE do `.hive/` o que sumiu da colmeia (é o "GC" do novo substrato); módulo que sumiu do código é visível no próprio grafo. O conceito `stale`/`archivedAt` do summary degenera (ver §2.5). |
| `POST /memory/gc/summarize` | **morre** | Sumarizava histórico de COMMITS do git da memória. Sem git, o `.md` é a única versão — não há histórico a condensar. Se o arquivo crescer demais, o teto vira preocupação do `appendLearning` (futuro, se doer). |
| `POST /memory/gc/prune-branches` | **morre** | Podava ramos `mem/ai/*` do git da memória. Sem git, sem ramos. |

### 2.2 As 12 tools MCP `memory_*` (`apps/mcp/src/tools/memory.ts`)

**Todas morrem na F2.3.** São clientes HTTP finos 1:1 dos endpoints acima — o
destino de cada uma é o destino do endpoint que ela chama. Nesta US todas
ganharam o prefixo `[DEPRECADO — US-F2.8/EP-F2: …]` **na descrição** (a
interface que a AI lê) apontando o substituto: ler `<clone>/.hive/**.md` ou
consultar o MCP do graphify.

| Tool | Endpoint | Destino |
|---|---|---|
| `memory_read` | `GET /memory/read` | morre → ler `.hive/` no worktree ou `query_graph` do graphify |
| `memory_write` | `POST /memory/write` | morre → canal `learnings` do resultado da iteração |
| `memory_acquire` / `memory_heartbeat` / `memory_release` | leases | morrem, sem substituto (coordenação sai da superfície pública) |
| `memory_resolve` | `POST /memory/resolve` | morre, sem substituto |
| `memory_bootstrap` / `memory_ensure_neuron` | bootstrap | morrem (o fluxo vira interno) |
| `memory_gc_sweep_stale` / `memory_gc_summarize` / `memory_gc_prune_branches` | gc | morrem (manutenção do git, que sai) |

### 2.3 `MEMORY_API_TOKENS` / `MemoryTokenRegistry` / `MemoryAuthGuard`

**Morre** (F2.3), marcado `@deprecated` nesta US. Perda **consciente**
(decisão 3 do dono): o graphify autentica com UMA `--api-key` — some a
identidade estável por agent (`holder`/autor) e o escopo de escrita por módulo
(`classifyWrite` → REVIEW). Mitigação de fato: sem endpoints de escrita
externos, o que a chave única protege é só LEITURA do grafo.

### 2.4 Os 2 endpoints de Project + a tela (REWIRADOS NESTA US)

| Consumidor | Destino | O que mudou (US-F2.8) |
|---|---|---|
| `GET /projects/:id/memory` | **fica** | `ProjectExplorerService.listMemory` agora lê a colmeia MATERIALIZADA do clone (`<clone>/.hive/**.md`) via `ProjectHiveService.listHiveFiles`/`readHiveFile` — por-Project **por construção**, consertando o `TODO(US-PROJ4)` (a lista era o `MemoryIndex` GLOBAL: neurônio de um Project vazava para todos). Fallback para Projects ainda sem colmeia materializada: o índice legado, agora **filtrado** por `projects/<id>/` (nunca mais global). O fallback morre na F2.3. |
| `GET /projects/:id/memory/read` | **fica** | Idem: lê `<clone>/.hive/<path>` (trust boundary: o path da query não escapa do `.hive/`). `headCommit` degenera para `''` (arquivo simples não tem git; a UI renderiza "—"). Fallback legado idem. |
| Tela `ProjectExplorer.tsx` + `useProjectExplorer.ts` | **fica** | A memória virou por-Project ⇒ o seletor de projeto passou a governar as DUAS abas; o cabeçalho "Colmeia (global)" — que existia para comunicar o escopo global — saiu junto com o escopo que comunicava. Hooks/apiClient inalterados (mesmo contrato). |

### 2.5 Tipos compartilhados (`packages/shared`)

| Tipo | Destino | Nota |
|---|---|---|
| `MemoryNeuronSummary` | **fica** | Continua o contrato da tela. No substrato `.hive/`, os campos de COORDENAÇÃO degeneram para o estado neutro: `lockState: 'FREE'`, `holder: null`, `stale: false`, `archivedAt: null` (não existem lease/arquivamento em arquivo simples). Na F2.3, avaliar enxugar esses campos do tipo (mudança de contrato web+api juntos). |
| `MemoryNeuronDetail` | **fica** | `headCommit` passa a poder ser `''` no caminho `.hive/` (a UI já tratava falsy). Candidato a virar opcional na F2.3. |
| Eventos WS `memory.*` (`events.ts` + `memory-events.service.ts`) | **ficam até a F2.3, depois morrem** | Ainda são emitidos pelos serviços internos vivos (write/lock/review) e consumidos pelo `useRealtime` para invalidar `queryKeys.memory`. Quando os serviços saírem (F2.3), os eventos saem junto — incluindo a invalidação no web. Débito pré-existente (não desta US): o realtime não invalida `queryKeys.projectMemory`, então a tela atualiza por refetch de navegação, não por push. |

### 2.6 Consumidores internos do módulo (referência para a F2.3)

Fora do escopo de rewire desta US (são a F2.1/F2.10), mas mapeados para a
deleção não ter surpresa:

| Consumidor interno | Destino |
|---|---|
| `orchestrator.ts` → `MemoryWriteService`/`appendLearning` (persistLearnings) | **vira** na F2.3: escrever direto no `.hive/` do clone (a materialização deixa de ser espelho e vira fonte). Oráculo: `learning-write.spec.ts` (F2.1). |
| `orchestrator.ts` → recall antigo (`MemoryIndexService.search`) | **morre** na F2.10 (cutover `GRAPHIFY_MEMORY_RECALL=true` → recall por grafo, US-F1.4/F2.5). Oráculo: `memory-recall.characterization.spec.ts`. |
| `orchestrator.ts` → `MemoryBootstrapService.ensureNeuronForFile` | ~~vira~~ **inexistente** — o orchestrator nunca chamou `ensureNeuronForFile` (correção da US-F2.9, ver §5). |
| `MemorySchedulerService` (ticks de GC/lease) | **morre** na F2.3 junto com o que ele agenda (detalhe executável no §5.3). |
| `ProjectHiveService` → `MemoryGitService.listNeurons/readNeuron` (materialize) | **vira** na F2.3: quando o git sai, `materialize()` deixa de existir (o `.hive/` É o dado) — ou inverte para seed único na criação do Project. |

---

## 3. O que esta US entregou de código

1. **`ProjectHiveService.listHiveFiles`/`readHiveFile`** — leitura da colmeia
   materializada, com trust boundary no path (não escapa do `.hive/`).
2. **`ProjectExplorerService`** rewirado (hive-first, fallback legado
   namespaceado). O `ProjectHiveService` é injetado como parâmetro OPCIONAL —
   as specs pré-existentes (que cobrem o caminho legado) seguem intactas.
3. **Tela**: seletor de projeto governa as duas abas do Explorer.
4. **Deprecações**: `memory.controller.ts` (classe), `tools/memory.ts` (grupo +
   prefixo em TODAS as descrições) e `memory-auth.tokens.ts` marcados
   `@deprecated US-F2.8` com o substituto documentado.
5. **Specs novas**: `project-explorer.hive.spec.ts` (isolamento por Project,
   projeção do frontmatter v2, retrocompat v1, traversal, fallback
   namespaceado).

Validação empírica (postgres + sidecar graphify + API reais): Project clonado
de repo público, neurônio semeado pelo control plane deprecado (provando que
ele ainda responde: `read`/`write`/`acquire`/`release`/`gc/prune-branches`),
`materialize` disparado pelo fluxo real de clone→build, e a tela provada no
navegador — Project A mostra o neurônio do seu `.hive/`, Project B mostra o
estado vazio (o vazamento que o `TODO(US-PROJ4)` admitia não acontece mais).

## 4. Débitos conhecidos (ficam para F2.10/F2.3)

- Fallback legado do Explorer (índice namespaceado) — remover na F2.3.
- `readMemory` com path-lixo cai no fallback legado e responde 500 (sem vazar
  conteúdo) — comportamento pré-existente do caminho git; morre com ele.
- Realtime não invalida `queryKeys.projectMemory` (pré-existente).
- Campos de coordenação em `MemoryNeuronSummary` degenerados — enxugar tipo na
  F2.3.
- ADR-0027 ainda descreve o mundo velho — emenda é a F2.10.

---

## 5. US-F2.9 — destino EXECUTÁVEL das capabilities de bootstrap/GC

> A US-F2.8 deu etiquetas de alto nível; esta seção dá o destino **executável**
> de cada capability de manutenção do substrato velho, com prova por
> arquivo:linha e por spec rodada. Verificado no código em `HEAD` da US-F2.9.

### 5.1 A tabela das 6 capabilities

| Capability | Destino | Prova / detalhe |
|---|---|---|
| `bootstrapFromRepo` (US-213) | **morre sem substituto** — o orchestrator NÃO chama mais (removido na US-F2.9 de `bootstrapAndStartAuto`, `orchestrator.ts`). | Buraco que abre: a colmeia nasce vazia. **Não é mais buraco**: com o recall por grafo (cutover F2.10) o grafo do código já dá o mapa do repo ao agent; o neurônio nasce lazy na 1ª escrita real de learning (`appendLearning(null, …)` — `neuron-format.ts:193`, chamado por `persistLearning`, `orchestrator.ts:~940`). Semear boilerplate ("registre aqui o propósito…") só materializava N páginas-ruído em `.hive/` → grafo → prompt do recall. Efeito colateral aceito: wikilink `[[modulo]]` para módulo ainda sem learning fica pendurado até aquele módulo ganhar o próprio neurônio (self-healing; o canal decisivo do recall é a aresta `describes` via `frontmatter.files`, não o wikilink). Specs: `bootstrap-retirement.spec.ts` (novo) + `neuron-format.spec.ts` ("appendLearning sem neurônio prévio cria v2"). O endpoint/tool deprecados (F2.8) seguem funcionais até a F2.3 e morrem lá. |
| `ensureNeuronForFile` (US-214) | **já coberta** pelo caminho de escrita — e o consumidor que a F2.8 citou não existia. | CORREÇÃO: o orchestrator nunca chamou `ensureNeuronForFile`; os únicos callers são o endpoint deprecado (`memory.controller.ts:181`) e a tool MCP — ambos morrem na F2.3. A criação lazy REAL do sistema é `appendLearning(content === null)` (`neuron-format.ts:206-213`): primeiro learning de um módulo cria o neurônio v2 com `files:` reais (mais rico que a semente vazia). Provado executando: `neuron-format.spec.ts` e `learning-write.spec.ts` ("caminho feliz") verdes. |
| `sweepStale` (US-215) | **parcialmente coberta + perda consciente**; morre na F2.3. | O eixo hive↔colmeia é coberto pelo `materialize()`: `project-hive.service.ts:87-91` remove do `.hive/` todo arquivo sem neurônio correspondente e reporta o path (o wrapper de build deleta os nós). Provado executando: `project-hive.service.spec.ts` "US-F2.4 (c) … stale é apagado e reportado" verde. O eixo colmeia↔código (módulo que sumiu do repo → flag `stale`/`archivedAt`) NÃO tem equivalente — perda consciente e pequena: o scheduler nunca disparou `sweepStale` (exige `repoPath`, ver `memory-scheduler.service.ts` runGc), então em produção o flag só mudava se alguém chamasse o endpoint de GC na mão; no alvo, módulo extinto é visível no próprio grafo e o neurônio obsoleto persiste em `.hive/` até remoção manual/regravação. |
| `summarizeHistory` (US-216) | **morre sem substituto** na F2.3. | Condensava histórico de COMMITS do git da memória — sem git, o `.md` é a única versão. Buraco teórico: crescimento sem teto do neurônio. Mitigação já existente no recall: `appendNeuronBodies` trunca cada corpo (`orchestrator.ts`, `MAX_CHARS`). E o método NUNCA foi disparado automaticamente (o scheduler o pula explicitamente) — a morte não muda comportamento de produção. Se o arquivo doer um dia, o teto vira preocupação do `appendLearning`. |
| `pruneEphemeralBranches` (US-217) | **morre na F2.3 junto com o git** — mas faz trabalho REAL até lá. | Cada learning write cria um ramo `mem/ai/<sessão>/<path>` e o `commitAndReindex` faz merge SEM podar (`memory-index.service.ts:61-66`; só `memory-review.service.ts:237` poda, no fluxo de arbitragem). O tick de GC é quem limpa os ramos merged do loop. Por isso NADA foi desligado nesta US: o serviço e o tick ficam armados até a F2.3, quando o git inteiro sai e ramos deixam de existir por construção. |
| `MemorySchedulerService` (EP-B) | **morre na F2.3; nenhum tick substituto é necessário** — fica LIGADO até lá. | O tick dispara (a) `expireStale` de leases — no alvo não há leases (escritor único, decisão da F2.8 §2.1); (b) `pruneEphemeralBranches` — no alvo não há ramos. A única manutenção do novo substrato é a materialização do `.hive/`, que é dirigida a EVENTO, não a timer: `ProjectGraphService.syncHive` roda antes de cada build completo e de cada rebuild incremental (`project-graph.service.ts`). Provado executando: `project-hive.service.spec.ts` "US-F2.4 (f): build completo sincroniza a colmeia antes; incremental anexa os .hive/…" verde. |

### 5.2 A decisão do bootstrap (semear neurônio vazio por módulo)

**Não semear mais.** Antes do grafo, a semente era o que impedia o agent de
começar cego: o recall LIKE só devolvia o que existia no índice, e um índice
vazio significava zero contexto. Com o cutover (F2.10), o mapa do repo É o
grafo do código — módulos, arquivos, símbolos e arestas existem sem nenhum
neurônio. A semente (`seedFor`) não carrega informação além de
nome/dir do módulo (que o grafo já tem) + boilerplate de instrução; cada uma
virava uma página no grafo que o `query_graph` podia casar por nome de módulo
e o `appendNeuronBodies` colava no prompt — ruído pago em tokens. A colmeia
que nasce vazia e cresce por learning real tem 100% de sinal.

Executável: a chamada saiu de `bootstrapAndStartAuto` (que agora só garante o
clone via `resolveStoryTargetRepo` — motivo original da cauda em background —
e arranca o auto-play). O slot posicional do construtor fica (`_memoryBootstrap`)
até a F2.3 para não quebrar a aridade nas specs pré-existentes.

### 5.3 O destino do scheduler

Fica ligado até a F2.3 (poda os ramos `mem/ai/*` que os learning writes ainda
deixam para trás e varre leases do control plane deprecado), e morre lá sem
substituto — ver a linha da tabela: no novo substrato não há lease nem ramo, e
a materialização é por evento de build.

### 5.4 Débitos para a F2.3

- ~~`withNamespace` … mover para fora antes de apagar o arquivo.~~
  **CORREÇÃO US-F2.3:** `withNamespace` MORREU em vez de mudar de lugar — com
  a escrita indo direto para `<clone>/.hive/<path>` (clone per-Project), o
  namespace `projects/<id>/` perdeu a razão de existir; nenhum caller restou.
- Remover o slot `_memoryBootstrap` do construtor do Orchestrator (junto com a
  atualização em massa das specs que instanciam com 10+ args).
- Neurônio de módulo extinto persiste em `.hive/` (perda consciente do
  `sweepStale`, §5.1) — se doer, um passo opcional no `materialize()` pode
  cotejar `frontmatter.dir` contra o clone.
- ~~`seedFor`/`detectModules` … morrem juntos na F2.3.~~
  **CORREÇÃO US-F2.3:** `detectModules` NÃO morreu — o
  `ProjectExplorerService.repoInfo` (US-PROJ7, fora do módulo `memory/`) sempre
  foi consumidor e este doc não o listou; a função mudou para
  `apps/api/src/modules/projects/detect-modules.ts` (enxuta, sem
  `neuronPath`/`seedFor`). `seedFor` e `moduleForFile` morreram como previsto.
  `neuron-format.ts` inteiro (outro sobrevivente) mudou para
  `apps/api/src/shared/neuron-format.ts`.
