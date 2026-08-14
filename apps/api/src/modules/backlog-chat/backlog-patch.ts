import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { STORY_POINTS } from '@kanban-ai/shared';
import type {
  BacklogProposal,
  BacklogProposalPatch,
  BacklogProposalStory,
  BacklogProposalTask,
  StoryPoints,
} from '@kanban-ai/shared';

const POINT_SET = new Set<number>(STORY_POINTS as readonly number[]);

/**
 * Aplica um PATCH cirúrgico sobre a proposta corrente e devolve uma NOVA
 * proposta (imutável) com `version = base.version + 1`.
 *
 * Só toca nos paths solicitados; valida cada op (path permitido, points
 * Fibonacci). Estilo JSON Pointer sobre um shape fixo — não é um JSON Patch
 * genérico (recusa paths fora do contrato de `BacklogProposal`).
 */
export function applyBacklogPatch(
  base: BacklogProposal,
  patch: BacklogProposalPatch,
): BacklogProposal {
  if (patch.baseVersion !== base.version) {
    throw new BadRequestException(
      `patch baseVersion=${patch.baseVersion} não corresponde à versão corrente=${base.version}`,
    );
  }

  // Cópia profunda simples (proposta é JSON puro).
  const next: BacklogProposal = JSON.parse(JSON.stringify(base));

  for (const op of patch.ops) {
    applyOp(next, op);
  }

  next.version = base.version + 1;
  return next;
}

function applyOp(
  proposal: BacklogProposal,
  op: BacklogProposalPatch['ops'][number],
): void {
  const path = op.path;

  // ── Epic ──────────────────────────────────────────────────────────────────
  if (path === '/epic/title') {
    proposal.epic.title = requireString(op.value, path);
    return;
  }
  if (path === '/epic/description') {
    proposal.epic.description = requireString(op.value, path);
    return;
  }
  if (path === '/epic/points') {
    proposal.epic.points = requirePoints(op.value, path);
    return;
  }
  if (path === '/epic/aiProject') {
    proposal.epic.aiProject = requireString(op.value, path);
    return;
  }
  if (path === '/epic/aiSummary') {
    proposal.epic.aiSummary = requireString(op.value, path);
    return;
  }
  if (path === '/epic/aiNotes') {
    proposal.epic.aiNotes = requireString(op.value, path);
    return;
  }

  // ── Stories: add/remove ─────────────────────────────────────────────────────
  if (path === '/stories/-') {
    if (op.op !== 'add') {
      throw new BadRequestException(`path ${path} só aceita op=add`);
    }
    proposal.stories.push(requireStory(op.value, path));
    return;
  }

  // ── Tasks de uma story: add/remove/replace item + replace do array inteiro ──
  const taskAddMatch = /^\/stories\/(\d+)\/tasks\/-$/.exec(path);
  if (taskAddMatch) {
    if (op.op !== 'add') {
      throw new BadRequestException(`path ${path} só aceita op=add`);
    }
    const idx = Number(taskAddMatch[1]);
    ensureStoryIndex(proposal, idx, path);
    const story = proposal.stories[idx];
    if (!story.tasks) story.tasks = [];
    story.tasks.push(requireTask(op.value, path));
    return;
  }

  const taskItemMatch = /^\/stories\/(\d+)\/tasks\/(\d+)$/.exec(path);
  if (taskItemMatch) {
    const sIdx = Number(taskItemMatch[1]);
    const tIdx = Number(taskItemMatch[2]);
    ensureStoryIndex(proposal, sIdx, path);
    const story = proposal.stories[sIdx];
    const tasks = story.tasks ?? [];
    if (op.op === 'remove') {
      ensureTaskIndex(tasks, tIdx, path);
      tasks.splice(tIdx, 1);
      story.tasks = tasks;
      return;
    }
    if (op.op === 'replace') {
      ensureTaskIndex(tasks, tIdx, path);
      const existingId = tasks[tIdx].id; // preserva id estável da task
      const replacement = requireTask(op.value, path);
      tasks[tIdx] = { ...replacement, id: existingId ?? replacement.id };
      story.tasks = tasks;
      return;
    }
    if (op.op === 'add') {
      tasks.splice(tIdx, 0, requireTask(op.value, path));
      story.tasks = tasks;
      return;
    }
  }

  const tasksArrayMatch = /^\/stories\/(\d+)\/tasks$/.exec(path);
  if (tasksArrayMatch) {
    const idx = Number(tasksArrayMatch[1]);
    ensureStoryIndex(proposal, idx, path);
    if (op.op === 'remove') {
      proposal.stories[idx].tasks = [];
      return;
    }
    proposal.stories[idx].tasks = requireTaskArray(op.value, path);
    return;
  }

  const storyMatch =
    /^\/stories\/(\d+)(\/(title|description|aiSummary|aiNotes|points|dod|affectedFlows))?$/.exec(path);
  if (storyMatch) {
    const idx = Number(storyMatch[1]);
    const field = storyMatch[3];

    if (op.op === 'remove' && !field) {
      ensureStoryIndex(proposal, idx, path);
      proposal.stories.splice(idx, 1);
      return;
    }
    if (op.op === 'add' && !field) {
      // Inserção posicional (raro): insere antes do índice.
      proposal.stories.splice(idx, 0, requireStory(op.value, path));
      return;
    }
    if (op.op === 'replace' && !field) {
      ensureStoryIndex(proposal, idx, path);
      // Preserva o id estável da story existente (a âncora da thread story:<id>
      // não pode mudar por um replace posicional). Ver ADR-0023.
      const existingId = proposal.stories[idx].id;
      const replacement = requireStory(op.value, path);
      proposal.stories[idx] = { ...replacement, id: existingId ?? replacement.id };
      return;
    }
    // Campo específico da story.
    ensureStoryIndex(proposal, idx, path);
    const story = proposal.stories[idx];
    if (field === 'title') {
      story.title = requireString(op.value, path);
      return;
    }
    if (field === 'description') {
      story.description = requireString(op.value, path);
      return;
    }
    if (field === 'aiSummary') {
      story.aiSummary = requireString(op.value, path);
      return;
    }
    if (field === 'aiNotes') {
      story.aiNotes = requireString(op.value, path);
      return;
    }
    if (field === 'points') {
      story.points = requirePoints(op.value, path);
      return;
    }
    if (field === 'dod') {
      if (op.op === 'remove') {
        story.dod = [];
        return;
      }
      story.dod = requireStringArray(op.value, path);
      return;
    }
    if (field === 'affectedFlows') {
      if (op.op === 'remove') {
        story.affectedFlows = [];
        return;
      }
      story.affectedFlows = requireFlowArray(op.value, path);
      return;
    }
  }

  throw new BadRequestException(`path de patch não permitido: ${path}`);
}

