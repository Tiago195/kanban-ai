/**
 * US-F4.2 — helpers PUROS da tela de grafo (agrupamento por comunidade e
 * layout radial do ego-grafo do modo `focus`). Sem dependência: com ≤150 nós
 * (corte do servidor, US-F4.1) um force-directed de lib nova vira um novelo
 * ilegível; a navegação primária é LISTA agrupada, e o único desenho é o
 * ego-grafo do focus (~30 nós), onde um layout radial determinístico (anéis
 * por distância BFS) é legível e cabe em trigonometria de colégio.
 */

import type {
  GraphCommunitySummary,
  GraphProjectionEdge,
  GraphProjectionNode,
} from '@kanban-ai/shared';

export interface CommunityGroup {
  community: number | null;
  communityName: string | null;
  nodes: GraphProjectionNode[];
}

/**
 * Agrupa os nós por comunidade — grupos ordenados pelo nó mais conectado
 * (o "esqueleto" primeiro), nós de cada grupo por grau desc.
 */
export function groupNodesByCommunity(nodes: GraphProjectionNode[]): CommunityGroup[] {
  const byId = new Map<string, CommunityGroup>();
  for (const node of nodes) {
    const key = node.community == null ? '∅' : String(node.community);
    let group = byId.get(key);
    if (!group) {
      group = { community: node.community, communityName: node.communityName, nodes: [] };
      byId.set(key, group);
    }
    if (!group.communityName && node.communityName) group.communityName = node.communityName;
    group.nodes.push(node);
  }
  const groups = [...byId.values()];
  for (const g of groups) g.nodes.sort((a, b) => b.degree - a.degree);
  groups.sort((a, b) => (b.nodes[0]?.degree ?? 0) - (a.nodes[0]?.degree ?? 0));
  return groups;
}

export interface RadialPosition {
  node: GraphProjectionNode;
  x: number;
  y: number;
  /** Distância BFS do focus (0 = o próprio focus). */
  ring: number;
}

/**
 * Layout radial do ego-grafo: focus no centro, demais nós em anéis pela
 * distância BFS (arestas tratadas como não-direcionadas). Determinístico
 * (ordenado por comunidade+label dentro do anel) — nada de física/aleatório.
 * Nó desconectado do focus (não deveria acontecer numa vizinhança BFS do
 * servidor, mas defensivo) cai no anel mais externo.
 */
