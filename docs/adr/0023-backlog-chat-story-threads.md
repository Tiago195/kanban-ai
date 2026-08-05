# ADR-0023 — Threads por story no chat de backlog (modelo Slack)

**Status:** Aceito

**Relacionado:** [ADR-0021](0021-client-side-routing-with-react-router.md)
(rota dedicada do backlog-chat), [ADR-0022](0022-hitl-survives-restart-via-cli-session-id.md)
(HITL resiliente via `--session-id`).

## Contexto

O "Chat de criação de Épicos/Histórias" (backlog-chat) conduz uma conversa em que
a IA (persona Product Owner) faz descoberta e **propõe** um backlog (Epic +
Stories) versionado. O humano refina por **patch cirúrgico** e, ao aprovar, o
backend materializa os cards.

A UI inicial tinha dois problemas de usabilidade:

1. **Não dava para conversar sobre uma story específica.** Toda a conversa
   acontecia num único fio linear; refinar "a Story 2" no meio do fluxo geral era
   confuso e poluía o transcript.
2. **O "Ver detalhes" da proposta era pobre** — só expandia a descrição inline,
   sem um espaço dedicado para inspecionar e discutir cada story.

Queríamos: ao clicar numa story, abrir um painel lateral (Sheet) com **detalhes
ricos** da story **e** um **chat focado apenas naquela story**, cujos ajustes
reflitam **em tempo real** na proposta.

Uma decisão-chave: esse chat focado deve ser a **mesma sessão** de Copilot da
conversa geral (a IA precisa lembrar todo o contexto do épico), mas o
**transcript** precisa ser **separado** — as mensagens da thread da story não
podem aparecer no chat geral e vice-versa.

Também avaliamos usar o comando `/plan` da Copilot CLI para gerar o plano.
**Descartado:** o `/plan` produz markdown livre; o produto precisa de JSON
estruturado versionado (Epic + Stories + points + ids estáveis) para materializar
cards com invariantes garantidas e suportar patch cirúrgico. A skill própria
(`backlog-po.prompt.ts`) continua sendo o motor; o que evoluímos é a
**visualização**.

## Decisão

Adotamos um modelo de **threads estilo Slack** sobre uma única sessão de Copilot.

### Canais (threads) sobre uma sessão

- Uma `BacklogChatSession` = **uma** sessão de Copilot (`--session-id` =
  `session.id`, ver [ADR-0022](0022-hitl-survives-restart-via-cli-session-id.md)).
  A IA mantém todo o contexto.
- Dentro dela há múltiplos **canais** de transcript, identificados por uma chave:
  - `main` — a conversa geral.
  - `story:<storyId>` — a thread focada de uma story.
- Mensagens são **particionadas por canal**: cada turno persiste no canal em que
  foi disparado; um canal só lê suas próprias mensagens. Nada vaza entre canais.

### Âncora estável por story

- Cada `BacklogProposalStory` ganha um campo `id: string` (gerado pelo backend).
  A thread ancora nesse **ID estável**, não na posição do array — assim a thread
  sobrevive a reordenação/remoção via patch.

### Refino escopado → patch cirúrgico

- Um turno disparado de `story:<id>` injeta no prompt a **story em foco** e
  instrui a IA a manter o escopo naquela story e **preferir** emitir um
  `<<<KANBAN_BACKLOG_PATCH>>>` mirando `/stories/<index>/...`.
- O patch atualiza a proposta **in-place** (mesma proposta, nova revisão por
  baixo) e é transmitido via `backlog.proposal` (evento **global**, não por
  canal) — refletindo em tempo real tanto no plano geral quanto no Sheet aberto.

### Contrato

- `BacklogChatMessage.channel: string` (`main` | `story:<id>`).
- `BacklogProposalStory.id: string`.
- Eventos WS `backlog.chunk|question|answered` carregam `channel`;
  `backlog.proposal` permanece global (a proposta é única na sessão).
- Helpers em `@kanban-ai/shared`: `BACKLOG_MAIN_CHANNEL`, `backlogStoryChannel`,
  `parseBacklogStoryChannel`.

## Consequências

**Positivas**
- Conversas focadas por story sem poluir o fluxo geral; UX familiar (Slack).
- A IA mantém o contexto completo (uma sessão só) — respostas coerentes entre
  threads.
- Refino cirúrgico previsível: uma thread mexe só na sua story.
- Detalhes ricos da story num Sheet dedicado (shadcn).

**Negativas / trade-offs**
- Mudança de contrato ⇒ `shared` + `api` + `web` juntos (regra da fundação).
- O store do front passa a ser `bySession[sid].byChannel[channel]` — mais estado
  a reidratar no F5 (mitigado: o transcript persiste com `channel` e é
  particionado na reidratação).
- A proposta é global à sessão: se duas threads pedirem patches concorrentes, a
  versão é serializada pelo backend (a de maior `version` vence), como já era.

## Alternativas consideradas

- **Sub-sessão isolada por story** (cada story com seu próprio `--session-id`):
  rejeitada — a IA perderia o contexto compartilhado do épico e duplicaria custo.
- **Só leitura + comentários** no Sheet (sem IA por item): insuficiente — o
  usuário quer refinar conversando.
- **`/plan` da Copilot CLI**: rejeitada — markdown livre não materializa cards
  com invariantes nem suporta patch versionado.
