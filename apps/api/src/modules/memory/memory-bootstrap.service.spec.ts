import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  detectModules,
  moduleForFile,
  seedFor,
} from './memory-bootstrap.service';

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
