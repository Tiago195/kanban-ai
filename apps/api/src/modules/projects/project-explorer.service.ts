import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import git from 'isomorphic-git';
import type {
  MemoryLockState,
  MemoryNeuronDetail,
  MemoryNeuronSummary,
  ProjectRepoInfo,
} from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from '../memory/memory-git.service';
import { detectModules } from '../memory/memory-bootstrap.service';

/**
 * Project Explorer — EP-PROJECT / US-PROJ7. Projeções **SÓ LEITURA** do repo
 * clonado e da memória-em-colmeia daquele Project (a "tela de valor" do épico):
 * o usuário vê o repositório que foi clonado e navega pelo que a AI já aprendeu.
 *
 * NÃO edita neurônios (escrita é do domínio do agent/loop, EP-79/80) e NUNCA
 * vaza campos internos de coordenação (`leaseId`/`activeBranch`/`baseCommit`/
 * `expiresAt`/`reviewQueued`/`lastSeenCommit`) — só projeta os campos do summary.
 *
 * **Namespacing por Project (dependência de US-PROJ4):** a projeção `MemoryIndex`
 * ainda NÃO tem coluna `projectId` — a colmeia é hoje GLOBAL. Por isso este
 * serviço lista o índice GLOBAL. Quando o namespacing por `projectId` aterrissar
 * (US-PROJ4/§1.2 — os neurônios passam a viver sob `projects/<id>/…`), o filtro
 * por Project fica correto e deve ser aplicado aqui. Ver `listMemory`.
 */
@Injectable()
export class ProjectExplorerService {
  private readonly logger = new Logger(ProjectExplorerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly git: MemoryGitService,
  ) {}

  /** Garante que o Project existe (404 explícito) e devolve o `localPath` do clone. */
  private async projectLocalPath(projectId: string): Promise<{ localPath: string | null }> {
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, localPath: true },
    });
    if (!row) throw new NotFoundException(`Project ${projectId} não encontrado`);
    return { localPath: row.localPath };
  }

  /**
   * US-PROJ7(a) — lista os neurônios (índice) do Project. Response =
   * `MemoryNeuronSummary[]`, com `tags` DESSERIALIZADO de JSON string para
   * `string[]`.
   *
   * TODO(US-PROJ4): quando `MemoryIndex` for namespaceado por `projectId` (path
   * sob `projects/<id>/…`), filtrar por esse prefixo. Hoje a colmeia é GLOBAL —
   * a spec (§US-PROJ7 "Namespacing") permite entregar global primeiro.
   */
  async listMemory(projectId: string): Promise<MemoryNeuronSummary[]> {
    await this.projectLocalPath(projectId);
    const rows = await this.prisma.memoryIndex.findMany({
      // Projeta APENAS os campos do summary público — nunca leaseId/activeBranch/
      // baseCommit/expiresAt/reviewQueued/lastSeenCommit (coordenação interna).
      select: {
        path: true,
        title: true,
        tags: true,
        summary: true,
        lockState: true,
        holder: true,
        stale: true,
        archivedAt: true,
        updatedAt: true,
      },
      orderBy: [{ stale: 'asc' }, { path: 'asc' }],
    });
    return rows.map((r) => this.toSummary(r));
  }

  /**
   * US-PROJ7(a) — proxy tipado de `GET /memory/read`: junta o summary do índice
   * com o markdown completo + `headCommit` (mesma âncora do CAS). Retorna
   * `MemoryNeuronDetail`.
   */
  async readMemory(projectId: string, neuronPath: string): Promise<MemoryNeuronDetail> {
    await this.projectLocalPath(projectId);
    const [content, row] = await Promise.all([
      this.git.readNeuron(neuronPath),
      this.prisma.memoryIndex.findUnique({
        where: { path: neuronPath },
        select: {
          path: true,
          title: true,
          tags: true,
          summary: true,
          lockState: true,
          holder: true,
          stale: true,
          archivedAt: true,
          updatedAt: true,
        },
      }),
    ]);
    const headCommit = await this.git.resolveHead();
    const summary: MemoryNeuronSummary = row
      ? this.toSummary(row)
      : {
          path: neuronPath,
          title: '',
          tags: [],
          summary: '',
          lockState: 'FREE',
          holder: null,
          stale: false,
          archivedAt: null,
          updatedAt: new Date(0).toISOString(),
        };
    return { ...summary, content, headCommit };
  }

  /**
   * US-PROJ7(b) — `ProjectRepoInfo`: `cloneState`/`lastSyncedAt` da linha do
   * Project; `defaultBranch`/`headCommit` lidos do clone via `isomorphic-git`;
   * `modules` via `detectModules(localPath)`. Trata "ainda não clonado"
   * graciosamente → git fields `null`, `modules` `[]`.
   */
  async repoInfo(projectId: string): Promise<ProjectRepoInfo> {
    const row = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { cloneState: true, lastSyncedAt: true, localPath: true, defaultBranch: true },
    });
    if (!row) throw new NotFoundException(`Project ${projectId} não encontrado`);

    const localPath = row.localPath;
    const isCloned = Boolean(localPath) && fs.existsSync(path.join(localPath as string, '.git'));

    let defaultBranch: string | null = row.defaultBranch;
    let headCommit: string | null = null;
    let modules: string[] = [];

    if (isCloned && localPath) {
      try {
        defaultBranch =
          (await git.currentBranch({ fs, dir: localPath, fullname: false })) ??
          row.defaultBranch ??
          null;
        headCommit = await git.resolveRef({ fs, dir: localPath, ref: 'HEAD' });
      } catch (err) {
        this.logger.warn(
          `repoInfo(${projectId}): falha lendo git do clone: ${(err as Error)?.message ?? err}`,
        );
      }
      try {
        modules = detectModules(localPath).map((m) => m.module);
      } catch (err) {
        this.logger.warn(
          `repoInfo(${projectId}): falha detectando módulos: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    return {
      defaultBranch,
      headCommit,
      lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
      cloneState: row.cloneState,
      modules,
    };
  }

  /** Projeta uma linha do `MemoryIndex` no summary público (desserializa `tags`). */
  private toSummary(row: {
    path: string;
    title: string;
    tags: string;
    summary: string;
    lockState: string;
    holder: string | null;
    stale: boolean;
    archivedAt: Date | null;
    updatedAt: Date;
  }): MemoryNeuronSummary {
    return {
      path: row.path,
      title: row.title,
      tags: this.parseTags(row.tags),
      summary: row.summary,
      lockState: normalizeLockState(row.lockState),
      holder: row.holder,
      stale: row.stale,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** `tags` é persistido como JSON array string (SQLite-friendly). Desserializa defensivo. */
  private parseTags(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
      return [];
    } catch {
      return [];
    }
  }
}

/** Normaliza o `lockState` persistido (string) para a união fechada `MemoryLockState`. */
function normalizeLockState(raw: string): MemoryLockState {
  return raw === 'EDITING' || raw === 'REVIEW' ? raw : 'FREE';
}
