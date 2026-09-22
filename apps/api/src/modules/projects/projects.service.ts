import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Project as ProjectRow } from '@prisma/client';
import type { Project as ProjectDto } from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import type { CreateProjectDto } from './projects.schema';

/**
 * Serviço de Projects (repo git clonado & gerenciado). EP-PROJECT / US-PROJ1.
 *
 * Entidade ortogonal à hierarquia Epic→Story→Task (associada ao Board). Nesta
 * story só o CRUD básico existe; o clone/sync gerenciado é a US-PROJ2.
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Projeção pública: NUNCA expõe `credentialRef` (segredo) nem `localPath`
   * (layout do FS do servidor). Datas viram ISO string (contrato com a web).
   */
  private toDto(row: ProjectRow): ProjectDto {
    return {
      id: row.id,
      name: row.name,
      repoUrl: row.repoUrl,
      defaultBranch: row.defaultBranch,
      authKind: row.authKind,
      cloneState: row.cloneState,
      lastError: row.lastError,
      lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
      // US-F1.3 — estado do build do grafo de conhecimento (graphify).
      graphState: row.graphState,
      graphBuiltAt: row.graphBuiltAt ? row.graphBuiltAt.toISOString() : null,
      graphLastError: row.graphLastError,
      tenantId: row.tenantId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async findAll(): Promise<ProjectDto[]> {
    const rows = await this.prisma.project.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDto(r));
  }

  async findOne(id: string): Promise<ProjectDto> {
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Project ${id} não encontrado`);
    return this.toDto(row);
  }

  /** Cria o Project em estado `pending` (clone é feito depois, US-PROJ2). */
  async create(dto: CreateProjectDto): Promise<ProjectDto> {
    const data: Prisma.ProjectCreateInput = {
      name: dto.name,
      repoUrl: dto.repoUrl,
      defaultBranch: dto.defaultBranch ?? null,
      authKind: dto.authKind ?? 'none',
      credentialRef: dto.credentialRef ?? null,
      tenantId: dto.tenantId ?? null,
      // cloneState default 'pending' via schema.
    };
    const row = await this.prisma.project.create({ data });
    return this.toDto(row);
  }

  async remove(id: string): Promise<{ id: string }> {
    try {
      await this.prisma.project.delete({ where: { id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException(`Project ${id} não encontrado`);
      }
      throw err;
    }
    return { id };
  }
}
