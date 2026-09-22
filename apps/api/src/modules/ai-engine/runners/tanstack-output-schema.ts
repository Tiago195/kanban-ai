/**
 * US-F3.5 — `outputSchema` Zod no lugar do protocolo de marcadores no
 * `TanStackRunner` (e SÓ nele; o caminho Copilot segue no marcador).
 *
 * O resultado da iteração deixa de ser um bloco de texto que a AI precisa
 * acertar (`<<<KANBAN_RESULT>>>`) e vira um OBJETO validado por schema. Cada
 * constraint/descrição abaixo referencia a regra R# do mapa da US-F3.3
 * (docs/specs/ep-f3-regras-do-prompt.md):
 *
 *  - R1  `dodTouched.max(1)` — regra nano (o slice do servidor continua como cinto).
 *  - R3  `proposedDod` condicional à análise-sem-DOD, `.min(3).max(7)`.
 *  - R5  `superRefine` `done:true ⇒ evidence` não-vazia.
 *  - R12 união discriminada `result | question` — emitir os dois é impossível
 *        por construção (a precedência do bridge deixa de ser necessária).
 *  - R13 `question` é um objeto ÚNICO (nunca lista).
 *  - R14 `options.min(2).max(4)` quando presentes.
 *  - R8/R9/R10/R11/R22 viram `.describe()` — a orientação semântica que nenhum
 *    tipo impõe continua chegando na AI, agora pelo schema.
 *
 * IMPORTANTE (limite do zod instalado): o `@tanstack/ai@0.52` só converte
 * schema→JSON Schema sozinho para libs com `~standard.jsonSchema` (Zod v4.2+);
 * o workspace usa zod 3.25.x, cujo `zod/v4` valida (`~standard.validate`) mas
 * NÃO expõe o conversor — passar o schema Zod direto em `outputSchema` lança
 * "Use Zod v4.2+...". Por isso o runner passa o JSON Schema PLANO (gerado aqui
 * via `z.toJSONSchema`) para o transporte e valida o objeto final ELE MESMO com
 * o schema Zod (`finalizeSchemaTurn`) — que é também onde o `superRefine`
 * cross-field roda (JSON Schema não o representa). No caminho streaming o
 * TanStack deliberadamente NÃO valida ("validation is the consumer's
 * responsibility"), então esta validação local é a única — sem duplicidade.
 */
import { z } from 'zod/v4';
import type { AgentRunResult } from './agent-runner.interface';
import type { MarkerQuestion } from './tanstack-marker-protocol';

/** Condições por-iteração que mudam a forma do schema (calculadas pelo orchestrator). */
export interface IterationSchemaOptions {
  /** R3 — true SÓ na fase de análise de task sem DOD: inclui `proposedDod`. */
  proposeDod: boolean;
  /** R6 (shape) — `AGENT_REQUIRE_STRUCTURED_EVIDENCE`: evidence vira objeto com checks. */
  structuredEvidence: boolean;
}

/** Resultado do fechamento de um turno estruturado (espelha MarkerFinalization). */
export interface SchemaFinalization {
  /** Presente quando a AI escolheu a variante `question` (HITL). */
  question?: MarkerQuestion;
  /** Sempre presente — o resultado da iteração no shape de `AgentRunResult`. */
  result: AgentRunResult;
  /**
   * Presente quando o objeto do modelo NÃO casou com o schema. A iteração é
   * INCONCLUSA (`done:false`, nunca o done-fantasma do mundo antigo — §5 Passo
   * 4 da US-F3.3); as issues vão para o `detail`/log para orientar a próxima.
   */
  schemaIssues?: string[];
}

/** Shape TS do payload validado (o schema é dinâmico; tipamos o resultado à mão). */
interface ParsedResult {
  kind: 'result';
  summary: string;
  proposedDod?: string[];
  dodTouched: string[];
  affectedFlows?: { name: string; files: string[]; note?: string }[];
  nextStep: string;
  learnings?: { path: string; summary: string; scope?: string }[];
  evidence?: string | { checks: { name: string; passed: boolean; output?: string }[]; filesChanged?: string[]; note?: string };
  done: boolean;
}
interface ParsedQuestion {
  kind: 'question';
  prompt: string;
  options?: string[];
}

/**
 * Constrói o schema Zod do turno. `z.toJSONSchema` ignora o `superRefine`
 * (inimpingível em JSON Schema) mas o `safeParse` o aplica — exatamente a
 * divisão desejada: forma no provider, cross-field aqui.
 */
