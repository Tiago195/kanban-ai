import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerEvent } from '@kanban-ai/shared';
import type { RealtimeService } from '../../realtime/realtime.service';
import { MemoryEventsService } from './memory-events.service';

// --- MemoryEventsService: broadcast tipado dos memory.* (EP-81, US-204) ---
//
// Verifica que cada transicao de memoria vira o ServerEvent correto no hub WS.

function makeSpy() {
  const sent: ServerEvent[] = [];
  const realtime = { broadcast: (e: ServerEvent) => sent.push(e) } as unknown as RealtimeService;
  return { events: new MemoryEventsService(realtime), sent };
}

test('locked() emite memory.locked com path/headCommit/owner', () => {
  const { events, sent } = makeSpy();
  events.locked('n.md', 'sha1', 'ai:s1');
  assert.deepEqual(sent[0], {
    type: 'memory.locked',
    path: 'n.md',
    headCommit: 'sha1',
    owner: 'ai:s1',
  });
});

test('released() emite memory.released', () => {
  const { events, sent } = makeSpy();
  events.released('n.md', 'sha2', 'human:tiago');
  assert.deepEqual(sent[0], {
    type: 'memory.released',
    path: 'n.md',
    headCommit: 'sha2',
    owner: 'human:tiago',
  });
});

test('updated() emite memory.updated com agentId', () => {
  const { events, sent } = makeSpy();
  events.updated('n.md', 'sha3', 'ai:s9');
  assert.deepEqual(sent[0], {
    type: 'memory.updated',
    path: 'n.md',
    headCommit: 'sha3',
    agentId: 'ai:s9',
  });
});

test('conflict() emite memory.conflict carregando o payload', () => {
  const { events, sent } = makeSpy();
  const conflict = {
    path: 'n.md',
    baseCommit: 'base',
    ours: { ref: 'a', content: '# a' },
    theirs: { ref: 'b', content: '# b' },
    holder: 'ai:s1',
  };
  events.conflict(conflict);
  assert.deepEqual(sent[0], { type: 'memory.conflict', conflict });
});

test('review() emite memory.review carregando o item', () => {
  const { events, sent } = makeSpy();
  const item = {
    path: 'n.md',
    baseCommit: 'base',
    reason: 'out-of-scope' as const,
    holder: 'ai:s1',
  };
  events.review(item);
  assert.deepEqual(sent[0], { type: 'memory.review', item });
});
