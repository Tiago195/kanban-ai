import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { ProjectExplorerService } from './project-explorer.service';
import { ProjectHiveService } from './project-hive.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { AppConfig } from '../../shared/config/config';

/**
 * US-F4.3 — nó → arquivo → card (`ProjectExplorerService.fileCards`).
 *
 * Testes DETERMINÍSTICOS e OFFLINE (estilo da casa — fake do Prisma em
 * memória). Cobrem os pontos frágeis da story:
 *   (a) via `AffectedFlow.files` → story com `flowNames`; via
 *       `Iteration.handoffFiles` → task; card nas DUAS vias → dedupe com
 *       `via` mesclado;
 *   (b) match EXATO por elemento (sem fuzzy) + única normalização aceita:
 *       trim e prefixo `./` dos dois lados;
 *   (c) estado vazio honesto: Project sem board vinculado, ou arquivo que
 *       nenhum card tocou → `cards: []` (nunca erro);
 *   (d) ordenação estável: stories antes de tasks, depois por key;
 *   (e) Project inexistente → 404 explícito.
 */

interface FakeCard {
  id: string;
  boardId: string;
  key: string;
  type: string;
  title: string;
  parentId: string | null;
}

function makeService(opts: {
  project?: { id: string; localPath: string | null } | null;
  boards?: { id: string; projectId: string | null }[];
  flows?: { name: string; files: string[]; card: FakeCard }[];
  iterations?: { handoffFiles: string[]; card: FakeCard }[];
}): ProjectExplorerService {
  const boards = opts.boards ?? [];
  const flows = opts.flows ?? [];
  const iterations = opts.iterations ?? [];
  const matches = (values: string[], variants: string[]) =>
    values.some((v) => variants.includes(v));
  const prisma = {
    project: {
      findUnique: async () => opts.project ?? null,
    },
    board: {
      findMany: async ({ where }: { where: { projectId: string } }) =>
        boards.filter((b) => b.projectId === where.projectId).map((b) => ({ id: b.id })),
    },
    affectedFlow: {
      findMany: async ({
        where,
      }: {
        where: { files: { hasSome: string[] }; card: { boardId: { in: string[] } } };
      }) =>
        flows
          .filter(
            (f) =>
              matches(f.files, where.files.hasSome) &&
              where.card.boardId.in.includes(f.card.boardId),
          )
          .map((f) => ({ name: f.name, card: { ...f.card } })),
    },
    iteration: {
      findMany: async ({
        where,
      }: {
        where: { handoffFiles: { hasSome: string[] }; card: { boardId: { in: string[] } } };
      }) =>
        iterations
          .filter(
            (i) =>
              matches(i.handoffFiles, where.handoffFiles.hasSome) &&
              where.card.boardId.in.includes(i.card.boardId),
          )
          .map((i) => ({ card: { ...i.card } })),
    },
  } as unknown as PrismaService;
  const hive = new ProjectHiveService({
    projects: { dir: '/tmp/nao-usado' },
  } as unknown as AppConfig);
  return new ProjectExplorerService(prisma, hive);
}

const project = { id: 'p1', localPath: null };
const story: FakeCard = {
  id: 's1',
  boardId: 'b1',
  key: 'US-2',
  type: 'story',
  title: 'Cadastro',
  parentId: 'e1',
};
const task: FakeCard = {
  id: 't1',
  boardId: 'b1',
  key: 'TK-3',
  type: 'task',
  title: 'Endpoint signup',
  parentId: 's1',
};

