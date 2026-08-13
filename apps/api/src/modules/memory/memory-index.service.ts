import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';
import { MEMORY_DEFAULT_BRANCH, MemoryGitService } from './memory-git.service';

/**
 * Projeção derivada de um neurônio no índice (Camada 2, ADR-0027).
 * Extraída do conteúdo `.md` versionado no git (Camada 1 = fonte da verdade).
 */
export interface NeuronProjection {
  path: string;
  headCommit: string;
  title: string;
  tags: string[];
  summary: string;
  searchText: string;
}

/** Resultado de uma consulta ao índice (retrieval). */
export interface MemoryIndexHit {
  path: string;
  headCommit: string;
  title: string;
  tags: string[];
  summary: string;
}

/**
 * Serviço de **índice** da memória (ADR-0027, **Camada 2**).
 *
 * O índice é uma **PROJEÇÃO DERIVADA e DESCARTÁVEL** dos neurônios `.md`
 * versionados no git (Camada 1). O git é a **fonte da verdade**: o índice pode
 * ser reconstruído do zero a qualquer momento (`rebuildAll`) sem perda.
 *
 * Ordem de escrita da colmeia (invariante): **git commit → reindexa → (emite
 * WS)**. `commitAndReindex` encapsula os dois primeiros passos, garantindo que
 * o índice NUNCA reflita um estado que ainda não existe no git.
 */
@Injectable()
export class MemoryIndexService {
  private readonly logger = new Logger(MemoryIndexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gitStore: MemoryGitService,
  ) {}

  /**
   * US-163 — Enforça a ordem de escrita **git → índice**: primeiro persiste o
   * neurônio no git (Camada 1, via branch da sessão), depois projeta o novo
   * estado no índice. Retorna o commit gravado e a projeção reindexada.
   *
   * A emissão de WebSocket (3º passo) NÃO vive aqui (Camada 2/EP-81); este
   * método garante apenas que o índice só é tocado APÓS o git.
   */
  async commitAndReindex(input: {
    path: string;
    content: string;
    sessionId: string;
    message: string;
  }): Promise<{ oid: string; branch: string; projection: NeuronProjection }> {
    const { oid, branch } = await this.gitStore.writeNeuron(input);
    const merge = await this.gitStore.mergeSessionBranch({
      sessionId: input.sessionId,
      path: input.path,
    });
    if (merge.conflict) {
      // Ordem preservada: nada é reindexado se o git não integrou em main.
      throw new MemoryWriteConflictError(input.path);
    }
    const projection = await this.reindexOne(input.path);
    if (!projection) {
      throw new Error(
        `Falha ao reindexar "${input.path}" após commit ${oid}: neurônio ausente em main.`,
      );
    }
    return { oid, branch, projection };
  }

  /**
   * US-160 — Reindexa UM neurônio a partir do git (idempotente). Lê o conteúdo
   * atual em `main`, projeta (title/tags/summary/searchText) e faz upsert no
   * índice. Se o neurônio não existir mais no git, remove a projeção e retorna
   * `null`. Rodar N vezes converge para o mesmo estado.
   */
  async reindexOne(neuronPath: string): Promise<NeuronProjection | null> {
    const content = await this.gitStore.readNeuron(neuronPath, MEMORY_DEFAULT_BRANCH);
    if (content === null) {
      await this.prisma.memoryIndex
        .delete({ where: { path: neuronPath } })
        .catch(() => undefined);
      return null;
    }
    const headCommit = await this.gitStore.resolveHead(MEMORY_DEFAULT_BRANCH);
    const projection = this.project(neuronPath, headCommit, content);
    await this.upsertProjection(projection);
    return projection;
  }

  /**
   * US-161 — Reconstrói o índice INTEIRO a partir do git (rebuild do zero).
   * Trunca a projeção e reprojeta todos os neurônios existentes em `main`.
   * Como o índice é descartável, isto é seguro e é o caminho de recuperação
   * canônico. Retorna a quantidade de neurônios reindexados.
   */
  async rebuildAll(): Promise<number> {
    const paths = await this.gitStore.listNeurons(MEMORY_DEFAULT_BRANCH);
    await this.prisma.memoryIndex.deleteMany({});
    const headCommit = await this.gitStore.resolveHead(MEMORY_DEFAULT_BRANCH);
    for (const p of paths) {
      const content = await this.gitStore.readNeuron(p, MEMORY_DEFAULT_BRANCH);
      if (content === null) {
        continue;
      }
      await this.upsertProjection(this.project(p, headCommit, content));
    }
    this.logger.log(`Índice de memória reconstruído: ${paths.length} neurônio(s).`);
    return paths.length;
  }

