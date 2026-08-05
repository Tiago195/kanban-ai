/**
 * Sanitização e segmentação do transcript cru do agent (Copilot CLI) para
 * exibição amigável no chat — na "faixa" de um chat do Claude.
 *
 * O stdout da CLI chega com ruído que NÃO deve ser mostrado ao usuário final:
 *  - códigos de escape ANSI (cores/bold);
 *  - blocos de tool call (linhas com `●`, `│`, `└ N lines…`);
 *  - o protocolo interno `<<<KANBAN_RESULT>>>{...}<<<END_KANBAN_RESULT>>>`
 *    (e o par `KANBAN_QUESTION`), que é maquinaria do loop engine;
 *  - mensagens de boot repetidas ("Invocando Copilot CLI ...").
 *
 * Estas funções são PURAS e não destroem o texto cru persistido — a limpeza é
 * feita no momento do render. Ficam no pacote shared para poderem ser testadas
 * isoladamente e reusadas por web (e futuramente pela API, se preciso).
 */

/** Um segmento tipado do conteúdo de uma mensagem, pronto para render. */
export type ChatSegment =
  | { type: 'prose'; text: string }
  | { type: 'tool'; title: string; command?: string; lines?: string }
  | { type: 'result'; summary?: string; done?: boolean };

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const KANBAN_RESULT_RE = /<<<KANBAN_RESULT>>>[\s\S]*?<<<END_KANBAN_RESULT>>>/g;
const KANBAN_QUESTION_RE = /<<<KANBAN_QUESTION>>>[\s\S]*?<<<END_KANBAN_QUESTION>>>/g;
// Vocabulário de marcadores de controle emitidos pela(s) skill(s): loop engine
// (RESULT/QUESTION) e backlog-chat (BACKLOG/BACKLOG_PATCH).
const KANBAN_KINDS = 'QUESTION|RESULT|BACKLOG_PATCH|BACKLOG';
const KANBAN_BACKLOG_RE =
  /<<<KANBAN_BACKLOG(?:_PATCH)?>>>[\s\S]*?<<<END_KANBAN_BACKLOG(?:_PATCH)?>>>/g;
// Blocos de controle "partidos" pelo streaming (chunk a chunk): pode chegar só
// o marcador de abertura + JSON sem o fechamento, ou marcadores/fragmentos de
// marcador soltos. Removemos de forma resiliente para o transcript não exibir
// `<<<KANBAN_QUESTION>>>`, `<<<END_KANBA`, `N_QUESTION>>>` etc. crus.
const KANBAN_OPEN_TO_END_RE = new RegExp(
  `<<<KANBAN_(?:${KANBAN_KINDS})>>>[\\s\\S]*?(?:<<<END_KANBAN_(?:${KANBAN_KINDS})>>>|$)`,
  'g',
);
// Qualquer marcador (ou fragmento com `<<<` / `>>>` ao redor de KANBAN) órfão.
const KANBAN_MARKER_FRAGMENT_RE = new RegExp(
  `<*<?<?\\s*(?:END_)?KANBAN_(?:${KANBAN_KINDS})?\\s*>*>?>?`,
  'g',
);
// Uma LINHA que sobrou sendo só "lixo de marcador" truncado pelo streaming,
// como `<<<END_KANBA`, `N_QUESTION>`, `>>`, `<<<KANBAN_RESULT`. Detectada por:
// conter um pedaço reconhecível do vocabulário de marcador E não ter mais nada
// além de `<`, `>`, `_` e letras desse vocabulário. Nunca casa prosa real.
const KANBAN_FRAGMENT_LINE_RE =
  /^[\s<>_]*(?:KANB[A-Z_]*|[A-Z]*_?(?:QUESTION|RESULT|BACKLOG)|END[A-Z_]*)[\s<>_A-Z]*$/;
const BOOT_NOISE_RE = /Invocando Copilot CLI[^\n]*/g;

/** Remove blocos de protocolo KANBAN — completos ou partidos pelo streaming. */
function stripKanbanBlocks(text: string): string {
  const stripped = text
    .replace(KANBAN_RESULT_RE, '')
    .replace(KANBAN_QUESTION_RE, '')
    .replace(KANBAN_BACKLOG_RE, '')
    .replace(KANBAN_OPEN_TO_END_RE, '')
    .replace(KANBAN_MARKER_FRAGMENT_RE, '');
  // Segunda passada linha-a-linha: descarta linhas que sobraram sendo só ruído
  // de marcador truncado, preservando qualquer linha com conteúdo real.
  return stripped
    .split('\n')
    .filter((ln) => !KANBAN_FRAGMENT_LINE_RE.test(ln.trim()))
    .join('\n');
}

