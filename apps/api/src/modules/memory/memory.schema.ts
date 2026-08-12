import { z } from 'zod';

/**
 * Schemas HTTP do módulo de **memória** (EP-82 — control plane REST consumido
 * pelo MCP). O MCP é um cliente HTTP fino (ADR-0020): estas rotas são a ponte
 * pela qual os agents autônomos leem/escrevem a colmeia. Toda regra de negócio
 * (CAS, locks, REVIEW) vive nos serviços; aqui só validamos a borda.
 *
 * `path` é a identidade LÓGICA do neurônio (o `.md` versionado — `Neuron.path`).
 */

/** Leitura global do HEAD de um neurônio (GET /memory/read?path=...). */
export const memoryReadQuerySchema = z.object({
  path: z.string().min(1),
});
export type MemoryReadQueryDto = z.infer<typeof memoryReadQuerySchema>;

/**
 * Escrita otimista de um neurônio (POST /memory/write). Exige `baseCommit`
 * (o HEAD lido) — delega ao compare-and-swap da EP-79. `sessionId` identifica o
 * ramo efêmero do autor (`mem/ai/<sessao>/<path>`).
 */
export const memoryWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  sessionId: z.string().min(1),
  baseCommit: z.string().min(1),
  message: z.string().min(1),
  /**
   * Módulo da story do autor (EP-83/US-211). Quando presente, ativa o
   * enforcement de escopo: escrita fora de `modules/<module>/` NÃO aplica direto
   * — vira proposta em REVIEW (US-212). Omitir preserva o comportamento anterior
   * (escrita direta), útil para chamadas internas já validadas.
   */
  module: z.string().min(1).optional(),
});
export type MemoryWriteDto = z.infer<typeof memoryWriteSchema>;

/** Aquisição de lease advisory (POST /memory/acquire). Retorna `baseCommit`. */
export const memoryAcquireSchema = z.object({
  path: z.string().min(1),
  holder: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});
export type MemoryAcquireDto = z.infer<typeof memoryAcquireSchema>;

/** Renovação de TTL do lease (POST /memory/heartbeat). */
export const memoryHeartbeatSchema = z.object({
  path: z.string().min(1),
  holder: z.string().min(1),
  ttlMs: z.number().int().positive().optional(),
});
export type MemoryHeartbeatDto = z.infer<typeof memoryHeartbeatSchema>;

/** Liberação do lease — dispara o merge do ramo efêmero (POST /memory/release). */
export const memoryReleaseSchema = z.object({
  path: z.string().min(1),
  holder: z.string().min(1),
});
export type MemoryReleaseDto = z.infer<typeof memoryReleaseSchema>;

/**
 * Arbitragem de um REVIEW (POST /memory/resolve). Sem `content` = **descartar**
 * (mantém o HEAD estável); com `content` = **aceitar** (commita a mutação
 * arbitrada). `baseCommit` alimenta o CAS anti-stale da EP-80.
 */
export const memoryResolveSchema = z.object({
  path: z.string().min(1),
  baseCommit: z.string().min(1),
  content: z.string().optional(),
  arbiter: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
});
export type MemoryResolveDto = z.infer<typeof memoryResolveSchema>;
