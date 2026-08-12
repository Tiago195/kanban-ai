import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { extractBearerToken, MemoryTokenRegistry } from './memory-auth.tokens';
import type { MemoryAgentIdentity } from './memory-auth.tokens';

/**
 * Chave sob a qual a identidade autenticada é anexada ao request. O controller
 * lê daqui (via `@Req()`) para derivar `agentId`/`scope` do TOKEN — nunca de um
 * `sessionId` livre no body.
 */
export const MEMORY_AGENT_KEY = 'memoryAgent';

/** Request com a identidade de memória resolvida pelo guard, quando presente. */
export interface RequestWithMemoryAgent {
  headers: Record<string, string | string[] | undefined>;
  [MEMORY_AGENT_KEY]?: MemoryAgentIdentity;
}

/**
 * Guard de autenticação do control plane de memória (EP-C / US-C2).
 *
 * - **Auth ligada** (há `MEMORY_API_TOKENS`): exige `Authorization: Bearer <token>`
 *   válido; token ausente/desconhecido → `401`. Em sucesso, anexa a identidade
 *   (`agentId` + `scope`) ao request para o controller derivar o autor/escopo do
 *   TOKEN, fechando o buraco de "escrever como qualquer sessão".
 * - **Auth desligada** (sem `MEMORY_API_TOKENS`, modo dev local): deixa passar
 *   SEM exigir token — retrocompat com o loop engine interno que já usa o
 *   controller. Nada é anexado ao request (o controller cai no comportamento
 *   anterior, baseado no body).
 *
 * O registro é resolvido de `process.env.MEMORY_API_TOKENS` no boot do guard.
 * Um registro pode ser injetado explicitamente (testes) via construtor.
 */
@Injectable()
export class MemoryAuthGuard implements CanActivate {
  private readonly registry: MemoryTokenRegistry;

  constructor(registry?: MemoryTokenRegistry) {
    this.registry = registry ?? new MemoryTokenRegistry(process.env.MEMORY_API_TOKENS);
  }

  /** `true` se a auth está ligada (há tokens configurados). */
  get enabled(): boolean {
    return this.registry.enabled;
  }

  canActivate(context: ExecutionContext): boolean {
    // Modo dev local: sem tokens configurados, a auth fica desligada (retrocompat).
    if (!this.registry.enabled) {
      return true;
    }

    const req = context.switchToHttp().getRequest<RequestWithMemoryAgent>();
    const header = firstHeader(req.headers?.authorization);
    const token = extractBearerToken(header);
    const identity = this.registry.resolve(token);
    if (!identity) {
      throw new UnauthorizedException(
        'Memory control plane: token ausente ou inválido. Envie ' +
          '"Authorization: Bearer <token>" com um token configurado em MEMORY_API_TOKENS.',
      );
    }

    req[MEMORY_AGENT_KEY] = identity;
    return true;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