/** Remove todos os códigos de escape ANSI (cores/estilos) do texto. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Extrai o `summary` (e `done`) de um bloco KANBAN_RESULT, se presente e válido.
 * Usado para transformar o protocolo interno num "selo" amigável de conclusão.
 */
function extractResult(text: string): { summary?: string; done?: boolean } | null {
  const m = text.match(/<<<KANBAN_RESULT>>>([\s\S]*?)<<<END_KANBAN_RESULT>>>/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim()) as { summary?: unknown; done?: unknown };
    return {
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
      done: obj.done === true,
    };
  } catch {
    return null;
  }
}

/**
 * Insere quebras onde a CLI colou frases/blocos sem separador (o stdout costuma
 * vir numa única linha). Heurística conservadora, dirigida pelos marcadores da
 * CLI e por pontuação seguida imediatamente de letra maiúscula.
 */
function reflow(text: string): string {
  return (
    text
      // marcador de tool colado ao texto anterior → nova linha
      .replace(/([^\n])\s*●/g, '$1\n●')
      // rodapé "└ N lines…" que gruda na prosa seguinte → quebra após o "…"
      .replace(/(└[^\n]*?lines?…)/g, '$1\n')
      // fim de frase colado ao começo de outra (pontuação + Maiúscula)
      .replace(/([.!?…])(?=[A-ZÀ-Ý])/g, '$1 ')
      // emoji grudado em texto (antes e depois) → dá respiro
      .replace(
        /([^\s])([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}])/gu,
        '$1 $2',
      )
      .replace(
        /([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}])([^\s])/gu,
        '$1 $2',
      )
  );
}

/**
 * Limpeza "leve": devolve só o texto legível para o usuário, sem ANSI, sem
 * blocos de protocolo e sem ruído de boot. Ideal para preview/summary de linha.
 */
export function cleanChatText(raw: string): string {
  let t = stripAnsi(raw);
  t = stripKanbanBlocks(t);
  t = t.replace(BOOT_NOISE_RE, '');
  t = reflow(t);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Segmenta o texto cru de UMA mensagem em blocos tipados para render rico.
 * Ordem preservada: prosa, chamadas de ferramenta (colapsáveis) e o selo de
 * resultado (quando a iteração concluiu).
 */
export function parseChatSegments(raw: string): ChatSegment[] {
  const result = extractResult(raw);

  let t = stripAnsi(raw);
  t = stripKanbanBlocks(t);
  t = t.replace(BOOT_NOISE_RE, '');
  t = reflow(t);

  const segments: ChatSegment[] = [];

  // Separa blocos de tool call. Um bloco começa em `●` e vai até a próxima
  // ocorrência de `●` ou até o fim. Dentro dele: título, comando (`│ ...`) e
  // rodapé (`└ N lines…`). O texto entre blocos é prosa.
  const parts = t.split(/(?=●)/);
  for (const part of parts) {
    const chunk = part.trim();
    if (chunk.length === 0) continue;

    if (chunk.startsWith('●')) {
      // O bloco de ferramenta ocupa só até a primeira quebra de linha (inserida
      // por `reflow` após o rodapé "… lines"). O que vier depois é prosa.
      const nlIdx = chunk.indexOf('\n');
      const toolPart = (nlIdx >= 0 ? chunk.slice(0, nlIdx) : chunk).slice(1).trim();
      const rest = nlIdx >= 0 ? chunk.slice(nlIdx + 1).trim() : '';

      const cmdIdx = toolPart.search(/[│└]/);
      const title = (cmdIdx >= 0 ? toolPart.slice(0, cmdIdx) : toolPart)
        .replace(/\(shell\)/i, '')
        .trim();
      const cmdMatch = toolPart.match(/│\s*([^└]*)/);
      const command = cmdMatch ? cmdMatch[1].trim() : undefined;
      const linesMatch = toolPart.match(/└\s*([^\n]*?)…?\s*$/);
      const lines = linesMatch ? linesMatch[1].trim() : undefined;

      segments.push({ type: 'tool', title: title || 'Ação', command, lines });
      if (rest.length > 0) segments.push({ type: 'prose', text: rest });
    } else {
      segments.push({ type: 'prose', text: chunk });
    }
  }

  if (result) {
    segments.push({ type: 'result', summary: result.summary, done: result.done });
  }

  // Colapsa proses vazias/duplicadas adjacentes.
  return segments.filter(
    (s) => s.type !== 'prose' || s.text.replace(/\s+/g, '').length > 0,
  );
}
