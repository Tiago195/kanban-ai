#!/usr/bin/env node
/**
 * Adapter: ponte entre o `CopilotCliRunner` (protocolo JSONL) e o **Copilot CLI real**.
 *
 * O `CopilotCliRunner` do projeto espera um comando cujo stdout seja JSONL:
 *   {"kind":"thought"|"output"|"result", ...}
 * O binário `copilot` real NÃO fala esse protocolo — ele imprime texto/markdown.
 * Este script traduz: recebe o prompt (stdin, conforme promptMode='stdin'),
 * invoca `copilot -p <prompt> --allow-all` (modo não-interativo) e converte
 * a saída em eventos JSONL, encerrando com um evento `result`.
 *
 * Uso (via docker-compose / .env):
 *   AGENT_RUNNER_KIND=copilot-cli
 *   AGENT_CLI_COMMAND=node
 *   AGENT_CLI_ARGS=/app/docker/copilot-cli-adapter.mjs
 *   AGENT_CLI_PROMPT_MODE=stdin   (default)
 *
 * Requer o binário `copilot` disponível no PATH do processo da API
 * (env COPILOT_BIN sobrescreve o caminho) e autenticação prévia (~/.copilot).
 */
import { spawn } from 'node:child_process';

const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';

/**
 * Os aliases de modelo do domínio ('opus', 'gpt', 'copilot') NÃO são ids válidos
 * do Copilot CLI. Traduzimos para ids reais aceitos por `--model`. Aliases
 * desconhecidos caem no default do CLI (omitimos a flag `--model`).
 * Sobrescreva o mapa via COPILOT_MODEL_MAP (JSON) ou force um modelo com
 * COPILOT_MODEL.
 */
const MODEL_MAP = {
  opus: 'uol-inc/AWS_Bedrock/anthropic.claude-opus-4-8',
  claude: 'uol-inc/AWS_Bedrock/anthropic.claude-opus-4-8',
  sonnet: 'claude-sonnet-4.5',
  gpt: 'gpt-5.4',
  copilot: '', // usa o default do CLI
  ...(() => {
    try {
      return process.env.COPILOT_MODEL_MAP ? JSON.parse(process.env.COPILOT_MODEL_MAP) : {};
    } catch {
      return {};
    }
  })(),
};

/**
 * Resolve o valor final passado a `--model`, SEMPRE traduzindo aliases do
 * domínio ('opus', 'gpt', ...) para ids reais — INDEPENDENTE da origem.
 *
 * BUG-A6: o orchestrator injeta o modelo resolvido em `COPILOT_MODEL`. Quando
 * esse valor é o alias de fallback 'opus' (config.agent.defaultModel), a versão
 * antiga usava `COPILOT_MODEL` VERBATIM (`process.env.COPILOT_MODEL ?? ...`),
 * pulando o MODEL_MAP → o CLI rejeitava com 'Model "opus" ... is not available'
 * em TODA iteração. Agora o alias é traduzido venha ele de COPILOT_MODEL ou de
 * AGENT_DEFAULT_MODEL; ids reais (com '/') e desconhecidos passam direto.
 */
function resolveModel(value) {
  if (value == null || value === '') return value ?? '';
  return value in MODEL_MAP ? MODEL_MAP[value] : value;
}

const RAW_MODEL = process.env.COPILOT_MODEL ?? process.env.AGENT_DEFAULT_MODEL ?? 'opus';
const MODEL = resolveModel(RAW_MODEL);

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

// Lê APENAS a primeira linha (o prompt) do stdin, resolvendo no primeiro '\n'.
// Só é usado quando NÃO há prompt em argv (promptMode='stdin'). O runner escreve
// o prompt seguido de '\n' mas NÃO fecha o stdin (mantém aberto para eventuais
// respostas de HITL); por isso resolvemos na primeira linha em vez de esperar EOF.
function readPromptLine() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        // Mantém o stdin drenado (evita EPIPE se o runner escrever mais).
        process.stdin.on('data', () => {});
        finish(buf.slice(0, nl).trim());
      }
    };
    const onEnd = () => finish(buf.trim());
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

