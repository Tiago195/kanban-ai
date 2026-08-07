import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Colunas cuja ausência indica uma migration não aplicada (schema drift).
 * Mantido enxuto: cobre as colunas adicionadas por migrations recentes que o
 * Prisma client SEMPRE seleciona em `GET /cards` (senão a query estoura P2022).
 * Formato: [tabela, coluna].
 */
const EXPECTED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['Card', 'derivedDepth'],
  ['Card', 'needsHuman'],
  ['Iteration', 'diff'],
];

/**
 * Wrapper do Prisma como provider injetável do Nest.
 * Tenta conectar no boot e desconecta no shutdown.
 *
 * A conexão no boot é tolerante a falhas de propósito: o `GET /health`
 * (e o processo em si) não devem depender do banco estar acessível para
 * subir. Se a conexão falhar, apenas logamos um aviso — a primeira query
 * real tentará reconectar e propagará o erro apropriado.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Resultado do health-check de schema no boot. `null` = ainda não checado
   * (ex.: banco inacessível no boot). Consultável por serviços que queiram
   * degradar com elegância em vez de estourar 500 opaco (bug-cards-500).
   */
  private schemaHealth: { ok: boolean; missing: string[] } | null = null;

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      await this.checkSchema();
    } catch (err) {
      this.logger.warn(
        `Não foi possível conectar ao banco no boot: ${
          err instanceof Error ? err.message : String(err)
        }. A aplicação seguirá de pé; a conexão será tentada na primeira query.`,
      );
    }
  }

  /**
   * Health-check de schema (bug-cards-500): verifica no `information_schema` se
   * as colunas esperadas existem. Se faltar alguma, uma migration não foi
   * aplicada — logamos um erro CLARO e acionável (em vez de deixar `GET /cards`
   * estourar um 500 opaco `P2022` mais tarde). Não lança: apenas registra o
   * diagnóstico em `schemaHealth` para consulta posterior.
   */
  async checkSchema(): Promise<{ ok: boolean; missing: string[] }> {
    try {
      const rows = await this.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = current_schema()`,
      );
      const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
      const missing = EXPECTED_COLUMNS.filter(([t, c]) => !present.has(`${t}.${c}`)).map(
        ([t, c]) => `${t}.${c}`,
      );
      this.schemaHealth = { ok: missing.length === 0, missing };
      if (missing.length > 0) {
        this.logger.error(
          `Schema drift detectado: colunas ausentes [${missing.join(', ')}]. ` +
            'Migrations pendentes — rode `npm run db:migrate:deploy` (ou `npm run db:setup`) ' +
            'antes de usar a API. `GET /cards` responderá 503 com aviso até a migration ser aplicada.',
        );
      } else {
        this.logger.log('Schema OK: todas as colunas esperadas estão presentes.');
      }
      return this.schemaHealth;
    } catch (err) {
      // Não conseguimos inspecionar o schema (ex.: banco indisponível). Não
      // marcamos drift — deixamos `schemaHealth` como estava para não bloquear.
      this.logger.warn(
        `Não foi possível verificar o schema: ${err instanceof Error ? err.message : String(err)}.`,
      );
      return this.schemaHealth ?? { ok: true, missing: [] };
    }
  }

  /** Último diagnóstico de schema (ver `checkSchema`). `null` se não checado. */
  getSchemaHealth(): { ok: boolean; missing: string[] } | null {
    return this.schemaHealth;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
