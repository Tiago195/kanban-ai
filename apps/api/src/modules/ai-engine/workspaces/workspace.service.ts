import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

type CommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * US-OBS2 (ADR-0035, refina ADR-0008) — política de worktree resiliente. As
 * funções abaixo são PURAS (sem I/O) e decidem, a partir da config, o que o
 * caminho de criação do worktree deve materializar. São exercitadas por specs
 * de unidade independentemente do worktree real existir, e reusadas pelo fluxo
 * de `resolveWorkdir` quando `worktreeIsolated=true`.
 */
export interface WorktreePolicy {
  /** usa `git worktree add` por execução (senão, roda direto no repo-alvo). */
  isolated: boolean;
  /** espelha paths ignorados pesados (ex.: node_modules) via symlink. */
  mirrorIgnoredPaths: boolean;
  /** roda `git submodule update --init --recursive` no worktree. */
  initSubmodules: boolean;
  /** captura/reaplica patch não-commitado ao trash/restart. */
  preservePatchOnTrash: boolean;
}

/** Deriva a `WorktreePolicy` das flags de config (função pura, testável). */
export function resolveWorktreePolicy(config: AppConfig): WorktreePolicy {
  const agent = config.agent;
  return {
    isolated: agent.worktreeIsolated,
    mirrorIgnoredPaths: agent.worktreeMirrorIgnored,
    initSubmodules: agent.worktreeInitSubmodules,
    preservePatchOnTrash: agent.worktreePreservePatch,
  };
}

/**
 * Decide se um path ignorado deve ser ESPELHADO (symlink) para o worktree. Puro:
 * só materializa quando a política pede e o candidato é um diretório "pesado"
 * conhecido (node_modules, .venv, etc.) ou explicitamente marcado como ignorado.
 * Nunca espelha `.git` nem paths que escapam do repo.
 */
export function shouldMirrorIgnoredPath(
  policy: WorktreePolicy,
  relPath: string,
): boolean {
  if (!policy.isolated || !policy.mirrorIgnoredPaths) return false;
  const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.length === 0) return false;
  if (normalized === '.git' || normalized.startsWith('.git/')) return false;
  if (normalized.includes('..')) return false;
  return true;
}

/** Puro: nome canônico do branch de execução para uma key sanitizada. */
export function executionBranchName(safeKey: string): string {
  return `kanban-ai/${safeKey}`;
}

/** #1: resultado de um script de validação rodado no worktree. */
export interface ProjectCheckResult {
  /** nome do script npm (test/build/lint). */
  name: string;
  /** o script existia no package.json e foi executado? */
  ran: boolean;
  /** passou? (scripts inexistentes contam como `passed` para não bloquear). */
  passed: boolean;
  exitCode: number | null;
  /** stdout+stderr combinados (truncados pelo consumidor). */
  output: string;
}

/** Erro de configuração do projeto-alvo (ex.: aiProject ausente ou inválido). */
export class TargetProjectError extends Error {}

