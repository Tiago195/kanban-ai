import { Inject, Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';

type CommandResult = {
  stdout: string;
  stderr: string;
};

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

    this.logger.log(
      `workdir do agent resolvido para o repo-alvo (sem worktree): ${resolvedTarget} (key=${safeKey})`,
    );
    return resolvedTarget;
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
   * Limpeza de fim de story. No modelo atual o agent trabalha DIRETO no repo-alvo
   * (sem worktree), então NÃO há working tree isolado a destruir — as mudanças
   * ficam no próprio projeto, exatamente o comportamento desejado. Este método
   * apenas solta o tracking em memória e remove eventuais diretórios de fallback
   * antigos. Nunca toca no repo-alvo (não roda `git worktree remove`, que
   * apagaria o trabalho do agent).
   */
  async cleanupWorktree(key: string): Promise<void> {
    const safeKey = this.sanitizeKey(key);

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
