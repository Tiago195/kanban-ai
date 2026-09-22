import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProjectExplorerService } from './project-explorer.service';
import { ProjectHiveService } from './project-hive.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { AppConfig } from '../../shared/config/config';

/**
 * US-F2.8 → US-F2.3 (EP-F2) — Project Explorer lê a colmeia do clone.
 *
 * A ÚNICA fonte de `listMemory`/`readMemory` é `<clone>/.hive/**.md`, lida via
 * `ProjectHiveService` (o fallback legado `MemoryIndex` + git da memória
 * morreu na US-F2.3):
 *   (a) isolamento por Project POR CONSTRUÇÃO (conserta o antigo
 *       TODO(US-PROJ4): um Project NÃO vê neurônio de outro);
 *   (b) US-F5.1 — summary projetado do memory doc CANÔNICO do graphify
 *       (título = `question`, tag = `type`, updatedAt = `date`) + heurística
 *       do corpo;
 *   (c) markdown sem frontmatter (estrangeiro) mantém a linha `tags:` inline;
 *   (d) trust boundary: path da query não escapa do `.hive/` (404, nunca
 *       conteúdo de fora);
 *   (e) colmeia ausente/vazia → `[]`; neurônio inexistente → 404 explícito.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'us-f28-hive-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// US-F5.1 — o neurônio agora é o memory doc canônico (parse_memory_doc).
const CANONICAL = [
  '---',
  'type: "learning"',
  'date: "2026-03-01T10:00:00.000Z"',
  'question: "Cards"',
  'contributor: "kanban-ai"',
  'outcome: "useful"',
  'source_nodes: ["apps_api_src_modules_cards_cards_service"]',
  '---',
  '',
  '# Q: Cards',
  '',
  '## Answer',
  '',
  'Regras de negócio de cards.',
  '',
  '## Outcome',
  '',
  '- Signal: useful',
].join('\n');

const V1 = ['# Legacy', 'tags: velho, v1', '', 'Neurônio sem frontmatter.'].join('\n');

function writeHive(projectId: string, rel: string, content: string): void {
  const target = path.join(tmp, projectId, '.hive', rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function makeHive(): ProjectHiveService {
  return new ProjectHiveService({ projects: { dir: tmp } } as unknown as AppConfig);
}

function makeService(): { svc: ProjectExplorerService } {
  const prisma = {
    project: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        localPath: path.join(tmp, where.id),
      }),
    },
  } as unknown as PrismaService;
  return { svc: new ProjectExplorerService(prisma, makeHive()) };
}

// Fixture: dois Projects com colmeias próprias.
writeHive('proj-a', 'memory/cards.md', CANONICAL);
writeHive('proj-a', 'modules/legacy.md', V1);
writeHive('proj-b', 'modules/other.md', '# Other\n\nSó do B.');
fs.mkdirSync(path.join(tmp, 'proj-a', '.git'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'proj-b', '.git'), { recursive: true });
// Arquivo FORA do .hive — nunca pode vazar pela leitura de neurônio.
fs.writeFileSync(path.join(tmp, 'proj-a', 'secret.md'), 'SEGREDO', 'utf8');

test('listMemory: lê do .hive do Project e NÃO vaza neurônio de outro Project', async () => {
  const { svc } = makeService();
  const a = await svc.listMemory('proj-a');
  const b = await svc.listMemory('proj-b');
  assert.deepEqual(
    a.map((n) => n.path),
    ['memory/cards.md', 'modules/legacy.md'],
  );
  assert.deepEqual(
    b.map((n) => n.path),
    ['modules/other.md'],
  );
  // O bug que o TODO(US-PROJ4) admitia: neurônio do A aparecendo no B.
  assert.ok(!b.some((n) => n.path === 'memory/cards.md'));
});

test('listMemory: summary projetado do memory doc canônico (US-F5.1) + corpo (sem campos internos)', async () => {
  const { svc } = makeService();
  const [cards] = await svc.listMemory('proj-a');
  assert.equal(cards.title, 'Cards', 'título = question do frontmatter');
  assert.deepEqual(cards.tags, ['learning'], 'tag única = type do doc');
  assert.equal(cards.summary, 'Regras de negócio de cards.');
  assert.equal(cards.updatedAt, '2026-03-01T10:00:00.000Z', 'updatedAt = date do doc');
  // US-F2.3 — os campos de coordenação do substrato git saíram do contrato.
  for (const forbidden of [
    'lockState', 'holder', 'stale', 'archivedAt',
    'leaseId', 'activeBranch', 'baseCommit', 'headCommit',
  ]) {
    assert.ok(!(forbidden in cards), `summary não deve conter ${forbidden}`);
  }
});

test('listMemory: markdown sem frontmatter mantém tags da linha `tags:` inline (heurística de corpo)', async () => {
  const { svc } = makeService();
  const list = await svc.listMemory('proj-a');
  const legacy = list.find((n) => n.path === 'modules/legacy.md');
  assert.ok(legacy);
  assert.equal(legacy.title, 'Legacy');
  assert.deepEqual(legacy.tags, ['velho', 'v1']);
});

test('readMemory: detalhe vem do arquivo do .hive (content completo, sem headCommit no contrato)', async () => {
  const { svc } = makeService();
  const detail = await svc.readMemory('proj-a', 'memory/cards.md');
  assert.equal(detail.content, CANONICAL);
  assert.ok(!('headCommit' in detail), 'US-F2.3: arquivo simples não tem git');
  assert.equal(detail.title, 'Cards');
  assert.deepEqual(detail.tags, ['learning']);
});

test('readMemory: path traversal NÃO escapa do .hive (trust boundary) — 404, nunca conteúdo de fora', async () => {
  const { svc } = makeService();
  for (const evil of ['../secret.md', '../../proj-a/secret.md', '/etc/passwd']) {
    await assert.rejects(
      () => svc.readMemory('proj-a', evil),
      /não encontrado/,
      `não pode ler ${evil}`,
    );
  }
});

test('US-F2.3: Project sem colmeia → [] (sem fallback legado); neurônio inexistente → 404', async () => {
  const { svc } = makeService();
  fs.mkdirSync(path.join(tmp, 'proj-sem-hive', '.git'), { recursive: true });
  assert.deepEqual(await svc.listMemory('proj-sem-hive'), []);
  await assert.rejects(() => svc.readMemory('proj-a', 'modules/nao-existe.md'), /não encontrado/);
});

test('ProjectHiveService.readHiveFile: rejeita rel absoluto/traversal e aceita rel válido', () => {
  const hive = makeHive();
  assert.equal(hive.readHiveFile('proj-a', '../secret.md'), null);
  assert.equal(hive.readHiveFile('proj-a', '/etc/passwd'), null);
  assert.equal(hive.readHiveFile('proj-a', ''), null);
  assert.equal(hive.readHiveFile('proj-a', 'memory/cards.md')?.content, CANONICAL);
});