export function buildIterationSchema(opts: IterationSchemaOptions) {
  // R5/R22 (string, default) ou R6-shape (estruturada, sob flag).
  const evidence = opts.structuredEvidence
    ? z
        .object({
          checks: z
            .array(
              z.object({
                name: z.string().min(1).describe('Nome do check rodado (ex.: test, build, lint).'),
                passed: z.boolean().describe('Se o check passou de verdade.'),
                output: z.string().optional().describe('Saída/resumo concreto do check.'),
              }),
            )
            .min(1)
            .describe('Checks verificáveis que VOCÊ rodou. Para fechar a task é obrigatório ao menos UM com passed=true — texto livre NÃO fecha (R6).'),
          filesChanged: z.array(z.string()).optional().describe('Arquivos alterados nesta conclusão.'),
          note: z.string().optional().describe('Nota livre adicional.'),
        })
        .describe(
          'Evidência ESTRUTURADA da verificação (R6/R22): rode os checks do projeto NO diretório atual ANTES de concluir e reporte o resultado concreto.',
        )
    : z
        .string()
        .describe(
          'Como você verificou seu trabalho (ex.: "npm test: 12 passed; build ok"). OBRIGATÓRIA quando done=true (R5). Rode os checks do projeto ANTES de concluir; se não houver como verificar, diga isso explicitamente aqui (R22).',
        );

  const result = z
    .object({
      kind: z.literal('result'),
      summary: z
        .string()
        .min(1)
        .describe('UMA linha objetiva do que você fez NESTA iteração (vira comentário do card e histórico) (R10).'),
      // R3 — campo condicional é a vocação do schema: só existe na análise-sem-DOD.
      ...(opts.proposeDod
        ? {
            proposedDod: z
              .array(z.string().min(1))
              .min(3)
              .max(7)
              .optional()
              .describe(
                'Definition of Done proposto: 3 a 7 critérios curtos, objetivos e VERIFICÁVEIS de conclusão desta task. Não invente ids — apenas os textos; o sistema cria os itens (R3).',
              ),
          }
        : {}),
      dodTouched: z
        .array(z.string())
        .max(1)
        .describe(
          'Ids de DOD que VOCÊ concluiu NESTA iteração — use os ids EXATOS listados no prompt (R2); NO MÁXIMO 1 por iteração (regra nano, R1). Vazio se nenhum.',
        ),
      affectedFlows: z
        .array(
          z.object({
            name: z.string().min(1).describe('Nome do fluxo afetado.'),
            files: z.array(z.string()).describe('Arquivos do fluxo que você tocou.'),
            note: z.string().optional().describe('O que muda neste fluxo.'),
          }),
        )
        .optional()
        .describe(
          'Fluxos que VOCÊ tocou — VOCÊ é a fonte disso. Acrescente/atualize (o servidor acumula por nome, não substitui) (R8). Não liste arquivos que não existem: eles são verificados contra o filesystem real (R7).',
        ),
      nextStep: z
        .string()
        .describe('O que a PRÓXIMA iteração deve fazer — seja ESPECÍFICO, ela começa exatamente daqui (R9). Vazio se o trabalho acabou.'),
      learnings: z
        .array(
          z.object({
            path: z.string().min(1).describe('Neurônio-alvo (ex.: modules/<modulo>.md).'),
            summary: z.string().min(1).describe('O aprendizado, conciso.'),
            scope: z.string().optional().describe('Módulo/escopo (opcional).'),
          }),
        )
        .optional()
        .describe(
          'OPCIONAL — memória viva (ADR-0027): apenas aprendizados DURÁVEIS e VERDADEIROS (decisão de arquitetura, convenção, armadilha, contrato). NÃO invente: o que você escrever é PERSISTIDO na colmeia e reinjetado em toda iteração futura. Omita se não houver nada durável (R11).',
        ),
      evidence: evidence.optional(),
      done: z
        .boolean()
        .describe(
          '`true` SÓ quando o trabalho de código da task terminou e o DOD está todo marcado (R4). Um gate de validação roda os checks reais do projeto; `done` prematuro é revertido com derivação de correção (R22).',
        ),
    })
    // R5 — done:true ⇒ evidence presente e não-vazia (cross-field: só o Zod vê).
    .superRefine((v, ctx) => {
      if (v.done !== true) return;
      const e = v.evidence as ParsedResult['evidence'];
      const ok =
        typeof e === 'string'
          ? e.trim().length > 0
          : !!e && Array.isArray(e.checks) && e.checks.length > 0;
      if (!ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence'],
          message: '`done: true` exige `evidence` não-vazia — reporte como você verificou o trabalho (R5).',
        });
      }
    });

  const question = z.object({
    kind: z.literal('question'),
    prompt: z.string().min(1).describe('UMA pergunta objetiva por vez para o humano (R13).'),
    options: z
      .array(z.string().min(1))
      .min(2)
      .max(4)
      .optional()
      .describe(
        '2 a 4 opções CURTAS e acionáveis quando a pergunta admitir alternativas (o humano responde com um clique); omita quando genuinamente aberta. Mesmo com options o humano pode responder livremente (R14).',
      ),
  });

  // Raiz é OBJETO (exigência de endpoints strict json_schema — anyOf na raiz é
  // rejeitado pela OpenAI); a união discriminada vive em `response` e torna
  // estruturalmente impossível emitir result E question no mesmo turno (R12).
  return z.object({
    response: z
      .discriminatedUnion('kind', [result, question])
      .describe(
        'Emita EXATAMENTE UMA variante: `result` (progresso desta iteração) OU `question` (decisão humana necessária — a task aguarda; a resposta chega no handoff da próxima iteração) (R12).',
      ),
  });
}

