import { execFile } from 'node:child_process';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  GraphProjection,
  GraphProjectionResponse,
  ProjectGraphState,
  ProjectKnowledgeSummary,
  ProjectLearning,
  ProjectLearningResponse,
  ProjectWikiArticle,
  ProjectWikiArticleResponse,
  ProjectWikiIndex,
  ProjectWikiIndexResponse,
} from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';

/**
 * EP-F1 / US-F1.3 — Build do grafo de conhecimento (graphify) por Project.
 *
 * Cliente do wrapper HTTP de build do sidecar (`docker/graphify_build_server.py`,
 * US-F1.6, ADR-0041): quando o clone de um Project fica `ready`, o
 * `ProjectWorkspaceService` dispara `build()` em background, que chama
 * `POST /build` (síncrono — a resposta só chega com o graph.json no lugar) e
 * reflete o ciclo em `Project.graphState` (`building → ready|failed`), gravando
 * `graphBuiltAt` ou `graphLastError` e emitindo `ProjectGraphStateEvent` no WS.
 *
 * Postura DEFENSIVA (mesmo espírito do bootstrap de memória do orchestrator):
 *  - `build()` NUNCA lança — falha de build jamais derruba o clone/fluxo de
 *    Project; o pior caso é `graphState='failed'` + `graphLastError` legível;
 *  - sem `GRAPHIFY_API_KEY` a integração fica DESLIGADA (skip com log de debug,
 *    `graphState` permanece `pending`) — retrocompatível com ambientes sem o
 *    sidecar;
 *  - CORRIDA do delete: o build leva ~18s e o Project pode ser DELETADO no
 *    meio. Toda transição de estado tolera a linha ausente (update vira no-op,
 *    sem evento), e ao fim do build re-checamos se o Project ainda existe — se
 *    sumiu, o grafo recém-escrito é removido (best-effort) para não deixar
 *    diretório órfão no volume do sidecar.
 *
 * O DELETE de Project chama `remove()` (best-effort, mesmo padrão do
 * `ProjectWorkspaceService.remove` do clone): o grafo vive no volume do sidecar
 * (`~/.graphify/projects/<projectId>`), inacessível pelo FS da API — a remoção
 * é delegada ao `POST /remove` do wrapper.
 */
/**
 * US-F2.7 — um hit do `POST /affected` (US-F1.6): nó afetado pela mudança no
 * seed, com a relação, o ARQUIVO e a linha do call site (`via_*` do
 * `AffectedHit` do graphify — o ponto de uso, não a definição do nó).
 */
export interface AffectedHitDto {
  nodeId: string;
  label: string;
  depth: number;
  relation: string;
  file: string | null;
  location: string | null;
}

@Injectable()
export class ProjectGraphService {
  private readonly logger = new Logger(ProjectGraphService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly realtime: RealtimeService,
  ) {}

  /** Integração ligada = `GRAPHIFY_API_KEY` presente (mesma chave do sidecar). */
  private get enabled(): boolean {
    return this.config.graphify.apiKey.length > 0;
  }

  // ── US-F1.5 — rebuild incremental pós-iteração (coalescido por Project) ──

  /**
   * US-F1.5 — pedidos de rebuild acumulados por Project ENQUANTO um build
   * daquele Project está em voo: uma rajada de iterações vira UM build (união
   * dos arquivos), não N chamadas HTTP de ~9s enfileiradas no sidecar.
   */
  private readonly pendingRebuild = new Map<string, Set<string>>();
  /** Build em voo por Project (chave do coalescing). */
  private readonly rebuildInFlight = new Map<string, Promise<void>>();
  /** Contador de rebuilds incrementais por Project, para o `force` periódico. */
  private readonly incrementalCount = new Map<string, number>();
  /**
   * US-F1.5 — janela de debounce ANTES de cada build do drenador: pedidos que
   * chegam quase-juntos (rajada de iterações, cujo `git diff` termina com ms de
   * diferença) caem TODOS no mesmo Set e viram UM build. 500ms é invisível
   * numa operação de ~9s que já roda fora do caminho crítico. Campo (não
   * const) para as specs zerarem e ficarem rápidas.
   */
  rebuildDebounceMs = 500;

