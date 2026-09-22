/**
 * US-F3.4 — Protocolo de marcadores `<<<KANBAN_RESULT>>>`/`<<<KANBAN_QUESTION>>>`
 * portado de `docker/copilot-cli-adapter.mjs` para o `TanStackRunner`.
 *
 * NESTA fatia o runner TanStack REUSA o protocolo de marcador atual (o mesmo do
 * bridge do Copilot CLI) em vez de `outputSchema` (que é a US-F3.5). O motivo é
 * estratégico: com o MESMO protocolo, o oráculo de paridade da US-F3.2
 * (`cli-bridge.characterization.spec.ts`) vale como teste de paridade entre os
 * dois runners — inclusive nos casos degenerados (done:true fantasma em prosa
 * sem bloco, JSON inválido silencioso, primeiro-bloco-vence etc.), que são
 * PRESERVADOS deliberadamente aqui e só serão decididos contra o oráculo na
 * US-F3.5 (§5 de docs/specs/ep-f3-regras-do-prompt.md, Passo 4).
 *
 * Divergências CONSCIENTES do bridge (reportadas na US-F3.4):
 *  - Sem blocos KANBAN_BACKLOG/KANBAN_TASKS (são do pipeline de backlog-chat,
 *    não do loop de iteração que este runner atende).
 *  - Sem filtro TOOL_RENDER_RE (ruído de TUI do `copilot`; não existe num
 *    stream de chat HTTP — mantê-lo só criaria falsos positivos).
 *  - Sem rodapé "Tokens ↑/↓": a telemetria vem do RUN_FINISHED do TanStack.
 *  - Mensagens sintéticas dizem "TanStack" em vez de "Copilot CLI".
 */
import type { AgentRunResult } from './agent-runner.interface';

/** Pergunta HITL extraída do bloco KANBAN_QUESTION. */
export interface MarkerQuestion {
  prompt: string;
  options?: string[];
}

/** Resultado do fechamento de um turno (espelha o `emitTerminalEvents` do bridge). */
export interface MarkerFinalization {
  /** Presente quando a AI emitiu um bloco KANBAN_QUESTION válido (vence o RESULT). */
  question?: MarkerQuestion;
  /** Sempre presente — o `result` da iteração, no MESMO shape do bridge. */
  result: AgentRunResult;
}

/** Última linha não-vazia de um texto (port de `lastLine` do bridge). */
export function lastLine(text: string): string {
  return text.split('\n').filter(Boolean).slice(-1)[0] || '';
}

/** Remove cercas markdown ```json que a AI às vezes inclui dentro do bloco. */
function stripFences(body: string): string {
  return body
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
}

/**
 * Extrai o bloco KANBAN_RESULT (regex não-guloso: o PRIMEIRO par de marcadores
 * vence — paridade com o bridge, fixada no oráculo). JSON inválido → null
 * (fallback silencioso, também fixado no oráculo).
 */
