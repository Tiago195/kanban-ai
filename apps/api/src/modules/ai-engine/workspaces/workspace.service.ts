import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

type CommandResult = {
  stdout: string;
  stderr: string;
};

/** Erro de configuração do projeto-alvo (ex.: aiProject ausente ou inválido). */
export class TargetProjectError extends Error {}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly fallbackDirsByKey = new Map<string, string>();
  /** Repo-alvo (aiProject) associado a cada key, para limpar o worktree certo. */
  private readonly targetRepoByKey = new Map<string, string>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Prepara um diretório de trabalho ISOLADO para o agent, criado como git
   * worktree DENTRO do repo-alvo (`targetRepoPath`, vindo de `story.aiProject`),
   * numa branch dedicada `kanban/<key>`. Nunca usa o repo do kanban-ai (`/app`)
   * como base — ver problema #8. Se o projeto-alvo não for um repo git válido,
   * lança `TargetProjectError` (o orchestrator recusa rodar).
   *
   * @param key            chave estável (storyId) para nomear worktree/branch.
   * @param targetRepoPath caminho absoluto do repo-alvo (aiProject).
   */
  async ensureWorktree(key: string, targetRepoPath?: string | null): Promise<string> {
    const safeKey = this.sanitizeKey(key);
    const target = (targetRepoPath ?? '').trim();

    if (!target) {
      throw new TargetProjectError(
        'Projeto-alvo não definido (aiProject vazio). Defina o repositório-alvo da story antes de rodar o agent.',
      );
    }

    const resolvedTarget = path.resolve(target);

    // Guard-rail duro (#8): o agent NUNCA pode trabalhar dentro do repo do
    // kanban-ai. Recusamos qualquer alvo que resolva para a raiz do próprio app.
    if (this.isInsideSelfRepo(resolvedTarget)) {
      throw new TargetProjectError(
        `Projeto-alvo inválido: ${resolvedTarget} está dentro do próprio kanban-ai. ` +
          'Aponte aiProject para um repositório-alvo externo.',
      );
    }

    if (!(await this.pathExists(resolvedTarget))) {
      throw new TargetProjectError(`Projeto-alvo não encontrado no filesystem: ${resolvedTarget}`);
    }
    if (!(await this.isInsideGitRepo(resolvedTarget))) {
      throw new TargetProjectError(
        `Projeto-alvo não é um repositório git: ${resolvedTarget}. ` +
          'Inicialize o repo (git init) antes de rodar o agent.',
      );
    }

    this.targetRepoByKey.set(safeKey, resolvedTarget);

    // Repo recém-criado (`git init`) tem HEAD "unborn": não há nenhum commit e
    // `HEAD` é uma referência inválida, então `git worktree add ... HEAD` falha
    // com "invalid reference: HEAD". Garantimos um commit inicial vazio para que
    // o worktree possa ser criado a partir dele.
    await this.ensureInitialCommit(resolvedTarget);

    const baseDir = await this.ensureBaseDir();
    const worktreePath = path.join(baseDir, safeKey);
    const branch = `kanban/${safeKey}`;

    if (await this.pathExists(worktreePath)) {
      return worktreePath;
    }

    try {
      // Cria o worktree do REPO-ALVO numa branch dedicada. `-B` reaproveita a
      // branch se já existir (retomada de story).
      await this.runGit(
        ['worktree', 'add', '-B', branch, worktreePath, 'HEAD'],
        resolvedTarget,
      );
      this.logger.log(
        `worktree isolado criado: ${worktreePath} (repo-alvo=${resolvedTarget}, branch=${branch})`,
      );
      return worktreePath;
    } catch (error: unknown) {
      if (await this.pathExists(worktreePath)) {
        this.logger.warn(
          `Falha ao criar worktree para key=${safeKey}, mas o diretório já existe. Reutilizando: ${worktreePath}`,
        );
        return worktreePath;
      }
      throw error;
    }
  }

  /** True se `candidate` está dentro (ou é) a raiz do repo do kanban-ai. */
  private isInsideSelfRepo(candidate: string): boolean {
    const self = path.resolve(process.cwd());
    const rel = path.relative(self, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * Garante que o repo-alvo tenha pelo menos um commit. Repositórios recém
   * inicializados (`git init`) têm HEAD "unborn" — `git worktree add ... HEAD`
   * falha porque `HEAD` não resolve para nenhum commit. Criamos um commit
   * inicial vazio (sem tocar em arquivos do usuário) para destravar o worktree.
   * No-op se o repo já tiver commits.
   */
  private async ensureInitialCommit(repoPath: string): Promise<void> {
    if (await this.hasCommits(repoPath)) return;

    this.logger.log(
      `Repo-alvo sem commits (HEAD unborn): ${repoPath}. Criando commit inicial vazio para habilitar o worktree.`,
    );
    // `-c` inline garante identidade mesmo sem git config global no host/CI.
    await this.runGit(
      [
        '-c',
        'user.email=agent@kanban-ai.local',
        '-c',
        'user.name=kanban-ai',
        'commit',
        '--allow-empty',
        '-m',
        'chore: initial commit (kanban-ai)',
      ],
      repoPath,
    );
  }

  /** True se o repo tem pelo menos um commit (HEAD resolve para um objeto). */
  private async hasCommits(repoPath: string): Promise<boolean> {
    try {
      await this.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repoPath);
      return true;
    } catch {
      return false;
    }
  }

  async cleanupWorktree(key: string): Promise<void> {
    const safeKey = this.sanitizeKey(key);

    const fallbackPath = this.fallbackDirsByKey.get(safeKey);
    if (fallbackPath) {
      await this.removeDirIfExists(fallbackPath);
      this.fallbackDirsByKey.delete(safeKey);
    }

    const worktreePath = path.join(path.resolve(this.config.agent.workspacesDir), safeKey);
    const targetRepo = this.targetRepoByKey.get(safeKey);
    if (!(await this.pathExists(worktreePath))) {
      this.targetRepoByKey.delete(safeKey);
      this.logger.warn(`Workspace para key=${safeKey} já não existe: ${worktreePath}`);
      return;
    }

    // Sem repo-alvo conhecido (ex.: reinício), removemos só o diretório local.
    if (!targetRepo || !(await this.isInsideGitRepo(targetRepo))) {
      await this.removeDirIfExists(worktreePath);
      this.targetRepoByKey.delete(safeKey);
      this.logger.warn(
        `Repo-alvo indisponível durante cleanup; removido diretório local para key=${safeKey}: ${worktreePath}`,
      );
      return;
    }

    try {
      await this.runGit(['worktree', 'remove', '--force', worktreePath], targetRepo);
      this.targetRepoByKey.delete(safeKey);
    } catch (error: unknown) {
      if (!(await this.pathExists(worktreePath))) {
        this.targetRepoByKey.delete(safeKey);
        this.logger.warn(`Worktree para key=${safeKey} já removido: ${worktreePath}`);
        return;
      }

      const message = this.extractErrorMessage(error);
      this.logger.warn(
        `Falha tolerada ao remover worktree key=${safeKey} (${worktreePath}): ${message}`,
      );
    }
  }

  private async ensureBaseDir(): Promise<string> {
    const baseDir = path.resolve(this.config.agent.workspacesDir);
    await fs.mkdir(baseDir, { recursive: true });
    return baseDir;
  }

  private sanitizeKey(key: string): string {
    const normalized = key.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const collapsed = normalized.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    return collapsed.length > 0 ? collapsed.slice(0, 64) : 'workspace';
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async isInsideGitRepo(cwd?: string): Promise<boolean> {
    try {
      const { stdout } = await this.runGit(['rev-parse', '--is-inside-work-tree'], cwd);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async removeDirIfExists(targetPath: string): Promise<void> {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
    } catch (error: unknown) {
      const message = this.extractErrorMessage(error);
      this.logger.warn(`Falha ao remover diretório ${targetPath}: ${message}`);
    }
  }

  private runGit(args: readonly string[], cwd?: string): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      execFile(
        'git',
        args,
        { encoding: 'utf8', ...(cwd ? { cwd } : {}) },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`git ${args.join(' ')} falhou: ${stderr || error.message}`));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