@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly fallbackDirsByKey = new Map<string, string>();
  /** Repo-alvo (aiProject) associado a cada key, para limpar o worktree certo. */
  private readonly targetRepoByKey = new Map<string, string>();
  /**
   * US-OBS2: worktree isolado criado para cada key (quando `worktreeIsolated`).
   * Guarda o path do worktree e o repo-alvo do qual foi derivado, para o
   * `cleanupWorktree` rodar `git worktree remove` SÓ contra worktrees que ESTE
   * serviço criou (nunca contra o repo-alvo direto).
   */
  private readonly isolatedWorktreeByKey = new Map<
    string,
    { worktreePath: string; targetRepo: string; branch: string }
  >();
  /**
   * US-OBS2 (PR-4): patch não-commitado capturado ao remover um worktree, para
   * reaplicar na recriação (patch-preserve entre restarts). Chave = safeKey.
   */
  private readonly preservedPatchByKey = new Map<string, string>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Resolve e valida o diretório de trabalho do agent. Diferente do modelo
   * antigo (worktree isolado + branch efêmera, que era destruído no cleanup e
   * fazia o trabalho nunca aterrissar no repo), o agent agora trabalha
   * **diretamente no working tree do repo-alvo (`aiProject`), na branch que já
   * estiver aberta**, sem criar branch/worktree e sem commitar — deixando os
   * arquivos alterados no próprio projeto. A colisão entre stories concorrentes
   * do mesmo repo é resolvida por SERIALIZAÇÃO no orchestrator (uma story In
   * Progress por aiProject), não por isolamento em worktree.
   *
   * Mantém os mesmos guard-rails do modelo anterior: recusa aiProject vazio,
   * dentro do próprio kanban-ai, inexistente ou que não seja repo git. Lança
   * `TargetProjectError` nesses casos (o orchestrator recusa rodar).
   *
   * @param key            chave estável (storyId), usada só para logs/tracking.
   * @param targetRepoPath caminho absoluto do repo-alvo (aiProject).
   */
  async resolveWorkdir(key: string, targetRepoPath?: string | null): Promise<string> {
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

    // Repo recém-criado (`git init`) tem HEAD "unborn": o `git diff HEAD` do
    // captureDiff falha até existir um commit. Garantimos um commit inicial
    // vazio (sem tocar arquivos do usuário) para o diff funcionar. No-op se já
    // houver commits.
    await this.ensureInitialCommit(resolvedTarget);

    const policy = resolveWorktreePolicy(this.config);

    // US-OBS2 (ADR-0035, refina ADR-0008): quando o worktree isolado está
    // LIGADO, o agent trabalha num `git worktree` dedicado por execução — nunca
    // no working tree do repo-alvo. Fallback EXATO ao comportamento legado
    // (retornar o próprio repo-alvo) quando desligado, garantindo retrocompat.
    if (!policy.isolated) {
      this.logger.log(
        `workdir do agent resolvido para o repo-alvo (sem worktree): ${resolvedTarget} (key=${safeKey})`,
      );
      return resolvedTarget;
    }

    const worktreePath = await this.createIsolatedWorktree(
      safeKey,
      resolvedTarget,
      policy,
    );
    this.logger.log(
      `workdir do agent resolvido para worktree ISOLADO: ${worktreePath} ` +
        `(key=${safeKey}, target=${resolvedTarget})`,
    );
    return worktreePath;
  }

  /**
   * US-OBS2 (PR-0): cria (ou reaproveita) um worktree git isolado para a `key`,
   * derivado de `targetRepo`, e retorna seu caminho absoluto. Cria um branch de
   * execução `kanban-ai/<safeKey>` a partir do HEAD do repo-alvo. Todo o git é
   * do ENGINE (ADR-0008): o agent nunca roda git. Mantém caminhos absolutos
   * (ADR-0019). PR-2 (mirror ignored paths), PR-3 (submodules) e PR-4
   * (patch-preserve) são aplicados aqui, atrás das respectivas flags.
   */
  private async createIsolatedWorktree(
    safeKey: string,
    targetRepo: string,
    policy: WorktreePolicy,
  ): Promise<string> {
    // Reaproveita um worktree já criado para a mesma key (iterações da mesma
    // story reusam o mesmo isolamento em vez de recriar).
    const existing = this.isolatedWorktreeByKey.get(safeKey);
    if (existing && (await this.pathExists(existing.worktreePath))) {
      return existing.worktreePath;
    }

    const base = path.resolve(this.config.agent.workspacesDir);
    await fs.mkdir(base, { recursive: true });
    const worktreePath = path.join(base, safeKey);
    const branch = executionBranchName(safeKey);

    // Limpeza defensiva: se sobrou um worktree órfão desse path (restart), o
    // `git worktree add` falharia. Removemos o registro e o diretório antes.
    await this.pruneStaleWorktree(targetRepo, worktreePath);

    // Cria o branch de execução (idempotente: se já existir, reusa). `-B` força
    // o branch para o HEAD atual; usamos `add -B` que cria/reseta o branch.
    await this.runGit(
      ['worktree', 'add', '-B', branch, worktreePath, 'HEAD'],
      targetRepo,
    );

    this.isolatedWorktreeByKey.set(safeKey, { worktreePath, targetRepo, branch });

    // PR-2: espelha paths ignorados pesados (node_modules, etc.) via symlink.
    if (policy.mirrorIgnoredPaths) {
      await this.mirrorIgnoredPaths(targetRepo, worktreePath, policy);
    }

    // PR-3: inicializa submódulos no worktree.
    if (policy.initSubmodules) {
      await this.initSubmodules(worktreePath);
    }

    // PR-4: reaplica um patch preservado de uma execução anterior (restart).
    if (policy.preservePatchOnTrash) {
      await this.reapplyPreservedPatch(safeKey, worktreePath);
    }

    return worktreePath;
  }

  /**
   * PR-2: materializa, DENTRO do worktree, os paths ignorados pesados do
   * repo-alvo via SYMLINK (barato — não copia). Lê `.gitignore` do repo-alvo e
   * cria links para as entradas de topo que existem como diretório no alvo e
   * que a política aprova (`shouldMirrorIgnoredPath`). Best-effort: qualquer
   * falha por entrada é logada e ignorada (nunca derruba a criação do worktree).
   */
  private async mirrorIgnoredPaths(
    targetRepo: string,
    worktreePath: string,
    policy: WorktreePolicy,
  ): Promise<void> {
    const candidates = await this.readTopLevelIgnoredDirs(targetRepo);
    for (const rel of candidates) {
      if (!shouldMirrorIgnoredPath(policy, rel)) continue;
      const source = path.join(targetRepo, rel);
      const linkPath = path.join(worktreePath, rel);
      try {
        if (!(await this.isDirectory(source))) continue;
        // Não sobrescreve algo já presente no worktree (ex.: versionado).
        if (await this.pathExists(linkPath)) continue;
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.symlink(source, linkPath, 'dir');
        this.logger.log(`mirror (symlink) de ignored path: ${rel} → ${source}`);
      } catch (error: unknown) {
        this.logger.warn(
          `Falha ao espelhar ignored path ${rel}: ${this.extractErrorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Lê entradas de topo do `.gitignore` do repo-alvo que sejam diretórios,
   * normalizadas para nomes relativos simples (ex.: `node_modules`, `.venv`).
   * Não interpreta globs complexos — pega entradas simples de topo, que cobrem
   * o caso pesado (node_modules) alvo do PR-2. Vazio se não houver `.gitignore`.
   */
  private async readTopLevelIgnoredDirs(targetRepo: string): Promise<string[]> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(targetRepo, '.gitignore'), 'utf8');
    } catch {
      return [];
    }
    const out = new Set<string>();
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('!')) continue; // negação — ignora
      // Só entradas de topo simples (sem `/` interno, sem glob).
      const name = trimmed.replace(/\/+$/, '');
      if (name.includes('/') || name.includes('*') || name.includes('?')) continue;
      if (name.startsWith('.git')) continue;
      out.add(name);
    }
    return [...out];
  }

  /** PR-3: inicializa submódulos no worktree (best-effort, não bloqueia). */
  private async initSubmodules(worktreePath: string): Promise<void> {
    try {
      await this.runGit(['submodule', 'update', '--init', '--recursive'], worktreePath);
      this.logger.log(`submódulos inicializados no worktree: ${worktreePath}`);
    } catch (error: unknown) {
      this.logger.warn(
        `Falha ao inicializar submódulos em ${worktreePath}: ${this.extractErrorMessage(error)}`,
      );
    }
  }

  /**
   * PR-4: se há um patch preservado para esta key (capturado no cleanup de uma
   * execução anterior — restart), reaplica-o no worktree recriado via
   * `git apply`. Best-effort e idempotente-ish: em falha loga e segue (o
   * trabalho não commitado seria refeito, mas o loop não quebra).
   */
  private async reapplyPreservedPatch(safeKey: string, worktreePath: string): Promise<void> {
    const patch = this.preservedPatchByKey.get(safeKey);
    if (!patch || patch.trim().length === 0) return;
    try {
      await this.applyPatch(worktreePath, patch);
      this.logger.log(`patch preservado reaplicado no worktree: ${worktreePath}`);
    } catch (error: unknown) {
      this.logger.warn(
        `Falha ao reaplicar patch preservado em ${worktreePath}: ${this.extractErrorMessage(error)}`,
      );
    } finally {
      this.preservedPatchByKey.delete(safeKey);
    }
  }

  /** Aplica um unified diff no worktree via `git apply` (stdin). */
  private applyPatch(worktreePath: string, patch: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = execFile(
        'git',
        ['apply', '--whitespace=nowarn', '-'],
        { cwd: worktreePath, encoding: 'utf8', timeout: 15_000 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`git apply falhou: ${stderr || error.message}`));
            return;
          }
          resolve();
        },
      );
      child.stdin?.end(patch);
    });
  }

  /**
   * PR-4: captura o patch não-commitado do worktree (git é do ENGINE, ADR-0008)
   * como unified diff, para preservar entre restart. Retorna '' se não houver
   * worktree isolado, não houver mudanças, ou em falha.
   */
  private async captureWorktreePatch(worktreePath: string): Promise<string> {
    const run = (args: string[]): Promise<string> =>
      new Promise<string>((resolve) => {
        execFile(
          'git',
          args,
          { cwd: worktreePath, encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 },
          (error, stdout) => resolve(error ? '' : stdout ?? ''),
        );
      });
    // `-N` faz arquivos novos aparecerem no diff sem alterar conteúdo.
    await run(['add', '-A', '-N']);
    let diff = await run(['diff', 'HEAD']);
    if (!diff) diff = await run(['diff']);
    return diff;
  }

  /**
   * Remove qualquer registro/diretório órfão de um worktree que ocuparia
   * `worktreePath` (restart deixou lixo). `git worktree prune` limpa registros
   * mortos; depois removemos o diretório se ainda existir.
   */
  private async pruneStaleWorktree(targetRepo: string, worktreePath: string): Promise<void> {
    try {
      await this.runGit(['worktree', 'remove', '--force', worktreePath], targetRepo);
    } catch {
      // path pode nem estar registrado — segue para prune/limpeza de diretório.
    }
    try {
      await this.runGit(['worktree', 'prune'], targetRepo);
    } catch {
      /* best-effort */
    }
    if (await this.pathExists(worktreePath)) {
      await this.removeDirIfExists(worktreePath);
    }
  }

  /**
   * Retorna o caminho absoluto do repo-alvo (aiProject) resolvido para `key`,
   * ou `null` se ainda não resolvido. Usado pela SERIALIZAÇÃO do orchestrator
   * para detectar duas stories apontando para o mesmo repo.
   */
  resolveTargetRepo(targetRepoPath?: string | null): string | null {
    const target = (targetRepoPath ?? '').trim();
    if (!target) return null;
    return path.resolve(target);
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

  /**
   * #1: roda os scripts de validação disponíveis no worktree (auto-detect a
   * partir dos `scripts` do package.json) e retorna o resultado de cada um.
   * Nunca roda `install`; só scripts já resolvíveis. Sem shell (execFile).
   */
  async runProjectChecks(
    worktreePath: string,
    wanted: string[],
  ): Promise<ProjectCheckResult[]> {
    const scripts = await this.readPackageScripts(worktreePath);
    const results: ProjectCheckResult[] = [];
    for (const name of wanted) {
      if (!scripts.has(name)) {
        results.push({ name, ran: false, passed: true, exitCode: null, output: '' });
        continue;
      }
      results.push(await this.runNpmScript(worktreePath, name));
    }
    return results;
  }

  /**
   * #7: true se `relPath` existe DENTRO do worktree. Rejeita paths que tentam
   * escapar do worktree (via `..` ou path absoluto) por segurança.
   */
  async fileExistsInWorktree(worktreePath: string, relPath: string): Promise<boolean> {
    const base = path.resolve(worktreePath);
    const resolved = path.resolve(base, relPath);
    const rel = path.relative(base, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return this.pathExists(resolved);
  }

  /**
   * Validação direcionada por fluxo: dado um arquivo fonte relativo ao worktree,
   * procura por specs co-located seguindo a convenção de nome. Para cada marcador
   * (ex.: `.spec.`, `.test.`) monta o candidato `<basename><marcador><ext>` no
   * mesmo diretório do fonte e verifica existência. Também aceita o próprio
   * arquivo caso ele JÁ seja um teste. Pragmático por convenção — não parseia
   * imports. Retorna paths relativos (deduplicados, sem o fonte não-teste).
   */
  async findRelatedTestFiles(
    worktreePath: string,
    sourceRelPath: string,
    testMarkers: string[],
  ): Promise<string[]> {
    const normalized = sourceRelPath.split(path.sep).join('/');
    const dir = path.posix.dirname(normalized);
    const ext = path.posix.extname(normalized);
    const base = path.posix.basename(normalized, ext);

    // Se o arquivo declarado já é um teste, ele mesmo é cobertura.
    if (testMarkers.some((m) => normalized.includes(m))) {
      const exists = await this.fileExistsInWorktree(worktreePath, sourceRelPath);
      return exists ? [normalized] : [];
    }

    const found = new Set<string>();
    for (const marker of testMarkers) {
      // marker tipicamente ".spec." ou ".test." -> foo.ts vira foo.spec.ts.
      const infix = marker.replace(/^\.|\.$/g, '');
      const candidate = path.posix.join(dir === '.' ? '' : dir, `${base}.${infix}${ext}`);
      if (await this.fileExistsInWorktree(worktreePath, candidate)) {
        found.add(candidate);
      }
    }
    return [...found];
  }

  /**
   * Roda os testes do projeto RESTRITOS a `testFiles` no worktree. Descobre o
   * runner a partir do script `test` do package.json: se for vitest/jest,
   * ambos aceitam paths posicionais via `npm test -- <arquivos>`. Se o runner
   * não puder ser determinado com segurança, retorna um resultado `ran:false`
   * (o consumidor faz fallback para os scripts globais) — nunca inventa flags
   * que possam quebrar. Sem shell (execFile).
   */
  async runTestsForFiles(
    worktreePath: string,
    testFiles: string[],
  ): Promise<ProjectCheckResult> {
    if (testFiles.length === 0) {
      return { name: 'test:flow', ran: false, passed: true, exitCode: null, output: '' };
    }
    const testScript = await this.readTestScriptCommand(worktreePath);
    if (!testScript) {
      return {
        name: 'test:flow',
        ran: false,
        passed: true,
        exitCode: null,
        output: 'runner de teste não determinado com segurança (script test="")',
      };
    }

    // BUG-10/10b: runners baseados em `node` (frequentemente encadeados, ex.:
    // `node a.test.js && node b.test.js`) NÃO aceitam paths posicionais com
    // segurança — o `npm test -- <arquivos>` só chegaria ao ÚLTIMO comando da
    // cadeia e o quebraria. Mas a suite ainda EXERCITA os specs co-located do
    // fluxo. Nesse caso rodamos a suite `test` inteira, sem posicionais, e
    // consideramos o fluxo exercitado (ran:true) — em vez de pular por
    // "runner não determinado". Determinístico: só quando o script é `node`.
    if (this.isNodeRunner(testScript) && !this.isPositionalPathRunner(testScript)) {
      return this.runNpmScript(worktreePath, 'test', [], 'test:flow');
    }

    if (!this.isPositionalPathRunner(testScript)) {
      // Runner desconhecido e sem paths posicionais seguros.
      return {
        name: 'test:flow',
        ran: false,
        passed: true,
        exitCode: null,
        output: `runner de teste não determinado com segurança (script test="${testScript}")`,
      };
    }
    // vitest sem subcomando entra em watch mode; força rodada única com `run`.
    // (jest é single-run por padrão; CI=1 no env cobre ambos como reforço.)
    const isVitest = /\bvitest\b/.test(testScript) && !/\bvitest\s+run\b/.test(testScript);
    const positional = isVitest ? ['run', ...testFiles] : [...testFiles];
    return this.runNpmScript(worktreePath, 'test', ['--', ...positional], 'test:flow');
  }

  /** Lê o comando bruto do script `test` do package.json (undefined se ausente). */
  private async readTestScriptCommand(worktreePath: string): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(path.join(worktreePath, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      const cmd = pkg.scripts?.test;
      return typeof cmd === 'string' ? cmd : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * True se o comando do script test usa um runner que aceita paths de teste
   * posicionais de forma segura (vitest/jest). Conservador: só libera runners
   * conhecidos.
   */
  private isPositionalPathRunner(testScript: string): boolean {
    return /\b(vitest|jest)\b/.test(testScript);
  }

  /**
   * True se o script `test` executa specs via `node` (inclui cadeias como
   * `node a.test.js && node b.test.js`). Esses runners rodam a suite inteira;
   * não aceitam paths posicionais, mas ainda exercitam os specs do fluxo.
   */
  private isNodeRunner(testScript: string): boolean {
    return /\bnode\b/.test(testScript);
  }


  /** Lê os nomes de scripts do package.json do worktree (vazio se ausente). */
  private async readPackageScripts(worktreePath: string): Promise<Set<string>> {
    try {
      const raw = await fs.readFile(path.join(worktreePath, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
      return new Set(Object.keys(pkg.scripts ?? {}));
    } catch {
      return new Set();
    }
  }

  /** Roda `npm run <name>` no worktree com timeout; captura saída e exit code. */
  private runNpmScript(
    worktreePath: string,
    name: string,
    extraArgs: string[] = [],
    resultName: string = name,
  ): Promise<ProjectCheckResult> {
    const timeout = this.config.agent.validationTimeoutMs;
    return new Promise<ProjectCheckResult>((resolve) => {
      execFile(
        'npm',
        ['run', name, '--silent', ...extraArgs],
        {
          cwd: worktreePath,
          encoding: 'utf8',
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          // CI=1 força runners (vitest/jest) a rodada única não-interativa,
          // evitando modo watch que travaria até o timeout.
          env: { ...process.env, CI: '1' },
        },
        (error, stdout, stderr) => {
          const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
          if (error) {
            const exitCode =
              typeof (error as { code?: unknown }).code === 'number'
                ? (error as { code: number }).code
                : null;
            resolve({ name: resultName, ran: true, passed: false, exitCode, output });
            return;
          }
          resolve({ name: resultName, ran: true, passed: true, exitCode: 0, output });
        },
      );
    });
  }

  /**
   * US-OBS3 (ADR-0037) — Informação do worktree ISOLADO ativo para uma `key`
   * (storyId), ou `null` quando não há isolamento (flag off / não criado). O
   * gate de auto-commit usa isto para decidir `skippedReason='no-isolated-worktree'`
   * — nunca commitamos direto no repo-alvo do usuário.
   */
  getIsolatedWorktree(
    key: string,
  ): { worktreePath: string; targetRepo: string; branch: string } | null {
    const safeKey = this.sanitizeKey(key);
    const isolated = this.isolatedWorktreeByKey.get(safeKey);
    return isolated ? { ...isolated } : null;
  }

  /**
   * US-OBS3 (ADR-0037) — Commit das mudanças do worktree ISOLADO pelo ENGINE
   * (nunca pelo agent, ver ADR-0008). SÓ age contra o worktree isolado
   * rastreado para a `key`; se não houver isolamento, retorna `null` e o
   * chamador reporta `skippedReason='no-isolated-worktree'`.
   *
   * Retorna o SHA + branch quando commitou, `{ sha: null }` quando não havia
   * nada a commitar, ou `null` quando não há worktree isolado. Best-effort:
   * qualquer falha de git é propagada como erro (o chamador trata).
   */
  async commitIsolatedWorktree(
    key: string,
    message: string,
  ): Promise<{ sha: string | null; branch: string } | null> {
    const safeKey = this.sanitizeKey(key);
    const isolated = this.isolatedWorktreeByKey.get(safeKey);
    if (!isolated) return null;
    const { worktreePath, branch } = isolated;

    // Stage tudo (inclui novos/removidos) no worktree isolado.
    await this.runGit(['add', '-A'], worktreePath);

    // Nada staged? Não commita (evita commit vazio).
    const status = await this.runGit(['status', '--porcelain'], worktreePath);
    if (!status.stdout.trim()) {
      return { sha: null, branch };
    }

    await this.runGit(
      ['-c', 'user.name=kanban-ai', '-c', 'user.email=agent@kanban-ai', 'commit', '-m', message],
      worktreePath,
    );
    const head = await this.runGit(['rev-parse', 'HEAD'], worktreePath);
    return { sha: head.stdout.trim(), branch };
  }

  /**
   * Limpeza de fim de story.
   *
   * - Com o worktree isolado LIGADO (US-OBS2): captura o patch não-commitado
   *   (PR-4, se `worktreePreservePatch`) para reaplicar numa recriação futura,
   *   e roda `git worktree remove --force` APENAS contra o worktree que ESTE
   *   serviço criou — NUNCA contra o repo-alvo direto (não apagaria o trabalho
   *   do usuário).
   * - Com o worktree DESLIGADO (legado): o agent trabalha direto no repo-alvo,
   *   então NÃO há working tree isolado a destruir; apenas solta o tracking em
   *   memória e limpa diretórios de fallback antigos (comportamento idêntico ao
   *   anterior — nunca roda `git worktree remove`).
   */
  async cleanupWorktree(key: string): Promise<void> {
    const safeKey = this.sanitizeKey(key);

    const isolated = this.isolatedWorktreeByKey.get(safeKey);
    if (isolated) {
      const policy = resolveWorktreePolicy(this.config);
      if (policy.preservePatchOnTrash) {
        const patch = await this.captureWorktreePatch(isolated.worktreePath).catch(() => '');
        if (patch && patch.trim().length > 0) {
          this.preservedPatchByKey.set(safeKey, patch);
        }
      }
      try {
        await this.runGit(
          ['worktree', 'remove', '--force', isolated.worktreePath],
          isolated.targetRepo,
        );
      } catch (error: unknown) {
        this.logger.warn(
          `Falha ao remover worktree isolado ${isolated.worktreePath}: ${this.extractErrorMessage(error)}`,
        );
        // Fallback: remove o diretório manualmente e limpa o registro.
        await this.removeDirIfExists(isolated.worktreePath);
        await this.runGit(['worktree', 'prune'], isolated.targetRepo).catch(() => undefined);
      }
      this.isolatedWorktreeByKey.delete(safeKey);
    }

    const fallbackPath = this.fallbackDirsByKey.get(safeKey);
    if (fallbackPath) {
      await this.removeDirIfExists(fallbackPath);
      this.fallbackDirsByKey.delete(safeKey);
    }

    this.targetRepoByKey.delete(safeKey);
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

  /** True se `targetPath` existe e é um diretório (segue symlinks). */
  private async isDirectory(targetPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(targetPath);
      return stat.isDirectory();
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
