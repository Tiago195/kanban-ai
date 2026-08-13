import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MemoryGitService } from './memory-git.service';
import { MemoryIndexService } from './memory-index.service';
import { MEMORY_MODULE_PREFIX } from './memory-policy.service';

/** Diretórios de topo que costumam AGRUPAR módulos (não são módulos em si). */
const MODULE_CONTAINER_DIRS = ['modules', 'features', 'packages', 'services', 'domains'];
/** Diretórios de código-fonte varridos em busca de containers/módulos. */
const SOURCE_ROOTS = ['apps', 'src', 'packages', 'lib'];
/** Ruído que nunca é módulo. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', 'tmp', '.cache',
]);

/** Um módulo detectado no repo-alvo e o path lógico do seu neurônio. */
export interface DetectedModule {
  /** Nome curto do módulo (segmento final). */
  module: string;
  /** Diretório do módulo relativo à raiz do repo (POSIX). */
  dir: string;
  /** Path lógico do neurônio: `modules/<modulo>.md`. */
  neuronPath: string;
}

/**
 * US-PROJ4 (§1.2 / decisão #6) — aplica o `namespace` do Project a um path de
 * neurônio. `withNamespace('modules/cards.md', 'projects/abc')` →
 * `'projects/abc/modules/cards.md'`. Sem `namespace`, devolve o path intacto
 * (colmeia GLOBAL legada). Puro e determinístico. Idempotente para prefixos já
 * aplicados.
 */
export function withNamespace(neuronPath: string, namespace?: string): string {
  if (!namespace) return neuronPath;
  const prefix = namespace.replace(/\/+$/, '');
  if (neuronPath === prefix || neuronPath.startsWith(`${prefix}/`)) return neuronPath;
  return `${prefix}/${neuronPath}`;
}

/**
 * **Bootstrap** da colmeia (ADR-0027, **EP-84**).
 *
 * Semeia a memória para que as AIs não comecem do zero:
 * - **US-213** — `bootstrapFromRepo`: varre o repo-alvo, detecta módulos e cria
 *   **1 neurônio inicial por módulo**, commitando pelo serviço de memória
 *   (ordem de escrita git → índice). É **idempotente**: neurônios já existentes
 *   são preservados (nunca sobrescreve o que as AIs já mantêm).
 * - **US-214** — `ensureNeuronForFile`: complemento **lazy**. Na primeira vez que
 *   um arquivo SEM neurônio é tocado por um agent, cria o neurônio do seu módulo.
 *   Cobre o que a varredura inicial não previu.
 *
 * A detecção de módulos (`detectModules`) é **pura e determinística** para ser
 * testável sem I/O de git; a semente (`seedFor`) também.
 */
@Injectable()
export class MemoryBootstrapService {
  private readonly logger = new Logger(MemoryBootstrapService.name);

  constructor(
    private readonly git: MemoryGitService,
    private readonly index: MemoryIndexService,
  ) {}

  /**
   * US-213 — varre `repoPath`, detecta módulos e cria 1 neurônio inicial por
   * módulo (idempotente: pula os que já existem no git). Retorna os paths dos
   * neurônios efetivamente CRIADOS nesta execução.
   *
   * US-PROJ4 (§1.2 / decisão #6) — `namespace` OPCIONAL: quando informado (ex.:
   * `projects/<projectId>`), os neurônios são criados sob esse prefixo
   * (`<namespace>/modules/<modulo>.md`), isolando a colmeia por Project no bare
   * repo da memória. SEM `namespace`, o comportamento é idêntico ao de hoje
   * (colmeia GLOBAL em `modules/<modulo>.md`).
   */
  async bootstrapFromRepo(input: {
    repoPath: string;
    sessionId?: string;
    namespace?: string;
  }): Promise<string[]> {
    const modules = detectModules(input.repoPath);
    const sessionId = input.sessionId ?? 'bootstrap';
    const created: string[] = [];
    for (const mod of modules) {
      const neuronPath = withNamespace(mod.neuronPath, input.namespace);
      const wrote = await this.createIfAbsent({
        neuronPath,
        module: mod.module,
        dir: mod.dir,
        sessionId,
      });
      if (wrote) created.push(neuronPath);
    }
    this.logger.debug(
      `bootstrap: ${modules.length} modulo(s) detectado(s), ${created.length} neuronio(s) criado(s)` +
        (input.namespace ? ` [namespace=${input.namespace}]` : '') +
        '.',
    );
    return created;
  }

