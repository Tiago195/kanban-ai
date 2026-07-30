import { Injectable, Logger } from '@nestjs/common';
import type { AffectedFlow, ValidationStrategy } from '@kanban-ai/shared';

export interface ValidationOutcome {
  passed: boolean;
  problems: Array<{ title: string; description: string }>;
}

@Injectable()
export class ValidationRunner {
  private readonly logger = new Logger(ValidationRunner.name);

  // NOTE b6: assinatura mudou para receber affectedFlows; integração completa no orchestrator em b6.
  /**
   * Executa validação heurística mínima (sem rodar suíte real de testes).
   *
   * Regras:
   * - Estratégias com "flows" exigem lista de fluxos afetados não vazia.
   * - Cada fluxo deve referenciar ao menos um arquivo para teste de mesa.
   */
  async validate(input: {
    storyId: string;
    strategy: ValidationStrategy;
    affectedFlows: AffectedFlow[];
  }): Promise<ValidationOutcome> {
    const { storyId, strategy, affectedFlows } = input;
    const problems: ValidationOutcome['problems'] = [];

    switch (strategy) {
      case 'flows+regression':
        if (affectedFlows.length === 0) {
          problems.push({
            title: 'Nenhum fluxo afetado declarado',
            description: `A estratégia ${strategy} requer fluxos afetados para validação, mas a story não declara nenhum.`,
          });
        }
        break;
      case 'bug-gone+regression':
      case 'regression-only':
        // Nessas estratégias, flows podem vir vazios; validamos arquivos só quando houver fluxos.
        break;
      default: {
        const exhaustiveCheck: never = strategy;
        this.logger.warn(`Estratégia de validação não mapeada: ${String(exhaustiveCheck)}`);
      }
    }

    for (const flow of affectedFlows) {
      if (flow.files.length === 0) {
        problems.push({
          title: `Fluxo "${flow.name}" sem arquivos`,
          description: `O fluxo afetado "${flow.name}" não referencia arquivos; não é possível fazer teste de mesa.`,
        });
      }
    }

    const passed = problems.length === 0;
    this.logger.debug(
      `Validation heurística concluída: story=${storyId} strategy=${strategy} flows=${affectedFlows.length} passed=${passed}`,
    );

    return { passed, problems };
  }
}
