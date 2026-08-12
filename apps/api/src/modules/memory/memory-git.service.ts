import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import git from 'isomorphic-git';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';

/** Branch inicial garantida pelo provisionamento (ADR-0027, Camada 1). */
export const MEMORY_DEFAULT_BRANCH = 'main';

/**
 * Autoria determinística do commit de bootstrap. `timestamp`/`timezoneOffset`
 * fixos tornam o SHA do commit vazio reproduzível, preservando a idempotência
 * (rodar N vezes num volume vazio converge sempre para o mesmo commit inicial).
 */
const BOOTSTRAP_AUTHOR = {
  name: 'kanban-ai',
  email: 'memory@kanban-ai',
  timestamp: 0,
  timezoneOffset: 0,
} as const;

/** Mensagem do commit vazio que materializa a branch `main`. */
const BOOTSTRAP_MESSAGE = 'chore: bootstrap memory repo';

/**
 * Serviço de armazenamento da **memória** (ADR-0027, Camada 1 — git como fonte
 * da verdade).
 *
 * Provisiona e opera um **bare git repository** num **volume dedicado do
 * serviço** (`config.memory.gitDir`), FORA do repo-alvo, com ciclo de vida
 * independente — não é clone nem convive com o working tree do projeto. Usa
 * **isomorphic-git** (git em JS puro, sem binário nativo) rodando dentro da API
 * Node.
 *
 * Escopo desta Camada: **só o provisionamento/versionamento** do armazenamento
 * (init/open idempotente do bare repo, garantia da branch `main`). Read/write
 * por path+commit, branches `mem/ai/<sessao>/<path>`, merge 3-way, diff e blame
 * chegam em iterações seguintes. Locks/WS/índice são Camada 2 — NÃO vivem aqui.
 */
@Injectable()
export class MemoryGitService implements OnModuleInit {
  private readonly logger = new Logger(MemoryGitService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Caminho do bare repo da memória (volume dedicado, fora do repo-alvo). */
  get gitDir(): string {
    return this.config.memory.gitDir;
  }

  /** No boot da API, garante o bare repo provisionado. */
  async onModuleInit(): Promise<void> {
    await this.provision();
  }

  /**
   * Detecta se o `gitDir` já hospeda um bare repository — usa o arquivo `HEAD`
   * como sentinela (presente tanto em repo bare quanto não-bare).
   */
  private hasRepo(): boolean {
    return fs.existsSync(path.join(this.gitDir, 'HEAD'));
  }

  /**
   * Verifica se a branch corrente é "unborn": o `HEAD` aponta para
   * `refs/heads/main` mas ainda não existe commit (a ref não resolve). Nesse
   * estado `git.resolveRef({ ref: 'HEAD' })` lança `NotFoundError`.
   */
  private async isHeadUnborn(): Promise<boolean> {
    const dir = this.gitDir;
    try {
      await git.resolveRef({ fs, dir, gitdir: dir, ref: 'HEAD' });
      return false;
    } catch (err) {
      const code = (err as { code?: string; name?: string })?.code;
      const name = (err as { name?: string })?.name;
      if (code === 'NotFoundError' || name === 'NotFoundError') {
        return true;
      }
      throw err;
    }
  }

  /**
   * Materializa a branch `main` com um **commit de bootstrap vazio** (árvore
   * vazia) quando o `HEAD` ainda é "unborn". Autoria/timestamp fixos garantem
   * um SHA determinístico, então reexecutar num volume vazio converge sempre
   * para o mesmo commit inicial (idempotência). Se a branch já tem commit, é
   * no-op — nunca recommita numa reabertura.
   */
  private async ensureBootstrapCommit(): Promise<void> {
    const dir = this.gitDir;
    if (!(await this.isHeadUnborn())) {
      return;
    }
    const tree = await git.writeTree({ fs, dir, gitdir: dir, tree: [] });
    await git.commit({
      fs,
      dir,
      gitdir: dir,
      message: BOOTSTRAP_MESSAGE,
      author: BOOTSTRAP_AUTHOR,
      committer: BOOTSTRAP_AUTHOR,
      tree,
    });
  }

  /**
   * Garante o bare repo provisionado de forma **idempotente**: se o volume não
   * tiver repo, `git.init({ bare: true })`; se já tiver, abre e valida o `HEAD`.
   * Roda N vezes = mesmo estado (bare repo com branch `main` materializada por
   * um commit de bootstrap vazio). Num repo bare o `dir` coincide com o
   * `gitdir` (não há working tree).
   */
  async provision(): Promise<void> {
    const dir = this.gitDir;
    const existed = this.hasRepo();

    // `git.init` é idempotente: reexecutar sobre um repo existente não o
    // corrompe, apenas garante HEAD/config. Chamamos sempre para convergir.
    await git.init({
      fs,
      dir,
      gitdir: dir,
      bare: true,
      defaultBranch: MEMORY_DEFAULT_BRANCH,
    });

    // Valida o HEAD: precisa apontar para a branch default esperada.
    const branch = await git.currentBranch({ fs, dir, gitdir: dir });
    if (branch !== MEMORY_DEFAULT_BRANCH) {
      throw new Error(
        `Bare repo da memória em "${dir}" tem HEAD inesperado (branch="${branch ?? 'destacado'}"); ` +
          `esperado "${MEMORY_DEFAULT_BRANCH}". Verifique o volume configurado em MEMORY_GIT_DIR.`,
      );
    }

    // Materializa a branch main com um commit vazio se ainda for "unborn",
    // deixando o HEAD resolvível. Idempotente: no-op se já houver commit.
    await this.ensureBootstrapCommit();

    this.logger.log(
      `Memória (Camada 1): bare repo ${existed ? 'aberto' : 'inicializado'} em "${dir}" — HEAD=${branch}.`,
    );
  }
}
