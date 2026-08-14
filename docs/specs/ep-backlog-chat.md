# EP-BCHAT — Paridade e coerência do chat de backlog (spec implementável)

> **Fonte:** investigação de sintoma reportado pelo humano ("o épico criado pelo
> backlog-chat sempre parece faltar informação") + auditoria do prompt do PO
> (`backlog-po.prompt.ts`). Ver findings desta sessão.
> **Status:** spec-of-truth para 4 stories (US-BCHAT1..4). Os implementers seguem
> este documento — não re-derivam decisões. Toda mudança é **aditiva e
> retrocompatível**: nenhuma migration (a proposta vive como JSON —
> [ADR-0024](../adr/0024-backlog-chat-rich-stories-and-draft-tasks.md)); campos
> novos são chaves opcionais do JSON; propostas antigas continuam válidas; o
> contrato existente não quebra.
>
> **Relacionado:** [ADR-0007](../adr/0007-remove-dor-and-acceptance.md) (único
> checklist é o DoD; sem DoR/acceptance), [ADR-0023](../adr/0023-backlog-chat-story-threads.md)
> (threads por story), [ADR-0024](../adr/0024-backlog-chat-rich-stories-and-draft-tasks.md)
> (reuso dos campos do `Card`, sem modelo paralelo),
> [ADR-0026](../adr/0026-story-chat-and-card-session-link.md) (chat da story +
> materialização de tasks), [ADR-0033](../adr/0033-mention-delegation-backlog-chat.md)
> (`@mention`).

## 1. Contexto e problema

O backlog-chat é o **Product Owner** (persona de IA) que transforma uma ideia do
humano num **backlog enxuto** (Epic + Stories, com Tasks sob demanda). A IA
**não** cria nada no board: ela **propõe** um `BacklogProposal` versionado e o
backend materializa em cards via `CardsService.create` quando o humano aprova
(`/apply`). O refinamento é **cirúrgico** (patches JSON-Pointer sobre a proposta).

A investigação encontrou **quatro defasagens** entre o que o domínio/entidade
suporta e o que o backlog-chat efetivamente produz. Todas empurram trabalho de
volta para o humano (preencher no board depois) ou geram granularidade
inconsistente — o oposto da promessa "a IA propõe, o humano aprova".

- **1) O épico é o "primo pobre" da proposta.** A **Story** carrega contexto rico
  de IA (`aiSummary`, `aiNotes`, `dod`, `affectedFlows`), materializado no card ao
  aplicar. O **Épico** só carrega `title`, `description`, `points`, `aiProject` —
  **mesmo o `Card` suportando `aiSummary`/`aiNotes` para qualquer tipo** e a UI do
  painel do épico (`BoardView.tsx`) renderizando um campo editável **"Notas para a
  AI"** ligado a `epic.aiNotes`. Resultado: o épico nasce **sempre com `aiNotes`/
  `aiSummary` vazios** — o "faltando informação" que o humano vê. A lacuna existe
  em **4 camadas coordenadas** (tipo → patch → apply → prompt): a IA nem sabe que
  *pode* enriquecer o épico.

- **2) Contradição interna sobre tasks "óbvias".** A **Fase 2** (proposta) é
  **determinística**: *"NÃO decida por conta própria com base em 'achou óbvio'…
  sem pedido explícito, omita `tasks`"*. Mas o bloco do **chat da story** diz
  *"Quando o humano pedir tasks (**ou já for óbvio que ele quer decompor**)…"*. Os
  dois blocos coexistem no mesmo prompt → a IA recebe ordens conflitantes sobre
  quando propor tasks, gerando granularidade desigual entre sessões.

- **3) `description` da task é descartada ao aplicar patch.** `BacklogProposalTask`
  **tem** `description` e o `/apply` do orchestrator **já** passa `description ??
  ''` ao criar o card. Mas `requireTask` (em `backlog-patch.ts`) retorna apenas
  `{ id, title }` — **descarta silenciosamente `description`** ao validar qualquer
  op de task. Além disso o template inicial (Fase 2) e os exemplos de patch de
  task só mostram `{ title }`, então a IA nem tenta preencher descrição de task
  via essa via.

- **4) Discovery não menciona a inspeção via shell.** A regra do `epic.aiProject`
  assume *"o mesmo diretório que você inspecionou nesta sessão; rode `pwd`"*, mas a
  **Fase 1 (Descoberta)** **não instrui** o PO a inspecionar o repositório-alvo via
  shell (`pwd`, `ls`, ler arquivos). A IA pode não saber que tem essa capacidade →
  `aiProject` chutado/ausente → modal "Falta o Projeto-alvo" ao mover a story para
  In Progress, e proposta descolada do código real.

