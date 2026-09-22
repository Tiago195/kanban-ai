/**
 * US-UX.1 — specs da máquina de roteamento da moldura do Explorador:
 * resolução de `(projectId, área)` da URL, defaults quando ausente e
 * preservação de contexto ao trocar de aba/projeto.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_EXPLORER_AREA,
  EXPLORER_AREAS,
  explorerPath,
  isExplorerArea,
  resolveExplorerRoute,
  switchAreaPath,
  switchProjectPath,
  wikiArticlePath,
} from './explorerShell.ts';

const IDS = ['p1', 'p2', 'p3'];
const base = {
  projectIdParam: null as string | null,
  areaParam: null as string | null,
  projectsLoaded: true,
  projectIds: IDS,
  boardProjectId: null as string | null,
};

describe('US-UX.1 isExplorerArea / explorerPath', () => {
  it('aceita exatamente as 4 áreas do rail', () => {
    for (const area of EXPLORER_AREAS) assert.equal(isExplorerArea(area), true);
    assert.equal(isExplorerArea('repo'), false); // legado: repo vive em "projects"
    assert.equal(isExplorerArea(''), false);
    assert.equal(isExplorerArea(null), false);
    assert.equal(isExplorerArea(undefined), false);
  });

  it('monta a URL canônica /explorer/:projectId/:area', () => {
    assert.equal(explorerPath('p1', 'graph'), '/explorer/p1/graph');
  });
});

describe('US-UX.1 resolveExplorerRoute — defaults e URL canônica', () => {
  it('carregando: nada a resolver (área já projetada para a UI)', () => {
    const route = resolveExplorerRoute({ ...base, projectsLoaded: false, areaParam: 'wiki' });
    assert.deepEqual(route, { kind: 'loading', area: 'wiki' });
  });

  it('zero projetos: abre na área resolvida (Projetos permite criar o primeiro)', () => {
    const route = resolveExplorerRoute({ ...base, projectIds: [] });
    assert.deepEqual(route, { kind: 'no-projects', area: DEFAULT_EXPLORER_AREA });
  });

  it('sem projeto na URL: default = projeto do quadro, refletido na URL (redirect)', () => {
    const route = resolveExplorerRoute({ ...base, boardProjectId: 'p2' });
    assert.deepEqual(route, {
      kind: 'redirect',
      path: '/explorer/p2/projects',
      projectId: 'p2',
      area: 'projects',
    });
  });

  it('sem projeto na URL e quadro sem projeto: default = primeiro da lista', () => {
    const route = resolveExplorerRoute({ ...base });
    assert.equal(route.kind, 'redirect');
    assert.equal(route.kind === 'redirect' && route.path, '/explorer/p1/projects');
  });

  it('projeto do quadro fora da lista não é usado como default', () => {
    const route = resolveExplorerRoute({ ...base, boardProjectId: 'fantasma' });
    assert.equal(route.kind === 'redirect' && route.projectId, 'p1');
  });

  it('projeto inexistente na URL: corrige para um default e preserva a área', () => {
    const route = resolveExplorerRoute({ ...base, projectIdParam: 'nope', areaParam: 'graph' });
    assert.deepEqual(route, {
      kind: 'redirect',
      path: '/explorer/p1/graph',
      projectId: 'p1',
      area: 'graph',
    });
  });

  it('área inválida/ausente com projeto válido: corrige a URL mantendo o projeto', () => {
    const semArea = resolveExplorerRoute({ ...base, projectIdParam: 'p3' });
    assert.deepEqual(semArea, {
      kind: 'redirect',
      path: '/explorer/p3/projects',
      projectId: 'p3',
      area: 'projects',
    });
    const areaLegada = resolveExplorerRoute({ ...base, projectIdParam: 'p3', areaParam: 'repo' });
    assert.equal(areaLegada.kind === 'redirect' && areaLegada.path, '/explorer/p3/projects');
  });

  it('URL canônica: ready (F5/link colado leva ao mesmo lugar)', () => {
    const route = resolveExplorerRoute({ ...base, projectIdParam: 'p2', areaParam: 'wiki' });
    assert.deepEqual(route, { kind: 'ready', projectId: 'p2', area: 'wiki' });
  });
});

describe('US-UX.1 preservação de contexto', () => {
  it('trocar de área MANTÉM o projeto', () => {
    assert.equal(switchAreaPath({ projectId: 'p2' }, 'graph'), '/explorer/p2/graph');
  });

  it('trocar de projeto MANTÉM a área', () => {
    assert.equal(switchProjectPath({ area: 'wiki' }, 'p3'), '/explorer/p3/wiki');
  });
});

describe('US-UX.5 wikiArticlePath — deep link de artigo da Wiki', () => {
  it('slug entra como segmento extra da área wiki (URL-encoded)', () => {
    assert.equal(wikiArticlePath('p1', 'Change_Log'), '/explorer/p1/wiki/Change_Log');
    assert.equal(wikiArticlePath('p1', 'slugify.d.ts'), '/explorer/p1/wiki/slugify.d.ts');
    assert.equal(wikiArticlePath('p1', 'a#b'), '/explorer/p1/wiki/a%23b');
  });

  it('slug null = home da wiki (sem segmento extra)', () => {
    assert.equal(wikiArticlePath('p1', null), '/explorer/p1/wiki');
  });
});
