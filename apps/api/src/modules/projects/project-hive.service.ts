import { Inject, Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_CONFIG, type AppConfig } from '../../shared/config/config';

/**
 * US-F2.4 → US-F2.3 (EP-F2) — **A colmeia do Project vive no clone**.
 *
 * Nasceu (US-F2.4) como ESPELHO: os neurônios moravam no bare repo da memória
 * (ADR-0027) e `materialize()` os copiava para `<clone>/.hive/**.md`, dentro
 * do scan root do graphify. A US-F2.3 deletou o git da memória (emenda da
 * US-F2.10 no ADR-0027): o `.hive/` deixou de ser espelho e virou a **fonte da
 * verdade** — este serviço agora é dono da leitura E da escrita dos neurônios
 * como arquivos simples.
 *
 * Por que o `.hive/` fica DENTRO do clone:
 *  - o `extract_markdown` do graphify indexa os neurônios junto com o código
 *    (nó `page` com o frontmatter como atributos);
 *  - US-F5.1 — os memory docs canônicos vivem em `.hive/memory/` (plano),
 *    o diretório que o `graphify reflect --memory-dir` vai receber na
 *    US-F5.2; a justificativa completa está em `HIVE_MEMORY_SUBDIR`
 *    (`shared/neuron-format.ts`). A ligação neurônio→código é `source_nodes`
 *    do frontmatter (agregada nativamente pelo reflect) — a antiga injeção
 *    de arestas `describes` no build wrapper foi APAGADA (não existia no
 *    vocabulário do graphify).
 *
 * A tensão do clone `:ro` (ADR-0041 §5): o SIDECAR monta os clones read-only,
 * mas a API monta o MESMO volume rw (é ela quem clona). Quem escreve a colmeia
 * é a API; o sidecar só a lê no scan.
 *
 * Higiene do working tree (onde os agents trabalham):
 *  - `.hive/` e `.graphifyignore` entram em `.git/info/exclude` (local, nunca
 *    commitável) → `git status` limpo, `git add -A` não os captura;
 *  - como o graphify TAMBÉM honra `.git/info/exclude`, um `.graphifyignore`
 *    na raiz re-inclui a colmeia com `!/.hive/` (last-match-wins — verificado
 *    empiricamente no `ignored_predicate` do graphify).
 *
 * Concorrência da escrita (US-F2.3, a resposta ao lost-update que o CAS/merge
 * do git resolvia): `mutateHiveFile` faz read→mutate→write **síncrono, sem
 * await no meio** — em Node single-thread isso torna o read-modify-write
 * não-interrompível dentro do processo, e a API é a ÚNICA escritora da
 * colmeia (ADR-0027, emenda US-F2.10: o canal `learnings` serializado pelo
 * orchestrator). A escrita é atômica no FS (tmp + rename) contra corrupção
 * por crash no meio do write.
 * ponytail: a garantia é single-process; se um dia houver um 2º escritor
 * (outra API, worker externo), o lost-update volta — aí precisa de lock por
 * arquivo (o ADR-0027 registra como o problema foi resolvido uma vez).
 */
@Injectable()
export class ProjectHiveService {
  /** Diretório da colmeia dentro do clone (contrato com o wrapper de build). */
  static readonly HIVE_DIR = '.hive';

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * US-F2.3 — escrita de um neurônio direto na colmeia do clone (a fonte da
   * verdade desde a deleção do git da memória). `rel` é relativo ao `.hive/`
   * (ex.: `modules/cards.md`) e pode vir da IA (`learnings[].path`) — trust
   * boundary: path inválido/traversal é rejeitado com `null`, nunca escapa.
   *
   * `mutate` recebe o conteúdo atual (`null` se o neurônio não existe) e
   * devolve o novo — o read-modify-write inteiro é SÍNCRONO (ver doc da
   * classe: é o que elimina lost-update in-process sem lock).
   *
   * Retorna o path repo-relativo escrito (`.hive/<rel>`) ou `null` quando o
   * clone não existe ou `rel` é inválido. LANÇA em falha de I/O (o chamador —
   * `persistLearning` — converte em perda visível no card, US-F2.6).
   */
  mutateHiveFile(
    projectId: string,
    rel: string,
    mutate: (prev: string | null) => string,
  ): string | null {
    if (!isSafeRel(rel) || !rel.endsWith('.md')) return null;
    const clone = path.join(this.config.projects.dir, projectId);
    if (!fs.existsSync(path.join(clone, '.git'))) return null;
    const target = path.join(clone, ProjectHiveService.HIVE_DIR, rel);
    const next = mutate(readIfExists(target));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, target);
    this.ensureIgnoreWiring(clone);
    return `${ProjectHiveService.HIVE_DIR}/${rel}`;
  }

  /**
   * US-F2.8 — lista os arquivos da colmeia do Project (`<clone>/.hive/**`)
   * como paths relativos POSIX SEM o prefixo `.hive/` (ex.: `modules/cards.md`).
   * `[]` quando o clone/colmeia não existe. É o substrato de leitura do Project Explorer.
   */
  listHiveFiles(projectId: string): string[] {
    return listFilesRecursive(this.hiveDir(projectId)).sort();
  }

  /**
   * US-F2.8 — lê um arquivo da colmeia. `rel` é relativo ao
   * `.hive/` (o shape que `listHiveFiles` devolve). Retorna `null` quando o
   * arquivo não existe OU quando `rel` tenta escapar do `.hive/` — trust
   * boundary: o path pode vir da query string do Explorer.
   */
  readHiveFile(projectId: string, rel: string): { content: string; mtime: Date } | null {
    if (!isSafeRel(rel)) return null;
    const target = path.join(this.hiveDir(projectId), rel);
    try {
      const content = fs.readFileSync(target, 'utf8');
      return { content, mtime: fs.statSync(target).mtime };
    } catch {
      return null;
    }
  }

  /** Diretório `.hive/` do clone gerenciado do Project. */
  private hiveDir(projectId: string): string {
    return path.join(this.config.projects.dir, projectId, ProjectHiveService.HIVE_DIR);
  }

  /**
   * Garante a fiação de ignore (idempotente):
   *  - `.git/info/exclude` ← `/.hive/` e `/.graphifyignore` (git não vê);
   *  - `.graphifyignore`   ← `!/.hive/` (graphify VÊ, vencendo o exclude).
   */
  private ensureIgnoreWiring(clone: string): void {
    appendMissingLines(path.join(clone, '.git', 'info', 'exclude'), [
      '# kanban-ai — colmeia materializada (US-F2.4); nunca commitar',
      '/.hive/',
      '/.graphifyignore',
    ]);
    appendMissingLines(path.join(clone, '.graphifyignore'), [
      '# kanban-ai (US-F2.4): re-inclui a colmeia no scan do graphify',
      '!/.hive/',
    ]);
  }
}

/** Trust boundary compartilhado de `rel`: nunca absoluto, nunca `..`. */
function isSafeRel(rel: string): boolean {
  return Boolean(rel) && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Lista arquivos sob `dir` como paths relativos POSIX. `[]` se não existir. */
function listFilesRecursive(dir: string, prefix = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFilesRecursive(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/** Anexa a `file` as linhas de `lines` que ainda não existem (cria se preciso). */
function appendMissingLines(file: string, lines: string[]): void {
  const current = readIfExists(file) ?? '';
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const glue = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${glue}${missing.join('\n')}\n`, 'utf8');
}
