import { Injectable, Logger } from '@nestjs/common';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { AgentModel } from '@kanban-ai/shared';

/**
 * Catalogo de modelos de AI disponiveis para o login atual do Copilot CLI.
 *
 * O Copilot CLI NAO expoe um comando nao-interativo para listar modelos (o
 * `/model` e TUI e o endpoint de catalogo fica atras do proxy interno da org).
 * Por isso a lista e resolvida em ordem de precedencia:
 *   1. env AGENT_MODELS (JSON: [{"id","label"}, ...] ou ["id", ...]);
 *   2. arquivo ~/.copilot/models.json (mesmo formato) — editavel pelo usuario;
 *   3. fallback embutido (ids validados para este login).
 *
 * O default do CLI vem de ~/.copilot/settings.json ("model"), usado para marcar
 * qual e o primeiro/preferido quando presente.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private cache: AgentModel[] | null = null;

  /** Fallback embutido: ids confirmados como disponiveis para o login atual. */
  private static readonly FALLBACK: AgentModel[] = [
    {
      id: 'uol-inc/AWS_Bedrock/anthropic.claude-opus-4-8',
      label: 'Claude Opus 4.8 BR',
    },
    { id: 'claude-opus-4.6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ];

  /** Lista os modelos disponiveis (cacheada apos a primeira resolucao). */
  list(): AgentModel[] {
    if (!this.cache) {
      this.cache = this.resolve();
      this.logger.log(
        `catalogo de modelos: ${this.cache.length} modelo(s) [${this.cache
          .map((m) => m.id)
          .join(', ')}]`,
      );
    }
    return this.cache;
  }

  /** Id do modelo default do quadro quando o board nao tem um definido. */
  defaultModelId(): string {
    const fromSettings = this.readCliDefault();
    if (fromSettings) return fromSettings;
    const list = this.list();
    return list[0]?.id ?? ModelsService.FALLBACK[0].id;
  }

  /** True se `id` esta no catalogo conhecido. */
  isKnown(id: string | null | undefined): boolean {
    if (!id) return false;
    return this.list().some((m) => m.id === id);
  }

  private resolve(): AgentModel[] {
    const fromEnv = this.parse(process.env.AGENT_MODELS, 'env AGENT_MODELS');
    if (fromEnv?.length) return this.withCliDefaultFirst(fromEnv);

    const fromFile = this.readFile();
    if (fromFile?.length) return this.withCliDefaultFirst(fromFile);

    return this.withCliDefaultFirst([...ModelsService.FALLBACK]);
  }

  private readFile(): AgentModel[] | null {
    const path = join(homedir(), '.copilot', 'models.json');
    if (!existsSync(path)) return null;
    try {
      return this.parse(readFileSync(path, 'utf8'), path);
    } catch (e) {
      this.logger.warn(`falha ao ler ${path}: ${(e as Error).message}`);
      return null;
    }
  }

  private parse(raw: string | undefined, source: string): AgentModel[] | null {
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as unknown;
      if (!Array.isArray(data)) return null;
      const models = data
        .map((item): AgentModel | null => {
          if (typeof item === 'string') return { id: item, label: item };
          if (item && typeof item === 'object') {
            const o = item as Record<string, unknown>;
            const id = typeof o.id === 'string' ? o.id : null;
            if (!id) return null;
            const label = typeof o.label === 'string' ? o.label : id;
            return { id, label };
          }
          return null;
        })
        .filter((m): m is AgentModel => m !== null);
      return models.length ? models : null;
    } catch (e) {
      this.logger.warn(`falha ao parsear ${source}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Le o modelo default do Copilot CLI em ~/.copilot/settings.json. */
  private readCliDefault(): string | null {
    const path = join(homedir(), '.copilot', 'settings.json');
    if (!existsSync(path)) return null;
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      return typeof o.model === 'string' ? o.model : null;
    } catch {
      return null;
    }
  }

  /**
   * Garante que o default do CLI (se conhecido) apareca primeiro na lista, e o
   * inclui caso nao esteja presente.
   */
  private withCliDefaultFirst(models: AgentModel[]): AgentModel[] {
    const def = this.readCliDefault();
    if (!def) return models;
    const existing = models.find((m) => m.id === def);
    const rest = models.filter((m) => m.id !== def);
    const head = existing ?? { id: def, label: def };
    return [head, ...rest];
  }
}
