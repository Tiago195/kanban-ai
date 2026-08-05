/**
 * Grupo `taxonomy` — gestão de labels, assignees, flows e loop profiles.
 *
 * - **Labels** categorizam cards e podem apontar para um `loopProfileId`, ligando
 *   uma categoria ao comportamento do loop engine.
 * - **Assignees** NÃO são humanos: cada assignee é um **agent autônomo** com seu
 *   próprio `model` e `instructions`.
 * - **Flows** documentam fluxos/arquivos relevantes de um card.
 * - **Loop profiles** definem fases, passo inicial e estratégia de validação do loop.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';
import { z } from 'zod';

export function registerTaxonomyTools(server: McpServer, client: KanbanClient): void {
  // ----- Labels -----------------------------------------------------------
  registerTool(
    server,
    'list_labels',
    'Lista as labels, opcionalmente filtrando por `boardId` (GET /labels). ' +
      'Uma label pode estar vinculada a um loop profile via `loopProfileId`.',
    { boardId: z.string().uuid().optional() },
    async ({ boardId }) => ok(await client.get('/labels', { boardId })),
  );

  registerTool(
    server,
    'create_label',
    'Cria uma label num board (POST /labels). `name` é obrigatório; `color` é opcional; ' +
      '`loopProfileId` liga a label a um loop profile, ditando o comportamento do loop ' +
      'engine para cards com essa label.',
    {
      boardId: z.string().uuid(),
      name: z.string().min(1),
      color: z.string().optional(),
      loopProfileId: z.string().uuid().optional(),
    },
    async ({ boardId, name, color, loopProfileId }) =>
      ok(await client.post('/labels', { boardId, name, color, loopProfileId })),
  );

  registerTool(
    server,
    'update_label',
    'Atualiza uma label (PATCH /labels/:id). Você pode alterar `name`, `color` e/ou ' +
      '`loopProfileId` (envie `null` para desvincular a label de qualquer loop profile).',
    {
      id: z.string().uuid(),
      name: z.string().min(1).optional(),
      color: z.string().optional(),
      loopProfileId: z.string().uuid().nullable().optional(),
    },
    async ({ id, name, color, loopProfileId }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (color !== undefined) body.color = color;
      if (loopProfileId !== undefined) body.loopProfileId = loopProfileId;
      return ok(await client.patch(`/labels/${id}`, body));
    },
  );

  registerTool(
    server,
    'delete_label',
    'Remove uma label (DELETE /labels/:id). A label deixa de existir para todos os cards.',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.delete(`/labels/${id}`)),
  );

  registerTool(
    server,
    'attach_label',
    'Associa uma label a um card (POST /cards/:id/labels). `id` é o card, `labelId` a label.',
    { id: z.string().uuid(), labelId: z.string().uuid() },
    async ({ id, labelId }) => ok(await client.post(`/cards/${id}/labels`, { labelId })),
  );

  registerTool(
    server,
    'detach_label',
    'Desassocia uma label de um card (DELETE /cards/:id/labels/:labelId). A label continua ' +
      'existindo no board — apenas deixa de estar no card.',
    { id: z.string().uuid(), labelId: z.string().uuid() },
    async ({ id, labelId }) => ok(await client.delete(`/cards/${id}/labels/${labelId}`)),
  );

  // ----- Assignees (agents autônomos) ------------------------------------
  registerTool(
    server,
    'list_assignees',
    'Lista os assignees, opcionalmente filtrando por `boardId` (GET /assignees). ' +
      'Cada assignee é um agent autônomo (não humano) com `model` e `instructions` próprios.',
    { boardId: z.string().uuid().optional() },
    async ({ boardId }) => ok(await client.get('/assignees', { boardId })),
  );

  registerTool(
    server,
    'create_assignee',
    'Cria um assignee (agent autônomo) num board (POST /assignees). `name` é obrigatório; ' +
      '`model` define o modelo de AI (senão herda o default do board); `instructions` é o ' +
      'prompt de sistema que orienta o comportamento do agent no loop.',
    {
      boardId: z.string().uuid(),
      name: z.string().min(1),
      model: z.string().optional(),
      instructions: z.string().optional(),
    },
    async ({ boardId, name, model, instructions }) =>
      ok(await client.post('/assignees', { boardId, name, model, instructions })),
  );

  registerTool(
    server,
    'delete_assignee',
    'Remove um assignee (DELETE /assignees/:id). O agent autônomo deixa de existir no board.',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.delete(`/assignees/${id}`)),
  );

  registerTool(
    server,
    'attach_assignee',
    'Associa um assignee (agent autônomo) a um card (POST /cards/:id/assignees). ' +
      '`id` é o card, `assigneeId` o agent que passará a atuar sobre ele.',
    { id: z.string().uuid(), assigneeId: z.string().uuid() },
    async ({ id, assigneeId }) => ok(await client.post(`/cards/${id}/assignees`, { assigneeId })),
  );

  registerTool(
    server,
    'detach_assignee',
    'Desassocia um assignee de um card (DELETE /cards/:id/assignees/:assigneeId). O agent ' +
      'continua existindo no board — apenas deixa de estar no card.',
    { id: z.string().uuid(), assigneeId: z.string().uuid() },
    async ({ id, assigneeId }) => ok(await client.delete(`/cards/${id}/assignees/${assigneeId}`)),
  );

  // ----- Flows ------------------------------------------------------------
  registerTool(
    server,
    'add_flow',
    'Adiciona um flow a um card (POST /cards/:id/flows). Um flow documenta um fluxo do card: ' +
      '`name` (obrigatório), `files` (arquivos relevantes) e `note` (observação). Serve de ' +
      'contexto para o agent autônomo durante o loop.',
    {
      id: z.string().uuid(),
      name: z.string().min(1),
      files: z.array(z.string()).optional(),
      note: z.string().optional(),
    },
    async ({ id, name, files, note }) =>
      ok(await client.post(`/cards/${id}/flows`, { name, files, note })),
  );

  registerTool(
    server,
    'remove_flow',
    'Remove um flow (DELETE /flows/:flowId).',
    { flowId: z.string().uuid() },
    async ({ flowId }) => ok(await client.delete(`/flows/${flowId}`)),
  );

  // ----- Loop profiles ----------------------------------------------------
  registerTool(
    server,
    'list_loop_profiles',
    'Lista os loop profiles, opcionalmente filtrando por `boardId` (GET /loop-profiles). ' +
      'Um loop profile define fases, passo inicial e a estratégia de validação do loop engine.',
    { boardId: z.string().uuid().optional() },
    async ({ boardId }) => ok(await client.get('/loop-profiles', { boardId })),
  );

  registerTool(
    server,
    'create_loop_profile',
    'Cria um loop profile num board (POST /loop-profiles). `name` é obrigatório. `phases` são ' +
      'as fases do loop; `firstStep` o passo inicial; `validation` a estratégia de validação ' +
      "('flows+regression' | 'bug-gone+regression' | 'regression-only').",
    {
      boardId: z.string().uuid(),
      name: z.string().min(1),
      description: z.string().optional(),
      phases: z.array(z.string()).optional(),
      validation: z
        .enum(['flows+regression', 'bug-gone+regression', 'regression-only'])
        .optional(),
      firstStep: z.string().optional(),
    },
    async ({ boardId, name, description, phases, validation, firstStep }) =>
      ok(
        await client.post('/loop-profiles', {
          boardId,
          name,
          description,
          phases,
          validation,
          firstStep,
        }),
      ),
  );

  registerTool(
    server,
    'update_loop_profile',
    'Atualiza um loop profile (PATCH /loop-profiles/:id). Altere `name`, `description`, ' +
      "`phases`, `validation` ('flows+regression' | 'bug-gone+regression' | 'regression-only') " +
      'e/ou `firstStep`.',
    {
      id: z.string().uuid(),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      phases: z.array(z.string()).optional(),
      validation: z
        .enum(['flows+regression', 'bug-gone+regression', 'regression-only'])
        .optional(),
      firstStep: z.string().optional(),
    },
    async ({ id, name, description, phases, validation, firstStep }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (phases !== undefined) body.phases = phases;
      if (validation !== undefined) body.validation = validation;
      if (firstStep !== undefined) body.firstStep = firstStep;
      return ok(await client.patch(`/loop-profiles/${id}`, body));
    },
  );

  registerTool(
    server,
    'delete_loop_profile',
    'Remove um loop profile (DELETE /loop-profiles/:id).',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.delete(`/loop-profiles/${id}`)),
  );
}
