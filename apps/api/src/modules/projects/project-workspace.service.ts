import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import type { Project as ProjectRow } from '@prisma/client';
import type { ProjectCloneState } from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';
import { PrismaService } from '../../shared/db/prisma.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { ProjectCredentialsService, asAuthInput } from './project-credentials.service';
import { ProjectGraphService } from './project-graph.service';

const execFileAsync = promisify(execFile);

/**
 * Hook de autenticação do git (isomorphic-git `onAuth`). US-PROJ2 só clona repos
 * PÚBLICOS (https); a RESOLUÇÃO de credenciais (token/ssh por Project) é a
 * US-PROJ3 — este ponto de extensão existe para ela plugar sem reescrever o
 * serviço. Enquanto ausente, o clone/fetch segue anônimo.
 */
export type GitAuthHook = (url: string) => {
  username?: string;
  password?: string;
} | void;

/**
 * EP-PROJECT / US-PROJ2 — Serviço de clone/sync gerenciado do repositório de um
 * `Project`.
 *
 * Materializa o repo (`repoUrl`) num diretório gerenciado previsível
 * (`<PROJECTS_DIR>/<projectId>`) via **isomorphic-git** (a MESMA lib da memória),
 * expondo estados observáveis (`pending → cloning → ready|failed`) emitidos como
 * `ProjectCloneStateEvent` no WebSocket. O clone/sync é feito pelo ENGINE (nunca
 * pelo agent — ADR-0008).
 *
 * Guard-rails:
 *  - o `localPath` NUNCA pode aterrissar DENTRO do próprio repo do kanban-ai
 *    (`isInsideSelfRepo`) — evita poluir/corromper o repositório do produto;
 *  - `PROJECTS_DIR` é resolvido para ABSOLUTO (config) e criado se ausente.
 *
 * Concorrência: dois `ensureCloned` simultâneos do MESMO projectId são
 * serializados por um lock in-process (`Map<projectId, Promise>`), sem Redis
 * (invariante 7).
 */
@Injectable()
export class ProjectWorkspaceService {
  private readonly logger = new Logger(ProjectWorkspaceService.name);

  /** Lock in-process por projectId: coalescing de clones concorrentes. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly realtime: RealtimeService,
    // US-PROJ3: resolvedor de credenciais git por Project (opcional para não
    // quebrar construções diretas em testes; injetado pelo ProjectsModule).
    @Optional() private readonly credentials: ProjectCredentialsService | null = null,
    // US-F1.3: build do grafo de conhecimento disparado quando o clone fica
    // ready (opcional para não quebrar construções diretas em testes).
    // NOTA: parâmetro `?:` SEM união com null — `X | null` faz o TS emitir
    // `Object` no design:paramtypes e o Nest injetaria undefined em silêncio.
    @Optional() private readonly graph?: ProjectGraphService,
  ) {}

  /**
   * US-PROJ3: ponto de extensão explícito para o `onAuth` do isomorphic-git.
   * Quando definido (via `setAuthHook`), TEM PRECEDÊNCIA sobre a resolução
   * automática por `ProjectCredentialsService`. Ausente (default) = a resolução
   * automática cuida do https por Project; sem credenciais o clone é anônimo.
   * Injetável nos testes.
   */
  private authHook: GitAuthHook | null = null;

  /** US-PROJ3: pluga um resolvedor de credenciais git (onAuth) manual/override. */
  setAuthHook(hook: GitAuthHook | null): void {
    this.authHook = hook;
  }

  /**
   * Resolve o `onAuth` efetivo do isomorphic-git para um Project (https):
   *  1) hook manual (`setAuthHook`) tem precedência (testes/override);
   *  2) senão, delega ao `ProjectCredentialsService` (token de env var).
   * Retorna `undefined` quando não há auth (clone anônimo). Pode LANÇAR erro
   * legível se `credentialRef` referenciar env var ausente — falha cedo.
   */
  private resolveOnAuth(project: ProjectRow): GitAuthHook | undefined {
    if (this.authHook) return this.authHook;
    if (!this.credentials) return undefined;
    const hook = this.credentials.buildHttpAuthHook(asAuthInput(project));
    return hook ? () => hook() : undefined;
  }

  /** Caminho gerenciado (absoluto) do clone de um Project. */
  private localPathFor(projectId: string): string {
    return path.join(this.config.projects.dir, projectId);
  }

  /**
   * Clona `repoUrl` para `<PROJECTS_DIR>/<projectId>` de forma idempotente do
   * ponto de vista do CHAMADOR: chamadas concorrentes para o mesmo projectId
   * compartilham a MESMA promessa (lock in-process). Persiste as transições de
   * `cloneState` e emite `ProjectCloneStateEvent` a cada uma. Retorna o
   * `localPath` do clone.
   */
  ensureCloned(projectId: string): Promise<string> {
    const existing = this.inFlight.get(projectId);
    if (existing) return existing;
    const run = this.doClone(projectId).finally(() => {
      this.inFlight.delete(projectId);
    });
    this.inFlight.set(projectId, run);
    return run;
  }

