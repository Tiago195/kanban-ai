import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectHiveService } from './project-hive.service';
import type { AppConfig } from '../../shared/config/config';

/**
 * US-F2.4 → US-F2.3 — a colmeia no clone (`<clone>/.hive/**.md`).
 *
 * Na US-F2.4 este arquivo cobria a MATERIALIZAÇÃO (espelho bare repo → clone).
 * A US-F2.3 deletou o git da memória: o `.hive/` virou a fonte da verdade e o
 * `materialize()` deixou de existir — a manutenção do substrato agora é a
 * própria escrita (`mutateHiveFile`, chamada pelo `persistLearning`). O que
 * estas specs cobrem:
 *  (a) escrita RMW: cria/atualiza o arquivo com o conteúdo devolvido por
 *      `mutate(prev)` e retorna o path repo-relativo `.hive/…`;
 *  (b) trust boundary: rel absoluto/traversal/não-.md → null, nada escrito;
 *  (c) clone ausente → null (throwless para o caso "não tem onde escrever");
 *  (d) fiação de ignore (`.git/info/exclude` + `.graphifyignore` com
 *      `!/.hive/`) acompanha a escrita, sem duplicar linhas.
 */

function makeConfig(projectsDir: string): AppConfig {
  return { projects: { dir: projectsDir } } as unknown as AppConfig;
}

async function makeClone(root: string, projectId: string): Promise<string> {
  const clone = join(root, projectId);
  fs.mkdirSync(join(clone, '.git'), { recursive: true });
  return clone;
}

test('US-F2.3 (a): mutateHiveFile cria e atualiza o neurônio (RMW recebe o prev)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-'));
  try {
    const clone = await makeClone(root, 'p1');
    const svc = new ProjectHiveService(makeConfig(root));

    const prevs: (string | null)[] = [];
    const w1 = svc.mutateHiveFile('p1', 'modules/cards.md', (prev) => {
      prevs.push(prev);
      return '# cards\n';
    });
    assert.equal(w1, '.hive/modules/cards.md');
    assert.equal(fs.readFileSync(join(clone, '.hive/modules/cards.md'), 'utf8'), '# cards\n');

    const w2 = svc.mutateHiveFile('p1', 'modules/cards.md', (prev) => {
      prevs.push(prev);
      return `${prev}- learning novo\n`;
    });
    assert.equal(w2, '.hive/modules/cards.md');
    assert.deepEqual(prevs, [null, '# cards\n'], 'mutate vê o estado anterior real');
    assert.match(fs.readFileSync(join(clone, '.hive/modules/cards.md'), 'utf8'), /learning novo/);
    // Sem lixo de escrita atômica sobrando.
    assert.equal(fs.existsSync(join(clone, '.hive/modules/cards.md.tmp')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('US-F2.3 (b): trust boundary — traversal/absoluto/não-.md → null, nada escrito', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-'));
  try {
    const clone = await makeClone(root, 'p1');
    const svc = new ProjectHiveService(makeConfig(root));
    for (const rel of ['../fora.md', 'a/../../fora.md', '/abs/fora.md', '', 'script.sh']) {
      assert.equal(svc.mutateHiveFile('p1', rel, () => 'x'), null, `rel inválido: "${rel}"`);
    }
    assert.equal(fs.existsSync(join(root, 'fora.md')), false);
    assert.equal(fs.existsSync(join(clone, '.hive')), false, 'nenhuma escrita aconteceu');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('US-F2.3 (c): clone ausente → null (não inventa diretório de projeto)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-'));
  try {
    const svc = new ProjectHiveService(makeConfig(root));
    assert.equal(svc.mutateHiveFile('p-sem-clone', 'modules/x.md', () => '# x\n'), null);
    assert.equal(fs.existsSync(join(root, 'p-sem-clone')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('US-F2.4 (d): fiação de ignore acompanha a escrita, sem duplicar em repetição', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-'));
  try {
    const clone = await makeClone(root, 'p1');
    const svc = new ProjectHiveService(makeConfig(root));
    svc.mutateHiveFile('p1', 'modules/cards.md', () => '# cards\n');
    svc.mutateHiveFile('p1', 'modules/cards.md', (p) => `${p}mais\n`);
    const exclude = fs.readFileSync(join(clone, '.git/info/exclude'), 'utf8');
    const graphifyignore = fs.readFileSync(join(clone, '.graphifyignore'), 'utf8');
    // git NÃO vê a colmeia (working tree dos agents limpo)…
    assert.equal(exclude.split('\n').filter((l) => l === '/.hive/').length, 1);
    assert.equal(exclude.split('\n').filter((l) => l === '/.graphifyignore').length, 1);
    // …mas o graphify VÊ (o .graphifyignore vence o exclude por last-match-wins).
    assert.equal(graphifyignore.split('\n').filter((l) => l === '!/.hive/').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('US-F2.8: listHiveFiles/readHiveFile leem o que mutateHiveFile escreveu', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hive-'));
  try {
    await makeClone(root, 'p1');
    const svc = new ProjectHiveService(makeConfig(root));
    svc.mutateHiveFile('p1', 'modules/cards.md', () => '# cards\n');
    svc.mutateHiveFile('p1', 'modules/api.md', () => '# api\n');
    assert.deepEqual(svc.listHiveFiles('p1'), ['modules/api.md', 'modules/cards.md']);
    assert.equal(svc.readHiveFile('p1', 'modules/cards.md')?.content, '# cards\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