export function extractKanbanResult(text: string): Record<string, unknown> | null {
  const m = text.match(/<<<KANBAN_RESULT>>>([\s\S]*?)<<<END_KANBAN_RESULT>>>/);
  if (!m) return null;
  try {
    const obj: unknown = JSON.parse(stripFences(m[1].trim()));
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extrai o bloco KANBAN_QUESTION (HITL). Prompt vazio/JSON inválido → null. */
export function extractKanbanQuestion(text: string): MarkerQuestion | null {
  const m = text.match(/<<<KANBAN_QUESTION>>>([\s\S]*?)<<<END_KANBAN_QUESTION>>>/);
  if (!m) return null;
  try {
    const obj: unknown = JSON.parse(stripFences(m[1].trim()));
    if (!obj || typeof obj !== 'object') return null;
    const rec = obj as Record<string, unknown>;
    const prompt = typeof rec.prompt === 'string' ? rec.prompt.trim() : '';
    if (!prompt) return null;
    return {
      prompt,
      options: Array.isArray(rec.options) ? rec.options.map(String) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * BUG-A7 (port de `detectFatalError` do bridge): distingue ERRO FATAL de
 * infraestrutura de uma iteração normal inconclusa. `failed` faz o papel do
 * "exit code ≠ 0" do subprocesso: aqui significa que o stream terminou com um
 * evento RUN_ERROR do TanStack (rede/provider/modelo quebrado).
 */
export function detectFatalError(
  failed: boolean,
  text: string,
  err: string,
): string | null {
  const haystack = `${text}\n${err}`.toLowerCase();
  const FATAL_PATTERNS = [
    /is not available/,
    /model .* not (found|available)/,
    /not authenticated|please (log|sign) ?in|authentication (failed|required)/,
    /permission denied and could not request/,
    /quota (exceeded|exhausted)|rate limit(ed)? exceeded|insufficient .*quota/,
    /invalid api key|unauthorized|401 /,
    /command not found|no such file or directory/,
  ];
  for (const re of FATAL_PATTERNS) {
    const m = haystack.match(re);
    if (m) return `fatal: ${lastLine(err) || lastLine(text) || m[0]}`.slice(0, 240);
  }
  if (failed && text.trim().length === 0) {
    return `fatal: stream TanStack falhou${err.trim() ? ` — ${lastLine(err)}` : ''}`.slice(0, 240);
  }
  return null;
}

/** Normaliza affectedFlows reportados pela AI (port de `normalizeFlows`). */
export function normalizeFlows(
  v: unknown,
): { name: string; files: string[]; note?: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { name: string; files: string[]; note?: string }[] = [];
  for (const f of v) {
    if (!f || typeof f !== 'object') continue;
    const rec = f as Record<string, unknown>;
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!name) continue;
    const files = Array.isArray(rec.files) ? rec.files.map(String) : [];
    const note = typeof rec.note === 'string' ? rec.note : '';
    out.push({ name, files, note });
  }
  return out;
}

/**
 * Fecha um turno a partir do texto completo do assistant — port fiel do
 * `emitTerminalEvents` do bridge (subset do loop: QUESTION → RESULT → fallback).
 *
 * Paridade preservada de propósito (fixada no oráculo da US-F3.2):
 *  - QUESTION vence o RESULT quando os dois aparecem;
 *  - `evidence`/`learnings` do bloco são DESCARTADOS (o bridge também descarta;
 *    a ressurreição desses canais é a US-F3.5, Passo 3);
 *  - prosa sem bloco + stream ok → done:true (o "done fantasma" — Passo 4);
 *  - summary ausente cai em lastLine (que pode ser o próprio marcador).
 */
export function finalizeTurn(
  rawText: string,
  errText: string,
  failed: boolean,
): MarkerFinalization {
  const text = rawText.trim();
  const err = errText;

  const question = extractKanbanQuestion(text);
  if (question) {
    return {
      question,
      result: {
        detail: text || '(tanstack) stream encerrou sem texto.',
        summary: `AI aguardando decisão humana: ${question.prompt}`.slice(0, 240),
        dodTouched: [],
        nextStep: `Pergunta ao humano: ${question.prompt}${
          question.options?.length
            ? ` (opções: ${question.options.join(' | ')})`
            : ''
        }. Continue a partir da resposta recebida.`,
        done: false,
      },
    };
  }

  const structured = extractKanbanResult(text);
  if (structured) {
    const proposedDod = Array.isArray(structured.proposedDod)
      ? structured.proposedDod.map(String).filter((s) => s.trim().length > 0)
      : undefined;
    // Paridade fim-a-fim com o caminho Copilot (bridge JSONL → CliAdapter):
    // affectedFlows VAZIO chega ao orchestrator como undefined (o CliAdapter
    // rebaixa lista vazia), então omitimos aqui também.
    const affectedFlows = normalizeFlows(structured.affectedFlows);
    return {
      result: {
        detail: text || '(tanstack) stream encerrou sem texto.',
        summary: (
          (typeof structured.summary === 'string' && structured.summary) ||
          lastLine(text) ||
          'Iteração concluída pelo TanStack runner.'
        ).slice(0, 240),
        dodTouched: Array.isArray(structured.dodTouched)
          ? structured.dodTouched.map(String)
          : [],
        ...(proposedDod ? { proposedDod } : {}),
        ...(affectedFlows.length > 0 ? { affectedFlows } : {}),
        nextStep: typeof structured.nextStep === 'string' ? structured.nextStep : '',
        done: structured.done === true,
      },
    };
  }

  const fatalError = detectFatalError(failed, text, err);
  return {
    result: {
      detail: text || err.trim() || '(tanstack) stream encerrou sem texto.',
      summary: (
        lastLine(text) ||
        lastLine(err) ||
        'Iteração concluída pelo TanStack runner.'
      ).slice(0, 240),
      dodTouched: [],
      nextStep: '',
      done: !failed && !fatalError,
      ...(fatalError ? { fatalError } : {}),
    },
  };
}

/**
 * Filtro de streaming (port do `emitOutputLine` do bridge): suprime as linhas
 * dos blocos de controle `<<<KANBAN_*>>>` para que o transcript não mostre o
 * JSON/marcadores crus, emitindo apenas a prosa como `output` — linha a linha,
 * com buffer para marcadores partidos entre deltas do stream.
 */
export class ControlBlockLineFilter {
  private buf = '';
  private insideControlBlock = false;
  private static readonly OPEN_RE =
    /<<<KANBAN_(QUESTION|RESULT|BACKLOG_PATCH|BACKLOG|TASKS_PATCH|TASKS)>>>/;
  private static readonly CLOSE_RE =
    /<<<END_KANBAN_(QUESTION|RESULT|BACKLOG_PATCH|BACKLOG|TASKS_PATCH|TASKS)>>>/;

  constructor(private readonly emit: (line: string) => void) {}

  /** Acumula um delta do stream e emite as linhas completas que ele fechar. */
  push(delta: string): void {
    this.buf += delta;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    for (const line of parts) this.line(line);
  }

  /** Descarrega a última linha incompleta ao final do stream. */
  flush(): void {
    if (this.buf.length > 0) this.line(this.buf);
    this.buf = '';
  }

  private line(raw: string): void {
    const t = raw.trimEnd();
    if (t.length === 0) return;
    if (this.insideControlBlock) {
      if (ControlBlockLineFilter.CLOSE_RE.test(t)) this.insideControlBlock = false;
      return;
    }
    if (ControlBlockLineFilter.OPEN_RE.test(t)) {
      const before = t.split(ControlBlockLineFilter.OPEN_RE)[0].trimEnd();
      if (before.length > 0) this.emit(before);
      this.insideControlBlock = !ControlBlockLineFilter.CLOSE_RE.test(t);
      return;
    }
    this.emit(t);
  }
}
