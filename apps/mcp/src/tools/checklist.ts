/**
 * Grupo `checklist` — gestão do DOD (Definition of Done) dos cards.
 *
 * IMPORTANTE (invariante de domínio): no v1 o **DOD é o único checklist e o único
 * gate** do card. NÃO existe DOR nem `acceptance` (ver ADR-0007). Todas as tools
 * abaixo operam exclusivamente sobre itens de DOD.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';
import { z } from 'zod';

export function registerChecklistTools(server: McpServer, client: KanbanClient): void {
  registerTool(
    server,
    'add_dod_item',
    'Adiciona um item ao DOD (Definition of Done) de um card (POST /cards/:id/dod). ' +
      'O DOD é o único checklist/gate do card no v1 — não há DOR nem acceptance (ADR-0007). ' +
      '`id` é o card; `text` é a descrição do critério de pronto.',
    { id: z.string().uuid(), text: z.string().min(1) },
    async ({ id, text }) => ok(await client.post(`/cards/${id}/dod`, { text })),
  );

  registerTool(
    server,
    'update_dod_item',
    'Atualiza um item de DOD (PATCH /dod/:itemId): edite o `text` e/ou marque `done`. ' +
      'Informe ao menos um dos dois campos. Marcar todos os itens como `done` é o que ' +
      'satisfaz o gate de conclusão do card.',
    {
      itemId: z.string().uuid(),
      text: z.string().min(1).optional(),
      done: z.boolean().optional(),
    },
    async ({ itemId, text, done }) => {
      const body: Record<string, unknown> = {};
      if (text !== undefined) body.text = text;
      if (done !== undefined) body.done = done;
      return ok(await client.patch(`/dod/${itemId}`, body));
    },
  );

  registerTool(
    server,
    'remove_dod_item',
    'Remove um item do DOD (DELETE /dod/:itemId). Use quando um critério deixou de ' +
      'fazer sentido para o card.',
    { itemId: z.string().uuid() },
    async ({ itemId }) => ok(await client.delete(`/dod/${itemId}`)),
  );
}