### DOD do épico

- Épico da proposta carrega **`aiSummary`/`aiNotes`** de ponta a ponta (tipo →
  patch → apply → prompt); ao aplicar, o card épico nasce com contexto de IA
  (US-BCHAT1).
- Prompt **coerente** sobre tasks: só propõe tasks quando o humano **pede
  explicitamente**, tanto na Fase 2 quanto no chat da story (US-BCHAT2).
- `description` da task **preservada** em todo o ciclo (patch → apply); prompt
  documenta o campo (US-BCHAT3).
- Fase 1 orienta o PO a **inspecionar o repo via shell** para descobrir estrutura
  e o `aiProject` antes de propor (US-BCHAT4).
- `npm run build && npm run lint && npm test` **verdes**; contratos **type-safe
  nos dois lados** (`packages/shared` consumido por api **e** web).

## 2. Invariantes preservados (checar em cada PR)

1. Hierarquia Epic→Story→Task num único `Card` polimórfico. **EP-BCHAT é
   ortogonal**: enriquece a proposta e o prompt, não mexe na hierarquia.
2. Epic é derivado — ninguém move epic direto. **Não alterado** (o épico recebe
   `aiSummary`/`aiNotes`, que são contexto, não status).
3. Task só se cria em Backlog/To Do. **Não alterado** — a materialização continua
   passando por `CardsService.create`, que impõe a coluna "To Do".
4. **Sem DOR e sem `acceptance` no v1** — único checklist é o DoD. **NÃO
   reintroduzir.** `aiNotes` do épico é **contexto técnico**, não acceptance/DoR
   (mesma semântica já usada na story — ADR-0024).
5. Story points ∈ {1,2,3,5,8,13}; **só Epic e Story têm pontos, Task não**. **Não
   alterado** — a task ganha `description`, nunca pontos.
6. Loop engine só dispara quando story entra em In Progress. **Não alterado** — o
   backlog-chat só **propõe/materializa**; não dispara loop.
7. A IA **nunca** cria card direto — **propõe** e o backend materializa via
   `CardsService.create` (ADR-0024/0026). **Não alterado.**
8. **Sem migration** — a proposta vive como JSON em `BacklogProposalRevision`
   (ADR-0024). Campos novos (`epic.aiSummary`/`epic.aiNotes`) são chaves
   adicionais do JSON; os campos do `Card` já existem no schema.

## 3. Grafo de dependências das stories

```
US-BCHAT1 (simetria do épico: aiSummary/aiNotes end-to-end)
   → 4 camadas coordenadas (tipo shared + patch + apply + prompt). BASE do épico.

US-BCHAT2 (coerência do prompt sobre tasks "óbvias")   ← só prompt
US-BCHAT3 (preservar description da task no patch)     ← backlog-patch + prompt
US-BCHAT4 (discovery via shell para aiProject)         ← só prompt

US-BCHAT1..4 são MUTUAMENTE INDEPENDENTES em nível de conteúdo, mas 2/3/4 tocam o
MESMO arquivo (`backlog-po.prompt.ts`) em regiões diferentes; US-BCHAT1 também o
toca (template + paths do épico). Para evitar colisão de edição, cada story tem
uma região delimitada (§7 aponta a âncora textual de cada uma). Se paralelizadas,
serializar apenas as edições do `backlog-po.prompt.ts`.
```

## 4. Contratos compartilhados (`packages/shared`)

### 4.1 US-BCHAT1 — `epic.aiSummary` / `epic.aiNotes` (`packages/shared/src/backlog-chat.ts`)

No objeto `epic` de `BacklogProposal` (hoje `{ title, description?, points?,
aiProject? }`), adicionar **aditivamente** (seguindo o padrão de comentário dos
mesmos campos na story, que apontam para o `Card`):

```ts
  epic: {
    title: string;
    description?: string;
    points?: StoryPoints;
    /**
     * Contexto de AI do épico — **mesmo campo do Card** (`Card.aiSummary`).
     * Resumo/objetivo do épico em linguagem natural. Ao aplicar (`/apply`) vai
     * direto para `aiSummary` do card épico. Opcional (retrocompatível). Ver
     * ADR-0024.
     */
    aiSummary?: string;
    /**
     * Notas de AI do épico — **mesmo campo do Card** (`Card.aiNotes`).
     * Contexto/escopo técnico do épico (dependências, restrições, pontos de
     * atenção). NÃO é acceptance/DoR (proibidos no v1 — ADR-0007). Ao aplicar
     * vai para `aiNotes` do card épico — a UI do painel do épico já expõe este
     * campo ("Notas para a AI"). Opcional (retrocompatível). Ver ADR-0024.
     */
    aiNotes?: string;
    /** ...aiProject? (inalterado)... */
    aiProject?: string;
  };
```

