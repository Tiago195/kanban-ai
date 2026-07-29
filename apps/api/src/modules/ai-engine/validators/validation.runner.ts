import { Injectable, Logger } from '@nestjs/common';
import type { ValidationStrategy } from '@kanban-ai/shared';

/** Resultado da iteração final de validação. */
export interface ValidationOutcome {
  passed: boolean;
  /** Problemas encontrados → viram tasks derivadas. */
  problems: Array<{ title: string; description: string }>;
}

/**
 * Executa a **iteração final de validação** quando todos os DOD estão marcados.
 *
 * Faz "teste de mesa" empírico dos **fluxos afetados** declarados pela story
 * (`affectedFlows`). Se encontra problemas, o Orchestrator cria uma **task
 * derivada** (derivedFrom) com contexto completo.
 *
 * ⚠️ STUB — a lógica real de validação ainda não está implementada.
 */
@Injectable()
export class ValidationRunner {
  private readonly logger = new Logger(ValidationRunner.name);

  async validate(
    storyId: string,
    strategy: ValidationStrategy,
  ): Promise<ValidationOutcome> {
    this.logger.warn(`ValidationRunner.validate() STUB — story=${storyId} strategy=${strategy}`);
    // TODO: percorrer affectedFlows da story e validar cada fluxo empiricamente.
    // TODO: mapear a estratégia (flows+regression | bug-gone+regression | regression-only).
    // TODO: retornar problems[] para o Orchestrator derivar tasks.
    return { passed: true, problems: [] };
  }
}
