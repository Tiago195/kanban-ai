/**
 * US-UX.1 — máquina de estados PURA do roteamento da "moldura" do Explorador.
 *
 * A camada de conhecimento (Projetos · O que a AI sabe · Grafo · Wiki) virou
 * página inteira e ENDEREÇÁVEL: `/explorer/:projectId/:area`. Este módulo
 * resolve `(projectId, área)` a partir dos params da URL + lista de projetos,
 * escolhe defaults sensatos quando falta algo, e garante os dois invariantes
 * de contexto: trocar de área mantém o projeto; trocar de projeto mantém a
 * área. Sem DOM e sem dependência — mesmo padrão das US-F4.2/F4.3/F5.4
 * (`graphView.ts`/`fileCards.ts`/`wikiView.ts`): a lógica é testável offline
 * e o componente só projeta o resultado.
 */

/** As 4 áreas do rail. "projects" absorve a antiga aba "Repositório" (o
 *  metadado do clone é do projeto selecionado — vive na área Projetos). */
export const EXPLORER_AREAS = ['projects', 'memory', 'graph', 'wiki'] as const;
export type ExplorerArea = (typeof EXPLORER_AREAS)[number];

/** Área default quando a URL não diz nada: a porta de entrada da camada. */
export const DEFAULT_EXPLORER_AREA: ExplorerArea = 'projects';

export function isExplorerArea(value: string | null | undefined): value is ExplorerArea {
  return (EXPLORER_AREAS as readonly string[]).includes(value ?? '');
}

/** URL canônica de `(projeto, área)` — recarregar/colar o link volta aqui. */
export function explorerPath(projectId: string, area: ExplorerArea): string {
  return `/explorer/${projectId}/${area}`;
}

/**
 * US-UX.5 — deep link de um artigo da Wiki: `/explorer/:projectId/wiki/:slug`
 * (slug `null` = a home da wiki, sem segmento extra). Extensão coerente da
 * URL canônica da moldura: F5/colar o link reabre o MESMO artigo.
 */
export function wikiArticlePath(projectId: string, slug: string | null): string {
  const base = explorerPath(projectId, 'wiki');
  return slug ? `${base}/${encodeURIComponent(slug)}` : base;
}

/** Trocar de área MANTÉM o projeto (contexto persistente da moldura). */
export function switchAreaPath(current: { projectId: string }, area: ExplorerArea): string {
  return explorerPath(current.projectId, area);
}

/** Trocar de projeto MANTÉM a área (contexto persistente da moldura). */
export function switchProjectPath(current: { area: ExplorerArea }, projectId: string): string {
  return explorerPath(projectId, current.area);
}

export type ExplorerRoute =
  /** Lista de projetos ainda não chegou — nada a resolver. */
  | { kind: 'loading'; area: ExplorerArea }
  /** Zero projetos: a moldura abre na área resolvida (Projetos permite criar). */
  | { kind: 'no-projects'; area: ExplorerArea }
  /** URL incompleta/inválida — o chamador deve navegar (replace) para `path`. */
  | { kind: 'redirect'; path: string; projectId: string; area: ExplorerArea }
  /** URL canônica: projeto existe e área é válida. */
  | { kind: 'ready'; projectId: string; area: ExplorerArea };

/**
 * Resolve a rota da moldura:
 * - área ausente/inválida → `DEFAULT_EXPLORER_AREA` (e a URL é corrigida);
 * - projeto ausente/inexistente → o projeto do quadro (se estiver na lista),
 *   senão o primeiro da lista — e a URL é corrigida para refletir a escolha;
 * - tudo válido → `ready` (F5/link colado leva ao MESMO lugar).
 */
export function resolveExplorerRoute(args: {
  projectIdParam: string | null;
  areaParam: string | null;
  projectsLoaded: boolean;
  projectIds: string[];
  boardProjectId: string | null;
}): ExplorerRoute {
  const { projectIdParam, areaParam, projectsLoaded, projectIds, boardProjectId } = args;
  const area = isExplorerArea(areaParam) ? areaParam : DEFAULT_EXPLORER_AREA;

  if (!projectsLoaded) return { kind: 'loading', area };
  if (projectIds.length === 0) return { kind: 'no-projects', area };

  const validParam =
    projectIdParam && projectIds.includes(projectIdParam) ? projectIdParam : null;
  const projectId =
    validParam ??
    (boardProjectId && projectIds.includes(boardProjectId) ? boardProjectId : projectIds[0]);

  if (validParam && isExplorerArea(areaParam)) return { kind: 'ready', projectId, area };
  return { kind: 'redirect', path: explorerPath(projectId, area), projectId, area };
}
