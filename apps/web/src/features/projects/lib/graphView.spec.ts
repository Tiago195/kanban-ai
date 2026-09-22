/**
 * US-F4.2 — specs dos helpers puros da tela de grafo (agrupamento por
 * comunidade e layout radial do ego-grafo do modo focus).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GraphProjectionNode } from '@kanban-ai/shared';

import {
  clusterLayout,
  communityBar,
  communityColor,
  groupNodesByCommunity,
  nodeRadius,
  partitionDocumentNoise,
  radialLayout,
} from './graphView.ts';

function node(id: string, degree: number, community: number | null): GraphProjectionNode {
  return {
    id,
    label: id,
    type: 'code',
    sourceFile: null,
    community,
    communityName: community != null ? `c${community}` : null,
    degree,
  };
}

describe('US-F4.2 groupNodesByCommunity', () => {
  it('agrupa por comunidade, grupos e nós ordenados por grau desc', () => {
    const groups = groupNodesByCommunity([
      node('a', 3, 1),
      node('b', 9, 2),
      node('c', 5, 1),
      node('d', 1, null),
    ]);
    assert.deepEqual(
      groups.map((g) => g.community),
      [2, 1, null],
    );
    assert.deepEqual(
      groups[1].nodes.map((n) => n.id),
      ['c', 'a'],
    );
  });
});

describe('US-F4.2 radialLayout', () => {
  const nodes = [node('f', 10, 1), node('n1', 4, 1), node('n2', 3, 2), node('far', 2, 2)];
  const edges = [
    { source: 'f', target: 'n1', relation: 'calls' },
    { source: 'n2', target: 'f', relation: 'imports' }, // direção não importa
    { source: 'n1', target: 'far', relation: 'calls' },
  ];

  it('focus no centro, anéis por distância BFS não-direcionada', () => {
    const size = 640;
    const positions = radialLayout(nodes, edges, 'f', size);
    const byId = new Map(positions.map((p) => [p.node.id, p]));
    assert.equal(positions.length, nodes.length);
    assert.deepEqual(
      [byId.get('f')!.x, byId.get('f')!.y, byId.get('f')!.ring],
      [size / 2, size / 2, 0],
    );
    assert.equal(byId.get('n1')!.ring, 1);
    assert.equal(byId.get('n2')!.ring, 1);
    assert.equal(byId.get('far')!.ring, 2);
    // anel mais distante fica mais longe do centro
    const dist = (id: string) =>
      Math.hypot(byId.get(id)!.x - size / 2, byId.get(id)!.y - size / 2);
    assert.ok(dist('far') > dist('n1'));
  });

  it('nó desconectado do focus cai no anel externo (defensivo)', () => {
    const positions = radialLayout([node('f', 1, 1), node('orfao', 1, 2)], [], 'f', 640);
    const orphan = positions.find((p) => p.node.id === 'orfao')!;
    assert.ok(orphan.ring >= 1);
    assert.ok(Number.isFinite(orphan.x) && Number.isFinite(orphan.y));
  });
});

describe('US-F4.2 escalas visuais', () => {
  it('communityColor é estável e null tem cor neutra', () => {
    assert.equal(communityColor(7), communityColor(7));
    assert.notEqual(communityColor(7), communityColor(8));
    assert.equal(communityColor(null), 'hsl(0, 0%, 55%)');
  });

  // US-UX.2 — contraste AA do rótulo da barra: o texto #16181d sobre
  // hsl(h, 55%, 70%) precisa medir ≥ 4.5:1 em TODO matiz (luminância WCAG).
  it('communityColor(id, 70) dá ≥ 4.5:1 com o texto #16181d em todo matiz', () => {
    const channel = (v: number) =>
      v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    const luminance = (r: number, g: number, b: number) =>
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const hslLuminance = (h: number, s: number, l: number) => {
      const c = (1 - Math.abs(2 * l - 1)) * s;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = l - c / 2;
      const [r, g, b] =
        h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      return luminance(r + m, g + m, b + m);
    };
    const textLum = luminance(22 / 255, 24 / 255, 29 / 255); // #16181d
    for (let id = 0; id < 360; id++) {
      const match = /^hsl\((\d+), 55%, 70%\)$/.exec(communityColor(id, 70));
      assert.ok(match, `formato inesperado para id ${id}`);
      const ratio = (hslLuminance(Number(match![1]), 0.55, 0.7) + 0.05) / (textLum + 0.05);
      assert.ok(ratio >= 4.5, `matiz ${match![1]} mede ${ratio.toFixed(2)}:1`);
    }
  });

  it('nodeRadius é contido em [5, 16]', () => {
    assert.equal(nodeRadius(0), 5);
    assert.equal(nodeRadius(10_000), 16);
    assert.ok(nodeRadius(50) > nodeRadius(4));
  });
});

// ── US-UX.2 — visão padrão em grafo ─────────────────────────────────────────

describe('US-UX.2 partitionDocumentNoise', () => {
  it('separa nós document (ruído) dos demais, sem perder ninguém', () => {
    const doc: GraphProjectionNode = { ...node('h1', 1, 0), type: 'document' };
    const concept: GraphProjectionNode = { ...node('c1', 2, 1), type: 'concept' };
    const code = node('a', 3, 1);
    const { visible, hidden } = partitionDocumentNoise([doc, code, concept]);
    assert.deepEqual(hidden.map((n) => n.id), ['h1']);
    assert.deepEqual(visible.map((n) => n.id), ['a', 'c1']);
  });
});

describe('US-UX.2 communityBar', () => {
  const comm = (id: number, size: number) => ({ id, name: `c${id}`, size });

  it('frações proporcionais ao tamanho, maiores primeiro, somando 1', () => {
    const segs = communityBar([comm(1, 10), comm(0, 30), comm(2, 60)]);
    assert.deepEqual(segs.map((s) => s.id), [2, 0, 1]);
    assert.equal(segs[0].fraction, 0.6);
    assert.ok(Math.abs(segs.reduce((s, x) => s + x.fraction, 0) - 1) < 1e-9);
  });

  it('acima de maxSegments a cauda vira UM segmento agregado (id null)', () => {
    const many = Array.from({ length: 6 }, (_, i) => comm(i, 10 - i));
    const segs = communityBar(many, 4);
    assert.equal(segs.length, 4);
    const tail = segs[3];
    assert.equal(tail.id, null);
    assert.equal(tail.size, 7 + 6 + 5); // comunidades 3, 4 e 5
  });

  it('vazio para lista vazia (sem divisão por zero)', () => {
    assert.deepEqual(communityBar([]), []);
  });
});

describe('US-UX.2 clusterLayout', () => {
  const nodes = [
    node('a', 9, 0),
    node('b', 4, 0),
    node('c', 2, 0),
    node('d', 7, 1),
    node('e', 1, 1),
    node('f', 3, null),
  ];

  it('uma bolha por comunidade, todo nó posicionado DENTRO da sua bolha', () => {
    const layout = clusterLayout(nodes);
    assert.equal(layout.bubbles.length, 3);
    assert.equal(layout.positions.length, nodes.length);
    const bubbleOf = new Map(layout.bubbles.map((b) => [b.community, b]));
    for (const p of layout.positions) {
      const b = bubbleOf.get(p.node.community)!;
      assert.ok(Math.hypot(p.x - b.cx, p.y - b.cy) <= b.r, `${p.node.id} fora da bolha`);
    }
  });

  it('área da bolha cresce com o nº de nós e bolhas não se sobrepõem', () => {
    const layout = clusterLayout(nodes);
    const byCommunity = new Map(layout.bubbles.map((b) => [b.community, b]));
    assert.ok(byCommunity.get(0)!.r > byCommunity.get(1)!.r);
    for (const a of layout.bubbles) {
      for (const b of layout.bubbles) {
        if (a === b) continue;
        assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.r + b.r, 'bolhas sobrepostas');
      }
    }
  });

  it('coordenadas cabem no viewBox (width × height) e são determinísticas', () => {
    const one = clusterLayout(nodes);
    const two = clusterLayout(nodes);
    assert.deepEqual(one, two);
    for (const p of one.positions) {
      assert.ok(p.x >= 0 && p.x <= one.width && p.y >= 0 && p.y <= one.height);
    }
  });

  it('o nó mais conectado da comunidade fica no CENTRO da bolha', () => {
    const layout = clusterLayout(nodes);
    const hub = layout.positions.find((p) => p.node.id === 'a')!;
    const bubble = layout.bubbles.find((b) => b.community === 0)!;
    assert.equal(Math.round(hub.x), Math.round(bubble.cx));
    assert.equal(Math.round(hub.y), Math.round(bubble.cy));
  });

  it('lista vazia não explode', () => {
    const layout = clusterLayout([]);
    assert.deepEqual(layout.bubbles, []);
    assert.deepEqual(layout.positions, []);
  });
});