/**
 * US-HARD5: lê COPILOT_POLICY_FLAGS (JSON array de strings) injetado pelo runner
 * do API. Cada item é uma flag/argumento já pronto para o `copilot` (ex.:
 * '--allow-all', '--deny-tool=shell', '--add-dir', '/path'). Fallback tolerante:
 * ausente, vazio ou inválido → ['--allow-all'] (comportamento histórico,
 * backwards-compatible). Filtra itens não-string/vazios (defensivo).
 */
function parsePolicyFlags(raw) {
  if (!raw || raw.trim().length === 0) return ['--allow-all'];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ['--allow-all'];
    const flags = parsed.filter((f) => typeof f === 'string' && f.length > 0);
    return flags.length > 0 ? flags : ['--allow-all'];
  } catch {
    return ['--allow-all'];
  }
}

async function main() {
  // promptMode='arg' entrega o prompt como argumento (preferido: suporta
  // prompts multi-linha e evita depender de EOF do stdin). Só caímos no stdin
  // quando não há prompt em argv.
  const argvPrompt = process.argv.slice(2).join(' ').trim();
  let prompt = argvPrompt || (await readPromptLine());
  // Prompt transportado via stdin vem como uma única linha `B64:<base64>` (o
  // runner codifica para suportar conteúdo multi-linha sem estourar limites de
  // argv). Decodificamos de volta para o texto original.
  if (prompt.startsWith('B64:')) {
    try {
      prompt = Buffer.from(prompt.slice(4), 'base64').toString('utf8');
    } catch {
      // Se falhar o decode, mantém o texto como veio (defensivo).
    }
  }
  if (!prompt) {
    emit({ kind: 'result', detail: 'Prompt vazio.', summary: 'noop', dodTouched: [], affectedFlows: [], nextStep: '', done: true });
    return;
  }

  emit({ kind: 'thought', text: `Invocando Copilot CLI (${COPILOT_BIN}, modelo ${MODEL || 'default'})...` });

  // US-HARD5: política de permissões granular. O API (host) resolve a policy
  // (config.agent.toolPolicy) e a injeta como COPILOT_POLICY_FLAGS (JSON array
  // de flags nativas do CLI). Aqui apenas as CONSUMIMOS. Fallback: sem a env
  // (ou JSON inválido), mantemos o `--allow-all` histórico — necessário no modo
  // não-interativo: sem --allow-all-paths o CLI verifica o path e NEGA escrita
  // fora do diretório permitido (o worktree fica fora), resultando em
  // "Permission denied ...". Ver ADR-0016/0019 e apps/api runners/tool-policy.ts.
  const policyFlags = parsePolicyFlags(process.env.COPILOT_POLICY_FLAGS);
  const args = ['-p', prompt, ...policyFlags, '--no-color'];
  if (MODEL) args.push('--model', MODEL);

  // Session-id: quando o chamador passa COPILOT_SESSION_ID, usamos `--session-id`
  // para que a MESMA sessão do Copilot seja retomada a cada turno. Isso dá
  // memória conversacional real ao CLI E — crucial — faz o HITL SOBREVIVER a um
  // restart da API: a sessão do Copilot é persistida em disco (~/.copilot), então
  // o próximo turno resume o contexto mesmo que o processo da API tenha morrido
  // enquanto aguardava a resposta humana.
  const SESSION_ID = process.env.COPILOT_SESSION_ID || '';
  if (SESSION_ID) args.push('--session-id', SESSION_ID);

  // Se COPILOT_BIN aponta para um script JS (ex.: o index.js do pacote montado
  // read-only), invoca via `node`; caso contrário, executa o binário direto.
  let cmd = COPILOT_BIN;
  let spawnArgs = args;
  if (/\.(c|m)?js$/.test(COPILOT_BIN)) {
    cmd = process.execPath;
    spawnArgs = [COPILOT_BIN, ...args];
  }

  const child = spawn(cmd, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let err = '';

  // Heartbeat: o `copilot` agêntico pode trabalhar por bastante tempo SEM emitir
  // nada em stdout (spin-up do modelo, tool calls). O runner tem um idle timeout
  // de stdout (AGENT_STREAM_IDLE_TIMEOUT_MS, default 120s) que dispararia no
  // meio de uma execução legítima. Emitimos um `thought` periódico enquanto o
  // processo vive para manter o stream "vivo" e não estourar o idle timeout.
  const HEARTBEAT_MS = Number(process.env.COPILOT_HEARTBEAT_MS || 20_000);
  const heartbeat = setInterval(() => {
    emit({ kind: 'thought', text: '…Copilot ainda trabalhando' });
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  child.stdout.setEncoding('utf8');
  // Filtro de streaming: os blocos de controle <<<KANBAN_QUESTION>>> e
  // <<<KANBAN_RESULT>>> são um canal ESTRUTURADO (parseado no `close`), NÃO
  // conteúdo para o humano. Se emitíssemos suas linhas como `output`, o
  // transcript (persistido e reidratado no F5) mostraria o JSON/marcadores
  // crus e quebrados por chunk. Aqui suprimimos tudo entre o marcador de
  // abertura e o de fechamento. Buffer de linha para lidar com marcadores
  // partidos entre chunks de stdout.
  let lineBuf = '';
  let insideControlBlock = false;
  const OPEN_RE = /<<<KANBAN_(QUESTION|RESULT|BACKLOG_PATCH|BACKLOG|TASKS_PATCH|TASKS)>>>/;
  const CLOSE_RE = /<<<END_KANBAN_(QUESTION|RESULT|BACKLOG_PATCH|BACKLOG|TASKS_PATCH|TASKS)>>>/;
  // BUG-04: o `copilot` renderiza tool calls (ex.: `● query (sql) │ SELECT …
  // └ 3 row(s) returned`) usando caracteres de "box-drawing" e bullets. Esse é
  // ruído de TUI — NÃO é resposta para o humano — e vazava cru para o chat/
  // transcript. Suprimimos linhas cujo primeiro caractere não-espaço é um
  // desses marcadores de renderização de ferramenta.
  const TOOL_RENDER_RE = /^\s*[●│└┌├┐┘┴┬┤─➜✔✗•]/u;
  const emitOutputLine = (raw) => {
    const t = raw.trimEnd();
    if (t.length === 0) return;
    if (insideControlBlock) {
      // Continua suprimindo até encontrar o fechamento (na mesma linha ou depois).
      if (CLOSE_RE.test(t)) insideControlBlock = false;
      return;
    }
    if (OPEN_RE.test(t)) {
      // Emite só o texto ANTES do marcador de abertura (o preâmbulo do humano).
      const before = t.split(OPEN_RE)[0].trimEnd();
      if (before.length > 0) emit({ kind: 'output', text: before });
      // Se o bloco abre e fecha na mesma linha, não entra em modo supressão.
      insideControlBlock = !CLOSE_RE.test(t);
      return;
    }
    if (TOOL_RENDER_RE.test(t)) return; // ruído de renderização de tool call
    emit({ kind: 'output', text: t });
  };
  child.stdout.on('data', (d) => {
    out += d;
    lineBuf += String(d);
    const parts = lineBuf.split('\n');
    // A última parte pode ser uma linha incompleta — guarda para o próximo chunk.
    lineBuf = parts.pop() ?? '';
    for (const line of parts) emitOutputLine(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    err += d;
  });

  child.on('error', (e) => {
    clearInterval(heartbeat);
    // BUG-A7: falha de SPAWN é erro de infraestrutura, não trabalho da AI. NÃO
    // pode virar `done:true` (marcaria a task como concluída!) nem `done:false`
    // silencioso (o loop iteraria até o cap). Sinalizamos `fatalError` para o
    // orchestrator escalar a humano e PARAR o loop (fail-fast).
    emit({
      kind: 'result',
      detail: `Falha ao invocar ${COPILOT_BIN}: ${e.message}. Verifique se o Copilot CLI está instalado no PATH e autenticado.`,
      summary: 'erro ao iniciar Copilot CLI',
      dodTouched: [],
      affectedFlows: [],
      nextStep: 'Instalar/autenticar o Copilot CLI no ambiente da API.',
      done: false,
      fatalError: `spawn: ${e.message}`,
    });
  });

  // O evento `close` só dispara quando TODOS os stdio streams do filho fecham.
  // Ferramentas do `copilot --allow-all` podem spawnar subprocessos (shell) que
  // herdam o stdout — se algum ficar aberto/em background, o pipe não fecha e
  // `close` NUNCA dispara, deixando o adapter pendurado (o filho `copilot` já
  // saiu) até o runner estourar o idle timeout. Para blindar, também escutamos
  // `exit` (dispara na saída do PROCESSO, independente dos pipes) e finalizamos
  // após uma pequena carência para o `close` chegar naturalmente (e drenar o
  // stdout). `finalize` é idempotente.
  let finalized = false;
  const finalize = (code) => {
    if (finalized) return;
    finalized = true;
    clearInterval(heartbeat);
    emitTerminalEvents(code);
    // Após emitir o(s) evento(s) terminal(is), o adapter cumpriu seu papel
    // one-shot. Encerramos explicitamente — se o `close` não veio (pipe preso
    // por subprocesso órfão de uma tool), isto evita pendurar o runner.
    process.exit(0);
  };

  const emitTerminalEvents = (code) => {
    // Flush da última linha incompleta do buffer de streaming (respeitando o
    // filtro de blocos de controle).
    if (lineBuf.length > 0) {
      emitOutputLine(lineBuf);
      lineBuf = '';
    }
    const text = out.trim();

    // Telemetria de tokens do rodapé de stats da CLI (modo texto). Computada
    // uma vez a partir do stdout completo e anexada a TODO evento `result`
    // abaixo, para o orchestrator persistir input/output tokens por iteração.
    const tokenUsage = parseTokenUsage(out);

    // Chat da story (ADR-0026): proposta de TASKS estruturada. Tem precedência
    // sobre os blocos de backlog (Epic+Stories), pois no chat da story o PO
    // emite tasks, não um backlog novo. Patch cirúrgico antes da lista inteira.
    const taskPatch = extractKanbanTasksPatch(text);
    if (taskPatch) {
      emit({ kind: 'task_patch', taskPatch });
      return;
    }
    const taskProposal = extractKanbanTasks(text);
    if (taskProposal) {
      emit({ kind: 'task_proposal', taskProposal });
      return;
    }

    // Ecossistema "Chat de criação de Épicos/Histórias": se a AI emitiu um
    // bloco KANBAN_BACKLOG (proposta) ou KANBAN_BACKLOG_PATCH (refinamento
    // cirúrgico), emitimos o evento estruturado correspondente. Nesses casos o
    // turno de backlog não usa `result` (o BacklogCliRunner consome proposal/
    // patch/question) — então retornamos sem emitir result.
    const patch = extractKanbanBacklogPatch(text);
    if (patch) {
      emit({ kind: 'patch', patch });
      return;
    }
    const proposal = extractKanbanBacklog(text);
    if (proposal) {
      emit({ kind: 'proposal', proposal });
      return;
    }

    // #6: canal ESTRUTURADO de HITL. Se a AI emitiu um bloco KANBAN_QUESTION,
    // ela precisa de decisão humana ANTES de continuar. Emitimos o evento
    // `question` (o runner pausa a iteração via waitForAnswer). Em seguida
    // emitimos um `result` (done:false) carregando a pergunta+contexto no
    // `nextStep`, para que — no modelo one-shot do Copilot CLI — a próxima
    // iteração seja reinvocada já com a pergunta e a resposta no lastro.
    const question = extractKanbanQuestion(text);
    if (question) {
      emit({
        kind: 'question',
        id: `q-${Date.now()}`,
        prompt: question.prompt,
        options: Array.isArray(question.options) ? question.options.map(String) : undefined,
      });
      emit({
        kind: 'result',
        detail: text || `Copilot CLI encerrou com código ${code}.`,
        summary: `AI aguardando decisão humana: ${question.prompt}`.slice(0, 240),
        dodTouched: [],
        affectedFlows: [],
        nextStep: `Pergunta ao humano: ${question.prompt}${
          question.options?.length ? ` (opções: ${question.options.join(' | ')})` : ''
        }. Continue a partir da resposta recebida.`,
        done: false,
        ...tokenUsage,
      });
      return;
    }

    const structured = extractKanbanResult(text);
    if (structured) {
      emit({
        kind: 'result',
        detail: text || `Copilot CLI encerrou com código ${code}.`,
        summary: (structured.summary || lastLine(text) || 'Iteração concluída pelo Copilot CLI.').slice(0, 240),
        dodTouched: Array.isArray(structured.dodTouched) ? structured.dodTouched.map(String) : [],
        proposedDod: Array.isArray(structured.proposedDod)
          ? structured.proposedDod.map(String).filter((s) => s.trim().length > 0)
          : undefined,
        affectedFlows: normalizeFlows(structured.affectedFlows),
        nextStep: typeof structured.nextStep === 'string' ? structured.nextStep : '',
        done: structured.done === true,
        ...tokenUsage,
      });
      return;
    }
    // Fallback: sem bloco estruturado, devolve o texto cru como antes.
    // BUG-A7: distinguimos ERRO FATAL de infraestrutura (a CLI abortou sem
    // produzir trabalho) de uma iteração normal inconclusa. Se a CLI saiu com
    // código ≠ 0 e não houve NENHUM bloco estruturado, ou o texto casa com um
    // padrão fatal conhecido (modelo indisponível, não autenticado, quota),
    // marcamos `fatalError` para o orchestrator escalar a humano e parar o loop
    // em vez de queimar iterações até o cap.
    const fatalError = detectFatalError(code, text, err);
    emit({
      kind: 'result',
      detail: text || err.trim() || `Copilot CLI encerrou com código ${code}.`,
      summary: (lastLine(text) || lastLine(err) || 'Iteração concluída pelo Copilot CLI.').slice(0, 240),
      dodTouched: [],
      affectedFlows: [],
      nextStep: '',
      done: code === 0 && !fatalError,
      ...tokenUsage,
      ...(fatalError ? { fatalError } : {}),
    });
  };

  // `close`: caminho feliz — todos os pipes fecharam, stdout drenado.
  child.on('close', (code) => finalize(code ?? 0));
  // `exit`: rede de segurança — o processo `copilot` saiu, mas algum pipe pode
  // seguir aberto (subprocesso de tool). Damos uma carência curta para o
  // `close` chegar (e drenar o buffer); se não vier, finalizamos com o que há.
  child.on('exit', (code) => {
    setTimeout(() => finalize(code ?? 0), 1500).unref?.();
  });
}

/** Última linha não-vazia de um texto. */
function lastLine(text) {
  return text.split('\n').filter(Boolean).slice(-1)[0] || '';
}

/**
 * Extrai a telemetria de TOKENS do rodapé de estatísticas que o Copilot CLI
 * imprime ao final de um turno (modo texto), no formato:
 *
 *   Tokens     ↑ 44.4k (29.7k cached, 14.5k written) • ↓ 25
 *
 * `↑` (U+2191) é o total de tokens de ENTRADA (prompt); `↓` (U+2193) é o total
 * de SAÍDA (resposta). Os valores podem vir como inteiro (`25`) ou abreviados
 * (`44.4k`, `1.2m`). Retorna `{ inputTokens, outputTokens }` com os campos que
 * conseguiu extrair (undefined quando ausente). Se o rodapé não existir (ex.:
 * turno estruturado sem stats, versão diferente da CLI), retorna `{}`.
 */
function parseTokenUsage(text) {
  if (!text) return {};
  // Pega a ÚLTIMA ocorrência da linha de Tokens (um turno = um rodapé; se
  // houver ruído, o rodapé real é o último).
  const lines = text.split('\n');
  let line = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(^|\s)Tokens\s/.test(lines[i]) && /[↑↓]/.test(lines[i])) {
      line = lines[i];
      break;
    }
  }
  if (!line) return {};
  const toNumber = (raw) => {
    if (!raw) return undefined;
    const m = String(raw)
      .trim()
      .match(/^([\d.,]+)\s*([kKmMgG])?/);
    if (!m) return undefined;
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return undefined;
    const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] || '').toLowerCase()] || 1;
    return Math.round(value * mult);
  };
  const up = line.match(/↑\s*([\d.,]+\s*[kKmMgG]?)/);
  const down = line.match(/↓\s*([\d.,]+\s*[kKmMgG]?)/);
  const usage = {};
  const inputTokens = up ? toNumber(up[1]) : undefined;
  const outputTokens = down ? toNumber(down[1]) : undefined;
  if (typeof inputTokens === 'number') usage.inputTokens = inputTokens;
  if (typeof outputTokens === 'number') usage.outputTokens = outputTokens;
  return usage;
}

