import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

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

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err) {
      this.logger.warn(
        `Não foi possível conectar ao banco no boot: ${
          err instanceof Error ? err.message : String(err)
        }. A aplicação seguirá de pé; a conexão será tentada na primeira query.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