  private async doClone(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} não encontrado`);

    const localPath = this.localPathFor(projectId);
    // US-F2.3 — "ensure" DE VERDADE: clone `ready` que já existe no disco é
    // REUSADO, nunca re-clonado. Antes, cada chamada fazia rm -rf + clone
    // fresco — invisível enquanto a colmeia vivia no bare repo da memória
    // (o materialize re-espelhava o .hive/ a cada build), mas FATAL desde que
    // `<clone>/.hive/**.md` virou a fonte da verdade dos learnings: o
    // re-clone apagaria a memória do Project a cada iteração. Também elimina
    // um clone de rede por iteração. Estados não-`ready` (cloning pela
    // metade, failed) seguem no caminho de clone limpo abaixo; refresh
    // explícito é o `sync()`.
    if (project.cloneState === 'ready' && fs.existsSync(path.join(localPath, '.git'))) {
      return localPath;
    }
    // Guard-rail: o clone jamais pode cair dentro do repo do kanban-ai.
    if (this.isInsideSelfRepo(localPath)) {
      const message =
        `Clone recusado: o localPath resolvido "${localPath}" está DENTRO do repo ` +
        'do kanban-ai. Configure PROJECTS_DIR para um diretório fora do repositório.';
      await this.markFailed(projectId, message);
      throw new Error(message);
    }

    // US-PROJ3: resolve o `onAuth` (https) ou valida a flag de ssh ANTES de
    // preparar o diretório — falha de configuração de credencial não deve deixar
    // resíduo no FS. Erros aqui são legíveis (sem segredo).
    let onAuth: GitAuthHook | undefined;
    try {
      if (project.authKind === 'ssh') {
        this.credentials?.assertSshAllowed(asAuthInput(project));
      } else {
        onAuth = this.resolveOnAuth(project);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markFailed(projectId, message);
      throw new Error(message);
    }

    await fsp.mkdir(this.config.projects.dir, { recursive: true });
    // Se já existe algo no destino, começa limpo (clone precisa de dir vazio).
    await fsp.rm(localPath, { recursive: true, force: true });
    await fsp.mkdir(localPath, { recursive: true });

    await this.transition(projectId, 'cloning');

    try {
      if (project.authKind === 'ssh') {
        // isomorphic-git NÃO fala ssh: delega ao `git` do sistema num cwd
        // controlado (gated por PROJECTS_ALLOW_SSH, já validado acima).
        await this.systemGitClone(project, localPath);
      } else {
        await git.clone({
          fs,
          http,
          dir: localPath,
          url: project.repoUrl,
          ref: project.defaultBranch ?? undefined,
          singleBranch: false,
          onAuth: onAuth ? (url) => onAuth?.(url) ?? undefined : undefined,
        });
      }
    } catch (err) {
      const message = this.legibleGitError(err, `clonar ${project.repoUrl}`);
      // Best-effort: não deixa um diretório pela metade no destino.
      await fsp.rm(localPath, { recursive: true, force: true }).catch(() => undefined);
      await this.markFailed(projectId, message);
      throw new Error(message);
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: { cloneState: 'ready', localPath, lastError: null, lastSyncedAt: new Date() },
    });
    this.emit(projectId, 'ready');
    this.logger.log(`Project ${projectId} clonado em "${localPath}" (ready).`);
    // US-F1.3: clone pronto → dispara o build do grafo em BACKGROUND
    // (fire-and-forget). `build()` nunca lança; o catch é cinto-e-suspensório
    // para que uma falha de grafo JAMAIS derrube o fluxo de clone/Project.
    void this.graph?.build(projectId).catch((err) => {
      this.logger.warn(
        `build do grafo falhou para Project ${projectId}: ${(err as Error)?.message ?? err}`,
      );
    });
    return localPath;
  }

  /**
   * Atualiza o clone gerenciado: `fetch` do remoto + checkout/fast-forward para
   * a branch default. Atualiza `lastSyncedAt`. Requer que o clone já exista
   * (`localPath` populado); caso contrário delega a `ensureCloned`.
   */
  async sync(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} não encontrado`);

    const localPath = project.localPath ?? this.localPathFor(projectId);
    if (!fs.existsSync(path.join(localPath, '.git'))) {
      // Ainda não clonado (ou clone removido): materializa do zero.
      await this.ensureCloned(projectId);
      return;
    }

    try {
      if (project.authKind === 'ssh') {
        this.credentials?.assertSshAllowed(asAuthInput(project));
        await this.systemGitFetch(localPath, project.defaultBranch ?? undefined);
      } else {
        const onAuth = this.resolveOnAuth(project);
        const branch =
          project.defaultBranch ??
          (await git.currentBranch({ fs, dir: localPath, fullname: false })) ??
          undefined;
        await git.fetch({
          fs,
          http,
          dir: localPath,
          ref: branch,
          singleBranch: false,
          onAuth: onAuth ? (url) => onAuth?.(url) ?? undefined : undefined,
        });
        await git.checkout({ fs, dir: localPath, ref: branch, force: true });
      }
    } catch (err) {
      const message = this.legibleGitError(err, `sincronizar ${project.repoUrl}`);
      await this.markFailed(projectId, message);
      throw new Error(message);
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: { lastSyncedAt: new Date(), lastError: null },
    });
    this.logger.log(`Project ${projectId} sincronizado (fetch + checkout).`);
  }

  /**
   * Remove o diretório gerenciado do clone (ao deletar o Project). Idempotente:
   * não falha se o diretório não existe. NUNCA remove nada fora de PROJECTS_DIR.
   */
  async remove(projectId: string): Promise<void> {
    const localPath = this.localPathFor(projectId);
    if (this.isInsideSelfRepo(localPath)) {
      // Defesa em profundidade: nunca apagar algo dentro do kanban-ai.
      this.logger.warn(
        `remove(${projectId}) recusado: "${localPath}" está dentro do kanban-ai.`,
      );
      return;
    }
    await fsp.rm(localPath, { recursive: true, force: true });
    this.logger.log(`Project ${projectId}: diretório gerenciado removido.`);
  }

  /** Persiste `cloneState` e emite o evento correspondente (sem erro). */
  private async transition(projectId: string, state: ProjectCloneState): Promise<void> {
    await this.prisma.project.update({ where: { id: projectId }, data: { cloneState: state } });
    this.emit(projectId, state);
  }

  /** Persiste `failed` + `lastError` (legível) e emite o evento com o erro. */
  private async markFailed(projectId: string, message: string): Promise<void> {
    await this.prisma.project
      .update({ where: { id: projectId }, data: { cloneState: 'failed', lastError: message } })
      .catch(() => undefined);
    this.emit(projectId, 'failed', message);
    this.logger.warn(`Project ${projectId} falhou: ${message}`);
  }

  /** Emite o `ProjectCloneStateEvent` tipado no WebSocket. */
  private emit(projectId: string, state: ProjectCloneState, error?: string): void {
    this.realtime.broadcast({ type: 'project.clone_state', projectId, state, ...(error ? { error } : {}) });
  }

  /**
   * US-PROJ3 (ssh) — clone delegado ao `git` do sistema num cwd controlado.
   * isomorphic-git não fala ssh; para `authKind='ssh'` (habilitado por
   * `PROJECTS_ALLOW_SSH`) usamos o `git` do host, que resolve a chave via o
   * agente/config ssh do ambiente do servidor. NÃO manipulamos segredos aqui: a
   * autenticação é responsabilidade do ssh do sistema (agent/known_hosts). O
   * prompt de terminal é DESABILITADO (`GIT_TERMINAL_PROMPT=0`) para nunca
   * travar aguardando credencial. Quando `PROJECTS_SSH_COMMAND` está setado, ele
   * é injetado como `GIT_SSH_COMMAND` (ex.: fixar `-i <chave>`, porta 443 ou
   * `-F /dev/null` quando o `~/.ssh/config` montado tem dono ≠ root).
   */
  private async systemGitClone(project: ProjectRow, localPath: string): Promise<void> {
    const args = ['clone'];
    if (project.defaultBranch) args.push('--branch', project.defaultBranch);
    args.push('--', project.repoUrl, localPath);
    await execFileAsync('git', args, {
      env: this.systemGitEnv(),
      timeout: this.config.projects.gitTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  /** US-PROJ3 (ssh) — fetch + checkout delegado ao `git` do sistema no clone. */
  private async systemGitFetch(localPath: string, branch: string | undefined): Promise<void> {
    const env = this.systemGitEnv();
    const opts = { cwd: localPath, env, timeout: this.config.projects.gitTimeoutMs };
    await execFileAsync('git', ['fetch', '--all', '--prune'], opts);
    if (branch) {
      await execFileAsync('git', ['checkout', '--force', branch], opts);
      await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], opts);
    }
  }

  /**
   * Ambiente do `git` do sistema para operações SSH: desabilita o prompt de
   * terminal (nunca trava pedindo credencial) e, quando configurado, injeta
   * `GIT_SSH_COMMAND` (`PROJECTS_SSH_COMMAND`) — sem segredo, só flags de
   * transporte ssh.
   */
  private systemGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (this.config.projects.sshCommand) {
      env.GIT_SSH_COMMAND = this.config.projects.sshCommand;
    }
    return env;
  }

  /**
   * Converte um erro do isomorphic-git numa mensagem LEGÍVEL (nunca um stacktrace
   * cru), preservando a ação em curso para diagnóstico do usuário.
   */
  private legibleGitError(err: unknown, action: string): string {
    const raw = err instanceof Error ? err.message : String(err);
    // Compacta múltiplas linhas (stacktrace) numa mensagem de 1 linha enxuta.
    const firstLine = raw.split('\n')[0]?.trim() || raw.trim();
    return `Falha ao ${action}: ${firstLine}`;
  }

  /** True se `candidate` está dentro (ou é) a raiz do repo do kanban-ai. */
  private isInsideSelfRepo(candidate: string): boolean {
    const self = path.resolve(process.cwd());
    const rel = path.relative(self, path.resolve(candidate));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}