Também atualizar o **JSDoc de `BacklogPatchOp`** (o comentário que lista os paths
válidos) para incluir `/epic/aiSummary` e `/epic/aiNotes`.

### 4.2 US-BCHAT3 — `BacklogProposalTask.description` (já existe)

O campo `description?: string` **já existe** em `BacklogProposalTask`. Nenhuma
mudança de contrato — o defeito é só no **applier** (`requireTask` descarta o
campo). Ver §7 (US-BCHAT3).

> **Regra de contrato:** todo tipo novo/alterado é reexportado pelo barrel
> `@kanban-ai/shared` (já reexportado para `backlog-chat.ts`). Consumido por
> **api** (patch/apply) e disponível ao **web** (proposta renderizada). Manter os
> comentários — são a documentação do contrato.

## 5. Schema Prisma — **N/A**

**Nenhuma migration.** A proposta é JSON (`BacklogProposalRevision`), e os campos
que o `/apply` grava no card (`aiSummary`/`aiNotes`) **já existem** no `model
Card` do schema. `CardsService.create` já aceita `aiSummary`/`aiNotes` na criação
(usado hoje para a story — ADR-0024); confirmar que aceita para `type:'epic'`
(mesmo caminho — sem branch por tipo para esses campos). Documentar a confirmação
no PR de US-BCHAT1.

## 6. Config — **N/A**

Nenhuma env/config nova. Puro contrato + orchestrator + prompt.

## 7. Stories em detalhe

### US-BCHAT1 — Simetria do épico (`aiSummary`/`aiNotes`) end-to-end — **med**

**Objetivo:** o épico da proposta deixa de ser o "primo pobre": passa a carregar
`aiSummary`/`aiNotes` como a story, materializados no card ao aplicar. Elimina o
sintoma "épico faltando informação".

**Contrato:** §4.1. **Sem schema** (§5).

**Hooks (4 camadas coordenadas — todas necessárias):**

1. **Tipo** — `packages/shared/src/backlog-chat.ts`: adicionar `aiSummary?`/
   `aiNotes?` ao objeto `epic` de `BacklogProposal` (§4.1) + atualizar o JSDoc de
   `BacklogPatchOp`.
2. **Patch** — `apps/api/src/modules/backlog-chat/backlog-patch.ts` (`applyOp`,
   bloco `// ── Epic ──`, logo após o `if (path === '/epic/aiProject')`): adicionar
   ```ts
   if (path === '/epic/aiSummary') {
     proposal.epic.aiSummary = requireString(op.value, path);
     return;
   }
   if (path === '/epic/aiNotes') {
     proposal.epic.aiNotes = requireString(op.value, path);
     return;
   }
   ```
3. **Apply** — `apps/api/src/modules/backlog-chat/backlog-chat.orchestrator.ts`
   (o `cards.create({ type: 'epic' })`, ~L1038-1046): passar
   `aiSummary: proposal.epic.aiSummary` e `aiNotes: proposal.epic.aiNotes` (como já
   feito no `cards.create({ type: 'story' })` logo abaixo). Confirmar que
   `CardsService.create` aceita esses campos para `epic` (§5).
4. **Prompt** — `apps/api/src/modules/backlog-chat/skill/backlog-po.prompt.ts`:
   - **Template da Fase 2** (linha do `"epic": { ... }`, ~L298): incluir
     `"aiSummary": "<1–2 linhas: contexto/objetivo do épico>"` e
     `"aiNotes": "<opcional: escopo técnico, dependências, restrições do épico>"`.
   - **Regras da proposta** (~L316-320): adicionar uma linha explicando quando
     enriquecer o épico com `aiSummary`/`aiNotes` (contexto que orienta a leitura
     do épico; **não** é DoR/acceptance).
   - **Fase 3 — paths de patch** (a linha que lista os `path` válidos, ~L357):
     incluir `/epic/aiSummary` e `/epic/aiNotes`. Adicionar exemplo de op no bloco
     `KANBAN_BACKLOG_PATCH` (~L340-343):
     `{ "op": "replace", "path": "/epic/aiNotes", "value": "<notas técnicas do épico>" }`.

