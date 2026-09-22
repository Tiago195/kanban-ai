/**
 * US-UX.4 — specs dos helpers puros do card de projeto.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProjectKnowledgeSummary } from "@kanban-ai/shared";

import { cloneStateBadge, knowledgeFacts, modulesEmptyMessage } from "./projectCard.ts";

const fullSummary: ProjectKnowledgeSummary = {
  projectId: "p1",
  graph: { ok: true, nodes: 3510, edges: 6300 },
  wiki: { ok: true, generated: true, articles: 7 },
  memory: { ok: true, generated: true, docs: 4, learnings: 12, contested: 2 },
};

describe("cloneStateBadge", () => {
  it("falha grita (danger) e pronto confirma (ok) — sempre com rótulo textual", () => {
    assert.deepEqual(cloneStateBadge("failed"), { label: "falhou", tone: "danger" });
    assert.deepEqual(cloneStateBadge("ready"), { label: "pronto", tone: "ok" });
    assert.deepEqual(cloneStateBadge("cloning"), { label: "clonando…", tone: "warn" });
    assert.deepEqual(cloneStateBadge("pending"), { label: "pendente", tone: "warn" });
  });
});

describe("knowledgeFacts", () => {
  it("projeto totalmente indexado: contagens nas 4 facetas, contestados destacados", () => {
    const facts = knowledgeFacts({ cloneState: "ready", graphState: "ready", summary: fullSummary });
    assert.deepEqual(
      facts.map((f) => [f.key, f.value, f.tone]),
      [
        ["clone", "pronto", "ok"],
        ["graph", "3510 nós · 6300 arestas", "ok"],
        ["wiki", "7 artigos", "ok"],
        ["memory", "12 aprendizados · 2 contestados", "warn"],
      ],
    );
  });

  it("grafo FALHOU: fato danger com a causa — nunca idêntico ao indexado", () => {
    const facts = knowledgeFacts({
      cloneState: "ready",
      graphState: "failed",
      summary: {
        ...fullSummary,
        graph: { ok: false, graphState: "failed", error: "build do grafo falhou: sem espaço" },
      },
    });
    const graph = facts.find((f) => f.key === "graph");
    assert.deepEqual(graph, {
      key: "graph",
      icon: "🕸️",
      label: "Grafo",
      value: "falhou",
      tone: "danger",
      detail: "build do grafo falhou: sem espaço",
    });
  });

  it("wiki/memória ainda não existem: estado vazio honesto (muted), não erro", () => {
    const facts = knowledgeFacts({
      cloneState: "ready",
      graphState: "pending",
      summary: {
        projectId: "p1",
        graph: { ok: false, graphState: "pending", error: "grafo ainda não construído" },
        wiki: { ok: true, generated: false, articles: 0 },
        memory: { ok: true, generated: false, docs: 0, learnings: 0, contested: 0 },
      },
    });
    assert.deepEqual(
      facts.map((f) => [f.key, f.value, f.tone]),
      [
        ["clone", "pronto", "ok"],
        ["graph", "ainda não construído", "muted"],
        ["wiki", "ainda não gerada", "muted"],
        ["memory", "nada aprendido ainda", "muted"],
      ],
    );
  });

  it("sidecar fora: wiki/memória 'indisponível' (danger) com causa — falha visível", () => {
    const facts = knowledgeFacts({
      cloneState: "ready",
      graphState: "ready",
      summary: {
        projectId: "p1",
        graph: { ok: false, graphState: "ready", error: "graphify inacessível" },
        wiki: { ok: false, error: "graphify inacessível" },
        memory: { ok: false, error: "graphify inacessível" },
      },
    });
    const wiki = facts.find((f) => f.key === "wiki");
    const memory = facts.find((f) => f.key === "memory");
    assert.deepEqual([wiki?.value, wiki?.tone, wiki?.detail], ["indisponível", "danger", "graphify inacessível"]);
    assert.deepEqual([memory?.value, memory?.tone], ["indisponível", "danger"]);
  });

  it("grafo construído mas sidecar fora: 'indisponível' (danger) — não 'ainda não construído'", () => {
    const facts = knowledgeFacts({
      cloneState: "ready",
      graphState: "ready",
      summary: {
        projectId: "p1",
        graph: { ok: false, graphState: "ready", error: "graphify inacessível" },
        wiki: { ok: true, generated: true, articles: 2 },
        memory: { ok: true, generated: false, docs: 0, learnings: 0, contested: 0 },
      },
    });
    const graph = facts.find((f) => f.key === "graph");
    assert.deepEqual([graph?.value, graph?.tone, graph?.detail], ["indisponível", "danger", "graphify inacessível"]);
  });

  it("resumo ainda carregando: degrada para '…' mudo — a faixa nunca some", () => {
    const facts = knowledgeFacts({ cloneState: "cloning", graphState: "pending", summary: undefined });
    assert.deepEqual(
      facts.map((f) => [f.key, f.value, f.tone]),
      [
        ["clone", "clonando…", "warn"],
        ["graph", "…", "muted"],
        ["wiki", "…", "muted"],
        ["memory", "…", "muted"],
      ],
    );
  });

  it("grafo construindo: warn com rótulo, mesmo sem contagens", () => {
    const facts = knowledgeFacts({ cloneState: "ready", graphState: "building", summary: undefined });
    const graph = facts.find((f) => f.key === "graph");
    assert.deepEqual([graph?.value, graph?.tone], ["construindo…", "warn"]);
  });

  it("singular/plural: 1 artigo, 1 aprendizado, 1 contestado", () => {
    const facts = knowledgeFacts({
      cloneState: "ready",
      graphState: "ready",
      summary: {
        projectId: "p1",
        graph: { ok: true, nodes: 1, edges: 0 },
        wiki: { ok: true, generated: true, articles: 1 },
        memory: { ok: true, generated: true, docs: 1, learnings: 1, contested: 1 },
      },
    });
    assert.equal(facts.find((f) => f.key === "wiki")?.value, "1 artigo");
    assert.equal(facts.find((f) => f.key === "memory")?.value, "1 aprendizado · 1 contestado");
  });
});

describe("modulesEmptyMessage (BUG-UI2)", () => {
  it("clone ready: zero módulos é resultado legítimo — NÃO sugere problema de clone", () => {
    const msg = modulesEmptyMessage("ready");
    assert.match(msg, /nenhum módulo detectado/);
    assert.doesNotMatch(msg, /não clonado/);
  });

  it("clone não-ready: aponta o clone como causa, com o estado real", () => {
    assert.equal(
      modulesEmptyMessage("cloning"),
      "nenhum — o clone ainda não está pronto (estado: clonando…)",
    );
    assert.equal(
      modulesEmptyMessage("failed"),
      "nenhum — o clone ainda não está pronto (estado: falhou)",
    );
  });
});
