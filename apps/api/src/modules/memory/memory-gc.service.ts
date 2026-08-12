import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';
import { MemoryGitService } from './memory-git.service';
import { detectModules } from './memory-bootstrap.service';

/** Limite default de commits que sumarizam o histórico "longo" (US-216). */
const DEFAULT_HISTORY_KEEP = 10;
/** Prefixo dos ramos efêmeros por sessão (US-217). */
const EPHEMERAL_BRANCH_PREFIX = 'mem/ai/';

/** Resultado da varredura de staleness (US-215). */
export interface GcStaleResult {
  /** Neurônios marcados stale + arquivados nesta execução. */
  archived: string[];
  /** Neurônios reativados (voltaram a existir no repo-alvo). */
  revived: string[];
}

/**
 * **Garbage collection** da colmeia (ADR-0027, **EP-85**).
 *
 * Jobs de baixa prioridade que mantêm a memória relevante e o repo enxuto SEM
 * perder a fonte da verdade (git preserva todo o histórico — GC nunca `git rm`
 * conteúdo estável nem apaga commits):
 * - **US-215** `sweepStale`: marca stale + arquiva neurônios cujo módulo sumiu do
 *   repo-alvo; reativa os que voltaram. Idempotente.
 * - **US-216** `summarizeHistory`: condensa o histórico longo de um neurônio num
 *   resumo determinístico (sem apagar commits — a fonte da verdade é o git).
 * - **US-217** `pruneEphemeralBranches`: poda ramos `mem/ai/*` órfãos após merge/
 *   expiração de lease. Ramo não é conteúdo estável; descartá-lo não perde nada.
 *
 * **Fora de escopo aqui:** o AGENDAMENTO periódico (tick/cron) que chama estes
 * métodos — a orquestração vive fora do módulo (infra/loop engine).
 */
@Injectable()
export class MemoryGcService {
  private readonly logger = new Logger(MemoryGcService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly git: MemoryGitService,
  ) {}

  /**
   * US-215 — varre o índice e reconcilia staleness contra o repo-alvo. Um
   * neurônio de módulo cujo diretório sumiu do repo é marcado `stale` e
   * ARQUIVADO (`archivedAt`); um neurônio arquivado cujo módulo reapareceu é
   * reativado. NÃO apaga nada do git (histórico preservado). Idempotente.
   */
  async sweepStale(input: { repoPath: string }): Promise<GcStaleResult> {
    const liveModuleNeurons = new Set(
      detectModules(input.repoPath).map((m) => m.neuronPath),
    );
    const headCommit = await this.git.resolveHead().catch(() => null);
    const rows = await this.prisma.memoryIndex.findMany({
      select: { path: true, stale: true },
    });

    const archived: string[] = [];
    const revived: string[] = [];
    for (const row of rows) {
      // Só reconciliamos neurônios de módulo (modules/<x>.md); outros paths
      // (endpoints, docs ad-hoc) ficam a cargo de jobs futuros.
      if (!isModuleNeuron(row.path)) continue;
      const present = liveModuleNeurons.has(row.path);
      if (!present && !row.stale) {
        await this.prisma.memoryIndex.update({
          where: { path: row.path },
          data: { stale: true, archivedAt: new Date() },
        });
        archived.push(row.path);
      } else if (present && row.stale) {
        await this.prisma.memoryIndex.update({
          where: { path: row.path },
          data: { stale: false, archivedAt: null, lastSeenCommit: headCommit },
        });
        revived.push(row.path);
      } else if (present && headCommit) {
        await this.prisma.memoryIndex.update({
          where: { path: row.path },
          data: { lastSeenCommit: headCommit },
        });
      }
    }
    this.logger.debug(
      `sweepStale: ${archived.length} arquivado(s), ${revived.length} reativado(s).`,
    );
    return { archived, revived };
  }

  /**
   * US-216 — sumariza o histórico longo de um neurônio. Determinístico e sem
   * side effects no git: lê o `git log` do path e, quando excede `keep`, produz
   * um bloco de resumo condensando os commits antigos (o essencial: quantidade e
   * intervalo temporal) e listando os `keep` mais recentes. Retorna `null` se o
   * neurônio não tem histórico longo o bastante (nada a condensar).
   */
  async summarizeHistory(
    neuronPath: string,
    keep: number = DEFAULT_HISTORY_KEEP,
  ): Promise<string | null> {
    const history = await this.git.historyNeuron(neuronPath);
    if (history.length <= keep) return null;

    const recent = history.slice(0, keep);
    const older = history.slice(keep);
    const oldest = older[older.length - 1];
    const newestOld = older[0];
    const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

    const lines = [
      `## Historico condensado (${older.length} commit(s) antigos)`,
      '',
      `Aprendizado antigo de \`${neuronPath}\` entre ${fmt(oldest.author.timestamp)} e ` +
        `${fmt(newestOld.author.timestamp)}, condensado (a fonte da verdade permanece no git).`,
      '',
      '### Commits recentes preservados',
      ...recent.map((c) => `- ${c.oid.slice(0, 8)} ${firstLine(c.message)}`),
      '',
    ];
    return lines.join('\n');
  }

  /**
   * US-217 — poda ramos efêmeros `mem/ai/<sessao>/*` órfãos. Um ramo é órfão
   * quando não há lease/edição ativa que o referencie no índice (`activeBranch`).
   * Idempotente: ramos já ausentes são ignorados. Retorna os ramos podados.
   */
  async pruneEphemeralBranches(): Promise<string[]> {
    const branches = await this.git.listBranches();
    const ephemeral = branches.filter((b) => b.startsWith(EPHEMERAL_BRANCH_PREFIX));
    if (ephemeral.length === 0) return [];

    const activeRows = await this.prisma.memoryIndex.findMany({
      where: { activeBranch: { not: null } },
      select: { activeBranch: true },
    });
    const active = new Set(
      activeRows.map((r) => r.activeBranch).filter((b): b is string => !!b),
    );

    const pruned: string[] = [];
    for (const branch of ephemeral) {
      if (active.has(branch)) continue;
      const ok = await this.git.deleteBranchByRef(branch);
      if (ok) pruned.push(branch);
    }
    this.logger.debug(`pruneEphemeralBranches: ${pruned.length} ramo(s) podado(s).`);
    return pruned;
  }
}

/** `true` se o path é um neurônio de módulo `modules/<x>.md`. */
function isModuleNeuron(path: string): boolean {
  return /^modules\/[^/]+\.md$/.test(path);
}

/** Primeira linha (título) de uma mensagem de commit. */
function firstLine(message: string): string {
  return message.split(/\r?\n/, 1)[0].trim();
}