**DOD (US-BCHAT1):**
- Proposta com `epic.aiSummary`/`epic.aiNotes` é aceita e, no `/apply`, o card
  épico nasce com esses campos preenchidos (verificável por spec white-box do
  orchestrator).
- Patch `/epic/aiSummary` e `/epic/aiNotes` aplica corretamente e rejeita valor
  não-string (padrão `requireString`).
- Prompt instrui a IA a preencher/patchar `aiSummary`/`aiNotes` do épico.
- Contrato type-safe consumido nos dois lados. Retrocompatível (propostas sem os
  campos continuam válidas).

### US-BCHAT2 — Coerência do prompt sobre tasks "óbvias" — **low (só prompt)**

**Objetivo:** eliminar a ordem conflitante. O padrão do produto é
**determinístico** (Fase 2): só propor tasks quando o humano **pedir
explicitamente**. Alinhar o bloco do chat da story ao mesmo padrão.

**Hook:** `apps/api/src/modules/backlog-chat/skill/backlog-po.prompt.ts`, bloco
`if (input.storyCard)` / `Como agir neste chat da story:` (~L148-153). Trocar
o trecho *"Quando o humano pedir tasks (**ou já for óbvio que ele quer
decompor**)"* por *"Quando o humano **pedir explicitamente** tasks/subtarefas"* —
removendo a permissão do "óbvio". Manter o restante (formato `KANBAN_TASKS`, "não
liste em texto puro", etc.). Opcional: uma linha reforçando "sem pedido
explícito, **não** proponha tasks — a story é a unidade de valor" (espelho da
regra da Fase 2, para consistência local do bloco).

**DOD (US-BCHAT2):**
- O prompt gerado **não** contém mais a permissão do "óbvio" no chat da story.
- Fase 2 e chat da story dizem a **mesma** coisa: tasks só sob pedido explícito.
- Se houver spec que inspeciona o texto do prompt (`*.prompt.spec.ts`),
  atualizá-la; senão, spec white-box simples verificando a ausência da frase.

### US-BCHAT3 — Preservar `description` da task no patch — **low**

**Objetivo:** corrigir o descarte silencioso de `description` em `requireTask` e
documentar o campo no prompt, para que uma task rascunhada no backlog inicial
chegue ao card com sua descrição (paridade com a via do chat da story, ADR-0026).

**Hooks:**
1. **Applier** — `apps/api/src/modules/backlog-chat/backlog-patch.ts`,
   `requireTask` (função no fim do arquivo). Hoje:
   ```ts
   const id = ...;
   return { id, title };
   ```
   Passar a preservar `description` (validação opcional, padrão dos outros
   `require*`):
   ```ts
   const task: BacklogProposalTask = { id, title };
   if (o.description !== undefined) {
     task.description = requireString(o.description, `${path}/description`);
   }
   return task;
   ```
2. **Prompt** — `backlog-po.prompt.ts`:
   - **Regra de tasks da Fase 2** (~L332): trocar *"Task tem só `title`"* por
     *"Task tem `title` e `description` opcional (sem pontos, sem DoD)"*.
   - **Exemplo de op de task** no bloco de patch (~L349,
     `{ "title": "<nova task>" }`): incluir `"description": "<opcional>"`.
   - **Descrição dos paths** (~L357): onde menciona tasks, deixar claro que a task
     aceita `description`.

> **Nota:** a via do **chat da story** (`MaterializeStoryTaskInput` /
> `materializeStoryTasks`, ADR-0026) **já** preserva `description`. Esta story
> fecha a via do **backlog inicial** (`requireTask`), eliminando a assimetria
> anotada no comentário de `MaterializeStoryTaskInput` no shared.

**DOD (US-BCHAT3):**
- Aplicar um patch `add`/`replace` de task com `description` **preserva** a
  descrição na proposta (spec do `backlog-patch`).
- Materializar (`/apply`) uma task com `description` cria o card com essa
  `description` (o apply já passa `description ?? ''`; agora ela chega não-vazia).
- Prompt documenta que task pode ter `description`.

### US-BCHAT4 — Discovery via shell para `aiProject` — **low (só prompt)**

**Objetivo:** tornar explícito na Fase 1 que o PO deve **inspecionar o
repositório-alvo via shell** durante a descoberta — o que sustenta a regra do
`aiProject` (que já assume "o diretório que você inspecionou").

