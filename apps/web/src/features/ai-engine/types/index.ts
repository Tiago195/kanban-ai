import type { Iteration } from '@kanban-ai/shared';

/** Estado client-side do loop do AI engine. Placeholder de fundação. */
export interface AiEngineLoopView {
  storyId: string;
  running: boolean;
  iterations: Iteration[];
}
