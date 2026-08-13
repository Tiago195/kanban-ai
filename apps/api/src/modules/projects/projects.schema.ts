import { z } from 'zod';

/**
 * Sintaxe aceita de `repoUrl`: https(s) ou ssh (git@host:path OU ssh://...).
 * Validação apenas sintática (o clone real é responsabilidade da US-PROJ2).
 */
const httpsRepoUrl = /^https?:\/\/\S+$/i;
const scpSshRepoUrl = /^[^@\s]+@[^:\s]+:\S+$/i; // git@github.com:owner/repo.git
const sshUrl = /^ssh:\/\/\S+$/i;

const repoUrlSchema = z
  .string()
  .min(1)
  .refine(
    (v) => httpsRepoUrl.test(v) || scpSshRepoUrl.test(v) || sshUrl.test(v),
    { message: 'repoUrl deve ser uma URL https ou ssh válida' },
  );

/** Schema de criação de Project. */
export const createProjectSchema = z.object({
  name: z.string().min(1),
  repoUrl: repoUrlSchema,
  defaultBranch: z.string().min(1).nullable().optional(),
  authKind: z.enum(['none', 'https', 'ssh']).optional(),
  // Referência OPACA à credencial (nunca o segredo em si). Ver US-PROJ3.
  credentialRef: z.string().min(1).nullable().optional(),
  /** Rótulo opaco de escopo multi-tenant (ADR-0009). Ausente = global. */
  tenantId: z.string().min(1).nullable().optional(),
});

export type CreateProjectDto = z.infer<typeof createProjectSchema>;

/**
 * US-PROJ7 — query da leitura de um neurônio (`GET /projects/:id/memory/read`).
 * `path` é o path lógico do neurônio no git (ex.: `modules/cards.md`).
 */
export const projectMemoryReadQuerySchema = z.object({
  path: z.string().min(1),
});

export type ProjectMemoryReadQueryDto = z.infer<typeof projectMemoryReadQuerySchema>;
