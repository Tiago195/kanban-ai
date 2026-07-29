import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../shared/config/config';

/**
 * Gerencia **git worktrees** isolados por execução de agent.
 *
 * Cada story/execução aponta para um **repositório-alvo** (git local/remoto).
 * Para não pisar em trabalho concorrente, cada iteração roda num worktree
 * isolado criado a partir do repo-alvo.
 *
 * ⚠️ STUB — ver TODOs e docs/loop-engine.md (estratégia de diretório base +
 * cleanup ainda em aberto).
 */
@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Cria (ou reaproveita) um worktree isolado para a story e retorna o cwd. */
  async ensureWorktree(storyId: string, targetRepo: string): Promise<string> {
    const base = this.config.agent.workspacesDir;
    this.logger.warn(
      `ensureWorktree() STUB — story=${storyId} repo=${targetRepo} base=${base}`,
    );
    // TODO: git -C <targetRepo> worktree add <base>/<storyId> <branch>
    // TODO: definir política de branch (por story?) e base de diretório.
    return `${base}/${storyId}`;
  }

  /** Remove o worktree ao finalizar a story. */
  async cleanupWorktree(storyId: string): Promise<void> {
    this.logger.warn(`cleanupWorktree() STUB — story=${storyId}`);
    // TODO: git worktree remove + prune; decidir se preserva branch.
  }
}
