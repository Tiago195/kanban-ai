import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectWorkspaceService } from './project-workspace.service';
import { ProjectExplorerService } from './project-explorer.service';
import { ProjectGraphService } from './project-graph.service';
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import {
  createProjectSchema,
  projectGraphFileCardsQuerySchema,
  projectGraphProjectionQuerySchema,
  projectMemoryReadQuerySchema,
  projectWikiArticleQuerySchema,
  type CreateProjectDto,
  type ProjectGraphFileCardsQueryDto,
  type ProjectGraphProjectionQueryDto,
  type ProjectWikiArticleQueryDto,
} from './projects.schema';

@Controller()
export class ProjectsController {
  private readonly logger = new Logger(ProjectsController.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly workspace: ProjectWorkspaceService,
    private readonly explorer: ProjectExplorerService,
    private readonly graph: ProjectGraphService,
  ) {}

  @Get('projects')
  findAll() {
    return this.projects.findAll();
  }

  /**
   * US-UX.4 — estado do conhecimento de TODOS os Projects numa tacada
   * (`ProjectKnowledgeSummary[]`): grafo (nós/arestas), wiki (artigos) e
   * memória (aprendizados/contestados) por projeto — a lista de cards faz UMA
   * requisição, não N×4. Declarada ANTES de `projects/:id` (senão "summary"
   * casaria como id). Cada faceta é throwless: falha vira `{ok:false}` visível.
   */
  @Get('projects/summary')
  async knowledgeSummary() {
    const projects = await this.projects.findAll();
    // ponytail: N×3 chamadas paralelas ao wrapper (leituras in-process de ms
    // cada); se a lista de Projects crescer, mover a agregação para uma rota
    // /summary do próprio wrapper.
    return Promise.all(projects.map((p) => this.graph.knowledgeSummary(p.id)));
  }

  @Get('projects/:id')
  findOne(@Param('id') id: string) {
    return this.projects.findOne(id);
  }

  @Post('projects')
  @UsePipes(new ZodValidationPipe(createProjectSchema))
  async create(@Body() dto: CreateProjectDto) {
    const project = await this.projects.create(dto);
    // US-PROJ2: dispara o clone de forma ASSÍNCRONA (fire-and-forget). A resposta
    // HTTP não bloqueia — o estado (`cloneState`) é observável via evento WS
    // `project.clone_state` e por `GET /projects/:id`.
    void this.workspace.ensureCloned(project.id).catch((err) => {
      this.logger.warn(
        `ensureCloned falhou para Project ${project.id}: ${(err as Error)?.message ?? err}`,
      );
    });
    return project;
  }

  @Post('projects/:id/sync')
  sync(@Param('id') id: string) {
    return this.workspace.sync(id).then(() => this.projects.findOne(id));
  }

  // ── US-PROJ7 — Project Explorer (SÓ leitura) ──────────────────────────────

  /** Índice da memória (colmeia) do Project → `MemoryNeuronSummary[]`. */
  @Get('projects/:id/memory')
  listMemory(@Param('id') id: string) {
    return this.explorer.listMemory(id);
  }

  /** Detalhe (markdown completo + headCommit) de um neurônio → `MemoryNeuronDetail`. */
  @Get('projects/:id/memory/read')
  readMemory(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(projectMemoryReadQuerySchema)) query: { path: string },
  ) {
    return this.explorer.readMemory(id, query.path);
  }

  /**
   * US-F4.1 — projeção do grafo de conhecimento → `GraphProjectionResponse`.
   * O corte é decidido no servidor (overview/focus/community/search); Project
   * inexistente → 404; grafo não-`ready`/sidecar fora → `{ok:false}` tipado
   * (falha visível para a UI da US-F4.2, nunca 500 opaco).
   */
  @Get('projects/:id/graph')
  async graphProjection(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(projectGraphProjectionQuerySchema))
    query: ProjectGraphProjectionQueryDto,
  ) {
    await this.projects.findOne(id); // 404 se o Project não existe
    return this.graph.projection(id, query);
  }

  /**
   * US-F4.3 — nó → arquivo → card(s): cards dos boards deste Project que
   * tocaram o arquivo (`AffectedFlow.files` + `Iteration.handoffFiles`) →
   * `GraphFileCardsResponse`. `cards: []` é resposta válida (estado vazio
   * honesto na UI — nunca 404 para "arquivo sem card").
   */
  @Get('projects/:id/graph/file-cards')
  graphFileCards(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(projectGraphFileCardsQuerySchema))
    query: ProjectGraphFileCardsQueryDto,
  ) {
    return this.explorer.fileCards(id, query.file);
  }

  /**
   * US-UX.3 — painel da memória → `ProjectLearningResponse`: o que o
   * `graphify reflect` aprendeu (vereditos por nó com proveniência e sinal
   * `stale`, becos sem saída, correções). Reflect nunca rodado →
   * `generated: false` (estado vazio honesto, nunca 404); sidecar fora /
   * integração desligada → `{ok:false}` com erro legível.
   */
  @Get('projects/:id/learning')
  async learning(@Param('id') id: string) {
    await this.projects.findOne(id); // 404 se o Project não existe
    return this.graph.learning(id);
  }

  /**
   * US-F5.4 — índice da Wiki do grafo → `ProjectWikiIndexResponse`. Wiki
   * ainda não gerada → `generated: false` (estado vazio honesto, nunca 404);
   * sidecar fora/integração desligada → `{ok:false}` com erro legível.
   */
  @Get('projects/:id/wiki')
  async wikiIndex(@Param('id') id: string) {
    await this.projects.findOne(id); // 404 se o Project não existe
    return this.graph.wikiList(id);
  }

  /**
   * US-F5.4 — leitura de um artigo da Wiki → `ProjectWikiArticleResponse`.
   * `slug` validado pelo zod (segmento único — traversal morre aqui com 400)
   * e revalidado no wrapper (path resolvido dentro do diretório da wiki).
   */
  @Get('projects/:id/wiki/article')
  async wikiArticle(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(projectWikiArticleQuerySchema))
    query: ProjectWikiArticleQueryDto,
  ) {
    await this.projects.findOne(id); // 404 se o Project não existe
    return this.graph.wikiArticle(id, query.slug);
  }

  /** Metadados do repositório clonado → `ProjectRepoInfo`. */
  @Get('projects/:id/repo-info')
  repoInfo(@Param('id') id: string) {
    return this.explorer.repoInfo(id);
  }

  @Delete('projects/:id')
  async remove(@Param('id') id: string) {
    const result = await this.projects.remove(id);
    // Limpa o clone gerenciado do FS (best-effort; a linha já foi removida).
    await this.workspace.remove(id).catch((err) => {
      this.logger.warn(
        `remove do clone falhou para Project ${id}: ${(err as Error)?.message ?? err}`,
      );
    });
    // US-F1.3: limpa também o diretório do grafo no volume do sidecar
    // (~/.graphify/projects/<id>), best-effort — apagar o Project é apagar o
    // diretório dele (ADR-0041 §2; não existe global_remove).
    await this.graph.remove(id);
    return result;
  }
}
