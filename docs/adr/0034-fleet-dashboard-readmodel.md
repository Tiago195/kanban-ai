# ADR-0034 — Dashboard de frota como read-model agregado (`GET /dashboard`)

**Status:** Aceito (implementado — US-OBS1)

**Data:** 2026-08-12

## Contexto

A frota de agents autônomos já expõe métricas **por story** via
`GET /cards/:id/loop/metrics` (`Orchestrator.computeStoryMetrics` → `LoopMetrics`,
consumido pelo `LoopMetricsPanel`). Faltava, porém, uma visão **agregada da frota
inteira**: quantos cards há em cada coluna do board, quais stories estão paradas
(stale) há muito tempo em `In Progress`, e o burn/cost total (tokens + iterações)
das stories ativas.

O maior risco de um endpoint agregado é **vazar segredo**: o repo-alvo
(`Card.aiProject`, um caminho arbitrário do FS do usuário — ADR-0019), env,
credenciais ou o transcript bruto do agent. Qualquer read-model de frota precisa
ser **sanitizado por construção**.

## Decisão

Adicionar um **read-model agregado read-only** exposto em `GET /dashboard`,
sem migration e sem alterar contratos existentes.

- **Contratos shared** (`packages/shared/src/domain.ts`, re-exportados por
  `index.ts`): `FleetColumnCount`, `FleetStaleStory`, `FleetCostSummary` e
  `FleetDashboard`. Aditivos e type-safe (consumidos por api **e** web).
- **Módulo `apps/api/src/modules/dashboard/`** (`DashboardModule` registrado em
  `app.module.ts`), com `DashboardController` (`@Controller('dashboard')`,
  `@Get()` → `FleetDashboard`) e `DashboardService`:
  - **`columns`**: lê todos os cards (`type` + coluna via `boardColumn`
    epic/story OU `taskColumn` task, ambos pelo `title` da `Column`) e agrega em
    `FleetColumnCount[]` na ordem de `BOARD_COLUMNS`.
  - **`staleStories`**: stories cuja coluna é `In Progress`; para cada uma pega a
    última `Iteration` (`orderBy index desc, take 1`) e calcula `staleMinutes` a
    partir do `ts` da iteração (ou do `updatedAt` da story quando nunca iterou);
    filtra pelo threshold e ordena desc. Threshold via nova env
    `DASHBOARD_STALE_MINUTES` (default 30) em `shared/config/config.ts`.
  - **`cost`**: para cada story ativa reusa `Orchestrator.computeStoryMetrics`
    (sem alterar a assinatura) e agrega; `derivedTaskRate`/`okIterationRate` são
    **média ponderada por `iterationCount`**.
- **Sanitização obrigatória:** os `select` do service carregam apenas o mínimo
  (id/key/title/execState/updatedAt/type/títulos de coluna) e **nunca** tocam
  `aiProject`, env, credenciais ou transcript. Há um teste de não-vazamento que
  serializa o objeto e assere que o path do repo-alvo não aparece.
- **Web** (`apps/web/src/features/dashboard/`): `apiClient.getFleetDashboard`,
  `queryKeys.dashboard`, hook `useFleetDashboard` (polling ~15s) e
  `FleetDashboardPanel` (reusa o padrão visual do `LoopMetricsPanel`).

## Consequências

- **Positivas:** observabilidade imediata da frota (counts/stale/cost) reusando o
  pipeline existente (`computeStoryMetrics`, request→hook→painel), sem migration e
  sem novos contratos por-story. Threshold de staleness é configurável por env.
- **Negativas / riscos:** o `cost` chama `computeStoryMetrics` uma vez por story
  ativa (N queries) — aceitável para o volume atual da frota; se crescer, dá para
  batch/caching depois. O risco de vazamento é mitigado por `select` mínimo +
  teste de não-vazamento.
- **Invariantes preservados:** o dashboard é **read-only** — não move epic
  (invariante 2) nem cria task fora de Backlog/To Do (invariante 3); só lê. Sem
  Redis (invariante 7). Endpoint e contratos novos, aditivos: nada quebra
  (retrocompat total).
