# ADR-0024 — Stories ricas + tasks rascunhadas no chat de backlog (reuso do modelo do Card, sem duplicação)

**Status:** Aceito

**Relacionado:** [ADR-0007](0007-remove-dor-and-acceptance.md) (sem DoR/acceptance
no v1; o único checklist é o DoD), [ADR-0023](0023-backlog-chat-story-threads.md)
(threads por story no backlog-chat).

## Contexto

O Sheet da thread de uma story (ADR-0023) exibia pouca informação: título,
pontos e uma descrição de **uma frase**. Faltava riqueza — contexto de negócio,
notas técnicas e, principalmente, as **tasks** da story. O usuário pediu para
enriquecer o Sheet e oferecer a criação de tasks sob demanda, deixando o DoD para
depois.

O ponto crítico: o board **já tem** um modelo completo de Epic → Story → Task e
DoD (`Card` polimórfico com `aiSummary`/`aiProject`/`aiNotes`, tasks como cards
`type:task` filhos da story, e `DodItem` como único checklist do v1). Havia risco
real de criar um **modelo paralelo** (campos "context"/"notes", um "DoD" próprio
da proposta) que duplicaria o que já existe.

## Decisão

Enriquecer a **proposta** do backlog-chat **reusando os nomes e a semântica do
`Card` existente**, sem inventar um modelo paralelo:

1. **Story rica** = mesmos campos do `Card`:
   - `description` (agora 2–5 linhas, não uma frase);
   - `aiSummary` (contexto/objetivo — **não** "context");
   - `aiNotes` (notas técnicas — **não** "notes").
2. **Tasks** = rascunho opcional `BacklogProposalTask { id, title }` na proposta.
   No `/apply`, cada task vira um card `type:task` filho da story via
   `CardsService.create` (cai automaticamente na coluna "To Do"). Task **não tem
   pontos** (invariante já validado no `CardsService`).
3. **DoD NÃO é duplicado.** Continua sendo `DodItem` montado no board depois do
   apply (a UI `ChecklistSection` já faz isso). O prompt é explícito: não propor
   nem descrever DoD no chat.

A criação continua passando **sempre** por `CardsService.create` — a IA nunca
cria card direto; ela **propõe** e o backend materializa.

## Consequências

- **Contrato (`packages/shared/backlog-chat.ts`):** `BacklogProposalStory` ganha
  `aiSummary?`, `aiNotes?` e `tasks?: BacklogProposalTask[]`;
  `BacklogAppliedCard.type` passa a incluir `'task'`. Novos paths de patch:
  `/stories/<i>/aiSummary`, `/stories/<i>/aiNotes`, `/stories/<i>/tasks` (array),
  `/stories/<i>/tasks/-` (add) e `/stories/<i>/tasks/<j>` (remove/replace).
- **Patch cirúrgico (`backlog-patch.ts`):** ids de tasks são estáveis
  (`randomUUID` na criação; preservados em `remove`/`replace` posicional), assim
  como já ocorre com ids de story (ADR-0023).
- **Prompt (`backlog-po.prompt.ts`):** pede descrições ricas, permite
  `aiSummary`/`aiNotes`, torna tasks **opcionais/sob demanda** e reforça que o DoD
  é feito no board (não duplicar). A thread focada de uma story documenta os novos
  paths.
- **`CardsService.create`:** passa a aceitar `aiSummary`/`aiNotes` na criação
  (antes só no `update`), para materializar a story rica de uma vez.
- **UI (`StoryThreadSheet.tsx`):** Sheet mostra seções Descrição / Contexto /
  Notas técnicas / Tasks, com botão "✨ Sugerir tasks" que pede à IA para
  decompor **aquela** story (patch cirúrgico → reflete em tempo real via
  `backlog.proposal`).
- **Sem migration:** a proposta vive como JSON na `BacklogProposalRevision`; os
  campos novos são apenas chaves adicionais do JSON. Os campos do `Card` já
  existem no schema.
- **Alinhado ao ADR-0007:** nenhum DoR/acceptance é reintroduzido; o único
  checklist continua sendo o DoD, no board.
