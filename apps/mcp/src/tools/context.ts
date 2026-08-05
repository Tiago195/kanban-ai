/**
 * Grupo `context` — memória e histórico do trabalho num card. Estas tools são a
 * espinha dorsal da qualidade da AI: permitem ler handoffs/resumos deixados por
 * iterações anteriores (comments) e montar o grafo de dependências entre cards.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';
import { z } from 'zod';

export function registerContextTools(server: McpServer, client: KanbanClient): void {
  registerTool(
    server,
    'list_comments',
    'Lista os comentários de um card (GET /cards/:id/comments). É a memória do card: ' +
      'use no início de uma iteração para ler handoffs, resumos e decisões deixadas por ' +
      'iterações anteriores (suas ou de outro agent). Sempre leia o histórico antes de agir.',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.get(`/cards/${id}/comments`)),
  );

  registerTool(
    server,
    'add_comment',
    'Adiciona um comentário a um card (POST /cards/:id/comments). Use para deixar um ' +
      'handoff/resumo estruturado para a próxima iteração: o que foi feito, decisões ' +
      'tomadas, próximos passos e pontos de atenção. `authorId` é opcional (id do ' +
      'assignee/autor); omita ou envie null quando não houver autor associado.',
    {
      id: z.string().uuid(),
      text: z.string().min(1),
      authorId: z.string().uuid().nullable().optional(),
    },
    async ({ id, text, authorId }) =>
      ok(await client.post(`/cards/${id}/comments`, { text, authorId })),
  );

  registerTool(
    server,
    'add_dependency',
    'Cria uma dependência entre cards (POST /cards/:id/dependencies). O card do path ' +
      '(`id`) passa a DEPENDER de `dependsOnId` — ou seja, `dependsOnId` deve ser concluído ' +
      'antes. Use para montar o grafo de dependências e evitar iniciar trabalho bloqueado.',
    { id: z.string().uuid(), dependsOnId: z.string().uuid() },
    async ({ id, dependsOnId }) =>
      ok(await client.post(`/cards/${id}/dependencies`, { dependsOnId })),
  );

  registerTool(
    server,
    'remove_dependency',
    'Remove uma dependência entre cards (DELETE /cards/:id/dependencies/:dependsOnId). ' +
      'Use para desfazer uma dependência criada por engano ou que deixou de existir. ' +
      'O card `id` deixa de depender de `dependsOnId`.',
    { id: z.string().uuid(), dependsOnId: z.string().uuid() },
    async ({ id, dependsOnId }) =>
      ok(await client.delete(`/cards/${id}/dependencies/${dependsOnId}`)),
  );
}