/**
 * BUG-A7: detecta ERRO FATAL de infraestrutura na saída da CLI. Retorna uma
 * string curta (motivo) quando o turno falhou de forma NÃO recuperável iterando
 * — nesses casos o orchestrator escala a humano e PARA o loop, em vez de tratar
 * como iteração normal (o que queimaria iterações até o cap, ou pior, marcaria
 * a task como `done`). Retorna `null` para saídas normais.
 *
 * Fatal quando:
 *  - a saída casa um padrão conhecido de falha dura (modelo indisponível, não
 *    autenticado, sem permissão de credencial, quota/limite estourado); OU
 *  - a CLI saiu com código ≠ 0 SEM ter produzido nenhum texto de trabalho útil
 *    (só ruído/stderr) — sinal de crash/config, não de trabalho inconcluso.
 */
function detectFatalError(code, text, err) {
  const haystack = `${text}\n${err}`.toLowerCase();
  const FATAL_PATTERNS = [
    /is not available/, // "Model \"x\" from --model flag is not available."
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
  // Saída não-zero sem qualquer conteúdo de trabalho é infra, não iteração.
  if (code !== 0 && text.trim().length === 0) {
    return `fatal: CLI saiu com código ${code}${err.trim() ? ` — ${lastLine(err)}` : ''}`.slice(0, 240);
  }
  return null;
}

/**
 * Extrai o bloco estruturado que a AI é instruída a emitir ao FINAL da resposta:
 *
 *   <<<KANBAN_RESULT>>>
 *   { "dodTouched": [...], "proposedDod": [...], "affectedFlows": [...], "nextStep": "...", "done": true, "summary": "..." }
 *   <<<END_KANBAN_RESULT>>>
 *
 * `proposedDod` (lista de strings) só é usado na fase de ANÁLISE, quando a task
 * ainda não tem DOD: o orchestrator cria os DodItems a partir dele. Se a AI não
 * o emitir, o orchestrator aplica um fallback determinístico.
 *
 * Tolerante: aceita o bloco em qualquer lugar da saída, com ou sem cerca ```json.
 * Retorna o objeto parseado ou null se ausente/inválido.
 */
function extractKanbanResult(text) {
  const m = text.match(/<<<KANBAN_RESULT>>>([\s\S]*?)<<<END_KANBAN_RESULT>>>/);
  if (!m) return null;
  let body = m[1].trim();
  // Remove cercas markdown se a AI as incluir.
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(body);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Extrai o bloco de PERGUNTA (HITL) que a AI emite quando precisa de decisão
 * humana:
 *
 *   <<<KANBAN_QUESTION>>>
 *   { "prompt": "<pergunta>", "options": ["a","b"] }
 *   <<<END_KANBAN_QUESTION>>>
 *
 * Retorna { prompt, options } ou null.
 */
function extractKanbanQuestion(text) {
  const m = text.match(/<<<KANBAN_QUESTION>>>([\s\S]*?)<<<END_KANBAN_QUESTION>>>/);
  if (!m) return null;
  let body = m[1].trim();
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object') return null;
    const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : '';
    if (!prompt) return null;
    return { prompt, options: Array.isArray(obj.options) ? obj.options : undefined };
  } catch {
    return null;
  }
}

/**
 * Extrai o bloco de PROPOSTA de backlog (Epic + Stories):
 *
 *   <<<KANBAN_BACKLOG>>>
 *   { "version": 1, "epic": {...}, "stories": [...], "rationale": "..." }
 *   <<<END_KANBAN_BACKLOG>>>
 *
 * Retorna o objeto proposta ou null.
 */
function extractKanbanBacklog(text) {
  const m = text.match(/<<<KANBAN_BACKLOG>>>([\s\S]*?)<<<END_KANBAN_BACKLOG>>>/);
  if (!m) return null;
  let body = m[1].trim();
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object' || !obj.epic) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Extrai o bloco de PATCH cirúrgico de backlog:
 *
 *   <<<KANBAN_BACKLOG_PATCH>>>
 *   { "baseVersion": 1, "ops": [...] }
 *   <<<END_KANBAN_BACKLOG_PATCH>>>
 *
 * Retorna o objeto patch ou null.
 */
function extractKanbanBacklogPatch(text) {
  const m = text.match(
    /<<<KANBAN_BACKLOG_PATCH>>>([\s\S]*?)<<<END_KANBAN_BACKLOG_PATCH>>>/,
  );
  if (!m) return null;
  let body = m[1].trim();
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.ops)) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Extrai o bloco de PROPOSTA DE TASKS do chat da story (ADR-0026):
 *
 *   <<<KANBAN_TASKS>>>
 *   { "version": 1, "tasks": [{ "title": "...", "description": "..." }], "rationale": "..." }
 *   <<<END_KANBAN_TASKS>>>
 *
 * Retorna { version?, tasks[], rationale? } ou null. Tolerante a cercas ```json.
 */
function extractKanbanTasks(text) {
  const m = text.match(/<<<KANBAN_TASKS>>>([\s\S]*?)<<<END_KANBAN_TASKS>>>/);
  if (!m) return null;
  let body = m[1].trim();
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.tasks)) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Extrai o bloco de PATCH cirúrgico de uma proposta de tasks (thread task:<id>):
 *
 *   <<<KANBAN_TASKS_PATCH>>>
 *   { "baseVersion": 1, "ops": [{ "op": "replace", "path": "/tasks/0/title", "value": "..." }] }
 *   <<<END_KANBAN_TASKS_PATCH>>>
 *
 * Retorna { baseVersion?, ops[] } ou null.
 */
function extractKanbanTasksPatch(text) {
  const m = text.match(
    /<<<KANBAN_TASKS_PATCH>>>([\s\S]*?)<<<END_KANBAN_TASKS_PATCH>>>/,
  );
  if (!m) return null;
  let body = m[1].trim();
  body = body.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(body);
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.ops)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Normaliza affectedFlows reportados pela AI. */
function normalizeFlows(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((f) => {
      if (!f || typeof f !== 'object') return null;
      const name = typeof f.name === 'string' ? f.name.trim() : '';
      if (!name) return null;
      const files = Array.isArray(f.files) ? f.files.map(String) : [];
      const note = typeof f.note === 'string' ? f.note : '';
      return { name, files, note };
    })
    .filter(Boolean);
}

main().catch((e) => {
  emit({
    kind: 'result',
    detail: `Erro inesperado no adapter: ${e?.message ?? e}`,
    summary: 'erro no adapter',
    dodTouched: [],
    affectedFlows: [],
    nextStep: '',
    done: false,
    fatalError: `adapter: ${e?.message ?? e}`,
  });
});