test('fileCards: via AffectedFlow → story com flowNames; via Iteration → task; ordem story < task', async () => {
  const svc = makeService({
    project,
    boards: [{ id: 'b1', projectId: 'p1' }],
    flows: [
      { name: 'Cadastro de usuário', files: ['src/signup.js'], card: story },
      { name: 'Login', files: ['src/signup.js'], card: story },
    ],
    iterations: [{ handoffFiles: ['src/signup.js'], card: task }],
  });
  const res = await svc.fileCards('p1', 'src/signup.js');
  assert.equal(res.file, 'src/signup.js');
  assert.equal(res.cards.length, 2);
  // stories antes de tasks (ordenação estável do painel da UI)
  assert.deepEqual(
    res.cards.map((c) => c.key),
    ['US-2', 'TK-3'],
  );
  const [s, t] = res.cards;
  assert.deepEqual(s.via, ['affected-flow']);
  // flowNames dedupados por nome, na ordem em que os fluxos citam o arquivo
  assert.deepEqual(s.flowNames, ['Cadastro de usuário', 'Login']);
  assert.equal(s.parentId, 'e1');
  assert.deepEqual(t.via, ['iteration']);
  assert.deepEqual(t.flowNames, []);
  assert.equal(t.parentId, 's1');
});

test('fileCards: card presente nas DUAS vias → uma linha só, via mesclado', async () => {
  const svc = makeService({
    project,
    boards: [{ id: 'b1', projectId: 'p1' }],
    flows: [{ name: 'Fluxo X', files: ['index.js'], card: story }],
    iterations: [
      { handoffFiles: ['index.js'], card: story },
      { handoffFiles: ['index.js'], card: story }, // iteração repetida não duplica
    ],
  });
  const res = await svc.fileCards('p1', 'index.js');
  assert.equal(res.cards.length, 1);
  assert.deepEqual(res.cards[0].via, ['affected-flow', 'iteration']);
});

test('fileCards: normalização mínima — "./" e espaços caem, e a variante "./" gravada na coluna casa', async () => {
  const svc = makeService({
    project,
    boards: [{ id: 'b1', projectId: 'p1' }],
    flows: [{ name: 'Fluxo', files: ['./index.js'], card: story }],
  });
  const res = await svc.fileCards('p1', '  ./index.js  ');
  assert.equal(res.file, 'index.js');
  assert.equal(res.cards.length, 1);
});

test('fileCards: SEM fuzzy — sufixo/nome parecido não casa (associação inventada é pior que nenhuma)', async () => {
  const svc = makeService({
    project,
    boards: [{ id: 'b1', projectId: 'p1' }],
    flows: [
      { name: 'Fluxo', files: ['src/index.js'], card: story },
      // lixo real observado na base: a IA declarou uma frase no lugar do path
      { name: 'Fluxo', files: ['Tratar separador vazio'], card: story },
    ],
  });
  const res = await svc.fileCards('p1', 'index.js');
  assert.deepEqual(res.cards, []);
});

test('fileCards: estado vazio honesto — Project sem board vinculado e arquivo sem card → cards: []', async () => {
  const semBoard = makeService({ project, boards: [] });
  assert.deepEqual(await semBoard.fileCards('p1', 'index.js'), {
    file: 'index.js',
    cards: [],
  });

  const semMatch = makeService({
    project,
    boards: [{ id: 'b1', projectId: 'p1' }],
    flows: [{ name: 'Fluxo', files: ['outro.js'], card: story }],
  });
  assert.deepEqual(await semMatch.fileCards('p1', 'index.js'), {
    file: 'index.js',
    cards: [],
  });
});

test('fileCards: boards de OUTRO Project não vazam para o resultado', async () => {
  const svc = makeService({
    project,
    boards: [{ id: 'b-outro', projectId: 'p-outro' }],
    flows: [{ name: 'Fluxo', files: ['index.js'], card: { ...story, boardId: 'b-outro' } }],
  });
  assert.deepEqual((await svc.fileCards('p1', 'index.js')).cards, []);
});

test('fileCards: Project inexistente → 404 explícito', async () => {
  const svc = makeService({ project: null });
  await assert.rejects(
    () => svc.fileCards('nope', 'index.js'),
    (err: unknown) => err instanceof NotFoundException,
  );
});
