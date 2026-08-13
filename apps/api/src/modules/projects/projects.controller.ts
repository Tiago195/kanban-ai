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
import { ZodValidationPipe } from '../../shared/pipes/zod-validation.pipe';
import {
  createProjectSchema,
  projectMemoryReadQuerySchema,
  type CreateProjectDto,
} from './projects.schema';

@Controller()
export class ProjectsController {
  private readonly logger = new Logger(ProjectsController.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly workspace: ProjectWorkspaceService,
    private readonly explorer: ProjectExplorerService,
  ) {}

  @Get('projects')
  findAll() {
    return this.projects.findAll();
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
    return result;
  }
}
