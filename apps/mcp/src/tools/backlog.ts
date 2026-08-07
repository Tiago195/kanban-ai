/**
 * Grupo `backlog` (fatia F7) — fluxo conversacional de criação de backlog via PO.
 *
 * Traduz os endpoints REST `backlog-chat/sessions` (API :3333) em tools finas,
 * permitindo que um agent externo PLANEJE uma feature conversando com o Product
 * Owner e materialize a árvore Epic → Stories → Tasks no board — o que antes só
 * existia no front-end `/backlog-chat`. Ver ADR-0025.
 *
 * O MCP é um cliente HTTP fino: toda a inteligência (decomposição, HITL de
 * descoberta, points Fibonacci, DOD, loopType, cascata de model) vive na API. O
 * fluxo é assíncrono/conversacional; sem streaming dedicado no v1, o cliente faz
 * POLLING de `get_backlog_messages` / `get_backlog_proposal`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  BacklogAppliedCard,
  BacklogChatMessage,
  BacklogChatSessionSummary,
  BacklogProposal,
} from '@kanban-ai/shared';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';

export function registerBacklogTools(server: McpServer, client: KanbanClient): void {
  registerTool(
    server,
    'start_backlog_chat',
    [
      'Inicia uma sessão de chat de backlog com o Product Owner (POST /backlog-chat/sessions).',
      'Retorna `{ id, title }`; use o `id` como `cid` nas demais tools do grupo backlog.',
      'Fluxo típico: start_backlog_chat → send_backlog_message (a intenção de alto nível) →',
      'poll get_backlog_messages até haver resposta/pergunta/proposta → (answer_backlog_question',
      'se houver HITL) → get_backlog_proposal → apply_backlog_proposal.',
    ].join(' '),
    {
      boardId: z.string().uuid().describe('Board onde o Epic + Stories serão materializados.'),
    },
    async (args) => ok(await client.post('/backlog-chat/sessions', { boardId: args.boardId })),
  );

  registerTool(
    server,
    'list_backlog_chats',
    'Lista as sessões de backlog-chat de um board (GET /backlog-chat/sessions), mais recentes primeiro — útil para retomar uma conversa.',
    {
      boardId: z.string().uuid(),
    },
    async (args) =>
      ok(
        await client.get<BacklogChatSessionSummary[]>('/backlog-chat/sessions', {
          boardId: args.boardId,
        }),
      ),
  );

  registerTool(
    server,
    'send_backlog_message',
    [
      'Envia uma mensagem do humano para o PO e DISPARA um turno da AI (POST /backlog-chat/sessions/:cid/messages).',
      'Retorna imediatamente `{ ok: true }` — a resposta da AI é ASSÍNCRONA.',
      'Depois de enviar, faça POLLING de `get_backlog_messages` (e `get_backlog_proposal`) até',
      'aparecer a resposta do PO, uma pergunta de descoberta (HITL) ou uma proposta.',
      'Use na 1ª mensagem para descrever a feature em alto nível (ex.: "épico X com 3 histórias").',
    ].join(' '),
    {
      cid: z.string().uuid().describe('Id da sessão (start_backlog_chat).'),
      text: z.string().min(1).describe('Mensagem do humano para o PO.'),
      channel: z
        .string()
        .min(1)
        .optional()
        .describe('Thread/canal (default: main). Use canais de story só se souber o id da thread.'),
    },
    async (args) =>
      ok(
        await client.post(`/backlog-chat/sessions/${args.cid}/messages`, {
          text: args.text,
          channel: args.channel,
        }),
      ),
  );

  registerTool(
    server,
    'get_backlog_messages',
    [
      'Retorna o transcript persistido da sessão (GET /backlog-chat/sessions/:cid/messages).',
      'É o mecanismo de POLLING do fluxo: chame após send_backlog_message para ler a resposta do',
      'PO, detectar perguntas de descoberta pendentes (HITL) e ver o progresso do turno.',
      'Filtre por `channel` para ler apenas uma thread.',
    ].join(' '),
    {
      cid: z.string().uuid(),
      channel: z.string().min(1).optional(),
    },
    async (args) =>
      ok(
        await client.get<BacklogChatMessage[]>(
          `/backlog-chat/sessions/${args.cid}/messages`,
          { channel: args.channel },
        ),
      ),
  );

  registerTool(
    server,
    'answer_backlog_question',
    [
      'Responde a uma pergunta de descoberta pendente do PO (HITL) (POST /backlog-chat/sessions/:cid/answer).',
      'Obtenha o `questionId` no transcript (get_backlog_messages). Retorna `{ accepted }`;',
      'se não houver pergunta pendente para o questionId, a tool reporta erro acionável.',
      'Após responder, o PO continua o turno — volte a fazer polling de get_backlog_messages.',
    ].join(' '),
    {
      cid: z.string().uuid(),
      questionId: z.string().min(1).describe('Id da pergunta HITL (visível no transcript).'),
      answer: z.string().min(1),
      channel: z.string().min(1).optional(),
    },
    async (args) =>
      ok(
        await client.post(`/backlog-chat/sessions/${args.cid}/answer`, {
          questionId: args.questionId,
          answer: args.answer,
          channel: args.channel,
        }),
      ),
  );

  registerTool(
    server,
    'get_backlog_proposal',
    [
      'Retorna a proposta corrente (maior versão) da sessão (GET /backlog-chat/sessions/:cid/proposal),',
      'ou `null` se o PO ainda está em descoberta. A proposta traz a árvore Epic → Stories → Tasks',
      'com points, loopType e DOD. Inspecione antes de aplicar; itere com send_backlog_message se',
      'quiser ajustes. Guarde o campo `version` para passar em apply_backlog_proposal.',
    ].join(' '),
    {
      cid: z.string().uuid(),
    },
    async (args) =>
      ok(await client.get<BacklogProposal | null>(`/backlog-chat/sessions/${args.cid}/proposal`)),
  );

  registerTool(
    server,
    'apply_backlog_proposal',
    [
      'Aprova e MATERIALIZA a proposta: cria o Epic + Stories (e tasks-rascunho) no board',
      '(POST /backlog-chat/sessions/:cid/apply). Retorna os cards criados (`{ cards }`).',
      'Passe a `version` obtida em get_backlog_proposal para aplicar exatamente a revisão inspecionada.',
      'As invariantes (task só em Backlog/To Do, points Fibonacci, epic derivado) são impostas pela API.',
    ].join(' '),
    {
      cid: z.string().uuid(),
      version: z.number().int().positive().describe('Versão da proposta a materializar.'),
    },
    async (args) =>
      ok(
        await client.post<{ cards: BacklogAppliedCard[] }>(
          `/backlog-chat/sessions/${args.cid}/apply`,
          { version: args.version },
        ),
      ),
  );
}