  /**
   * US-214 — complemento lazy. Dado um arquivo tocado (`filePath`, relativo a
   * `repoPath`), garante o neurônio do módulo desse arquivo, criando-o se ausente.
   * Retorna o `neuronPath` garantido, ou `null` se o arquivo não mapeia módulo.
   */
  async ensureNeuronForFile(input: {
    filePath: string;
    sessionId?: string;
  }): Promise<string | null> {
    const mod = moduleForFile(input.filePath);
    if (!mod) return null;
    await this.createIfAbsent({
      neuronPath: mod.neuronPath,
      module: mod.module,
      dir: mod.dir,
      sessionId: input.sessionId ?? 'lazy',
    });
    return mod.neuronPath;
  }

  /** Cria o neurônio se ele ainda não existe em `main`. `true` se criou agora. */
  private async createIfAbsent(input: {
    neuronPath: string;
    module: string;
    dir: string;
    sessionId: string;
  }): Promise<boolean> {
    const existing = await this.git.readNeuron(input.neuronPath);
    if (existing !== null) return false;
    await this.index.commitAndReindex({
      path: input.neuronPath,
      content: seedFor({ module: input.module, dir: input.dir }),
      sessionId: input.sessionId,
      message: `bootstrap: neuronio inicial de "${input.module}"`,
    });
    return true;
  }
}

/**
 * Detecção **pura** de módulos num repo. Heurística determinística: procura
 * containers de módulos (`modules/`, `features/`, …) sob as raízes de código e
 * trata cada subdiretório como módulo; se não houver container, cada raiz de
 * código de topo vira um módulo. Ignora ruído (`node_modules`, `dist`, …).
 */
export function detectModules(repoPath: string): DetectedModule[] {
  const found = new Map<string, DetectedModule>();
  const add = (dir: string) => {
    const moduleName = dir.split('/').pop() as string;
    const neuronPath = `${MEMORY_MODULE_PREFIX}/${moduleName}.md`;
    if (!found.has(neuronPath)) {
      found.set(neuronPath, { module: moduleName, dir, neuronPath });
    }
  };

  for (const root of SOURCE_ROOTS) {
    const rootAbs = path.join(repoPath, root);
    if (!isDir(rootAbs)) continue;
    // apps/<app>/... e packages/<pkg> viram módulos por si.
    for (const child of listDirs(rootAbs)) {
      const childRel = `${root}/${child}`;
      const childAbs = path.join(repoPath, childRel);
      // Procura um container de módulos dentro (ex.: apps/api/src/modules/*).
      const containers = findContainers(childAbs);
      if (containers.length === 0) {
        add(childRel);
        continue;
      }
      for (const containerAbs of containers) {
        for (const mod of listDirs(containerAbs)) {
          add(`${path.relative(repoPath, containerAbs).split(path.sep).join('/')}/${mod}`);
        }
      }
    }
  }
  return [...found.values()].sort((a, b) => a.neuronPath.localeCompare(b.neuronPath));
}

/** Mapeia um arquivo tocado ao módulo (US-214). Puro. */
export function moduleForFile(filePath: string): DetectedModule | null {
  const posix = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = posix.split('/').filter(Boolean);
  // Procura um container conhecido no caminho e pega o segmento seguinte.
  for (let i = 0; i < segs.length - 1; i++) {
    if (MODULE_CONTAINER_DIRS.includes(segs[i])) {
      const moduleName = segs[i + 1];
      const dir = segs.slice(0, i + 2).join('/');
      return { module: moduleName, dir, neuronPath: `${MEMORY_MODULE_PREFIX}/${moduleName}.md` };
    }
  }
  // Sem container: usa a 1ª pasta de código de topo como módulo.
  if (segs.length >= 2 && SOURCE_ROOTS.includes(segs[0])) {
    const moduleName = segs[1];
    return {
      module: moduleName,
      dir: `${segs[0]}/${segs[1]}`,
      neuronPath: `${MEMORY_MODULE_PREFIX}/${moduleName}.md`,
    };
  }
  return null;
}

/** Semente `.md` determinística de um neurônio de módulo. Pura. */
export function seedFor(input: { module: string; dir: string }): string {
  return [
    `# ${input.module}`,
    '',
    `tags: modulo, ${input.module}`,
    '',
    `Neuronio inicial do modulo \`${input.module}\` (\`${input.dir}\`), semeado pelo`,
    'bootstrap da memoria (EP-84). As AIs mantem este conteudo: registre aqui o',
    'proposito do modulo, invariantes, contratos e pontos de atencao conforme',
    'trabalham nele.',
    '',
  ].join('\n');
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Encontra diretórios-container de módulos dentro de `dirAbs` (1 nível + src/). */
function findContainers(dirAbs: string): string[] {
  const out: string[] = [];
  for (const name of MODULE_CONTAINER_DIRS) {
    const direct = path.join(dirAbs, name);
    if (isDir(direct)) out.push(direct);
    const underSrc = path.join(dirAbs, 'src', name);
    if (isDir(underSrc)) out.push(underSrc);
  }
  return out;
}