  /**
   * US-F1.5 — flag do rebuild incremental pós-iteração. Exige a integração
   * ligada (`GRAPHIFY_API_KEY`) E a env nova `GRAPHIFY_INCREMENTAL_REBUILD`
   * (default OFF — strangler-fig do EP-F1: nada muda até alguém ligar).
   */
  get incrementalEnabled(): boolean {
    return this.enabled && this.config.graphify.incrementalRebuildEnabled;
  }

  /**
   * US-F1.5 — dispara o rebuild incremental do grafo ao fim de uma iteração do
   * loop. NUNCA lança e NUNCA bloqueia o caminho crítico: o orchestrator chama
   * com `void` (fire-and-forget); a promise retornada só existe para as specs
   * e para observabilidade — ela resolve quando a fila do Project drena.
   *
   * A lista de arquivos vem de `git diff --name-only` no `cwd` da iteração
   * (não do unified diff textual, que é truncado em 100KB e escapa paths não
   * ASCII/com espaço nos headers): `-z` separa por NUL (path com espaço sai
   * literal) e `--no-renames` decompõe rename em delete+add — exatamente o
   * contrato do wrapper, onde path inexistente no clone = remover os nós dele.
   */
  async rebuildFromIteration(
    projectId: string,
    cwd: string,
    baseline?: string | null,
  ): Promise<void> {
    if (!this.incrementalEnabled) return;
    try {
      const files = await this.collectChangedFiles(cwd, baseline ?? null);
      if (files.length === 0) return;
      await this.scheduleRebuild(projectId, files);
    } catch (err) {
      // Best-effort absoluto (mesmo espírito dos learnings do orchestrator).
      this.logger.warn(
        `US-F1.5: rebuild incremental do grafo de ${projectId} falhou: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * US-F1.5 — coalescing por Project: acumula `files` no pending e garante UM
   * drenador em voo. Chamadas na mesma rajada (mesmo tick ou durante um build
   * de ~9s) são unidas e viram um único build ao final. Resolve quando a fila
   * do Project esvazia. Público para as specs; o orchestrator usa
   * `rebuildFromIteration`.
   */
  scheduleRebuild(projectId: string, files: string[]): Promise<void> {
    const pending = this.pendingRebuild.get(projectId);
    if (pending) {
      for (const f of files) pending.add(f);
    } else {
      this.pendingRebuild.set(projectId, new Set(files));
    }
    const inFlight = this.rebuildInFlight.get(projectId);
    if (inFlight) return inFlight;
    const flight = this.drainRebuilds(projectId).finally(() => {
      this.rebuildInFlight.delete(projectId);
    });
    this.rebuildInFlight.set(projectId, flight);
    return flight;
  }

  /** US-F1.5 — drena o pending do Project, um build por vez, até esvaziar. */
  private async drainRebuilds(projectId: string): Promise<void> {
    for (;;) {
      // Debounce: deixa a rajada inteira aterrissar no Set antes de ler
      // (N pedidos quase-juntos = 1 build, não N).
      await new Promise((resolve) => setTimeout(resolve, this.rebuildDebounceMs));
      const pending = this.pendingRebuild.get(projectId);
      if (!pending || pending.size === 0) {
        this.pendingRebuild.delete(projectId);
        return;
      }
      this.pendingRebuild.delete(projectId);
      await this.rebuildOnce(projectId, [...pending]);
    }
  }

  /**
   * US-F1.5 — UM build no sidecar. Incremental (`files`) por padrão; a cada
   * `incrementalForceEvery` builds do MESMO Project, um build COMPLETO com
   * `force: true` — o incremental é lossy (o `_reconcile_existing_graph`
   * evicta nós cujo `source_file` é pacote externo; medido 3514 → 3510) e o
   * force restaura o corpus. Nunca lança.
   */
  private async rebuildOnce(projectId: string, files: string[]): Promise<void> {
    try {
      // Só re-buildamos grafo que EXISTE: sem build inicial (`ready`), um
      // merge incremental criaria um grafo só com os arquivos da iteração.
      const row = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { graphState: true },
      });
      if (row?.graphState !== 'ready') {
        this.logger.debug(
          `US-F1.5: rebuild incremental de ${projectId} pulado (graphState=${row?.graphState ?? 'ausente'}).`,
        );
        return;
      }
      const count = (this.incrementalCount.get(projectId) ?? 0) + 1;
      const forceFull = count >= Math.max(1, this.config.graphify.incrementalForceEvery);
      this.incrementalCount.set(projectId, forceFull ? 0 : count);
      // US-F2.3 — a colmeia (`.hive/`) já vive no clone (fonte da verdade):
      // não há mais espelho a sincronizar antes do build. Neurônios que mudam
      // entram no chunk incremental pelo próprio `persistLearning` (o
      // orchestrator agenda o path `.hive/…` escrito via `scheduleRebuild`).
      const result = await this.post(
        '/build',
        forceFull ? { projectId, force: true } : { projectId, files },
      );
      // Sem transição de graphState/evento WS aqui: um rebuild por iteração
      // viraria spam de `building→ready`; só refrescamos o timestamp.
      await this.prisma.project
        .update({ where: { id: projectId }, data: { graphBuiltAt: new Date() } })
        .catch(() => undefined); // Project deletado no meio → no-op
      this.logger.log(
        `US-F1.5: grafo de ${projectId} atualizado (${forceFull ? 'force FULL' : `incremental, ${files.length} arquivo(s)`}): ` +
          `${result.nodes} nós, ${result.edges} arestas em ${result.durationMs}ms.`,
      );
      // US-F5.4 — grafo mudou → wiki muda junto (best-effort, nunca lança).
      await this.wikiGenerate(projectId);
    } catch (err) {
      this.logger.warn(
        `US-F1.5: rebuild do grafo de ${projectId} falhou: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * US-F1.5 — lista repo-relativa dos arquivos tocados desde o `baseline`.
   * Delegado à função exportada (reusada pela escrita de learnings, US-F2.6).
   */
  private collectChangedFiles(cwd: string, baseline: string | null): Promise<string[]> {
    return collectChangedFiles(cwd, baseline);
  }

  /**
   * Constrói (ou reconstrói) o grafo do Project no sidecar. Fire-and-forget
   * seguro: NUNCA lança. Ciclo: `building` → `ready` (com `graphBuiltAt`) |
   * `failed` (com `graphLastError` legível).
   */
  async build(projectId: string): Promise<void> {
    if (!this.enabled) {
      this.logger.debug(
        `graphify desligado (GRAPHIFY_API_KEY ausente): build do grafo de ${projectId} pulado.`,
      );
      return;
    }
    // Se o Project já não existe (deletado antes do build começar), no-op.
    if (!(await this.transition(projectId, 'building'))) return;

    try {
      // US-F2.3 — a colmeia (`.hive/`) já está no clone; o scan completo a
      // indexa direto (re-incluída pelo `.graphifyignore`, US-F2.4).
      const result = await this.post('/build', { projectId });
      // CORRIDA: o Project pode ter sido deletado durante os ~18s do build. O
      // sidecar acabou de reescrever o grafo — se a linha sumiu, limpamos o
      // diretório recém-criado (best-effort) e NÃO gravamos/emitimos nada.
      const alive = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true },
      });
      if (!alive) {
        this.logger.debug(
          `Project ${projectId} deletado durante o build do grafo; removendo grafo órfão.`,
        );
        await this.remove(projectId);
        return;
      }
      await this.prisma.project.update({
        where: { id: projectId },
        data: { graphState: 'ready', graphBuiltAt: new Date(), graphLastError: null },
      });
      this.emit(projectId, 'ready');
      this.logger.log(
        `Grafo do Project ${projectId} construído: ${result.nodes} nós, ` +
          `${result.edges} arestas em ${result.durationMs}ms.`,
      );
      // US-F5.4 — a wiki deriva do grafo: regenera após o build. Throwless
      // por contrato (wikiGenerate nunca lança) — o `ready` acima já foi
      // persistido/emitido, então falha na wiki não toca o estado do grafo.
      await this.wikiGenerate(projectId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(projectId, message);
    }
  }

  /**
   * Remove o diretório do grafo no volume do sidecar
   * (`~/.graphify/projects/<projectId>`) via `POST /remove`. Best-effort e
   * idempotente — chamado pelo `DELETE /projects/:id` e pela limpeza da corrida
   * de delete-durante-build. Nunca lança.
   */
  async remove(projectId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.post('/remove', { projectId });
      this.logger.log(`Project ${projectId}: diretório do grafo removido no sidecar.`);
    } catch (err) {
      this.logger.warn(
        `remove do grafo falhou para Project ${projectId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * US-F5.2 — dispara o `graphify reflect` do Project no sidecar
   * (`POST /reflect` do wrapper): agrega os memory docs de
   * `<clone>/.hive/memory/*.md` em `reflections/LESSONS.md` + overlay
   * `.graphify_learning.json` ao lado do graph.json. O wrapper roda com
   * `--if-stale` (no-op barato quando o LESSONS.md já é mais novo que todas
   * as entradas) e pula quando um rebuild do MESMO Project está em voo
   * (flock). Chamado pelo orchestrator (fire-and-forget) depois de gravar
   * learnings. Best-effort e throwless: memória jamais derruba o loop —
   * qualquer falha vira warn.
   */
  async reflect(projectId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const result = await this.post<{ skipped?: string | null; durationMs?: number }>(
        '/reflect',
        { projectId },
        // Leitura+agregação in-container, sem LLM — mesmo regime curto do
        // /affected, nunca o timeout de build.
        this.config.graphify.queryTimeoutMs,
      );
      this.logger.debug(
        `US-F5.2: reflect do Project ${projectId} ` +
          (result.skipped ? `pulado (${result.skipped}).` : `ok em ${result.durationMs}ms.`),
      );
    } catch (err) {
      this.logger.warn(
        `US-F5.2: reflect do grafo de ${projectId} falhou: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * US-UX.3 — painel da memória (`GET /projects/:id/learning`): o que o
   * `graphify reflect` (US-F5.2) já grava em disco e nenhuma UI via — nós
   * preferred/tentative/contested com veredito, placar, proveniência e
   * `stale` (código mudou desde o aprendizado), + becos sem saída e
   * correções. Throwless (mesma filosofia da wiki): sidecar fora/integração
   * desligada viram `{ok:false}` legível; reflect nunca rodado NÃO é erro —
   * o wrapper responde `generated: false` (estado vazio honesto na UI).
   */
  async learning(projectId: string): Promise<ProjectLearningResponse> {
    if (!this.enabled) {
      return { ok: false, error: 'graphify desligado (GRAPHIFY_API_KEY ausente)' };
    }
    try {
      return await this.post<ProjectLearning>(
        '/learning',
        { projectId },
        // Leitura pura de artefatos no wrapper — regime curto do queryTimeoutMs.
        this.config.graphify.queryTimeoutMs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const firstLine = message.split('\n')[0]?.trim() || message.trim();
      this.logger.warn(`US-UX.3: leitura do learning de ${projectId} falhou: ${firstLine}`);
      return { ok: false, error: firstLine };
    }
  }

  /**
   * US-F5.4 — (re)gera a wiki do Project no sidecar (`POST /wiki` do
   * wrapper): index.md + um artigo por comunidade + artigos de god node,
   * derivados do graph.json recém-construído. Chamada após cada build
   * completo e após cada rebuild incremental (a wiki deriva do grafo —
   * grafo novo, wiki nova). Best-effort ABSOLUTO: falha na wiki JAMAIS
   * derruba o build do grafo nem o loop — qualquer erro vira warn.
   */
  async wikiGenerate(projectId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const result = await this.post<{ articles?: number; skipped?: string | null }>(
        '/wiki',
        { projectId },
        // Computação pura sobre o grafo no wrapper (medido: ~14ms num grafo
        // de 84 nós) — regime curto do queryTimeoutMs, nunca o de build.
        this.config.graphify.queryTimeoutMs,
      );
      this.logger.debug(
        `US-F5.4: wiki do Project ${projectId} ` +
          (result.skipped
            ? `pulada (${result.skipped}).`
            : `gerada (${result.articles ?? 0} artigos).`),
      );
    } catch (err) {
      this.logger.warn(
        `US-F5.4: geração da wiki de ${projectId} falhou: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * US-F5.4 — índice da wiki (`GET /projects/:id/wiki`). Throwless (mesma
   * filosofia da projeção F4.1): sidecar fora/integração desligada viram
   * `{ok:false}` com erro legível; wiki ainda não gerada NÃO é erro — o
   * wrapper responde `generated: false` (estado vazio honesto na UI).
   */
  async wikiList(projectId: string): Promise<ProjectWikiIndexResponse> {
    if (!this.enabled) {
      return { ok: false, error: 'graphify desligado (GRAPHIFY_API_KEY ausente)' };
    }
    try {
      return await this.post<ProjectWikiIndex>(
        '/wiki-list',
        { projectId },
        this.config.graphify.queryTimeoutMs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const firstLine = message.split('\n')[0]?.trim() || message.trim();
      this.logger.warn(`US-F5.4: listagem da wiki de ${projectId} falhou: ${firstLine}`);
      return { ok: false, error: firstLine };
    }
  }

  /**
   * US-F5.4 — leitura de UM artigo (`GET /projects/:id/wiki/article`).
   * O `slug` já chega validado pelo zod do controller (segmento único, sem
   * `/`/`\`/`..`) e o wrapper revalida + confere o path resolvido dentro do
   * diretório da wiki — o caller nunca escolhe caminho livre. Artigo
   * inexistente/slug rejeitado viram `{ok:false}` legível (não 500).
   */
  async wikiArticle(projectId: string, slug: string): Promise<ProjectWikiArticleResponse> {
    if (!this.enabled) {
      return { ok: false, error: 'graphify desligado (GRAPHIFY_API_KEY ausente)' };
    }
    try {
      return await this.post<ProjectWikiArticle>(
        '/wiki-article',
        { projectId, slug },
        this.config.graphify.queryTimeoutMs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const firstLine = message.split('\n')[0]?.trim() || message.trim();
      this.logger.warn(`US-F5.4: leitura do artigo "${slug}" de ${projectId} falhou: ${firstLine}`);
      return { ok: false, error: firstLine };
    }
  }

  /**
   * US-F2.7 — blast radius de UM arquivo/símbolo via `POST /affected` do
   * wrapper (US-F1.6). Best-effort e throwless (mesmo contrato do
   * `ProjectGraphQueryService`): sidecar fora, grafo inexistente ou wrapper em
   * erro viram `{ ok: false, error }` legível — quem chama decide como
   * sinalizar. Seed que não resolve para um nó único NÃO é erro: o wrapper
   * responde `seed: null, hits: []` (arquivo fora do grafo — css, docs…).
   */
  async affected(
    projectId: string,
    seed: string,
    depth: number,
  ): Promise<{ ok: true; hits: AffectedHitDto[] } | { ok: false; error: string }> {
    if (!this.enabled) {
      return { ok: false, error: 'graphify desligado (GRAPHIFY_API_KEY ausente)' };
    }
    try {
      const result = await this.post(
        '/affected',
        { projectId, seed, depth },
        // Leitura in-process do graph.json — rápida; teto curto do queryTimeoutMs
        // (US-F1.4), nunca os 30min do timeout de build.
        this.config.graphify.queryTimeoutMs,
      );
      return { ok: true, hits: result.hits ?? [] };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  }

  /**
   * US-F4.1 — projeção do grafo para a UI (`GET /projects/:id/graph`), com o
   * corte decidido no SERVIDOR (rota `POST /projection` do wrapper, que lê o
   * graph.json ESTRUTURADO — nada de regex sobre o texto do MCP). Throwless
   * (mesma filosofia das F2.5/F2.10 — falha visível, não mascarada): grafo
   * não-`ready`, sidecar fora ou integração desligada viram `{ok:false}`
   * tipado com `graphState` e erro legível.
   */
  async projection(
    projectId: string,
    query: {
      focus?: string;
      community?: number;
      search?: string;
      depth?: number;
      limit?: number;
    } = {},
  ): Promise<GraphProjectionResponse> {
    if (!this.enabled) {
      return {
        ok: false,
        graphState: 'pending',
        error: 'graphify desligado (GRAPHIFY_API_KEY ausente)',
      };
    }
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { graphState: true, graphLastError: true },
    });
    if (!row) {
      // O controller já 404-a antes (findOne); guard defensivo para chamadas diretas.
      return { ok: false, graphState: 'pending', error: `Project ${projectId} não encontrado` };
    }
    const state = row.graphState as ProjectGraphState;
    if (state !== 'ready') {
      const error =
        state === 'failed'
          ? `build do grafo falhou: ${row.graphLastError ?? 'erro desconhecido'}`
          : state === 'building'
            ? 'grafo em construção — tente novamente em instantes'
            : 'grafo ainda não construído';
      return { ok: false, graphState: state, error };
    }
    try {
      // Leitura in-process do graph.json no wrapper — teto curto do
      // queryTimeoutMs (mesmo regime do /affected), nunca o timeout de build.
      return await this.post<GraphProjection>(
        '/projection',
        { projectId, ...query },
        this.config.graphify.queryTimeoutMs,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const firstLine = message.split('\n')[0]?.trim() || message.trim();
      this.logger.warn(`US-F4.1: projeção do grafo de ${projectId} falhou: ${firstLine}`);
      return { ok: false, graphState: 'ready', error: firstLine };
    }
  }


  /**
   * US-UX.4 — resumo do estado do conhecimento de UM Project (card da lista):
   * grafo (nós/arestas), wiki (artigos) e memória (aprendizados/contestados)
   * numa consulta só. Reusa os clientes throwless existentes (projection/
   * wikiList/learning) em paralelo — cada faceta falha SOZINHA e vira
   * `{ok:false}` legível no resumo, nunca 500.
   */
  async knowledgeSummary(projectId: string): Promise<ProjectKnowledgeSummary> {
    const [graph, wiki, learning] = await Promise.all([
      this.projection(projectId, {}),
      this.wikiList(projectId),
      this.learning(projectId),
    ]);
    return summarizeKnowledge(projectId, graph, wiki, learning);
  }

  // ── internos ─────────────────────────────────────────────────────────────

  /**
   * `POST <buildUrl><path>` autenticado. Lança `Error` com mensagem LEGÍVEL
   * (1 linha, extraída do `error` do wrapper quando houver) em qualquer status
   * não-2xx, timeout ou falha de conexão.
   */
  private async post<
    // US-F4.1: genérico para o `/projection` tipar a resposta estruturada;
    // o default preserva a forma histórica (`/build`/`/affected`).
    T = { nodes?: number; edges?: number; durationMs?: number; hits?: AffectedHitDto[] },
  >(
    path:
      | '/build'
      | '/remove'
      | '/affected'
      | '/projection'
      | '/reflect'
      // US-UX.3: painel da memória (overlay do reflect + becos sem saída).
      | '/learning'
      // US-F5.4: gerar / listar / ler a wiki derivada do grafo.
      | '/wiki'
      | '/wiki-list'
      | '/wiki-article',
    // US-F1.5: `files` (repo-relativos) = rebuild incremental; `force` desarma
    // o shrink-guard e restaura o corpus no build completo periódico.
    // US-F2.7: `seed`+`depth` = blast radius (`/affected`).
    // US-F4.1: `focus`/`community`/`search`/`limit` (+`depth`) = projeção.
    body: {
      projectId: string;
      files?: string[];
      force?: boolean;
      seed?: string;
      depth?: number;
      focus?: string;
      community?: number;
      search?: string;
      limit?: number;
      // US-F5.4: `slug` = artigo da wiki (`/wiki-article`).
      slug?: string;
    },
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.config.graphify.buildUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.graphify.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.config.graphify.buildTimeoutMs),
      });
    } catch (err) {
      // Timeout do AbortSignal ou sidecar fora do ar — mensagem curta e legível.
      const cause = err instanceof Error ? (err.name === 'TimeoutError' ? 'timeout' : err.message) : String(err);
      throw new Error(`graphify inacessível em ${url}: ${cause}`);
    }
    const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
    if (!res.ok || payload.ok !== true) {
      throw new Error(`graphify ${path} HTTP ${res.status}: ${payload.error ?? 'erro desconhecido'}`);
    }
    return payload;
  }

  /**
   * Persiste `graphState` e emite o evento. Retorna `false` (sem lançar) quando
   * o Project não existe mais — o chamador desiste em silêncio.
   */
  private async transition(projectId: string, state: ProjectGraphState): Promise<boolean> {
    try {
      await this.prisma.project.update({ where: { id: projectId }, data: { graphState: state } });
    } catch {
      // P2025 (linha sumiu) ou banco fora — nunca propaga (fluxo é best-effort).
      this.logger.debug(`transition(${projectId}, ${state}) sem efeito: Project ausente.`);
      return false;
    }
    this.emit(projectId, state);
    return true;
  }

  /** Persiste `failed` + `graphLastError` legível (tolerante a linha ausente). */
  private async markFailed(projectId: string, message: string): Promise<void> {
    const firstLine = message.split('\n')[0]?.trim() || message.trim();
    try {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { graphState: 'failed', graphLastError: firstLine },
      });
    } catch {
      this.logger.debug(`markFailed(${projectId}) sem efeito: Project ausente.`);
      return;
    }
    this.emit(projectId, 'failed', firstLine);
    this.logger.warn(`Build do grafo do Project ${projectId} falhou: ${firstLine}`);
  }

  /** Emite o `ProjectGraphStateEvent` tipado no WebSocket. */
  private emit(projectId: string, state: ProjectGraphState, error?: string): void {
    this.realtime.broadcast({
      type: 'project.graph_state',
      projectId,
      state,
      ...(error ? { error } : {}),
    });
  }
}

/**
 * US-F1.5 (extraída na US-F2.6 para reuso) — lista repo-relativa dos arquivos
 * tocados desde o `baseline` (tree-hash do início da iteração; sem baseline,
 * cai em `HEAD`, o mesmo fallback do `captureDiff` do orchestrator). `git add
 * -A -N` registra intenção para arquivos NOVOS aparecerem; `--no-renames`
 * decompõe rename em delete+add; `-z` devolve paths NUL-separados sem quoting
 * (espaço/UTF-8 saem literais). Erros de git viram lista vazia (best-effort).
 */
export async function collectChangedFiles(
  cwd: string,
  baseline: string | null,
): Promise<string[]> {
  if (!cwd) return [];
  const run = (args: string[]): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 },
        (error, stdout) => resolve(error ? '' : (stdout ?? '')),
      );
    });
  await run(['add', '-A', '-N']);
  const out = await run(['diff', '--name-only', '-z', '--no-renames', baseline ?? 'HEAD']);
  return out.split('\0').filter((p) => p.length > 0);
}

/**
 * US-UX.4 — projeção PURA das três respostas throwless para o resumo do card
 * (exportada para as specs: a agregação é testável offline, sem sidecar).
 * Só contagens saem daqui — a lista de nós/artigos fica no servidor.
 */
export function summarizeKnowledge(
  projectId: string,
  graph: GraphProjectionResponse,
  wiki: ProjectWikiIndexResponse,
  learning: ProjectLearningResponse,
): ProjectKnowledgeSummary {
  return {
    projectId,
    graph: graph.ok
      ? { ok: true, nodes: graph.totalNodes, edges: graph.totalEdges }
      : { ok: false, graphState: graph.graphState, error: graph.error },
    wiki: wiki.ok
      ? { ok: true, generated: wiki.generated, articles: wiki.articles.length }
      : { ok: false, error: wiki.error },
    memory: learning.ok
      ? {
          ok: true,
          generated: learning.generated,
          docs: learning.docs,
          learnings: learning.nodes.length,
          contested: learning.nodes.filter((n) => n.status === 'contested').length,
        }
      : { ok: false, error: learning.error },
  };
}