/**
 * JSON Schema plano para o `outputSchema` do `chat()` (ver cabeçalho: o
 * conversor do TanStack exige Zod 4.2+; geramos aqui e validamos no consumer).
 */
export function buildIterationJsonSchema(opts: IterationSchemaOptions): Record<string, unknown> {
  return z.toJSONSchema(buildIterationSchema(opts)) as Record<string, unknown>;
}

/**
 * Modo strict dos providers exige todo campo `required`; o TanStack "alarga"
 * opcionais para `null` e desfaz no `value.object` (undoNullWidening) — mas o
 * mapa não desce em `anyOf`. `null` em campo opcional ≡ ausente para nós.
 * ponytail: strip raso e recursivo; se um dia `null` for semântico num campo,
 * este helper precisa de allowlist.
 */
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== null) out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
}

/**
 * Fecha um turno estruturado: valida o objeto do modelo contra o schema Zod e
 * o converte em `AgentRunResult`.
 *
 * Diferenças DELIBERADAS vs. o protocolo de marcador (oráculo da US-F3.2):
 *  - `evidence`/`learnings` CHEGAM ao servidor (o bridge os descartava —
 *    BUG-BRIDGE1). É a mudança de comportamento anunciada da US-F3.5 (§5 Passo
 *    3): a memória viva passa a receber o que a AI escrever.
 *  - payload que não casa com o schema ⇒ iteração INCONCLUSA (`done:false`)
 *    com as issues no detail — NUNCA o done-fantasma do fallback antigo.
 *  - sem fallback de `summary` para a última linha (o summary é required; o
 *    bug "summary = <<<END_KANBAN_RESULT>>>" morre por construção).
 */
export function finalizeSchemaTurn(
  payload: unknown,
  raw: string,
  opts: IterationSchemaOptions,
): SchemaFinalization {
  const parsed = buildIterationSchema(opts).safeParse(stripNulls(payload));
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`,
    );
    return {
      schemaIssues: issues,
      result: {
        detail:
          'Resultado estruturado REJEITADO pelo schema da iteração (US-F3.5).\n' +
          `Issues:\n- ${issues.join('\n- ')}\n\nPayload bruto:\n${raw}`,
        summary: `resultado rejeitado pelo schema: ${issues[0] ?? 'formato inválido'}`.slice(0, 240),
        dodTouched: [],
        nextStep:
          'Reemita o resultado da iteração respeitando o schema (as regras de cada campo estão nas descrições).',
        // §5 Passo 4: schema inválido NUNCA vira done:true.
        done: false,
      },
    };
  }

  const r = (parsed.data as { response: ParsedResult | ParsedQuestion }).response;
  if (r.kind === 'question') {
    return {
      question: { prompt: r.prompt, options: r.options },
      // Mesmo shape do caminho de marcador — o orchestrator não distingue.
      result: {
        detail: raw || '(tanstack) resposta estruturada sem texto.',
        summary: `AI aguardando decisão humana: ${r.prompt}`.slice(0, 240),
        dodTouched: [],
        nextStep: `Pergunta ao humano: ${r.prompt}${
          r.options?.length ? ` (opções: ${r.options.join(' | ')})` : ''
        }. Continue a partir da resposta recebida.`,
        done: false,
      },
    };
  }

  // Paridade de omissões com o CliAdapter: lista vazia chega como campo ausente.
  const flows = (r.affectedFlows ?? []).map((f) => ({
    name: f.name,
    files: f.files,
    note: f.note ?? '',
  }));
  const evidence =
    typeof r.evidence === 'string' ? (r.evidence.trim() ? r.evidence : undefined) : r.evidence;
  return {
    result: {
      // O "texto inteiro do turno" agora é o próprio JSON emitido pelo modelo.
      detail: raw || '(tanstack) resposta estruturada sem texto.',
      summary: r.summary.slice(0, 240),
      dodTouched: r.dodTouched,
      ...(r.proposedDod?.length ? { proposedDod: r.proposedDod } : {}),
      ...(flows.length > 0 ? { affectedFlows: flows } : {}),
      nextStep: r.nextStep,
      done: r.done,
      // US-F3.5 Passo 3 — RESSURREIÇÃO: evidence e learnings chegam ao servidor.
      ...(evidence !== undefined ? { evidence } : {}),
      ...(r.learnings?.length
        ? {
            learnings: r.learnings.map((l) => ({
              path: l.path,
              summary: l.summary,
              ...(l.scope ? { scope: l.scope } : {}),
            })),
          }
        : {}),
    },
  };
}
