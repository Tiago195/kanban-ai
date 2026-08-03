import { Injectable, Logger } from '@nestjs/common';
import type {
  AgentRunContext,
  AgentRunInput,
  AgentRunResult,
  AgentRunner,
} from './agent-runner.interface';

/**
 * Runner MOCK server-side. Determinístico, sem spawn de processo nem rede.
 *
 * Porta o `mockIterationContent` do artifact de referência
 * (docs/reference/kanban.html, linhas ~950–976): gera `detail`/`summary`/
 * `nextStep`/`dodTouched` coerentes por fase do loop, a partir do contexto de
 * domínio da story pai (projeto, notas, fluxos afetados, arquivos).
 *
 * O `done` só é `true` na fase `validation` — o gate de DOD (quem decide quando
 * chega a `validation`) fica no Orchestrator; aqui apenas geramos conteúdo.
 */
@Injectable()
export class MockAgentRunner implements AgentRunner {
  readonly id = 'mock';
  private readonly logger = new Logger(MockAgentRunner.name);

  run(input: AgentRunInput): Promise<AgentRunResult> {
    const ctx = this.ctx(input.context);
    const filesLabel = ctx.files.length ? ctx.files.join(', ') : '—';

    switch (input.phase) {
      case 'reproduce':
        return this.result({
          detail: `Reproduzindo o problema em ${ctx.project}. Passos executados para disparar o cenário e confirmar a causa raiz. Arquivos suspeitos: ${filesLabel}.`,
          summary: 'Reproduzi o problema e isolei a causa raiz.',
          nextStep: 'Analisar a causa raiz e planejar a correção.',
        });
      case 'analysis':
        return this.result({
          detail: `Entendi o objetivo da task "${ctx.taskTitle}". Vou mexer em ${ctx.project} nos arquivos ${filesLabel}. Efeitos colaterais a cuidar: ${ctx.notes || 'validar regressões nos fluxos relacionados'}.`,
          summary: 'Analisei escopo, arquivos e efeitos colaterais.',
          nextStep: 'Implementar a mudança conforme a análise.',
          affectedFlows: this.buildAffectedFlows(ctx),
        });
      case 'implementation':
        return this.result({
          detail: `Implementação em andamento. Alterei ${ctx.files[0] ?? 'os arquivos-alvo'} para atender ao próximo DOD. Cobertura de teste local ajustada. Próxima iteração continua até fechar os DODs restantes.`,
          summary: 'Implementei parte da mudança e marquei DOD.',
          nextStep: 'Continuar implementação até fechar todos os DODs.',
          affectedFlows: this.buildAffectedFlows(ctx),
        });
      case 'validation':
        return this.result({
          detail: `Validação final (teste de mesa) dos fluxos afetados: ${ctx.flowNames.join(', ') || '—'}. Verifiquei cada fluxo empiricamente nos arquivos vinculados. ✅ Todos os fluxos validados com sucesso.`,
          summary: 'Validei todos os fluxos afetados.',
          nextStep: '',
          done: true,
        });
      default:
        this.logger.warn(`fase desconhecida: ${input.phase}`);
        return this.result({ detail: '', summary: '', nextStep: '' });
    }
  }

  private ctx(context?: AgentRunContext): AgentRunContext {
    return {
      taskTitle: context?.taskTitle ?? '(task)',
      project: context?.project || '(projeto não definido)',
      notes: context?.notes ?? '',
      flowNames: context?.flowNames ?? [],
      files: (context?.files ?? []).slice(0, 4),
    };
  }

  private result(partial: {
    detail: string;
    summary: string;
    nextStep: string;
    done?: boolean;
    affectedFlows?: { name: string; files: string[]; note?: string }[];
  }): Promise<AgentRunResult> {
    return Promise.resolve({
      detail: partial.detail,
      summary: partial.summary,
      dodTouched: [],
      nextStep: partial.nextStep,
      done: partial.done ?? false,
      ...(partial.affectedFlows ? { affectedFlows: partial.affectedFlows } : {}),
    });
  }

  /**
   * Deriva a lista de fluxos afetados a partir do contexto da story.
   * Se a story já tem fluxos declarados (flowNames), mapeia cada um para os
   * arquivos disponíveis. Caso contrário, cria um único fluxo "main" com os
   * arquivos do contexto (ou o título da task como fallback).
   */
  private buildAffectedFlows(
    ctx: AgentRunContext,
  ): { name: string; files: string[]; note?: string }[] {
    // Garante que os arquivos nunca ficam vazios: flows+regression exige
    // files.length > 0 em cada fluxo. Na primeira iteração (sem fluxos
    // declarados ainda), usa o título da task como referência sintética.
    const files = ctx.files.length > 0 ? ctx.files : [ctx.taskTitle || 'main'];
    if (ctx.flowNames.length > 0) {
      return ctx.flowNames.map((name) => ({
        name,
        files,
        note: 'Fluxo identificado na análise',
      }));
    }
    return [
      {
        name: files[0].split('/').pop()!.replace(/\.ts$/, ''),
        files,
        note: 'Fluxo derivado do contexto da task',
      },
    ];
  }
}
