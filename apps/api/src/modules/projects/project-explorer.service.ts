import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import git from 'isomorphic-git';
import type {
  GraphFileCard,
  GraphFileCardsResponse,
  MemoryNeuronDetail,
  MemoryNeuronSummary,
  ProjectRepoInfo,
} from '@kanban-ai/shared';
import { PrismaService } from '../../shared/db/prisma.service';
import {
  moduleFromNeuronPath,
  parseMemoryDoc,
  stripFrontmatter,
} from '../../shared/neuron-format';
import { detectModules } from './detect-modules';
import { ProjectHiveService } from './project-hive.service';

/**
 * Project Explorer — EP-PROJECT / US-PROJ7. Projeções **SÓ LEITURA** do repo
 * clonado e da colmeia daquele Project (a "tela de valor" do épico): o usuário
 * vê o repositório que foi clonado e navega pelo que a AI já aprendeu.
 *
 * NÃO edita neurônios (escrita é do canal `learnings` do loop, US-F2.6/F2.3).
 *
 * US-F2.3 — a ÚNICA fonte é a colmeia do clone (`<clone>/.hive/**.md`,
 * per-Project por construção). O fallback legado (índice Postgres global + git
 * da memória, US-F2.8) morreu junto com o substrato — e o model `MemoryIndex`
 * foi dropado do schema na US-F2.12: neurônio que não está no `.hive/` não
 * existe. Os campos de coordenação (lock/lease/stale) saíram do contrato —
 * arquivo simples não tem lease (ADR-0027, emenda US-F2.10).
 */
