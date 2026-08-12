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
 * Autoria default de commits de conteúdo (write/merge) quando o chamador não
 * informa `author`. Ao contrário do bootstrap, aqui o timestamp é o do
 * relógio (commits de conteúdo não precisam ser determinísticos).
 */
const MEMORY_COMMIT_AUTHOR = {
  name: 'kanban-ai',
  email: 'memory@kanban-ai',
} as const;

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

  // ---------------------------------------------------------------------------
  // Camada 1 — read/write/merge/diff/history de neurônios (US-136..141).
  //
  // Todo conteúdo é versionado como blob num path do bare repo. Não há working
  // tree (repo bare): escrita = writeBlob → writeTree → commit → writeRef. A
  // fonte da verdade é o git; índice/locks/WS são Camada 2 e NÃO vivem aqui.
  // ---------------------------------------------------------------------------

  /**
   * US-136 — Lê o conteúdo de um neurônio por `path` num commit específico.
   *
   * @param neuronPath path do neurônio no repo (ex.: `api/cards.md`).
   * @param ref ref/SHA a resolver; default `main` (HEAD lógico da memória).
   * @returns conteúdo utf8 do blob, ou `null` se o path não existir naquele ref.
   */
  async readNeuron(
    neuronPath: string,
    ref: string = MEMORY_DEFAULT_BRANCH,
  ): Promise<string | null> {
    const dir = this.gitDir;
    const filepath = this.normalizePath(neuronPath);
    let oid: string;
    try {
      oid = await git.resolveRef({ fs, dir, gitdir: dir, ref });
    } catch (err) {
      if (this.isNotFound(err)) {
        return null;
      }
      throw err;
    }
    try {
      const { blob } = await git.readBlob({ fs, dir, gitdir: dir, oid, filepath });
      return Buffer.from(blob).toString('utf8');
    } catch (err) {
      if (this.isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * US-137 — Grava/atualiza um neurônio numa **branch efêmera por sessão**
   * (`mem/ai/<sessao>/<path>`) derivada de `main`, e commita a mudança.
   *
   * Escrita otimista da colmeia (ADR-0027): cada sessão escreve na sua própria
   * branch; a integração em `main` é feita depois por merge 3-way (US-138). Em
   * repo bare montamos a nova árvore a partir da árvore do commit-base,
   * substituindo o blob do `path`.
   */
  async writeNeuron(input: {
    path: string;
    content: string;
    sessionId: string;
    message: string;
    author?: { name: string; email: string };
  }): Promise<{ oid: string; branch: string }> {
    const dir = this.gitDir;
    const filepath = this.normalizePath(input.path);
    const branch = this.sessionBranch(input.sessionId, filepath);

    // Base da branch: a própria branch se já existe; senão, main.
    const baseOid = await this.resolveBranchBase(branch);
    const baseTree = await git.readTree({ fs, dir, gitdir: dir, oid: baseOid });

    const blobOid = await git.writeBlob({
      fs,
      dir,
      gitdir: dir,
      blob: Buffer.from(input.content, 'utf8'),
    });
    const treeOid = await this.writeTreeWithBlob(baseTree.oid, filepath, blobOid);

    const author = { ...(input.author ?? MEMORY_COMMIT_AUTHOR) };
    const oid = await git.commit({
      fs,
      dir,
      gitdir: dir,
      message: input.message,
      author,
      committer: author,
      tree: treeOid,
      parent: [baseOid],
      ref: `refs/heads/${branch}`,
    });
    return { oid, branch };
  }

  /**
   * US-138 — Merge 3-way da branch da sessão para `main`.
   *
   * Se o merge é limpo, atualiza `main` (fast-forward ou commit de merge) e
   * retorna `merged: true`. Em conflito, NÃO escreve em `main` e retorna
   * `conflict: true` — a resolução é responsabilidade da Camada 2/EP-80
   * (árbitro/REVIEW); aqui só SINALIZAMOS.
   */
  async mergeSessionBranch(input: {
    sessionId: string;
    path: string;
    author?: { name: string; email: string };
  }): Promise<{ merged: boolean; oid?: string; conflict: boolean }> {
    const dir = this.gitDir;
    const filepath = this.normalizePath(input.path);
    const branch = this.sessionBranch(input.sessionId, filepath);
    const author = { ...(input.author ?? MEMORY_COMMIT_AUTHOR) };

    try {
      const result = await git.merge({
        fs,
        dir,
        gitdir: dir,
        ours: MEMORY_DEFAULT_BRANCH,
        theirs: branch,
        author,
        committer: author,
        abortOnConflict: true,
      });
      // `git.merge` só atualiza a ref quando `dryRun` é falso (default). O oid
      // resultante é `mergeCommit` (merge real) ou `oid` (fast-forward).
      const oid =
        (result as { mergeCommit?: string; oid?: string }).mergeCommit ??
        (result as { oid?: string }).oid;
      return { merged: true, oid, conflict: false };
    } catch (err) {
      if (this.isMergeConflict(err)) {
        return { merged: false, conflict: true };
      }
      throw err;
    }
  }

  /**
   * US-139 — Diff de um neurônio entre dois commits: retorna o conteúdo do
   * `path` em `from` e `to` mais o status da mudança (added/modified/deleted/
   * unchanged). Diff textual granular é responsabilidade do consumidor (UI).
   */
  async diffNeuron(input: {
    path: string;
    from: string;
    to?: string;
  }): Promise<{
    path: string;
    status: 'added' | 'modified' | 'deleted' | 'unchanged';
    before: string | null;
    after: string | null;
  }> {
    const to = input.to ?? MEMORY_DEFAULT_BRANCH;
    const before = await this.readNeuron(input.path, input.from);
    const after = await this.readNeuron(input.path, to);
    let status: 'added' | 'modified' | 'deleted' | 'unchanged';
    if (before === null && after === null) {
      status = 'unchanged';
    } else if (before === null) {
      status = 'added';
    } else if (after === null) {
      status = 'deleted';
    } else {
      status = before === after ? 'unchanged' : 'modified';
    }
    return { path: this.normalizePath(input.path), status, before, after };
  }

  /**
   * US-140 — Histórico (git log) dos commits que TOCARAM um neurônio,
   * ordenado do mais recente para o mais antigo. Filtra por mudança de blob no
   * `path` (equivalente a `git log -- <path>`).
   */
  async historyNeuron(
    neuronPath: string,
    ref: string = MEMORY_DEFAULT_BRANCH,
  ): Promise<
    Array<{
      oid: string;
      message: string;
      author: { name: string; email: string; timestamp: number };
    }>
  > {
    const dir = this.gitDir;
    const filepath = this.normalizePath(neuronPath);
    let commits: Awaited<ReturnType<typeof git.log>>;
    try {
      commits = await git.log({ fs, dir, gitdir: dir, ref, filepath, force: true });
    } catch (err) {
      if (this.isNotFound(err)) {
        return [];
      }
      throw err;
    }
    return commits.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      author: {
        name: entry.commit.author.name,
        email: entry.commit.author.email,
        timestamp: entry.commit.author.timestamp,
      },
    }));
  }

  /**
   * Resolve o SHA do commit apontado por `ref` (default `main`). Usado pela
   * Camada 2 para gravar o `headCommit` de origem de cada projeção.
   */
  async resolveHead(ref: string = MEMORY_DEFAULT_BRANCH): Promise<string> {
    const dir = this.gitDir;
    return git.resolveRef({ fs, dir, gitdir: dir, ref });
  }

  /**
   * Lista os paths de TODOS os neurônios (blobs) existentes num `ref` (default
   * `main`). Base para o rebuild do índice (US-161). Percorre a árvore do
   * commit recursivamente. Ignora branches efêmeras `mem/ai/*` — só o estado
   * integrado em `main` conta como fonte da verdade.
   */
  async listNeurons(ref: string = MEMORY_DEFAULT_BRANCH): Promise<string[]> {
    const dir = this.gitDir;
    let oid: string;
    try {
      oid = await git.resolveRef({ fs, dir, gitdir: dir, ref });
    } catch (err) {
      if (this.isNotFound(err)) {
        return [];
      }
      throw err;
    }
    const paths: string[] = [];
    const walk = async (treeOid: string, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({ fs, dir, gitdir: dir, oid: treeOid });
      for (const entry of tree) {
        const full = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === 'tree') {
          await walk(entry.oid, full);
        } else if (entry.type === 'blob') {
          paths.push(full);
        }
      }
    };
    const { commit } = await git.readCommit({ fs, dir, gitdir: dir, oid });
    await walk(commit.tree, '');
    return paths.sort();
  }

  // ---------------------------------------------------------------------------
  // Helpers internos (Camada 1).
  // ---------------------------------------------------------------------------

  /** Normaliza o path do neurônio (sem `/` inicial, sem `..`, sempre POSIX). */
  private normalizePath(neuronPath: string): string {
    const posix = neuronPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (posix.length === 0 || posix.split('/').some((seg) => seg === '..')) {
      throw new Error(
        `Path de neurônio inválido: "${neuronPath}". Use um path relativo POSIX sem "..".`,
      );
    }
    return posix;
  }

  /** Nome da branch efêmera por sessão para um path (`mem/ai/<sessao>/<path>`). */
  private sessionBranch(sessionId: string, filepath: string): string {
    const safeSession = sessionId.replace(/[^\w.-]+/g, '-');
    return `mem/ai/${safeSession}/${filepath}`;
  }

  /** Oid base de uma branch: a própria se existe, senão o tip de `main`. */
  private async resolveBranchBase(branch: string): Promise<string> {
    const dir = this.gitDir;
    try {
      return await git.resolveRef({ fs, dir, gitdir: dir, ref: `refs/heads/${branch}` });
    } catch (err) {
      if (!this.isNotFound(err)) {
        throw err;
      }
      return git.resolveRef({ fs, dir, gitdir: dir, ref: MEMORY_DEFAULT_BRANCH });
    }
  }

  /**
   * Escreve recursivamente uma nova árvore a partir de `baseTreeOid`,
   * substituindo (ou criando) o blob em `filepath`. Retorna o oid da árvore
   * raiz resultante. Suporta paths aninhados criando subárvores conforme
   * necessário (repo bare, sem working tree).
   */
  private async writeTreeWithBlob(
    baseTreeOid: string,
    filepath: string,
    blobOid: string,
  ): Promise<string> {
    const dir = this.gitDir;
    const segments = filepath.split('/');
    const [head, ...rest] = segments;

    const base = await git.readTree({ fs, dir, gitdir: dir, oid: baseTreeOid });
    const entries = base.tree.filter((e) => e.path !== head);

    if (rest.length === 0) {
      entries.push({ mode: '100644', path: head, oid: blobOid, type: 'blob' });
    } else {
      const existing = base.tree.find((e) => e.path === head && e.type === 'tree');
      const emptyTree = await git.writeTree({ fs, dir, gitdir: dir, tree: [] });
      const childBase = existing ? existing.oid : emptyTree;
      const childOid = await this.writeTreeWithBlob(childBase, rest.join('/'), blobOid);
      entries.push({ mode: '040000', path: head, oid: childOid, type: 'tree' });
    }

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return git.writeTree({ fs, dir, gitdir: dir, tree: entries });
  }

  /** `true` se o erro do isomorphic-git é um "não encontrado". */
  private isNotFound(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    const name = (err as { name?: string })?.name;
    return code === 'NotFoundError' || name === 'NotFoundError';
  }

  /** `true` se o erro do isomorphic-git é um conflito de merge. */
  private isMergeConflict(err: unknown): boolean {
    const code = (err as { code?: string })?.code;
    const name = (err as { name?: string })?.name;
    return code === 'MergeNotSupportedError' || name === 'MergeConflictError' || code === 'MergeConflictError';
  }
}
