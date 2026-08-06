import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AffectedFlow, ValidationStrategy } from '@kanban-ai/shared';
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config';
import { WorkspaceService } from '../workspaces/workspace.service';

export interface ValidationOutcome {
  passed: boolean;
  problems: Array<{ title: string; description: string }>;
}

/** #1: mapeia a estrategia do profile para os scripts npm a rodar no worktree. */
const STRATEGY_SCRIPTS: Record<ValidationStrategy, string[]> = {
  'flows+regression': ['build', 'lint', 'test'],
  'bug-gone+regression': ['build', 'test'],
  'regression-only': ['build', 'test'],
};

@Injectable()
export class ValidationRunner {
  private readonly logger = new Logger(ValidationRunner.name);

  constructor(
    private readonly workspaces: WorkspaceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Valida uma story quando o DOD fecha. Combina:
   *  1. Checagens estruturais baratas (fluxos declarados, arquivos por fluxo).
   *  2. #7: verificacao de que os arquivos dos fluxos existem no worktree.
   *  3. #1: validacao empirica real - roda os scripts do projeto (test/build/lint)
   *     no worktree isolado e converte falhas em `problems` (-> task derivada).
   *  4. #5: teste de mesa empirico por fluxo - garante que uma suite global verde
   *     nao conte como "passed" quando os affectedFlows declarados nao sao de fato
   *     exercitados por nenhum teste (ver runFlowTargetedTests).
   */
  async validate(input: {
    storyId: string;
    strategy: ValidationStrategy;
    affectedFlows: AffectedFlow[];
    /** #1/#7: worktree isolado da story (quando disponivel). */
    cwd?: string;
  }): Promise<ValidationOutcome> {
    const { storyId, strategy, affectedFlows, cwd } = input;
    const problems: ValidationOutcome['problems'] = [];

    // 1. Checagens estruturais (pre-condicao barata).
    switch (strategy) {
      case 'flows+regression':
        if (affectedFlows.length === 0) {
          problems.push({
            title: 'Nenhum fluxo afetado declarado',
            description: `A estrategia ${strategy} requer fluxos afetados para validacao, mas a story nao declara nenhum.`,
          });
        }
        break;
      case 'bug-gone+regression':
      case 'regression-only':
        break;
      default: {
        const exhaustiveCheck: never = strategy;
        this.logger.warn(`Estrategia de validacao nao mapeada: ${String(exhaustiveCheck)}`);
      }
    }

    for (const flow of affectedFlows) {
      if (flow.files.length === 0) {
        problems.push({
          title: `Fluxo "${flow.name}" sem arquivos`,
          description: `O fluxo afetado "${flow.name}" nao referencia arquivos; nao e possivel fazer teste de mesa.`,
        });
      }
    }

    // 2. #7: verificar que os arquivos declarados existem no worktree.
    if (this.config.agent.verifyFlowFiles && cwd) {
      for (const flow of affectedFlows) {
        for (const file of flow.files) {
          const exists = await this.workspaces.fileExistsInWorktree(cwd, file);
          if (!exists) {
            problems.push({
              title: `Arquivo inexistente no fluxo "${flow.name}"`,
              description:
                `A AI declarou tocar "${file}" no fluxo "${flow.name}", mas o arquivo nao existe no ` +
                `worktree. Provavel alucinacao - revise o fluxo e o trabalho feito.`,
            });
          }
        }
      }
    }

    // 3b. Validação direcionada por fluxo: localizar e rodar os testes
    //     associados aos arquivos de cada affectedFlow. Complementar ao passo
    //     global (3). Roda ANTES do global para saber se já cobrimos `test`.
    let flowTestsCoveredTest = false;
    if (this.config.agent.flowTestsEnabled && cwd) {
      flowTestsCoveredTest = await this.runFlowTargetedTests(cwd, affectedFlows, problems);
    }

    // 3. #1: validacao empirica real (scripts do projeto no worktree).
    if (this.config.agent.validationEnabled && cwd) {
      let wanted =
        this.config.agent.validationScripts.length > 0
          ? this.config.agent.validationScripts
          : STRATEGY_SCRIPTS[strategy];
      // Evita rodar `test` duas vezes: se os testes direcionados já rodaram
      // testes de fluxo, mantemos build/lint globais (regression) mas pulamos
      // o `test` global — os direcionados são um subconjunto mais preciso.
      if (flowTestsCoveredTest) {
        wanted = wanted.filter((s) => s !== 'test');
      }
      try {
        const checks = await this.workspaces.runProjectChecks(cwd, wanted);
        for (const check of checks) {
          if (check.ran && !check.passed) {
            problems.push({
              title: `Falha no check \`${check.name}\` (exit ${check.exitCode ?? '?'})`,
              description:
                `O script \`npm run ${check.name}\` falhou no worktree. Corrija antes de concluir.\n\n` +
                truncate(check.output, 2000),
            });
          }
        }
      } catch (err) {
        this.logger.warn(`Falha ao rodar checks de validacao (story=${storyId}): ${String(err)}`);
      }
    }

    const passed = problems.length === 0;
    this.logger.debug(
      `Validation concluida: story=${storyId} strategy=${strategy} flows=${affectedFlows.length} ` +
        `cwd=${cwd ? 'sim' : 'nao'} passed=${passed} problems=${problems.length}`,
    );

    return { passed, problems };
  }

  /**
   * Validação direcionada por fluxo ("teste de mesa" empírico dos affectedFlows).
   * Para cada affectedFlow localiza os testes co-located dos seus arquivos e os
   * roda restritos a esses arquivos. O objetivo é fechar a lacuna "suite verde ≠
   * mudança coberta": um fluxo cujos arquivos existem e cuja suite global passa
   * NÃO deve contar como validado se nenhum teste realmente exercita aquele fluxo.
   *
   *  - Testes encontrados que falham -> `problem` mencionando o fluxo.
   *  - Fluxo que declara arquivos-fonte (não-spec) mas NÃO tem nenhum spec
   *    co-located -> lacuna de cobertura: `problem` (nomeando fluxo+arquivos) se
   *    `requireFlowCoverage`, senão apenas aviso.
   *  - Fluxo com specs localizados mas que NÃO puderam ser executados (runner
   *    indeterminado) -> `problem` se `requireFlowCoverage` (não podemos afirmar
   *    que o fluxo foi exercitado); senão fallback silencioso ao global.
   *
   * Retorna true se ao menos um fluxo teve testes direcionados EXECUTADOS
   * (usado para pular o `test` global e evitar rodar duas vezes).
   */
  private async runFlowTargetedTests(
    cwd: string,
    affectedFlows: AffectedFlow[],
    problems: ValidationOutcome['problems'],
  ): Promise<boolean> {
    const markers = this.config.agent.flowTestGlobs;
    const requireCoverage = this.config.agent.requireFlowCoverage;
    let ranAny = false;

    for (const flow of affectedFlows) {
      // Separamos arquivos-fonte (que PRECISAM de teste que os exercite) dos
      // arquivos que já são specs. Um fluxo que só declara specs não gera lacuna.
      const sourceFiles = flow.files.filter((f) => !markers.some((m) => f.includes(m)));
      const testFiles = new Set<string>();
      for (const file of flow.files) {
        try {
          const related = await this.workspaces.findRelatedTestFiles(cwd, file, markers);
          for (const t of related) testFiles.add(t);
        } catch (err) {
          this.logger.warn(
            `Falha ao localizar testes do fluxo "${flow.name}" (arquivo=${file}): ${String(err)}`,
          );
        }
      }

      if (testFiles.size === 0) {
        // Lacuna de cobertura empírica: o fluxo declara arquivos-fonte mas
        // nenhum spec co-located os exercita. A suite global pode estar verde
        // sem tocar nada disto — não conta como "teste de mesa" do fluxo.
        if (requireCoverage && sourceFiles.length > 0) {
          problems.push({
            title: `Fluxo "${flow.name}" sem cobertura de teste executável`,
            description:
              `Teste de mesa do fluxo "${flow.name}" impossível: nenhum arquivo de teste ` +
              `(${markers.join(', ')}) foi encontrado para os arquivos-fonte declarados ` +
              `(${sourceFiles.join(', ')}). Uma suite global verde NÃO comprova que este ` +
              `fluxo foi exercitado. Adicione um teste co-located que cubra o fluxo declarado.`,
          });
        } else {
          this.logger.debug(
            `Fluxo "${flow.name}" sem testes associados ` +
              `(requireFlowCoverage=${requireCoverage}, sourceFiles=${sourceFiles.length}; apenas aviso).`,
          );
        }
        continue;
      }

      try {
        const check = await this.workspaces.runTestsForFiles(cwd, [...testFiles]);
        if (!check.ran) {
          // Runner não determinado com segurança. Com cobertura exigida não
          // podemos afirmar que o fluxo foi exercitado empiricamente: vira
          // problema. Sem exigência, fallback silencioso aos scripts globais.
          if (requireCoverage) {
            problems.push({
              title: `Fluxo "${flow.name}" com testes não executados`,
              description:
                `Foram localizados specs para o fluxo "${flow.name}" ` +
                `(${[...testFiles].join(', ')}), mas o runner de testes não pôde ser ` +
                `determinado com segurança, então eles NÃO foram executados ` +
                `(${check.output || 'runner desconhecido'}). Sem execução não há teste de mesa ` +
                `do fluxo — configure o script \`test\` do projeto para um runner suportado.`,
            });
          } else {
            this.logger.debug(
              `Testes direcionados do fluxo "${flow.name}" não executados (${check.output || 'runner desconhecido'}); usando scripts globais.`,
            );
          }
          continue;
        }
        ranAny = true;
        if (!check.passed) {
          problems.push({
            title: `Testes do fluxo "${flow.name}" falharam (exit ${check.exitCode ?? '?'})`,
            description:
              `Os testes direcionados ao fluxo "${flow.name}" falharam no worktree ` +
              `(${[...testFiles].join(', ')}). Corrija antes de concluir.\n\n` +
              truncate(check.output, 2000),
          });
        } else {
          this.logger.debug(
            `Teste de mesa do fluxo "${flow.name}" OK: ${testFiles.size} spec(s) executado(s) com sucesso.`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Falha ao rodar testes direcionados do fluxo "${flow.name}": ${String(err)}`,
        );
      }
    }

    return ranAny;
  }
}

/** Trunca a saida de um check para nao estourar o campo de descricao. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (saida truncada, ${text.length - max} chars omitidos)`;
}
