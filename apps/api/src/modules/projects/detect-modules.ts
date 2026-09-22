import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * US-F2.3 (EP-F2) — detecção **pura** de módulos de um repo-alvo.
 *
 * Sobrevivente da deleção do módulo `memory/`: nasceu no
 * `memory-bootstrap.service.ts` (EP-84) para semear neurônios, mas ganhou um
 * consumidor fora da memória — o `ProjectExplorerService.repoInfo` (US-PROJ7)
 * usa a mesma heurística para listar os módulos do clone na tela do Explorer.
 * Com o bootstrap morto (US-F2.9) e o módulo `memory/` deletado (US-F2.3), a
 * função mudou para cá, enxuta: sem `neuronPath`/`seedFor` (conceitos do
 * substrato git da memória, que saiu).
 *
 * Heurística determinística: procura containers de módulos (`modules/`,
 * `features/`, …) sob as raízes de código e trata cada subdiretório como
 * módulo; se não houver container, cada raiz de código de topo vira um módulo.
 * Ignora ruído (`node_modules`, `dist`, …).
 */

/** Diretórios de topo que costumam AGRUPAR módulos (não são módulos em si). */
const MODULE_CONTAINER_DIRS = ['modules', 'features', 'packages', 'services', 'domains'];
/** Diretórios de código-fonte varridos em busca de containers/módulos. */
const SOURCE_ROOTS = ['apps', 'src', 'packages', 'lib'];
/** Ruído que nunca é módulo. */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', 'tmp', '.cache',
]);

/** Um módulo detectado no repo-alvo. */
export interface DetectedModule {
  /** Nome curto do módulo (segmento final). */
  module: string;
  /** Diretório do módulo relativo à raiz do repo (POSIX). */
  dir: string;
}

export function detectModules(repoPath: string): DetectedModule[] {
  const found = new Map<string, DetectedModule>();
  const add = (dir: string) => {
    const moduleName = dir.split('/').pop() as string;
    if (!found.has(moduleName)) found.set(moduleName, { module: moduleName, dir });
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
  return [...found.values()].sort((a, b) => a.module.localeCompare(b.module));
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
