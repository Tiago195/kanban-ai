import type { AppConfig } from '../../../shared/config/config';

/**
 * Contrato do "CLI adapter": isola o comando/flags/parser exatos da Copilot CLI
 * atrás de uma camada configurável por env, para plugar o comando real depois
 * sem tocar no orchestrator. Ver docs/loop-engine.md e ADR-0016.
 *
 * PROTOCOLO DE STDOUT — JSONL (uma linha JSON por evento):
 *   {"kind":"thought","text":"..."}              → raciocínio incremental
 *   {"kind":"output","text":"..."}               → saída/ação incremental
 *   {"kind":"question","id":"...","prompt":"...","options":["a","b"]}
 *                                                → pergunta (HITL); pausa a iteração
 *   {"kind":"result","detail":"...","summary":"...","dodTouched":["id"],
 *     "nextStep":"...","done":true}              → resultado final da iteração
 *
 * Linhas que NÃO forem JSON válido são tratadas como `thought` (fallback
 * tolerante), permitindo plugar comandos que apenas imprimem texto cru.
 */

/** Evento estruturado extraído de uma linha de stdout da CLI. */
export type CliEvent =
  | { kind: 'thought'; text: string }
  | { kind: 'output'; text: string }
  | { kind: 'question'; id: string; prompt: string; options?: string[] }
  | {
      kind: 'result';
      detail: string;
      summary: string;
      dodTouched: string[];
      affectedFlows?: { name: string; files: string[]; note?: string }[];
      nextStep: string;
      done: boolean;
    };

/** Como o processo deve ser spawnado. */
export interface SpawnPlan {
  command: string;
  args: string[];
  /** Prompt a escrever no stdin (quando promptMode='stdin'). */
  stdinPrompt: string | null;
}

/**
 * Adapter configurável: monta o comando e parseia o stdout da CLI em `CliEvent`s.
 * Sem estado de processo — o `CopilotCliRunner` cuida do spawn e do ciclo de vida.
 */
export class CliAdapter {
  constructor(private readonly config: AppConfig) {}

  get hitlTimeoutMs(): number {
    return this.config.agent.hitlTimeoutMs;
  }

  get streamIdleTimeoutMs(): number {
    return this.config.agent.streamIdleTimeoutMs;
  }

  /**
   * Monta o plano de spawn a partir da config e do prompt da iteração.
   * `{prompt}` em `cliArgs` é substituído quando promptMode='arg'.
   */
  buildSpawnPlan(prompt: string): SpawnPlan {
    const { cliCommand, cliArgs, promptMode } = this.config.agent;
    if (promptMode === 'arg') {
      const args = cliArgs.map((a) => a.replace('{prompt}', prompt));
      return { command: cliCommand, args, stdinPrompt: null };
    }
    return { command: cliCommand, args: [...cliArgs], stdinPrompt: prompt };
  }

  /**
   * Parseia uma linha de stdout em um `CliEvent`. Retorna `null` para linhas
   * vazias. Linhas não-JSON ou JSON sem `kind` reconhecido viram `thought`.
   */
  parseLine(line: string): CliEvent | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: 'thought', text: trimmed };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return { kind: 'thought', text: trimmed };
    }

    const obj = parsed as Record<string, unknown>;
    const kind = obj.kind;

    if (kind === 'output') {
      return { kind: 'output', text: str(obj.text) };
    }
    if (kind === 'question') {
      return {
        kind: 'question',
        id: str(obj.id) || `q-${Date.now()}`,
        prompt: str(obj.prompt),
        options: Array.isArray(obj.options)
          ? obj.options.map((o) => String(o))
          : undefined,
      };
    }
    if (kind === 'result') {
      return {
        kind: 'result',
        detail: str(obj.detail),
        summary: str(obj.summary),
        dodTouched: Array.isArray(obj.dodTouched)
          ? obj.dodTouched.map((d) => String(d))
          : [],
        affectedFlows: parseAffectedFlows(obj.affectedFlows),
        nextStep: str(obj.nextStep),
        done: obj.done === true,
      };
    }
    // kind ausente/desconhecido → tratar como pensamento com o texto disponível.
    return { kind: 'thought', text: str(obj.text) || trimmed };
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Normaliza a lista de fluxos afetados reportada pela AI (tolerante a lixo). */
function parseAffectedFlows(
  v: unknown,
): { name: string; files: string[]; note?: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const flows = v
    .map((f) => {
      if (typeof f !== 'object' || f === null) return null;
      const o = f as Record<string, unknown>;
      const name = str(o.name).trim();
      if (!name) return null;
      const files = Array.isArray(o.files) ? o.files.map((x) => String(x)) : [];
      const note = str(o.note);
      return note ? { name, files, note } : { name, files };
    })
    .filter((f): f is { name: string; files: string[]; note?: string } => f !== null);
  return flows.length > 0 ? flows : undefined;
}
