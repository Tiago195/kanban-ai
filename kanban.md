# backlog

<!-- Stories de correção derivadas do QA rodada 2 (2026-08-06). Prioridade: 🔴 crítico > 🟠 alto > 🟡 médio > 🟢 baixo -->

- [ ] Precisamos melhorar o chat de conversa do backlog-chat

- [ ] tentar disponibilizar tudo em docker

- [ ] Gravar um video de como usar a ferramenta
# in progress



# done
<!-- apenas ultimas 2 tarefas, para n poluir o arquivo -->

- [x] 🟠 **Tasks estruturadas clicáveis no chat da story (paridade com backlog-chat)** — **CONCLUÍDO 2026-08-11 (build+lint verdes; 26/26 specs backlog-chat)**
  - **Problema:** o chat da story emitia as tasks como **texto puro**; queríamos o MESMO comportamento do backlog-chat (cartão com tasks clicáveis → thread dedicada por task para refinar só ela).
  - **Protocolo `KANBAN_TASKS`/`KANBAN_TASKS_PATCH`** (espelha `KANBAN_BACKLOG`) em `packages/shared` (`BacklogTaskProposal`/`Item`/`Patch`, markers, evento WS `backlog.task_proposal`).
  - **Adapter** (`docker/copilot-cli-adapter.mjs`): extrai os blocos em `emitTerminalEvents` (patch antes de proposta) → `{kind:'task_proposal'|'task_patch'}`; blocos suprimidos do transcript.
  - **Runner/Orchestrator:** handlers `onTaskProposal`/`onTaskPatch`; `getCurrentTaskProposal`, `persistTaskProposal` (ids estáveis + `version`), `applyTaskPatch` (ops JSON-Patch cirúrgicas), `resolveFocusTask` (canal `task:<id>`); prompt injeta `KANBAN_TASKS`/`focusTask`/`currentTaskProposalJson`. **Persistência SEM migração** (reusa `BacklogChatMessage.proposal`).
  - **Front:** `TaskProposalCard` (espelha `ProposalCard`) render via `renderMessageBody` no `StoryChatSheet`; clique → thread `task:<id>`; "Materializar em To Do" usa os títulos da proposta corrente (textarea manual removida); `openStorySession` devolve a `taskProposal` corrente semeada no store. ADR-0026 (adendo).

- [x] 🟠 **Épico: Story sem tasks → In Progress (Caminho E + A) + rastreio Card↔Session** — **CONCLUÍDO 2026-08-10 (fleet: 4 tarefas; build+lint verdes; 62/62 specs backlog-chat+ai-engine)**
  - **US Caminho E — badge "Precisa de você" no board:** o backend já marcava `needsHuman`/`needsHumanReason` + broadcast `card.needs_human`; o gap real era que o **`StoryCardContent`** (card de story no board principal) **não exibia o badge** (só o `MiniCardContent` exibia) — por isso "nada aparecia" ao puxar a story para In Progress. Adicionado o badge com o motivo acionável em `apps/web/src/features/board/components/BoardView.tsx`; clicar no card abre o `StoryModal` (que hospeda o "💬 Chat da história"). `useRealtime` já invalida `card`/`cards`/`loopState` no evento → re-render sem F5.
  - **US Chat da story (Caminho A) + rastreio:** criado `Card.backlogChatSessionId` (migration `20260810182331_card_backlog_chat_session`, aplicada) preenchido no `apply` para épico/story/task; endpoints `POST /backlog-chat/story/:storyId/session` (reusa a sessão original se a story veio de backlog-chat, senão cria zerada) e `POST /backlog-chat/story/:storyId/tasks` (materializa tasks incrementais em To Do + limpa `needsHuman`). Threads por task (`task:<id>`) em `packages/shared`. UI `StoryChatSheet`/`useStoryChat` + botão "💬 Chat da história" no `StoryModal`. ADR-0026.
  - **US Modal ao aprovar épico:** em `BacklogChatView.tsx`, ao aprovar, se houver stories sem tasks abre modal (Dialog) listando-as com "Criar tasks agora" (abre o chat/thread da story) ou "Aprovar mesmo assim" (com alerta do que acontece). Se todas têm tasks, aplica direto.
  - **BUG tasks fantasma (sessão applied):** o guard do `apply` total continua bloqueando reaplicação; em sessão `applied` o "✨ Sugerir tasks" virou **"✨ Materializar tasks"** e redireciona ao `StoryChatSheet`, que cria cards reais via `/story/:id/tasks` (sem duplicar épico/stories) e invalida o board. "Aprovar" fica oculto em `applied`. Novo `resolveAppliedStoryCard(sessionId, title)` liga a story da proposta à story-card real do board.
  - **FOLLOW-UP (2026-08-11) — 2 bugs do chat da story:** (1) **clique fechava tudo:** o overlay `modal-layer` fechava com qualquer clique borbulhado; como o `StoryChatSheet` (Radix Sheet em portal) é filho JSX do `StoryModal`, os eventos React sobem a árvore até o overlay. Fix: guard `backdropClose` (`event.target === event.currentTarget`) em todos os `modal-layer` de `BoardView.tsx` + os 2 de `App.tsx`. (2) **chat abria sem conhecer a story** (PO perguntava "qual é a história?"): sessão de story manual/zerada (Caminho B) não tinha history/proposta/focus. Fix: `resolveStoryCardContext(sessionId)` no orchestrator (resolve a única story-card vinculada via `Card.backlogChatSessionId`, com DoD/épico/tasks existentes) injetada como `storyCard` no `buildBacklogPrompt`, que agora renderiza o bloco "CHAT DE UMA STORY QUE JÁ EXISTE" instruindo o PO a **não** perguntar e já decompor em tasks. +4 specs (22/22 backlog-chat verdes); build+lint verdes.
