/**
 * US-F5.1 (EP-F5) — **Formato de neurônio CANÔNICO do graphify** (memory doc).
 *
 * O v2 anterior (frontmatter `schema/module/tags/files`) era uma invenção
 * nossa: o graphify NUNCA o leu — o caminho nativo de memória de trabalho do
 * pacote é `save_query_result`/`parse_memory_doc` (`graphify/ingest.py` e
 * `graphify/reflect.py`), e o `graphify reflect` agrega EXATAMENTE esse
 * formato. Este módulo agora emite e parseia o formato canônico, espelhando
 * a implementação Python byte a byte no que importa:
 *
 * - frontmatter com escalares em ASPAS DUPLAS (`key: "value"` — o regex do
 *   `parse_memory_doc` EXIGE as aspas) nos campos reconhecidos: `type`,
 *   `date`, `question`, `outcome`, `correction`, `contributor`;
 * - `source_nodes: ["id_a", "id_b"]` — lista flow de **IDs DE NÓ** (não
 *   caminhos!), com teto de 10 (mesmo corte do `save_query_result`);
 * - corpo `# Q:` / `## Answer` / `## Outcome` / `## Source Nodes` (o corpo é
 *   ignorado pelo reflect, mas round-tripa no grafo via `extract_markdown`);
 * - `outcome` ∈ `useful|dead_end|corrected` (`OUTCOMES` do ingest.py) —
 *   valor inválido é REJEITADO na serialização, como no Python.
 *
 * A receita de id de nó é a do graphify (`ids.make_id` + `_file_stem` de
 * `extractors/base.py`): caminho relativo ao repo com TODOS os segmentos,
 * última extensão removida, casefold+NFKC até ponto fixo, não-alfanumérico →
 * `_`, `_` repetido colapsado, `_` das bordas removido. Símbolo é sufixado
 * como parte extra (`src/auth/session.py` + `ValidateToken` →
 * `src_auth_session_validatetoken`).
 *
 * Onde os neurônios vivem (decisão da US-F5.1): `<clone>/.hive/memory/*.md`
 * — ver `HIVE_MEMORY_SUBDIR` abaixo.
 *
 * Tudo aqui é função pura e determinística (estilo da casa).
 */

/** Vocabulário de outcome do graphify (`OUTCOMES` em `graphify/ingest.py`). */
export const OUTCOMES = ['useful', 'dead_end', 'corrected'] as const;
export type MemoryOutcome = (typeof OUTCOMES)[number];

/**
 * US-F5.1 — subdiretório da colmeia onde os memory docs vivem:
 * `<clone>/.hive/memory/*.md` (PLANO — o `load_memory_docs` do reflect.py faz
 * `memory_dir.glob("*.md")`, NÃO-recursivo).
 *
 * Por que no clone e não no default do CLI: o `graphify reflect` recebe
 * `--memory-dir` como parâmetro (default `GRAPHIFY_OUT/memory`, cli.py
 * ~l.1347) — e o nosso GRAPHIFY_OUT é `~/.graphify/projects/<id>/graphify-out`
 * (ADR-0041), fora do clone: morre num purge/rebuild do grafo e não viaja com
 * o volume do repo. Mantendo os docs em `.hive/memory/` eles (a) sobrevivem a
 * rebuild do grafo, (b) viajam com o clone, e (c) são indexados pelo
 * `extract_markdown` como nós `page` (o `.graphifyignore` re-inclui `.hive/`).
 * A US-F5.2 passa `--memory-dir <clone>/.hive/memory` explicitamente (rota
 * `POST /reflect` do wrapper, `docker/graphify_build_server.py`).
 */
export const HIVE_MEMORY_SUBDIR = 'memory';

/** Campos reconhecidos pelo `parse_memory_doc` (reflect.py ~l.104). */
export interface MemoryDoc {
  type?: string;
  date?: string;
  question?: string;
  outcome?: string;
  correction?: string;
  contributor?: string;
  /** IDs de nó do grafo (receita `fileNodeId`/`makeNodeId`). Sempre lista. */
  sourceNodes: string[];
}

// ---------------------------------------------------------------------------
// Escape/unescape YAML — porta fiel de `_yaml_str` (ingest.py) e
// `_yaml_unescape` (reflect.py). Sem lib YAML de propósito (paridade com o
// Python, que também não depende de PyYAML aqui).
// ---------------------------------------------------------------------------