  /**
   * US-162 — Consulta/retrieval de neurônios pelo índice. Busca case-insensitive
   * em title/summary/searchText/path e retorna os hits mais relevantes. Sem
   * termo, lista os neurônios (ordenados por atualização recente).
   *
   * US-PROJ4 (§1.2 / decisão #6) — `pathPrefix` OPCIONAL: quando informado (ex.:
   * `projects/<projectId>`), a busca é RESTRITA aos neurônios daquele namespace
   * (colmeia do Project), sem misturar com a colmeia global ou de outros
   * projetos. Sem `pathPrefix`, o comportamento é o legado (busca global).
   */
  async query(term?: string, limit = 20, pathPrefix?: string): Promise<MemoryIndexHit[]> {
    const q = (term ?? '').trim();
    const scope = (pathPrefix ?? '').replace(/\/+$/, '');
    const prefixFilter = scope ? { path: { startsWith: `${scope}/` } } : {};
    const rows = q
      ? await this.prisma.memoryIndex.findMany({
          where: {
            ...prefixFilter,
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { summary: { contains: q, mode: 'insensitive' } },
              { searchText: { contains: q, mode: 'insensitive' } },
              { path: { contains: q, mode: 'insensitive' } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: limit,
        })
      : await this.prisma.memoryIndex.findMany({
          where: prefixFilter,
          orderBy: { updatedAt: 'desc' },
          take: limit,
        });
    return rows.map((r) => ({
      path: r.path,
      headCommit: r.headCommit,
      title: r.title,
      tags: this.parseTags(r.tags),
      summary: r.summary,
    }));
  }

  // ---------------------------------------------------------------------------
  // Projeção e persistência.
  // ---------------------------------------------------------------------------

  /**
   * Projeta o conteúdo `.md` de um neurônio em campos indexáveis. Heurística
   * leve e determinística: título = 1ª linha `# `, tags = linha `tags:` ou
   * `#hashtags`, resumo = 1º parágrafo, searchText = conteúdo achatado.
   */
  private project(path: string, headCommit: string, content: string): NeuronProjection {
    const lines = content.split(/\r?\n/);
    const heading = lines.find((l) => /^#\s+/.test(l));
    const title = heading ? heading.replace(/^#\s+/, '').trim() : path;

    const tagLine = lines.find((l) => /^tags:/i.test(l.trim()));
    const tags = tagLine
      ? tagLine
          .replace(/^tags:/i, '')
          .split(/[,\s]+/)
          .map((t) => t.replace(/^#/, '').trim())
          .filter(Boolean)
      : Array.from(new Set((content.match(/(?:^|\s)#([\w-]+)/g) ?? []).map((h) => h.trim().replace(/^#/, ''))));

    const paragraph = content
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^#/.test(p));
    const summary = (paragraph ?? '').slice(0, 280);

    const searchText = content.replace(/\s+/g, ' ').trim().slice(0, 4000);
    return { path, headCommit, title, tags, summary, searchText };
  }

  private async upsertProjection(p: NeuronProjection): Promise<void> {
    const data = {
      headCommit: p.headCommit,
      title: p.title,
      tags: JSON.stringify(p.tags),
      summary: p.summary,
      searchText: p.searchText,
    };
    await this.prisma.memoryIndex.upsert({
      where: { path: p.path },
      create: { path: p.path, ...data },
      update: data,
    });
  }

  private parseTags(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
}

/** Erro sinalizado quando a integração em `main` conflita (Camada 2 → EP-80). */
export class MemoryWriteConflictError extends Error {
  constructor(public readonly path: string) {
    super(`Conflito ao integrar o neurônio "${path}" em main; requer resolução (REVIEW).`);
    this.name = 'MemoryWriteConflictError';
  }
}