export function radialLayout(
  nodes: GraphProjectionNode[],
  edges: GraphProjectionEdge[],
  focusId: string,
  size: number,
): RadialPosition[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.source)!.push(e.target);
    adjacency.get(e.target)!.push(e.source);
  }
  const ringOf = new Map<string, number>([[focusId, 0]]);
  let frontier = [focusId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (!ringOf.has(neighbor)) {
          ringOf.set(neighbor, (ringOf.get(id) ?? 0) + 1);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  const known = nodes.filter((n) => ringOf.has(n.id));
  const maxKnown = Math.max(0, ...known.map((n) => ringOf.get(n.id)!));
  // Nó sem caminho até o focus = artefato do teto de arestas do servidor
  // (truncated) — entra no anel BFS mais externo em vez de ganhar um anel
  // extra (que criava uma banda vazia e enganava sobre a distância real).
  const orphanRing = Math.max(1, maxKnown);
  const maxRing = orphanRing;

  const byRing = new Map<number, GraphProjectionNode[]>();
  for (const node of nodes) {
    const ring = node.id === focusId ? 0 : (ringOf.get(node.id) ?? orphanRing);
    if (!byRing.has(ring)) byRing.set(ring, []);
    byRing.get(ring)!.push(node);
  }

  const center = size / 2;
  // 110px de folga: os labels do anel externo saem RADIAIS (sunburst) e
  // precisam de uma banda própria para não serem clipados pelo viewBox.
  const step = (size / 2 - 110) / maxRing;
  const out: RadialPosition[] = [];
  for (const [ring, ringNodes] of byRing) {
    ringNodes.sort((a, b) =>
      a.community === b.community
        ? a.label.localeCompare(b.label)
        : (a.community ?? -1) - (b.community ?? -1),
    );
    ringNodes.forEach((node, index) => {
      if (ring === 0) {
        out.push({ node, x: center, y: center, ring });
        return;
      }
      // -π/2 começa no topo; offset por anel evita labels colineares entre anéis.
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / ringNodes.length + ring * 0.35;
      out.push({
        node,
        x: center + Math.cos(angle) * step * ring,
        y: center + Math.sin(angle) * step * ring,
        ring,
      });
    });
  }
  return out;
}

/**
 * Cor estável por comunidade (ângulo áureo sobre o matiz — 255 comunidades não
 * cabem numa paleta fixa). Saturação/luminosidade fixas legíveis no tema escuro.
 *
 * US-UX.2 — `lightness` opcional: a BARRA proporcional usa 70% porque o rótulo
 * escuro (#16181d) sobre 58% media 4.05:1 nos matizes escuros (azul/violeta),
 * abaixo dos 4.5:1 de AA — e branco também reprova nesses mesmos fills (4.38:1),
 * então trocar só a cor do texto não resolve. Em 70% o pior matiz (h=240) dá
 * 5.61:1 com o texto escuro; bolhas/nós seguem no default 58% para manter a
 * correlação visual barra↔bolha pelo MATIZ, que não muda.
 */
export function communityColor(community: number | null, lightness = 58): string {
  if (community == null) return 'hsl(0, 0%, 55%)';
  return `hsl(${Math.round((community * 137.508) % 360)}, 55%, ${lightness}%)`;
}

/** Raio do nó no ego-grafo: escala √grau, contida em [5, 16]. */
export function nodeRadius(degree: number): number {
  return Math.min(16, Math.max(5, Math.round(3 + Math.sqrt(Math.max(0, degree)) * 1.6)));
}

// ── US-UX.2 — a visão padrão vira GRAFO (mapa de comunidades + esqueleto) ────

/**
 * US-UX.2 — separa o "ruído documental" (headings de CHANGELOG/README etc.,
 * `type === 'document'` do graphify) do esqueleto do sistema. O filtro é
 * REVERSÍVEL e VISÍVEL na UI: nada some em silêncio — a UI mostra quantos nós
 * estão ocultos e o botão para exibi-los.
 */
export function partitionDocumentNoise(nodes: GraphProjectionNode[]): {
  visible: GraphProjectionNode[];
  hidden: GraphProjectionNode[];
} {
  const visible: GraphProjectionNode[] = [];
  const hidden: GraphProjectionNode[] = [];
  for (const node of nodes) (node.type === 'document' ? hidden : visible).push(node);
  return { visible, hidden };
}

export interface CommunityBarSegment {
  /** null = segmento agregado "outras N comunidades" (não navegável). */
  id: number | null;
  name: string | null;
  size: number;
  /** Fração 0..1 do total de nós do grafo COMPLETO — largura do segmento. */
  fraction: number;
}

/**
 * US-UX.2 — mapa proporcional de comunidades: cada segmento tem largura
 * proporcional ao número de nós no grafo COMPLETO ("Change Log domina com
 * 30 de 84" precisa ser visível de relance, não um número entre parênteses).
 * Acima de `maxSegments`, a cauda vira UM segmento agregado — o drill-down
 * de todas as comunidades continua na lista paginada.
 */
export function communityBar(
  communities: GraphCommunitySummary[],
  maxSegments = 14,
): CommunityBarSegment[] {
  const total = communities.reduce((sum, c) => sum + c.size, 0);
  if (total === 0) return [];
  const sorted = [...communities].sort((a, b) => b.size - a.size);
  const head = sorted.length > maxSegments ? sorted.slice(0, maxSegments - 1) : sorted;
  const tail = sorted.slice(head.length);
  const segments: CommunityBarSegment[] = head.map((c) => ({
    id: c.id,
    name: c.name,
    size: c.size,
    fraction: c.size / total,
  }));
  if (tail.length > 0) {
    const size = tail.reduce((sum, c) => sum + c.size, 0);
    segments.push({
      id: null,
      name: `outras ${tail.length} comunidades`,
      size,
      fraction: size / total,
    });
  }
  return segments;
}

export interface ClusterBubble {
  community: number | null;
  name: string | null;
  cx: number;
  cy: number;
  r: number;
  /** Nós projetados DENTRO da bolha (após o filtro de ruído da UI). */
  count: number;
}

export interface ClusterLayout {
  width: number;
  height: number;
  bubbles: ClusterBubble[];
  positions: { node: GraphProjectionNode; x: number; y: number }[];
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * US-UX.2 — layout do esqueleto: uma bolha por comunidade (área ∝ nº de nós
 * projetados), bolhas empacotadas por espiral gulosa determinística (maiores
 * no centro), nós dentro da bolha em phyllotaxis (mais conectado no centro).
 * Sem física, sem aleatório, sem lib — mesmo espírito do `radialLayout`.
 * Coordenadas normalizadas para começar em (0,0); `width`/`height` viram o
 * viewBox do SVG. O(n) nos nós; a espiral é limitada e ≤150 nós é o teto real.
 */
export function clusterLayout(nodes: GraphProjectionNode[]): ClusterLayout {
  const groups = groupNodesByCommunity(nodes);
  // Maiores primeiro: empacotamento melhor e as comunidades dominantes no centro.
  const bySize = [...groups].sort((a, b) => b.nodes.length - a.nodes.length);

  // c ≈ distância entre vizinhos na phyllotaxis; precisa comportar 2 nós de
  // raio máximo (nodeRadius ≤ 16) lado a lado sem sobreposição feia.
  const spacing = 24;
  const placed: { cx: number; cy: number; r: number; group: CommunityGroup }[] = [];
  for (const group of bySize) {
    const r = Math.max(36, spacing * Math.sqrt(group.nodes.length) + 16);
    if (placed.length === 0) {
      placed.push({ cx: 0, cy: 0, r, group });
      continue;
    }
    // Espiral a partir do centro: primeira posição sem sobreposição vence.
    // Espiral ELÍPTICA (x esticado): a área do grafo é paisagem (tela cheia,
    // US-UX.1) — um empacotamento circular deixava bandas vazias dos lados.
    for (let step = 0; step < 4000; step++) {
      const angle = placed.length * GOLDEN_ANGLE + step * 0.3;
      const dist = 8 + step * 5;
      const cx = Math.cos(angle) * dist * 1.9;
      const cy = Math.sin(angle) * dist;
      if (placed.every((p) => Math.hypot(p.cx - cx, p.cy - cy) >= p.r + r + 12)) {
        placed.push({ cx, cy, r, group });
        break;
      }
    }
  }

  if (placed.length === 0) return { width: 0, height: 0, bubbles: [], positions: [] };
  // Caixa JUSTA em volta das bolhas (margem extra no topo para o rótulo).
  const margin = 10;
  const minX = Math.min(...placed.map((p) => p.cx - p.r)) - margin;
  const minY = Math.min(...placed.map((p) => p.cy - p.r)) - margin - 8;
  const maxX = Math.max(...placed.map((p) => p.cx + p.r)) + margin;
  const maxY = Math.max(...placed.map((p) => p.cy + p.r)) + margin;

  const bubbles: ClusterBubble[] = [];
  const positions: ClusterLayout['positions'] = [];
  for (const p of placed) {
    bubbles.push({
      community: p.group.community,
      name: p.group.communityName,
      cx: p.cx - minX,
      cy: p.cy - minY,
      r: p.r,
      count: p.group.nodes.length,
    });
    // Nós já vêm por grau desc do groupNodesByCommunity: o hub fica no centro.
    p.group.nodes.forEach((node, index) => {
      const rad = spacing * 0.55 * Math.sqrt(index);
      const angle = index * GOLDEN_ANGLE;
      positions.push({
        node,
        x: p.cx - minX + Math.cos(angle) * rad,
        y: p.cy - minY + Math.sin(angle) * rad,
      });
    });
  }
  return { width: maxX - minX, height: maxY - minY, bubbles, positions };
}
