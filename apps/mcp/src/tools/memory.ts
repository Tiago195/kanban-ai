/**
 * Grupo `memory` — o canal pelo qual os agents autônomos leem/escrevem a
 * **colmeia de memória** (ADR-0027, ADR-0020). O MCP é um cliente HTTP fino: as
 * tools abaixo são pontes ergonômicas para o control plane REST `/memory/*` da
 * API; toda invariante (CAS, locks advisory, REVIEW) vive no backend.
 *
 * Fluxo canônico de escrita coordenada:
 *   1. `memory_acquire` (pega o lease + o `baseCommit` a usar)
 *   2. `memory_read` (opcional — lê o conteúdo atual)
 *   3. `memory_write` (repassa o `baseCommit` — CAS anti-stale)
 *   4. `memory_release` (dispara o merge do ramo efêmero)
 * Use `memory_heartbeat` para renovar o lease em trabalhos longos.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KanbanClient } from '../client.js';
import { ok, registerTool } from './util.js';
import { z } from 'zod';

export function registerMemoryTools(server: McpServer, client: KanbanClient): void {
  registerTool(
    server,
    'memory_read',
    'Lê o HEAD global de um neurônio da colmeia (GET /memory/read). A leitura é ' +
      'GLOBAL: qualquer agent lê qualquer neurônio. Retorna `content` (pode ser null se ' +
      'o neurônio ainda não existe) e `headCommit` — GUARDE esse `headCommit` para ' +
      'repassá-lo como `baseCommit` num `memory_write` (compare-and-swap anti-stale).',
    { path: z.string().min(1) },
    async ({ path }) => ok(await client.get('/memory/read', { path })),
  );

  registerTool(
    server,
    'memory_write',
    'Escreve/atualiza um neurônio (POST /memory/write) com escrita otimista. EXIGE ' +
      '`baseCommit` (o `headCommit` que você leu em `memory_read`/`memory_acquire`): a API ' +
      'faz compare-and-swap — se o HEAD tiver avançado, tenta rebase e pode falhar com 409 ' +
      '(releia e reescreva). Informe `module` (o módulo da sua story) para ativar o ' +
      'enforcement de escopo: escrita fora de `modules/<module>/` NÃO aplica direto — vira ' +
      'proposta em REVIEW (a resposta será o item de REVIEW). `sessionId` identifica seu ramo efêmero.',
    {
      path: z.string().min(1),
      content: z.string(),
      sessionId: z.string().min(1),
      baseCommit: z.string().min(1),
      message: z.string().min(1),
      module: z.string().min(1).optional(),
    },
    async (args) => ok(await client.post('/memory/write', args)),
  );

  registerTool(
    server,
    'memory_acquire',
    'Adquire um lease advisory sobre um neurônio (POST /memory/acquire) — coordenação ' +
      'social "estou editando isto agora". Retorna `baseCommit` (use-o no `memory_write`), ' +
      '`leaseId` e `expiresAt`. O lease tem TTL: em trabalhos longos renove com ' +
      '`memory_heartbeat`. `holder` é sua identidade estável (sessão+story).',
    {
      path: z.string().min(1),
      holder: z.string().min(1),
      ttlMs: z.number().int().positive().optional(),
    },
    async (args) => ok(await client.post('/memory/acquire', args)),
  );

  registerTool(
    server,
    'memory_heartbeat',
    'Renova o TTL do lease de um neurônio (POST /memory/heartbeat). Chame periodicamente ' +
      'durante edições longas para não perder o lease por expiração. Retorna o novo ' +
      '`expiresAt`. Deve ser chamado pelo mesmo `holder` que fez o `memory_acquire`.',
    {
      path: z.string().min(1),
      holder: z.string().min(1),
      ttlMs: z.number().int().positive().optional(),
    },
    async (args) => ok(await client.post('/memory/heartbeat', args)),
  );

  registerTool(
    server,
    'memory_release',
    'Libera o lease de um neurônio (POST /memory/release) e dispara o merge do seu ramo ' +
      'efêmero em main. Chame ao terminar de editar. Deve ser o mesmo `holder` do ' +
      '`memory_acquire`. Se o merge conflitar semanticamente, o neurônio pode entrar em REVIEW.',
    { path: z.string().min(1), holder: z.string().min(1) },
    async (args) => ok(await client.post('/memory/release', args)),
  );

  registerTool(
    server,
    'memory_resolve',
    'Arbitra um neurônio em REVIEW (POST /memory/resolve) — para o árbitro (agent revisor ' +
      'ou humano) fechar um conflito pelo control plane. Sem `content` = DESCARTAR (mantém o ' +
      'HEAD estável). Com `content` = ACEITAR (commita a mutação arbitrada). `baseCommit` ' +
      'alimenta o compare-and-swap anti-stale: use o `baseCommit` do item de REVIEW.',
    {
      path: z.string().min(1),
      baseCommit: z.string().min(1),
      content: z.string().optional(),
      arbiter: z.string().min(1).optional(),
      sessionId: z.string().min(1).optional(),
    },
    async (args) => ok(await client.post('/memory/resolve', args)),
  );

  registerTool(
    server,
    'memory_bootstrap',
    'Semeia a colmeia a partir do repo-alvo (POST /memory/bootstrap, EP-84). Varre ' +
      '`repoPath` (a raiz do projeto), detecta os módulos e cria 1 neurônio inicial por ' +
      'módulo. É IDEMPOTENTE: neurônios já existentes são preservados (nunca sobrescreve o ' +
      'que as AIs já mantêm), então pode ser chamado com segurança quantas vezes precisar. ' +
      'Retorna `created` (paths criados agora) e `count`.',
    {
      repoPath: z.string().min(1),
      sessionId: z.string().min(1).optional(),
    },
    async (args) => ok(await client.post('/memory/bootstrap', args)),
  );

  registerTool(
    server,
    'memory_ensure_neuron',
    'Garante o neurônio do módulo de um arquivo (POST /memory/ensure-neuron, EP-84 lazy). ' +
      'Dado um `filePath` (relativo à raiz do repo) que você vai tocar, cria o neurônio do ' +
      'seu módulo se ainda não existir — útil quando o bootstrap inicial não previu o módulo. ' +
      'Retorna o `neuronPath` garantido (ou null se o arquivo não mapeia um módulo).',
    {
      filePath: z.string().min(1),
      sessionId: z.string().min(1).optional(),
    },
    async (args) => ok(await client.post('/memory/ensure-neuron', args)),
  );
}
