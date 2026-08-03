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

const RAW_MODEL = process.env.AGENT_DEFAULT_MODEL || 'opus';
// COPILOT_MODEL força um id explícito; senão traduz o alias do domínio.
const MODEL =
  process.env.COPILOT_MODEL ??
  (RAW_MODEL in MODEL_MAP ? MODEL_MAP[RAW_MODEL] : RAW_MODEL);

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

async function main() {
  // promptMode='arg' entrega o prompt como argumento (preferido: suporta
  // prompts multi-linha e evita depender de EOF do stdin). Só caímos no stdin
  // quando não há prompt em argv.
  const argvPrompt = process.argv.slice(2).join(' ').trim();
  const prompt = argvPrompt || (await readPromptLine());
  if (!prompt) {
    emit({ kind: 'result', detail: 'Prompt vazio.', summary: 'noop', dodTouched: [], affectedFlows: [], nextStep: '', done: true });
    return;
  }

  emit({ kind: 'thought', text: `Invocando Copilot CLI (${COPILOT_BIN}, modelo ${MODEL || 'default'})...` });

  // --allow-all = --allow-all-tools + --allow-all-paths + --allow-all-urls.
  // Necessário no modo não-interativo: sem --allow-all-paths o CLI verifica o
  // path e NEGA escrita fora do diretório permitido (o worktree do repo-alvo
  // fica fora), resultando em "Permission denied and could not request
  // permission from user". Ver ADR-0016/0019.
  const args = ['-p', prompt, '--allow-all', '--no-color'];
  if (MODEL) args.push('--model', MODEL);

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
  child.stdout.on('data', (d) => {
    out += d;
    // Stream incremental: cada linha vira um `output`.
    for (const line of String(d).split('\n')) {
      const t = line.trimEnd();
      if (t.length > 0) emit({ kind: 'output', text: t });
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    err += d;
  });

  child.on('error', (e) => {
    clearInterval(heartbeat);
    emit({
      kind: 'result',
      detail: `Falha ao invocar ${COPILOT_BIN}: ${e.message}. Verifique se o Copilot CLI está instalado no PATH e autenticado.`,
      summary: 'erro ao iniciar Copilot CLI',
      dodTouched: [],
      affectedFlows: [],
      nextStep: 'Instalar/autenticar o Copilot CLI no ambiente da API.',
      done: true,
    });
  });

  child.on('close', (code) => {
    clearInterval(heartbeat);
    const text = out.trim();

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
        affectedFlows: normalizeFlows(structured.affectedFlows),
        nextStep: typeof structured.nextStep === 'string' ? structured.nextStep : '',
        done: structured.done === true,
      });
      return;
    }
    // Fallback: sem bloco estruturado, devolve o texto cru como antes.
    emit({
      kind: 'result',
      detail: text || err.trim() || `Copilot CLI encerrou com código ${code}.`,
      summary: (lastLine(text) || 'Iteração concluída pelo Copilot CLI.').slice(0, 240),
      dodTouched: [],
      affectedFlows: [],
      nextStep: '',
      done: code === 0,
    });
  });
}

/** Última linha não-vazia de um texto. */
function lastLine(text) {
  return text.split('\n').filter(Boolean).slice(-1)[0] || '';
}

/**
 * Extrai o bloco estruturado que a AI é instruída a emitir ao FINAL da resposta:
 *
 *   <<<KANBAN_RESULT>>>
 *   { "dodTouched": [...], "affectedFlows": [...], "nextStep": "...", "done": true, "summary": "..." }
 *   <<<END_KANBAN_RESULT>>>
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
    done: true,
  });
});
