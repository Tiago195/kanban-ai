import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

type CommandResult = {
  stdout: string;
  stderr: string;
};

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly fallbackDirsByKey = new Map<string, string>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async ensureWorktree(key: string): Promise<string> {
    const baseDir = await this.ensureBaseDir();
    const safeKey = this.sanitizeKey(key);
    const worktreePath = path.join(baseDir, safeKey);

    if (await this.pathExists(worktreePath)) {
      return worktreePath;
    }

    if (!(await this.isInsideGitRepo())) {
      const cachedFallback = this.fallbackDirsByKey.get(safeKey);
      if (cachedFallback && (await this.pathExists(cachedFallback))) {
        return cachedFallback;
      }

      // Fallback gracioso: fora de repositório git, usamos diretório temporário
      // isolado para não interromper a execução do agent.
      const fallbackPrefix = path.join(baseDir, `${safeKey}-`);
      const fallbackPath = await this.createFallbackDir(fallbackPrefix);
      this.fallbackDirsByKey.set(safeKey, fallbackPath);
      this.logger.warn(
        `Git indisponível no cwd atual; usando workspace temporário para key=${safeKey}: ${fallbackPath}`,
      );
      return fallbackPath;
    }

    try {
      await this.runGit(['worktree', 'add', worktreePath, 'HEAD']);
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

  async cleanupWorktree(key: string): Promise<void> {
    const safeKey = this.sanitizeKey(key);

    const fallbackPath = this.fallbackDirsByKey.get(safeKey);
    if (fallbackPath) {
      await this.removeDirIfExists(fallbackPath);
      this.fallbackDirsByKey.delete(safeKey);
    }

    const worktreePath = path.join(path.resolve(this.config.agent.workspacesDir), safeKey);
    if (!(await this.pathExists(worktreePath))) {
      this.logger.warn(`Workspace para key=${safeKey} já não existe: ${worktreePath}`);
      return;
    }

    if (!(await this.isInsideGitRepo())) {
      await this.removeDirIfExists(worktreePath);
      this.logger.warn(
        `Git indisponível durante cleanup; removido diretório local para key=${safeKey}: ${worktreePath}`,
      );
      return;
    }

    try {
      await this.runGit(['worktree', 'remove', '--force', worktreePath]);
    } catch (error: unknown) {
      if (!(await this.pathExists(worktreePath))) {
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

  private async isInsideGitRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.runGit(['rev-parse', '--is-inside-work-tree']);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  private async createFallbackDir(prefix: string): Promise<string> {
    try {
      return await fs.mkdtemp(prefix);
    } catch {
      return fs.mkdtemp(path.join(tmpdir(), 'kanban-ai-workspace-'));
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

  private runGit(args: readonly string[]): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      execFile('git', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} falhou: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
