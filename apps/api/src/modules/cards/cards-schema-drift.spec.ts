import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CardsService } from './cards.service';
import type { PrismaService } from '../../shared/db/prisma.service';
import type { RealtimeService } from '../../realtime/realtime.service';
import type { Orchestrator } from '../ai-engine/orchestrator';
import type { ModelsService } from '../models/models.service';

/**
 * bug-cards-500: `GET /cards` não pode retornar 500 opaco em schema drift
 * (migration não aplicada → coluna ausente). Deve degradar com 503 acionável.
 * Testamos os dois caminhos: (a) health-check de boot já sinalizou drift; e
 * (b) health-check não pegou, mas a query estoura P2022 em runtime.
 */

function makeService(prismaOverrides: {
  schemaHealth?: { ok: boolean; missing: string[] } | null;
  findMany?: () => Promise<unknown>;
}): CardsService {
  const prisma = {
    getSchemaHealth: () => prismaOverrides.schemaHealth ?? { ok: true, missing: [] },
    card: {
      findMany: prismaOverrides.findMany ?? (async () => []),
    },
    board: { findMany: async () => [] },
  } as unknown as PrismaService;
  const realtime = { broadcast() {} } as unknown as RealtimeService;
  const orchestrator = {} as unknown as Orchestrator;
  const models = { defaultModelId: () => 'default-model' } as unknown as ModelsService;
  return new CardsService(prisma, realtime, orchestrator, models);
}

test('findAll: health-check de boot sinaliza coluna ausente -> 503 acionável (não 500)', async () => {
  const svc = makeService({ schemaHealth: { ok: false, missing: ['Card.derivedDepth'] } });
  await assert.rejects(
    () => svc.findAll(),
    (err: unknown) => {
      assert.ok(err instanceof ServiceUnavailableException, 'deve ser 503, não 500 opaco');
      const body = err.getResponse() as { missingColumns?: string[] };
      assert.deepEqual(body.missingColumns, ['Card.derivedDepth']);
      return true;
    },
  );
});

test('findAll: query estoura P2022 em runtime -> traduz para 503 com a coluna', async () => {
  const svc = makeService({
    schemaHealth: { ok: true, missing: [] }, // boot não pegou o drift
    findMany: async () => {
      throw new Prisma.PrismaClientKnownRequestError('column does not exist', {
        code: 'P2022',
        clientVersion: 'test',
        meta: { column: 'derivedDepth' },
      });
    },
  });
  await assert.rejects(
    () => svc.findAll(),
    (err: unknown) => {
      assert.ok(err instanceof ServiceUnavailableException, 'P2022 deve virar 503');
      const body = err.getResponse() as { missingColumns?: string[] };
      assert.deepEqual(body.missingColumns, ['derivedDepth']);
      return true;
    },
  );
});

test('findAll: sem drift -> retorna lista normalmente', async () => {
  const svc = makeService({
    schemaHealth: { ok: true, missing: [] },
    findMany: async () => [],
  });
  const result = await svc.findAll();
  assert.deepEqual(result, []);
});