function ensureStoryIndex(
  proposal: BacklogProposal,
  idx: number,
  path: string,
): void {
  if (!Number.isInteger(idx) || idx < 0 || idx >= proposal.stories.length) {
    throw new BadRequestException(
      `índice de story fora do intervalo em ${path} (stories: ${proposal.stories.length})`,
    );
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`valor de ${path} deve ser string`);
  }
  return value;
}

function requirePoints(value: unknown, path: string): StoryPoints {
  if (typeof value !== 'number' || !POINT_SET.has(value)) {
    throw new BadRequestException(
      `valor de ${path} deve ser Fibonacci ∈ {${STORY_POINTS.join(', ')}}`,
    );
  }
  return value as StoryPoints;
}

function requireStory(value: unknown, path: string): BacklogProposalStory {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestException(`valor de ${path} deve ser um objeto story`);
  }
  const o = value as Record<string, unknown>;
  const title = requireString(o.title, `${path}/title`);
  // A IA emite stories sem id; o backend atribui um id estável ao adicionar.
  // Se um id vier (ex.: story já existente sendo movida), preserva-o.
  const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : randomUUID();
  const story: BacklogProposalStory = { id, title };
  if (o.description !== undefined) {
    story.description = requireString(o.description, `${path}/description`);
  }
  if (o.aiSummary !== undefined) {
    story.aiSummary = requireString(o.aiSummary, `${path}/aiSummary`);
  }
  if (o.aiNotes !== undefined) {
    story.aiNotes = requireString(o.aiNotes, `${path}/aiNotes`);
  }
  if (o.points !== undefined) {
    story.points = requirePoints(o.points, `${path}/points`);
  }
  if (o.tasks !== undefined) {
    story.tasks = requireTaskArray(o.tasks, `${path}/tasks`);
  }
  if (o.dod !== undefined) {
    story.dod = requireStringArray(o.dod, `${path}/dod`);
  }
  if (o.affectedFlows !== undefined) {
    story.affectedFlows = requireFlowArray(o.affectedFlows, `${path}/affectedFlows`);
  }
  return story;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`valor de ${path} deve ser um array de strings`);
  }
  return value.map((item, i) => requireString(item, `${path}/${i}`));
}

function requireFlowArray(
  value: unknown,
  path: string,
): { name: string; files: string[]; note?: string }[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`valor de ${path} deve ser um array de flows`);
  }
  return value.map((item, i) => requireFlow(item, `${path}/${i}`));
}

function requireFlow(
  value: unknown,
  path: string,
): { name: string; files: string[]; note?: string } {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestException(`valor de ${path} deve ser um objeto flow`);
  }
  const o = value as Record<string, unknown>;
  const name = requireString(o.name, `${path}/name`);
  const files =
    o.files === undefined ? [] : requireStringArray(o.files, `${path}/files`);
  const flow: { name: string; files: string[]; note?: string } = { name, files };
  if (o.note !== undefined) {
    flow.note = requireString(o.note, `${path}/note`);
  }
  return flow;
}

function requireTask(value: unknown, path: string): BacklogProposalTask {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestException(`valor de ${path} deve ser um objeto task`);
  }
  const o = value as Record<string, unknown>;
  const title = requireString(o.title, `${path}/title`);
  // Tasks são rascunhos; o backend atribui id estável ao adicionar.
  const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : randomUUID();
  const task: BacklogProposalTask = { id, title };
  if (o.description !== undefined) {
    task.description = requireString(o.description, `${path}/description`);
  }
  return task;
}

function requireTaskArray(value: unknown, path: string): BacklogProposalTask[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException(`valor de ${path} deve ser um array de tasks`);
  }
  return value.map((item, i) => requireTask(item, `${path}/${i}`));
}

function ensureTaskIndex(
  tasks: BacklogProposalTask[],
  idx: number,
  path: string,
): void {
  if (!Number.isInteger(idx) || idx < 0 || idx >= tasks.length) {
    throw new BadRequestException(
      `índice de task fora do intervalo em ${path} (tasks: ${tasks.length})`,
    );
  }
}