**Hook:** `apps/api/src/modules/backlog-chat/skill/backlog-po.prompt.ts`, bloco
`## Fase 1 — Descoberta` (~L270-277). Adicionar orientação de que, além de
perguntar (KANBAN_QUESTION), o PO **pode e deve inspecionar o repositório-alvo via
shell** (ex.: `pwd`, `ls`, ler arquivos-chave/README) para entender a estrutura do
projeto e **descobrir o caminho absoluto** que irá em `epic.aiProject`. Deixar
claro que isso **informa** a proposta (fluxos/áreas afetadas mais precisos) e
**evita** o modal "Falta o Projeto-alvo". Manter a regra existente do `aiProject`
na Fase 2 (ela passa a referenciar essa inspeção).

**DOD (US-BCHAT4):**
- Fase 1 do prompt menciona a inspeção do repo via shell e a descoberta do
  `aiProject`.
- A regra do `aiProject` (Fase 2) permanece coerente com a Fase 1.
- Se houver spec do prompt, atualizada; senão, spec white-box verificando a
  presença da orientação.

## 8. Integração — mapa de arquivos

| Arquivo | US-BCHAT1 | US-BCHAT2 | US-BCHAT3 | US-BCHAT4 |
|---|---|---|---|---|
| `packages/shared/src/backlog-chat.ts` | `epic.aiSummary`/`aiNotes` + JSDoc paths | — | — (campo já existe) | — |
| `backlog-patch.ts` (`applyOp`) | `/epic/aiSummary` + `/epic/aiNotes` | — | — | — |
| `backlog-patch.ts` (`requireTask`) | — | — | preserva `description` | — |
| `backlog-chat.orchestrator.ts` (`/apply` epic) | passa `aiSummary`/`aiNotes` | — | — | — |
| `backlog-po.prompt.ts` (template Fase 2) | épico c/ `aiSummary`/`aiNotes` | — | task c/ `description` | — |
| `backlog-po.prompt.ts` (regras Fase 2) | regra do épico | tasks só sob pedido | task tem `description` | — |
| `backlog-po.prompt.ts` (Fase 3 paths/exemplos) | paths do épico | — | exemplo c/ `description` | — |
| `backlog-po.prompt.ts` (chat da story) | — | remove "óbvio" | — | — |
| `backlog-po.prompt.ts` (Fase 1 discovery) | — | — | — | shell + `aiProject` |
| specs `*.spec.ts` (backlog-chat) | apply/patch do épico | prompt (opcional) | patch/apply task | prompt (opcional) |

## 9. Retrocompatibilidade

- **US-BCHAT1**: `epic.aiSummary`/`aiNotes` opcionais; proposta antiga (sem eles)
  ⇒ épico criado como hoje (campos vazios). Paths novos só disparam quando a IA os
  emite. Nenhum contrato existente muda de forma quebrável.
- **US-BCHAT2**: só texto do prompt; nenhum contrato. Comportamento fica **mais**
  determinístico (menos tasks espúrias) — sem quebra.
- **US-BCHAT3**: `description` já existia no tipo e o apply já a lia; a correção só
  **para de descartá-la**. Task sem `description` ⇒ comportamento idêntico ao
  atual (`description ?? ''`).
- **US-BCHAT4**: só texto do prompt; a IA que não inspecionar ainda pode propor
  (a regra do `aiProject` já existia). Sem quebra.
- **Sem migration**, sem remoção/rename de coluna ou campo; propostas persistidas
  antigas continuam desserializando.

## 10. Plano de validação

Após cada story e ao fechar o épico:

```bash
# contrato compartilhado precisa buildar antes (é consumido por api e web):
npm run build --workspace @kanban-ai/shared

# TS real da API (nest build é opaco):
cd apps/api && npx tsc -p tsconfig.build.json --noEmit

# specs alvo do backlog-chat (runner do projeto):
npm test --workspace apps/api -- backlog-chat backlog-patch
# ou os arquivos específicos:
#   backlog-chat.orchestrator.spec.ts, backlog-chat-apply-aiproject.spec.ts,
#   backlog-chat-story-chat.spec.ts, backlog-patch.spec.ts (se criado)

# suíte inteira + fundação:
npm run build && npm run lint && npm test
curl -s localhost:3333/health   # smoke da fundação
```

- Contrato reexportado pelo barrel e consumível nos dois lados (type-safe).
- Specs existentes do backlog-chat continuam **verdes** (ajustar as que inspecionam
  o texto do prompt, se houver).
- `npm run build && npm run lint && npm test` **verdes**.