/** Escapa `s` para um escalar YAML entre aspas duplas (porta de `_yaml_str`). */
export function yamlStr(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\0') out += '\\0';
    else if (cp === 0x2028) out += '\\L';
    else if (cp === 0x2029) out += '\\P';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return out;
}

/** Reverte `yamlStr` (porta de `_yaml_unescape` do reflect.py). */
function yamlUnescape(s: string): string {
  const simple: Record<string, string> = {
    n: '\n',
    r: '\r',
    t: '\t',
    '0': '\0',
    '"': '"',
    '\\': '\\',
    L: '\u2028',
    P: '\u2029',
  };
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const nxt = s[i + 1];
      if (nxt in simple) {
        out += simple[nxt];
        i += 2;
        continue;
      }
      if (nxt === 'x' && i + 3 < s.length) {
        const code = parseInt(s.slice(i + 2, i + 4), 16);
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code);
          i += 4;
          continue;
        }
      }
      if (nxt === 'u' && i + 5 < s.length) {
        const code = parseInt(s.slice(i + 2, i + 6), 16);
        if (!Number.isNaN(code)) {
          out += String.fromCharCode(code);
          i += 6;
          continue;
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialização — espelho de `save_query_result` (ingest.py).
// ---------------------------------------------------------------------------

/** Teto de `source_nodes` por doc — mesmo corte do `save_query_result` (`[:10]`). */
export const MAX_SOURCE_NODES = 10;

/**
 * Serializa um memory doc canônico. Estrutura idêntica à que
 * `save_query_result` escreve (frontmatter + `# Q:`/`## Answer`/`## Outcome`/
 * `## Source Nodes`). `outcome` fora de `OUTCOMES` LANÇA (paridade com o
 * `ValueError` do Python).
 */
export function serializeMemoryDoc(input: {
  question: string;
  answer: string;
  /** ISO-8601 (equivalente ao `now.isoformat()` do Python). */
  date: string;
  /** Default 'query' como no Python; nós usamos 'learning'. */
  type?: string;
  contributor?: string;
  outcome?: MemoryOutcome;
  correction?: string;
  /** IDs de nó (`fileNodeId`) — teto `MAX_SOURCE_NODES`, como no Python. */
  sourceNodes?: string[];
}): string {
  if (input.outcome !== undefined && !OUTCOMES.includes(input.outcome)) {
    throw new RangeError(`outcome deve ser um de ${OUTCOMES.join('|')}, veio ${input.outcome}`);
  }
  const nodes = (input.sourceNodes ?? []).slice(0, MAX_SOURCE_NODES);
  const fm = [
    '---',
    `type: "${yamlStr(input.type ?? 'query')}"`,
    `date: "${yamlStr(input.date)}"`,
    `question: "${yamlStr(input.question)}"`,
    `contributor: "${yamlStr(input.contributor ?? 'graphify')}"`,
  ];
  if (input.outcome) fm.push(`outcome: "${yamlStr(input.outcome)}"`);
  if (input.correction) fm.push(`correction: "${yamlStr(input.correction)}"`);
  if (nodes.length > 0) {
    fm.push(`source_nodes: [${nodes.map((n) => `"${yamlStr(n)}"`).join(', ')}]`);
  }
  fm.push('---');
  const body = ['', `# Q: ${input.question}`, '', '## Answer', '', input.answer];
  if (input.outcome || input.correction) {
    body.push('', '## Outcome', '');
    if (input.outcome) body.push(`- Signal: ${input.outcome}`);
    if (input.correction) body.push(`- Correction: ${input.correction}`);
  }
  if (nodes.length > 0) {
    body.push('', '## Source Nodes', '', ...nodes.map((n) => `- ${n}`));
  }
  return [...fm, ...body].join('\n');
}

/**
 * Nome de arquivo de um memory doc, na receita do `save_query_result`:
 * `learning_<YYYYMMDD_HHMMSS>_<slug50>.md` (slug = minúsculo, cada char
 * não-`\w` → `_`, corte em 50, `_` das bordas removido). O reflect não lê o
 * nome (só ordena por ele), mas manter a receita dá arquivos uniformes com os
 * `query_*.md` que um `graphify save-result` manual criaria no mesmo dir.
 */
export function memoryDocFilename(slugSource: string, date: Date): string {
  const slug = slugSource
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]/gu, '_')
    .slice(0, 50)
    .replace(/^_+|_+$/g, '');
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `_${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  return `learning_${stamp}_${slug}.md`;
}

// ---------------------------------------------------------------------------
// Parse — espelho de `parse_memory_doc` (reflect.py ~l.104): mesmos regexes,
// mesma tolerância (linha não reconhecida é ignorada; sem frontmatter → null).
// ---------------------------------------------------------------------------

const SCALAR_RE = /^([A-Za-z_][\w-]*):\s*"(.*)"\s*$/;
const LIST_RE = /^([A-Za-z_][\w-]*):\s*\[(.*)\]\s*$/;
const DQ_ITEM_RE = /"((?:[^"\\]|\\.)*)"/g;
const SCALAR_KEYS = new Set(['type', 'date', 'question', 'outcome', 'correction', 'contributor']);

/**
 * Parseia o frontmatter de um memory doc. `null` quando não há frontmatter
 * (markdown estrangeiro no dir de memória — o reflect também o pula).
 */
export function parseMemoryDoc(text: string): MemoryDoc | null {
  if (!text.startsWith('---')) return null;
  const lines = text.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  const doc: MemoryDoc = { sourceNodes: [] };
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const list = LIST_RE.exec(line);
    if (list && list[1] === 'source_nodes') {
      doc.sourceNodes = [...list[2].matchAll(DQ_ITEM_RE)].map((m) => yamlUnescape(m[1]));
      continue;
    }
    const scalar = SCALAR_RE.exec(line);
    if (scalar && SCALAR_KEYS.has(scalar[1])) {
      const key = scalar[1] as 'type' | 'date' | 'question' | 'outcome' | 'correction' | 'contributor';
      doc[key] = yamlUnescape(scalar[2]);
    }
  }
  return doc;
}

/**
 * Remove o bloco de frontmatter INICIAL (`--- … ---`) de um conteúdo, se
 * existir. Sem frontmatter → conteúdo intacto. Mesma regra do graphify: só é
 * frontmatter se o `---` for a PRIMEIRA linha e a cerca fechar (`---`/`...`).
 */
export function stripFrontmatter(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return content;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return lines.slice(i + 1).join('\n');
  }
  return content;
}

// ---------------------------------------------------------------------------
// IDs de nó — porta fiel de `ids.make_id`/`normalize_id` e do `_file_stem` de
// `extractors/base.py` (a receita que `_file_node_id` do extract.py usa).
// ---------------------------------------------------------------------------

/**
 * Porta de `normalize_id` (ids.py): casefold→NFKC até ponto fixo (teto 6),
 * runs de não-alfanumérico → `_`, `_` repetido colapsado, `_` das bordas
 * removido. `toLowerCase()` no lugar do casefold do Python — idêntico para
 * ASCII (paths e símbolos deste repo); `\p{L}\p{N}_` no lugar do `\w`
 * unicode do Python.
 */
export function normalizeId(s: string): string {
  let cur = s;
  for (let i = 0; i < 6; i++) {
    const nxt = cur.toLowerCase().normalize('NFKC');
    if (nxt === cur) break;
    cur = nxt;
  }
  return cur
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Porta de `make_id` (ids.py): junta as partes com `_` (bordas `_`/`.` de cada parte removidas) e normaliza. */
export function makeNodeId(...parts: string[]): string {
  return normalizeId(
    parts
      .filter(Boolean)
      .map((p) => p.replace(/^[_.]+|[_.]+$/g, ''))
      .join('_'),
  );
}

/**
 * ID de nó de ARQUIVO (porta de `_file_node_id` + `_file_stem`): caminho
 * relativo ao repo, todos os segmentos preservados, ÚLTIMA extensão removida
 * (`with_suffix("")` — arquivo oculto sem stem, tipo `.env`, mantém o nome),
 * normalizado. Com `symbol`, o símbolo entra como parte extra do `make_id` —
 * é o id que a extração AST/semântica dá ao símbolo daquele arquivo:
 * `src/auth/session.py` + `ValidateToken` → `src_auth_session_validatetoken`.
 */
export function fileNodeId(relPath: string, symbol?: string): string {
  const segs = relPath.replace(/\\/g, '/').split('/');
  const name = segs[segs.length - 1];
  // `Path.with_suffix("")`: só remove se o `.` não for o 1º char do nome.
  const dot = name.lastIndexOf('.');
  if (dot > 0) segs[segs.length - 1] = name.slice(0, dot);
  const stem = segs.join('/');
  return symbol ? makeNodeId(stem, symbol) : makeNodeId(stem);
}

/** Deriva um título de fallback do path do doc (`…/cards.md` → `cards`). */
export function moduleFromNeuronPath(neuronPath: string): string {
  const base = neuronPath.split('/').pop() ?? neuronPath;
  return base.replace(/\.md$/i, '');
}
