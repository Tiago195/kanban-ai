/**
 * Grupo `loop` — controle e observação do AI Engine (loop engine). Permite
 * disparar iterações, ligar/desligar o modo automático, responder perguntas do
 * agent (HITL) e inspecionar estado, métricas e o transcript persistido.
 *
 * IMPORTANTE — granularidade:
 * - O loop opera sobre uma STORY: `loop_state`, `loop_step`, `loop_start_auto`,
 *   `loop_stop_auto`, `loop_answer` e `loop_metrics` recebem o id de uma STORY.
 * - `get_chat` é por TASK: recebe o id de uma TASK e retorna o transcript
 *   persistido daquela task (com options/questionId do HITL).
 *
 * Padrão típico de operação:
 *   1. move_card(story → In Progress)  // dispara o loop engine
 *   2. loop_state(story)               // poll do estado
 *   3. se houver pergunta pendente → get_chat(task) para ler as `options` e
 *      loop_answer(story, questionId, answer) respondendo uma OPÇÃO VÁLIDA
 *   4. get_chat(task)                  // inspecionar o transcript
 *   5. loop_stop_auto(story)           // encerrar ao concluir
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';
import { z } from 'zod';

export function registerLoopTools(server: McpServer, client: KanbanClient): void {
  registerTool(
    server,
    'loop_state',
    'Retorna o estado atual do loop de uma STORY (GET /cards/:id/loop/state). `id` é o ' +
      'id da STORY. Use para poll: descobrir se o loop está rodando, se há pergunta ' +
      'pendente (HITL) aguardando resposta e em que iteração está.',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.get(`/cards/${id}/loop/state`)),
  );

  registerTool(
    server,
    'loop_step',
    'Executa UMA iteração manual do loop de uma STORY (POST /cards/:id/loop/step). ' +
      'Retorna `{ ran }` indicando se a iteração foi executada. `id` é o id da STORY. ' +
      'Use para avançar o trabalho passo a passo sem ligar o modo automático.',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.post(`/cards/${id}/loop/step`)),
  );

  registerTool(
    server,
    'loop_start_auto',
    'Liga o modo automático do loop de uma STORY (POST /cards/:id/loop/auto/start). ' +
      'Retorna `{ running }`. `id` é o id da STORY. O loop passa a iterar sozinho até ' +
      'concluir, ser parado (loop_stop_auto) ou ficar bloqueado por uma pergunta (HITL).',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.post(`/cards/${id}/loop/auto/start`)),
  );

  registerTool(
    server,
    'loop_stop_auto',
    'Desliga o modo automático do loop de uma STORY (POST /cards/:id/loop/auto/stop). ' +
      '`id` é o id da STORY. `mode` é opcional: `graceful` (padrão) deixa a iteração ' +
      'atual terminar; `hard` interrompe imediatamente. Use `graceful` ao concluir ' +
      'normalmente; `hard` só para abortar de emergência.',
    { id: z.string().uuid(), mode: z.enum(['graceful', 'hard']).optional() },
    async ({ id, mode }) =>
      ok(await client.post(`/cards/${id}/loop/auto/stop`, mode !== undefined ? { mode } : {})),
  );

  registerTool(
    server,
    'loop_answer',
    'Responde uma pergunta do agent no loop de uma STORY (POST /cards/:id/loop/answer, ' +
      'HITL). `id` é o id da STORY. Informe o `questionId` da pergunta pendente e a ' +
      '`answer`. Quando a pergunta trouxer `options` (via get_chat), responda com uma ' +
      'OPÇÃO VÁLIDA — o loop retoma a execução após a resposta.',
    { id: z.string().uuid(), questionId: z.string().min(1), answer: z.string().min(1) },
    async ({ id, questionId, answer }) =>
      ok(await client.post(`/cards/${id}/loop/answer`, { questionId, answer })),
  );

  registerTool(
    server,
    'loop_metrics',
    'Retorna as métricas do loop de uma STORY (GET /cards/:id/loop/metrics). `id` é o ' +
      'id da STORY. Use para observar progresso e custo: iterações, tempo, tokens e ' +
      'demais indicadores acumulados da execução.',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.get(`/cards/${id}/loop/metrics`)),
  );

  registerTool(
    server,
    'get_chat',
    'Retorna o transcript persistido de uma TASK (GET /cards/:id/chat). ATENÇÃO: aqui ' +
      '`id` é o id de uma TASK (não da story). Traz o histórico de mensagens da execução, ' +
      'incluindo perguntas do HITL com seu `questionId` e as `options` (respostas rápidas) ' +
      'que devem ser usadas em loop_answer. Use para inspecionar o que o agent fez e decidir.',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.get(`/cards/${id}/chat`)),
  );

  registerTool(
    server,
    'loop_set_monitor',
    'US-SCHED1: arma um monitor deferred (time-gated wake) para uma STORY ' +
      '(POST /cards/:id/loop/monitor). `id` é o id da STORY. O agent PARK (espera um ' +
      'evento externo, ex: "volto em 30min pra checar CI") e acorda automaticamente no ' +
      '`nextCheckAt` (ISO 8601 datetime). One-shot: dispara UMA vez e auto-clear; o agent ' +
      'pode re-armar se ainda estiver esperando. Útil para esperas longas sem polling.',
    {
      id: z.string().uuid(),
      nextCheckAt: z.string().datetime(),
      notes: z.string().optional(),
      timeoutAt: z.string().datetime().optional(),
      maxAttempts: z.number().int().positive().optional(),
    },
    async ({ id, nextCheckAt, notes, timeoutAt, maxAttempts }) =>
      ok(
        await client.post(`/cards/${id}/loop/monitor`, {
          nextCheckAt,
          ...(notes !== undefined ? { notes } : {}),
          ...(timeoutAt !== undefined ? { timeoutAt } : {}),
          ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        }),
      ),
  );

  registerTool(
    server,
    'loop_clear_monitor',
    'US-SCHED1: limpa/cancela o monitor pendente de uma STORY ' +
      '(DELETE /cards/:id/loop/monitor). `id` é o id da STORY. Útil quando o agent ' +
      'decide que não precisa mais esperar pelo evento externo (ex: CI completou antes ' +
      'do esperado).',
    { id: z.string().uuid() },
    async ({ id }) => ok(await client.delete(`/cards/${id}/loop/monitor`)),
  );
}