@Injectable()
export class ProjectExplorerService {
  private readonly logger = new Logger(ProjectExplorerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly hive: ProjectHiveService,
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
   * US-PROJ7(a) — lista os neurônios do Project (`MemoryNeuronSummary[]`),
   * lidos da colmeia do clone (`<clone>/.hive/**.md`). Colmeia ausente/vazia
   * → `[]` (Project novo ainda sem learnings — o neurônio nasce lazy na
   * primeira escrita, US-F2.9).
   */
  async listMemory(projectId: string): Promise<MemoryNeuronSummary[]> {
    await this.projectLocalPath(projectId);
    const files = this.hive.listHiveFiles(projectId).filter((p) => p.endsWith('.md'));
    const out: MemoryNeuronSummary[] = [];
    for (const rel of files) {
      const file = this.hive.readHiveFile(projectId, rel);
      if (file) out.push(hiveNeuronSummary(rel, file.content, file.mtime));
    }
    return out;
  }

  /**
   * US-PROJ7(a) — detalhe de um neurônio (`MemoryNeuronDetail`), lido de
   * `<clone>/.hive/<path>` (a leitura valida que o path não escapa do
   * `.hive/`). Inexistente → 404 explícito.
   */
  async readMemory(projectId: string, neuronPath: string): Promise<MemoryNeuronDetail> {
    await this.projectLocalPath(projectId);
    const file = this.hive.readHiveFile(projectId, neuronPath);
    if (!file) {
      throw new NotFoundException(`Neurônio ${neuronPath} não encontrado no Project ${projectId}`);
    }
    return { ...hiveNeuronSummary(neuronPath, file.content, file.mtime), content: file.content };
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

  /**
   * US-F4.3 — nó → arquivo → card(s): quais cards dos boards vinculados a este
   * Project tocaram `file` (o `sourceFile` repo-relativo do nó do grafo).
   *
   * Duas vias, ambas por MATCH EXATO de elemento de array (sem fuzzy —
   * `files`/`handoffFiles` são texto auto-declarado pela IA e podem conter
   * lixo; associação inventada é pior que nenhuma):
   *  - `AffectedFlow.files[]` (story): fluxos declarados pela IA + o derivado
   *    do blast radius (US-F2.7) — carregam nome semântico do fluxo;
   *  - `Iteration.handoffFiles` (task): o que cada iteração entregou.
   *
   * A única normalização é trim + prefixo `./` (dos dois lados). Dedupe por
   * card; stories/epics antes de tasks. `cards: []` é resultado VÁLIDO — a UI
   * mostra estado vazio honesto (a cobertura depende do board ter de fato
   * trabalhado o arquivo).
   */
  async fileCards(projectId: string, file: string): Promise<GraphFileCardsResponse> {
    await this.projectLocalPath(projectId); // 404 explícito se o Project não existe
    const normalized = file.trim().replace(/^\.\//, '');
    if (!normalized) return { file: normalized, cards: [] };

    const boards = await this.prisma.board.findMany({
      where: { projectId },
      select: { id: true },
    });
    const boardIds = boards.map((b) => b.id);
    if (boardIds.length === 0) return { file: normalized, cards: [] };

    // Aceita a variante com "./" gravada na coluna (texto livre da IA).
    const variants = [normalized, `./${normalized}`];
    const cardSelect = {
      id: true,
      boardId: true,
      key: true,
      type: true,
      title: true,
      parentId: true,
    } as const;

    const [flows, iterations] = await Promise.all([
      this.prisma.affectedFlow.findMany({
        where: { files: { hasSome: variants }, card: { boardId: { in: boardIds } } },
        select: { name: true, card: { select: cardSelect } },
      }),
      this.prisma.iteration.findMany({
        where: { handoffFiles: { hasSome: variants }, card: { boardId: { in: boardIds } } },
        select: { card: { select: cardSelect } },
      }),
    ]);

    const byId = new Map<string, GraphFileCard>();
    const upsert = (
      card: { id: string; boardId: string; key: string; type: string; title: string; parentId: string | null },
      via: GraphFileCard['via'][number],
      flowName?: string,
    ) => {
      const prev = byId.get(card.id) ?? {
        id: card.id,
        boardId: card.boardId,
        key: card.key,
        type: card.type as GraphFileCard['type'],
        title: card.title,
        parentId: card.parentId,
        via: [],
        flowNames: [],
      };
      if (!prev.via.includes(via)) prev.via.push(via);
      if (flowName && !prev.flowNames.includes(flowName)) prev.flowNames.push(flowName);
      byId.set(card.id, prev);
    };
    for (const flow of flows) upsert(flow.card, 'affected-flow', flow.name);
    for (const iteration of iterations) upsert(iteration.card, 'iteration');

    const typeRank: Record<string, number> = { epic: 0, story: 1, task: 2 };
    const cards = [...byId.values()].sort(
      (a, b) =>
        (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9) || a.key.localeCompare(b.key),
    );
    return { file: normalized, cards };
  }
}

/**
 * US-F2.8 → US-F5.1 — projeta um arquivo da colmeia no summary público. O
 * neurônio agora é o memory doc CANÔNICO do graphify (`parse_memory_doc`):
 * título = `question`, `updatedAt` = `date`, tag única = `type` (ex.:
 * `learning`). Markdown sem frontmatter (arquivo estrangeiro no `.hive/`)
 * mantém as heurísticas de corpo (1º heading, linha `tags:` inline).
 */
function hiveNeuronSummary(rel: string, content: string, mtime: Date): MemoryNeuronSummary {
  const doc = parseMemoryDoc(content);
  const body = stripFrontmatter(content);
  const bodyLines = body.split(/\r?\n/);
  const heading = bodyLines.find((l) => /^#\s+/.test(l));
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^#/.test(p));
  // Sem frontmatter: preserva a leitura da linha `tags:` inline do legado.
  const tagLine = doc ? null : bodyLines.find((l) => /^tags:/i.test(l.trim()));
  const tags = doc
    ? doc.type
      ? [doc.type]
      : []
    : tagLine
      ? tagLine
          .replace(/^tags:/i, '')
          .split(/[,\s]+/)
          .map((t) => t.replace(/^#/, '').trim())
          .filter(Boolean)
      : [];
  const date = doc?.date;
  const updatedAt = date && !Number.isNaN(Date.parse(date)) ? new Date(date) : mtime;
  const title =
    doc?.question ?? (heading ? heading.replace(/^#\s+/, '').trim() : moduleFromNeuronPath(rel));
  return {
    path: rel,
    title,
    tags,
    summary: (paragraph ?? '').slice(0, 280),
    updatedAt: updatedAt.toISOString(),
  };
}
