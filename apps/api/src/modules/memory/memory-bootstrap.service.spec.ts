import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MemoryBootstrapService,
  detectModules,
  moduleForFile,
  seedFor,
  withNamespace,
} from './memory-bootstrap.service';
import type { MemoryGitService } from './memory-git.service';
import type { MemoryIndexService } from './memory-index.service';

// ---------------------------------------------------------------------------
// detectModules — varredura determinística de um repo de teste em disco.
// ---------------------------------------------------------------------------

function makeRepo(dirs: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bootstrap-'));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

test('detectModules encontra modulos sob um container (apps/api/src/modules/*)', () => {
  const repo = makeRepo([
    'apps/api/src/modules/cards',
    'apps/api/src/modules/memory',
    'apps/api/node_modules/foo',
  ]);
  const mods = detectModules(repo).map((m) => m.neuronPath);
  assert.ok(mods.includes('modules/cards.md'));
  assert.ok(mods.includes('modules/memory.md'));
  // node_modules deve ser ignorado.
  assert.ok(!mods.includes('modules/foo.md'));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('detectModules trata apps/<app> como modulo quando nao ha container', () => {
  const repo = makeRepo(['apps/web/src', 'packages/shared/src']);
  const mods = detectModules(repo).map((m) => m.neuronPath);
  assert.ok(mods.includes('modules/web.md'));
  assert.ok(mods.includes('modules/shared.md'));
  fs.rmSync(repo, { recursive: true, force: true });
});

test('detectModules e deterministico (ordenado) e sem duplicatas', () => {
  const repo = makeRepo(['src/modules/a', 'src/features/a']);
  const paths = detectModules(repo).map((m) => m.neuronPath);
  const sorted = [...paths].sort();
  assert.deepEqual(paths, sorted);
  assert.equal(new Set(paths).size, paths.length);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// moduleForFile — mapeamento lazy (US-214). Puro.
// ---------------------------------------------------------------------------

test('moduleForFile mapeia arquivo dentro de um container', () => {
  const m = moduleForFile('apps/api/src/modules/cards/cards.service.ts');
  assert.equal(m?.module, 'cards');
  assert.equal(m?.neuronPath, 'modules/cards.md');
});

test('moduleForFile usa a 1a pasta de topo quando nao ha container', () => {
  const m = moduleForFile('apps/web/main.ts');
  assert.equal(m?.module, 'web');
  assert.equal(m?.neuronPath, 'modules/web.md');
});

test('moduleForFile normaliza separadores do Windows', () => {
  const m = moduleForFile('apps\\api\\src\\modules\\memory\\x.ts');
  assert.equal(m?.neuronPath, 'modules/memory.md');
});

test('moduleForFile retorna null quando nao ha modulo', () => {
  assert.equal(moduleForFile('README.md'), null);
});

// ---------------------------------------------------------------------------
// seedFor — semente determinística.
// ---------------------------------------------------------------------------

test('seedFor gera markdown com titulo, tags e path do modulo', () => {
  const md = seedFor({ module: 'cards', dir: 'apps/api/src/modules/cards' });
  assert.match(md, /^# cards$/m);
  assert.match(md, /tags: modulo, cards/);
  assert.match(md, /apps\/api\/src\/modules\/cards/);
});

// ---------------------------------------------------------------------------
// US-PROJ4 (§1.2 / decisão #6) — namespacing da colmeia por projectId.
// ---------------------------------------------------------------------------

test('withNamespace prefixa o neuronPath com o namespace do Project', () => {
  assert.equal(
    withNamespace('modules/cards.md', 'projects/abc'),
    'projects/abc/modules/cards.md',
  );
});

test('withNamespace sem namespace devolve o path intacto (colmeia global legada)', () => {
  assert.equal(withNamespace('modules/cards.md'), 'modules/cards.md');
  assert.equal(withNamespace('modules/cards.md', ''), 'modules/cards.md');
});

test('withNamespace é idempotente (não duplica prefixo já aplicado)', () => {
  const once = withNamespace('modules/cards.md', 'projects/abc');
  assert.equal(withNamespace(once, 'projects/abc'), once);
});

test('withNamespace tolera barra final no namespace', () => {
  assert.equal(
    withNamespace('modules/cards.md', 'projects/abc/'),
    'projects/abc/modules/cards.md',
  );
});

// bootstrapFromRepo com namespace: os neurônios criados vão para
// `projects/<id>/modules/<x>.md`; DOIS projetos distintos NÃO colidem (os paths
// gravados no git/índice são disjuntos).
test('bootstrapFromRepo namespaceado: projetos distintos criam neurônios disjuntos (sem colisão)', async () => {
  // Repo de teste em disco, sob o cwd (NUNCA /tmp).
  const root = fs.mkdtempSync(path.join(process.cwd(), '.proj4-mem-'));
  fs.mkdirSync(path.join(root, 'apps/api/src/modules/cards'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps/api/src/modules/memory'), { recursive: true });

  try {
    // Fake git: nenhum neurônio existe ainda → tudo é criado.
    const gitStore = { readNeuron: async () => null } as unknown as MemoryGitService;
    // Fake index: registra os paths gravados.
    const writtenA: string[] = [];
    const indexA = {
      commitAndReindex: async ({ path: p }: { path: string }) => {
        writtenA.push(p);
      },
    } as unknown as MemoryIndexService;
    const writtenB: string[] = [];
    const indexB = {
      commitAndReindex: async ({ path: p }: { path: string }) => {
        writtenB.push(p);
      },
    } as unknown as MemoryIndexService;

    const svcA = new MemoryBootstrapService(gitStore, indexA);
    const svcB = new MemoryBootstrapService(gitStore, indexB);

    const createdA = await svcA.bootstrapFromRepo({
      repoPath: root,
      namespace: 'projects/proj-A',
    });
    const createdB = await svcB.bootstrapFromRepo({
      repoPath: root,
      namespace: 'projects/proj-B',
    });

    // Todos os paths do projeto A estão sob projects/proj-A/.
    assert.ok(createdA.length > 0, 'A deve criar ao menos um neurônio');
    assert.ok(
      createdA.every((p) => p.startsWith('projects/proj-A/modules/')),
      'todos os neurônios de A vivem sob projects/proj-A/',
    );
    assert.ok(
      createdB.every((p) => p.startsWith('projects/proj-B/modules/')),
      'todos os neurônios de B vivem sob projects/proj-B/',
    );
    // Nenhuma interseção entre os conjuntos de paths gravados.
    const setB = new Set(writtenB);
    assert.equal(
      writtenA.some((p) => setB.has(p)),
      false,
      'os paths de A e B não colidem',
    );
    // Sanidade: os módulos são os mesmos, só o prefixo difere.
    assert.deepEqual(
      writtenA.map((p) => p.replace('projects/proj-A/', '')).sort(),
      writtenB.map((p) => p.replace('projects/proj-B/', '')).sort(),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrapFromRepo SEM namespace cria neurônios globais legados (modules/<x>.md)', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.proj4-mem-'));
  fs.mkdirSync(path.join(root, 'apps/api/src/modules/cards'), { recursive: true });
  try {
    const gitStore = { readNeuron: async () => null } as unknown as MemoryGitService;
    const written: string[] = [];
    const index = {
      commitAndReindex: async ({ path: p }: { path: string }) => {
        written.push(p);
      },
    } as unknown as MemoryIndexService;
    const svc = new MemoryBootstrapService(gitStore, index);
    const created = await svc.bootstrapFromRepo({ repoPath: root });
    assert.ok(
      created.every((p) => /^modules\/[^/]+\.md$/.test(p)),
      'sem namespace, neurônios são globais modules/<x>.md',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
