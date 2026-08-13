# EP-COLAB — Colaboração multi-agent no board (design-spec implementável)

> **Público-alvo:** agents de AI autônomos que vão implementar este épico **sem
> acesso ao autor**. Este documento é **autossuficiente**: todos os contratos,
> caminhos e símbolos citados foram **verificados no código** na data de escrita.
> **Não reinvente contratos existentes** — estenda-os. Leia sempre o
> [`AGENTS.md`](../../AGENTS.md) da raiz e o `AGENTS.md` do módulo que for tocar.

---

## 0. Sumário do épico

O EP-COLAB transforma o kanban-ai de um board single-tenant com um único plano de
controle (o loop engine "codador") em um board **colaborativo multi-agent**:

- **US-COLAB1** — Isolamento **multi-tenant** por **uma coluna nullable**
  (`Card.tenantId`), retrocompatível (`null` = comportamento atual). Filtra o
  board por tenant.
- **US-COLAB2** — Um **loop profile "orquestrador"** (board-manager) que **só
  cria/atribui/linka cards e NUNCA edita arquivos** (toolset restrito por
  prompt). É o "gerente de board" agent.
- **US-COLAB3** — Uma **wakeup queue persistente, idempotente e com coalescing**
  que substitui a fila 100% in-process de wakeups, sobrevive a restart e faz
  merge de wakeups duplicados por story.
- **US-COLAB4** — **`@mention` delegation** no backlog-chat: escrever
  `@nome-do-agent` numa mensagem **cria e atribui** uma task ao assignee/perfil
  mencionado.

### Ordem recomendada de implementação

A ordem minimiza retrabalho e respeita dependências reais entre as features:

1. **US-COLAB3** (wakeup queue) — é a mudança mais profunda no engine; fazê-la
   primeiro dá a fundação persistente que as outras podem observar. Não depende
   de nenhuma outra US.
2. **US-COLAB1** (multi-tenant) — coluna + filtro isolados; independente, mas o
   escopo de tenant deve existir antes do orquestrador para o board-manager
   respeitar tenant.
3. **US-COLAB2** (orquestrador) — depende conceitualmente do escopo de tenant
   (US-COLAB1) para saber "qual board/tenant gerenciar" e usa a wakeup queue
   (US-COLAB3) para ser acordado.
4. **US-COLAB4** (`@mention`) — depende da existência de perfis/assignees
   nomeados (reusa o mecanismo de assignee já existente; o perfil orquestrador
   da US-COLAB2 é um alvo natural de `@mention`, mas não é bloqueante).

> Cada US é entregável **isolada e retrocompatível**. É possível mergear US-COLAB1
> sozinha sem quebrar nada, por exemplo.

### Tabela de rastreabilidade

| US | Feature | Contrato novo (`packages/shared`) | Schema Prisma | Módulos api tocados | Web tocado | ADR |
|----|---------|-----------------------------------|---------------|---------------------|------------|-----|
| US-COLAB1 | Multi-tenant 1 coluna nullable | `ListCardsQueryDto.tenantId?`, `Card.tenantId?` em `domain.ts` | `Card.tenantId String?` + `@@index` | `cards` (schema, service.findAll) | `apiClient.getCards`, board query | **ADR-0030** |
| US-COLAB2 | Loop profile orquestrador | `LoopProfileId` += `'orchestrator'`; `LoopProfileDef.toolset?` | (usa `LoopProfile` existente; opcional persistir `toolset`) | `ai-engine/loop-profiles`, `orchestrator.buildPrompt` | seletor de loopType (labels) | **ADR-0031** |
| US-COLAB3 | Wakeup queue persistente + coalescing | `WakeupReason` type (opcional) | novo model `WakeupQueue` + `@@unique` | `ai-engine/orchestrator`, `session-manager` | — | **ADR-0032** |
| US-COLAB4 | `@mention` delegation no backlog-chat | `MentionDirective`, helper `parseMentions()` em `backlog-chat.ts` | — (reusa `Assignee` + `CardAssignee`) | `backlog-chat.orchestrator`, `cards.attachAssignee` | render de menções (opcional) | **ADR-0033** |

> **ADRs sugeridos** (livres — o último existente é `0027`; `0028`/`0029` NÃO
> existem, então há folga): registre um ADR por US **antes** de mergear.
> Se `0028`/`0029` forem tomados por outro épico até lá, use os próximos livres e
> atualize esta tabela.

---

## Invariantes do domínio (NUNCA violar — citados por US)

Fonte: [`AGENTS.md`](../../AGENTS.md) raiz + `packages/shared/src/enums.ts`.

1. Hierarquia **Epic → Story → Task** num `Card` polimórfico (`type`, `parentId`,
   `key` `EP-`/`US-`/`TK-`). Prefixos em `KEY_PREFIX` (`enums.ts:12`).
2. **Epic é derivado** das stories filhas — ninguém move epic direto (ADR-0013).
3. **Task só se cria** em `TASK_CREATION_COLUMNS = ['Backlog','To Do']`
   (`enums.ts:72`), garantido em `CardsService.create` (`cards.service.ts:279`).
4. **Sem DOR e sem `acceptance`** (ADR-0007). Único gate é o **DOD**.
5. **Story points** ∈ `STORY_POINTS = {1,2,3,5,8,13}` (só story/epic; task não
   tem pontos — validado em `cards.service.ts:287`).
6. O **loop engine** só dispara quando **story → In Progress**
   (`cards.service.ts:578` → `orchestrator.onStoryEnterInProgress`).
7. **Concorrência por-story serializada por epic**; orquestração **in-process
   sem Redis** (ADR-0019; `orchestrator.findConflictingActiveStory`,
   `resumeDeferredForStory`). A wakeup queue da US-COLAB3 **não pode** introduzir
   Redis/BullMQ no v1.

---
---

# US-COLAB1 — Multi-tenant por 1 coluna nullable

## 1.1 Estado atual (verificado)

- **Não existe** nenhum conceito de tenant no schema. O model `Card`
  (`apps/api/prisma/schema.prisma:89-172`) **não tem** `tenantId`. Índices atuais:
  `@@unique([boardId, key])`, `@@index([boardId])`, `@@index([parentId])`,
  `@@index([type])`, `@@index([backlogChatSessionId])`
  (`schema.prisma:167-171`).
- O board é carregado por `GET /cards?boardId=...`. O controller
  (`apps/api/src/modules/cards/cards.controller.ts:43` — `@Get('cards')`) delega a
  `CardsService.findAll(query)`.
- `findAll` (`apps/api/src/modules/cards/cards.service.ts:46-125`) monta um
  `Prisma.CardWhereInput` **incremental e retrocompatível** — cada filtro é
  opcional, ausência = comportamento antigo:

  ```ts
  // cards.service.ts:59-68 (verbatim, resumido)
  const where: Prisma.CardWhereInput = {};
  if (boardId) where.boardId = boardId;
  if (type) where.type = type;
  if (columnId) {
    where.OR = [{ boardColumnId: columnId }, { taskColumnId: columnId }];
  }
  if (updatedSince) where.updatedAt = { gte: new Date(updatedSince) };
  ```

- O schema de query é `listCardsQuerySchema` / `ListCardsQueryDto`
  (`apps/api/src/modules/cards/cards.schema.ts:36-52`) — todos os campos são
  `.optional()` (`boardId`, `type`, `columnId`, `updatedSince`, `limit`, `cursor`,
  `fields`).
- O web consome via `apiClient.getCards(boardId)`
  (`apps/web/src/shared/services/apiClient.ts:106-108`):

  ```ts
  getCards(boardId: string): Promise<ApiCardSummary[]> {
    return request<ApiCardSummary[]>(`/cards?boardId=${encodeURIComponent(boardId)}`);
  }
  ```

- **Padrão de escopo a ecoar** (ADR-0027): `MemoryAccessMode`
  (`enums.ts:127-131`, valores `READ_GLOBAL` / `WRITE_SCOPE`) e
  `MemoryPolicyService.scopeFor` já modelam "um agent enxerga/escreve dentro de um
  escopo". O tenant é o mesmo conceito aplicado ao board.

## 1.2 Gap

Falta uma dimensão de isolamento **horizontal** por tenant: hoje qualquer
consumidor do board vê **todos** os cards de um `boardId`. Precisamos de uma
coluna `tenantId` nullable no `Card` e de um filtro opcional `tenantId` na query
do board — mantendo `null` como "sem tenant" = comportamento atual (retrocompat
total). **Não** haverá multi-tenant no nível de auth (não há auth no v1 — ADR-0009);
é isolamento de **visualização/escopo de dados**.

## 1.3 Contrato proposto

### Prisma (`apps/api/prisma/schema.prisma`, model `Card`)

Adicione o campo nullable e o índice. Coloque o campo junto dos "Campos
específicos de STORY/TASK" ou logo após `boardId`:

```prisma
model Card {
  id      String @id @default(uuid())
  boardId String
  board   Board  @relation(fields: [boardId], references: [id], onDelete: Cascade)

  // EP-COLAB / US-COLAB1 — isolamento multi-tenant por coluna nullable.
  // null = card global (comportamento pré-COLAB, retrocompatível). Quando
  // preenchido, o card só aparece no board quando a query filtra pelo MESMO
  // tenantId (ou não filtra por tenant). Não há FK — tenant é um rótulo opaco
  // no v1 (sem auth, ADR-0009).
  tenantId String?

  // ... demais campos inalterados ...

  @@unique([boardId, key])
  @@index([boardId])
  @@index([parentId])
  @@index([type])
  @@index([backlogChatSessionId])
  @@index([boardId, tenantId]) // US-COLAB1: filtro de board por tenant
}
```

### Contrato compartilhado (`packages/shared/src/domain.ts`)

O tipo `Card` compartilhado precisa refletir a coluna nova (consumido por web e
api). Adicione o campo **opcional** ao tipo base de `Card`:

```ts
// packages/shared/src/domain.ts — no tipo Card (ou BaseCard) compartilhado
export interface Card {
  // ... campos existentes ...
  /**
   * US-COLAB1 — tenant do card. `null`/ausente = card global (retrocompatível).
   * Rótulo opaco de isolamento de escopo no board (sem auth no v1, ADR-0009).
   */
  tenantId?: string | null;
}
```

### Query DTO (`apps/api/src/modules/cards/cards.schema.ts`, `listCardsQuerySchema`)

Adicione o filtro opcional (mesmo padrão dos demais):

```ts
export const listCardsQuerySchema = z.object({
  boardId: z.string().uuid().optional(),
  type: z.enum(['epic', 'story', 'task']).optional(),
  columnId: z.string().uuid().optional(),
  updatedSince: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().uuid().optional(),
  fields: z.enum(['full', 'summary']).optional(),
  /**
   * US-COLAB1 — filtra o board por tenant. Ausente = comportamento antigo
   * (todos os cards do board). Presente = só cards com esse tenantId. Para
   * incluir também cards globais (tenantId=null) junto de um tenant, veja o
   * where em findAll (política padrão: tenant estrito).
   */
  tenantId: z.string().min(1).optional(),
});
```

### Filtro em `CardsService.findAll` (`cards.service.ts`, dentro do bloco `where`)

```ts
// após: if (updatedSince) where.updatedAt = { gte: new Date(updatedSince) };
if (tenantId) where.tenantId = tenantId;
```

> **Decisão de política (documente no ADR-0030):** filtro **estrito** — quando
> `tenantId` é passado, retorna só cards com esse `tenantId`. Cards globais
> (`tenantId=null`) **não** vazam para dentro de um tenant. Sem `tenantId` na
> query → sem cláusula → todos os cards (retrocompat). Se o produto quiser
> "tenant + globais", troque por `where.OR = [{ tenantId }, { tenantId: null }]`
> — mas isso é decisão explícita, não default.

### Propagação de `tenantId` na criação (opcional, recomendado)

Para cards nascerem já com tenant, adicione `tenantId` opcional a
`createCardSchema` (`cards.schema.ts:5-27`) e propague no
`tx.card.create({ data: { ... } })` de `CardsService.create`
(`cards.service.ts:343-360`), seguindo o padrão dos campos condicionais
`...(dto.aiProject !== undefined ? { aiProject: dto.aiProject } : {})`:

```ts
// createCardSchema += tenantId: z.string().min(1).optional()
// no data do create:
...(dto.tenantId !== undefined ? { tenantId: dto.tenantId } : {}),
```

## 1.4 Plano PR-a-PR

**PR-1 (schema + migration):**
1. Editar `apps/api/prisma/schema.prisma`: adicionar `tenantId String?` e
   `@@index([boardId, tenantId])` ao model `Card`.
2. Gerar migration: `npm run db:migrate -- --name add_card_tenant_id`
   (Prisma gera `ALTER TABLE "Card" ADD COLUMN "tenantId" TEXT;` — nullable, sem
   default, **não** reescreve linhas existentes → retrocompat).
3. `npx prisma generate` (implícito no migrate) para atualizar o client tipado.

**PR-2 (contrato shared — atualiza os DOIS lados):**
4. `packages/shared/src/domain.ts`: adicionar `tenantId?: string | null` ao `Card`.
5. `npm run build -w @kanban-ai/shared` (o pacote é CommonJS — ver AGENTS.md).

**PR-3 (api — query + filtro):**
6. `cards.schema.ts`: adicionar `tenantId` opcional a `listCardsQuerySchema` (e,
   se adotado, a `createCardSchema`).
7. `cards.service.ts`: adicionar `if (tenantId) where.tenantId = tenantId;` no
   bloco `where` de `findAll`; extrair `tenantId` do destructuring de `query`
   (linha `const { boardId, type, columnId, updatedSince, limit, cursor, fields } = query;`
   → incluir `tenantId`). Propagar no `create` se adotado.

**PR-4 (web — cliente):**
8. `apps/web/src/shared/services/apiClient.ts`: sobrecarga/opção em `getCards`
   para aceitar `tenantId` opcional e anexar `&tenantId=...` na URL.
9. Consumir o tipo `Card.tenantId` onde o board renderiza (nenhuma mudança de
   layout obrigatória — o campo é aditivo).

## 1.5 Pontos de integração

- **Board query:** `CardsService.findAll` (`cards.service.ts:46`) — único ponto de
  filtro; o `attachResolvedModel`/`attachEpicStatus` a jusante não precisam mudar.
- **MCP / consumidores headless:** `GET /cards` é reusado pelo MCP server
  (`apps/mcp`). O filtro é opcional → MCP continua funcionando sem `tenantId`.
- **Escopo de memória (ADR-0027):** se no futuro o tenant precisar restringir a
  memória viva, o ponto é `MemoryPolicyService.scopeFor` — **fora do escopo desta
  US**, apenas registrado como extensão futura.

## 1.6 DOD verificável

- [ ] `npm run build && npm run lint && npm test` verdes.
- [ ] Migration aplicada: `npm run db:migrate:deploy` sem erro; coluna
  `Card.tenantId` existe e é nullable (`\d "Card"` no psql mostra `tenantId | text`).
- [ ] `GET /cards?boardId=<b>` sem `tenantId` retorna **exatamente** o mesmo
  conjunto de antes (retrocompat — spec de regressão em
  `apps/api/src/modules/cards/*.spec.ts`).
- [ ] `GET /cards?boardId=<b>&tenantId=t1` retorna só cards com `tenantId='t1'`.
- [ ] Card criado sem `tenantId` tem `tenantId=null` e aparece só em queries sem
  filtro de tenant (política estrita).
- [ ] Novo teste em `cards.service.spec.ts` cobrindo os 3 casos acima.

## 1.7 Riscos / invariantes / retrocompatibilidade

- **Retrocompat:** coluna nullable sem default; nenhum código antigo passa
  `tenantId` → tudo continua igual. **Não** altere `@@unique([boardId, key])` —
  a chave `key` continua única por board (não por tenant) no v1.
- **Invariante 1-6:** intocados — `tenantId` é ortogonal à hierarquia e às
  colunas.
- **Risco:** vazamento entre tenants se algum consumidor esquecer o filtro. No
  v1 (sem auth) é aceitável — documente que o isolamento é **cooperativo**, não
  de segurança. NÃO prometer isolamento de segurança no ADR.
- **Risco de índice:** `@@index([boardId, tenantId])` cobre o filtro composto;
  não remova `@@index([boardId])` (usado por queries sem tenant).

---
---

# US-COLAB2 — Loop profile "orquestrador" (board-manager)

## 2.1 Estado atual (verificado)

- **Loop profiles embutidos** vivem em
  `apps/api/src/modules/ai-engine/loop-profiles/loop-profiles.ts`. O contrato é
  `LoopProfileDef` (`loop-profiles.ts:6-15`):

  ```ts
  export interface LoopProfileDef {
    id: LoopProfileId | string;
    name: string;
    builtin: boolean;
    description: string;
    phases: IterationPhase[];
    validation: ValidationStrategy;
    firstStep: string;
  }
  ```

  Os 4 perfis atuais estão em `BUILTIN_LOOP_PROFILES` (`loop-profiles.ts:18-56`):
  `feature`, `bug`, `refactor`, `__default`. `resolveLoopProfile(loopType)`
  (`loop-profiles.ts:59-62`) faz fallback para `__default`.

- **Tipos compartilhados** (`packages/shared/src/enums.ts`):
  - `LoopProfileId = 'feature' | 'bug' | 'refactor' | '__default'`
    (`enums.ts:44`).
  - `IterationPhase = 'reproduce' | 'analysis' | 'implementation' | 'validation'`
    (`enums.ts:41`).
  - `ValidationStrategy = 'flows+regression' | 'bug-gone+regression' | 'regression-only'`
    (`enums.ts:52`).

- **O toolset do agent é 100% dirigido por PROMPT.** Verificado:
  - O runner real (`CopilotCliRunner`,
    `apps/api/src/modules/ai-engine/runners/copilot-cli.runner.ts:29`) faz
    `spawn(plan.command, plan.args, ...)` (`copilot-cli.runner.ts:43`).
  - O `plan` vem de `CliAdapter.buildSpawnPlan(prompt)`
    (`cli-adapter.ts:84-95`): usa `config.agent.cliCommand`/`cliArgs`/`promptMode`
    (env `AGENT_CLI_COMMAND`, default `'copilot'`). **Não há** flags de
    allow/deny de ferramentas — o comportamento (editar arquivos vs. só gerenciar
    board) é imposto pelo **texto do prompt**.
  - O prompt é construído em `Orchestrator.buildPrompt(phase, profile, context,
    agentInstructions, workdir)` (`orchestrator.ts:2579`). Ele já injeta seções
    duras de política, incluindo **"## ❌ PROIBIDO — operações de git que
    alteram estado"** (`orchestrator.ts:2682-2690`) e "NUNCA crie features no
    kanban-ai" (`orchestrator.ts:2672`). O `profile.name`/`description`/`phases`
    são injetados em `orchestrator.ts:2605-2608`.

- **`LoopProfile` persistido** (por-board, custom) existe no schema
  (`schema.prisma:409-422`) com `profileId`, `phases`, `validation`, `firstStep`,
  `@@unique([boardId, profileId])`. O CRUD está em
  `apps/api/src/modules/loop-profiles/loop-profiles.service.ts` (mapeia
  `ValidationStrategy` prisma↔shared e **força a última fase = `validation`**).

- **loopType → profile → prompt:** no `stepStory`, o orchestrator lê
  `raw?.loopType` da task e chama `resolveLoopProfile(raw?.loopType)`
  (`orchestrator.ts:316`), depois `buildPrompt(phase, profile, ...)`
  (`orchestrator.ts:438`). O `loopType` da task vem de `Card.loopType`
  (`schema.prisma`: `loopType String?`).

## 2.2 Gap

Não existe um perfil cujo mandato seja **gerenciar o board** (criar/atribuir/
linkar cards) e **jamais editar arquivos do repo-alvo**. Todos os perfis atuais
assumem "codar no working tree" (o `buildPrompt` inclusive **exige** `git diff`
não-vazio: `orchestrator.ts:2663`). Precisamos de:

1. Um novo `LoopProfileId` (`'orchestrator'`) no contrato compartilhado.
2. Um `BUILTIN_LOOP_PROFILES.orchestrator` com fases próprias (sem
   `implementation` de código).
3. Um **prompt restrito** que substitua a seção "edite os arquivos" por
   "você só opera o board via ferramentas MCP; NUNCA edite arquivos".

## 2.3 Contrato proposto

### `packages/shared/src/enums.ts`

```ts
// enums.ts:44 — estender o union (consumido por web E api)
export type LoopProfileId = 'feature' | 'bug' | 'refactor' | 'orchestrator' | '__default';
```

> **Atenção retrocompat:** `LoopProfileId` é usado em `LoopProfileDef.id`,
> no seletor do web e no Prisma `LoopProfile.profileId` (string livre). Adicionar
> um valor ao union é aditivo. **Não** remova nem renomeie os existentes.

### `LoopProfileDef` — campo `toolset` opcional (`loop-profiles.ts`)

Para tornar a restrição **explícita e verificável** (e futura-prova para runners
que suportem allow/deny real), adicione um campo opcional ao `LoopProfileDef`:

```ts
// apps/api/src/modules/ai-engine/loop-profiles/loop-profiles.ts
export type LoopToolset = 'full' | 'board-only';

export interface LoopProfileDef {
  id: LoopProfileId | string;
  name: string;
  builtin: boolean;
  description: string;
  phases: IterationPhase[];
  validation: ValidationStrategy;
  firstStep: string;
  /**
   * US-COLAB2 — capacidade de ferramentas desta iteração.
   * `full` (default/ausente) = pode editar arquivos do repo-alvo (perfis
   * codadores existentes). `board-only` = o agent SÓ pode criar/atribuir/linkar
   * cards (via MCP) e NUNCA editar arquivos. O `buildPrompt` troca a seção de
   * escopo conforme este campo.
   */
  toolset?: LoopToolset;
}
```

### Novo perfil embutido (`BUILTIN_LOOP_PROFILES`)

```ts
export const BUILTIN_LOOP_PROFILES: Record<string, LoopProfileDef> = {
  // ... feature, bug, refactor, __default inalterados ...

  orchestrator: {
    id: 'orchestrator',
    name: 'Orquestrador (board manager)',
    builtin: true,
    description:
      'Gerente de board: quebra escopo em stories/tasks, atribui aos agents ' +
      'certos e linka dependências. NUNCA edita arquivos do repo-alvo.',
    // Sem fase de implementação de CÓDIGO: analisa o board e decide, planeja e
    // valida a organização. A última fase deve ser 'validation' (invariante do
    // normalizador de perfis — loop-profiles.service.ts).
    phases: ['analysis', 'validation'],
    validation: 'regression-only',
    firstStep:
      'Ler o board (épicos/stories/tasks), identificar lacunas de decomposição ' +
      'e planejar quais cards criar/atribuir/linkar — sem tocar em arquivos.',
    toolset: 'board-only',
  },
};
```

> **Por que `regression-only` + `['analysis','validation']`?** O gate de validação
> final (`orchestrator.ts:571` usa `profile.validation`) espera uma estratégia
> válida. `regression-only` é a mais leve e não exige "fluxos novos" (que um
> board-manager não produz, pois não coda). As fases evitam `implementation`
> (que o `buildPrompt` associa a editar arquivos). Se o normalizador de perfis
> forçar a última fase para `validation` (ele força — ver
> `loop-profiles.service.ts`), este perfil já satisfaz isso.

## 2.4 Ponto crítico: o prompt restrito em `buildPrompt`

Hoje `buildPrompt` (`orchestrator.ts:2579`) **sempre** injeta a seção "## Escopo
e diretório de trabalho" mandando **editar arquivos** e exigindo `git diff`
não-vazio (`orchestrator.ts:2649-2668`). Para o perfil `board-only`, essa seção
precisa ser **substituída** por uma seção de mandato de board. Faça um branch por
`profile.toolset`:

```ts
// dentro de buildPrompt, no lugar do bloco "## Escopo e diretório de trabalho":
if (profile.toolset === 'board-only') {
  lines.push('');
  lines.push('## 🧭 Você é o ORQUESTRADOR do board (board manager)');
  lines.push(
    '- Seu trabalho é ORGANIZAR o board: criar stories/tasks, atribuí-las aos ' +
      'agents certos e linkar dependências — via as ferramentas MCP do kanban-ai.',
  );
  lines.push(
    '- ❌ Você **NÃO PODE editar, criar ou apagar NENHUM arquivo** do ' +
      'repositório-alvo. Você não coda. Se algo precisa de código, CRIE uma task ' +
      'e atribua a um agent codador (feature/bug/refactor).',
  );
  lines.push(
    '- ❌ NÃO rode comandos de shell que alterem o FS. Comandos de LEITURA para ' +
      'entender o board são permitidos.',
  );
  lines.push(
    '- ✅ Ferramentas permitidas: criar card (task/story), atribuir assignee, ' +
      'linkar dependência, mover card entre colunas do board.',
  );
} else {
  // ... seção "## Escopo e diretório de trabalho" existente (inalterada) ...
}
```

> **Importante:** o `AGENT_REQUIRE_STRUCTURED_EVIDENCE` e o gate que exige
> `git diff` não-vazio (`orchestrator.ts:712-766`, "desvio detectado: a AI listou
> fluxos afetados mas o git diff do repo-alvo está vazio") **precisam ser
> neutralizados** para `toolset==='board-only'`, senão o board-manager sempre
> falharia a validação (ele nunca produz diff). No fechamento de iteração, faça:
> `if (profile.toolset === 'board-only') skip ghost-diff check`. Localize o guard
> por `git diff` no `stepStory`/fechamento (símbolos: `captureDiff`,
> `affectedFlows`, `orchestrator.ts:712-766`) e adicione o short-circuit.

## 2.5 Plano PR-a-PR

**PR-1 (contrato shared — os DOIS lados):**
1. `packages/shared/src/enums.ts`: adicionar `'orchestrator'` a `LoopProfileId`.
2. `npm run build -w @kanban-ai/shared`.
3. Atualizar qualquer `switch`/mapa exaustivo sobre `LoopProfileId` no web
   (seletor de perfil por label) e na api — o TypeScript apontará os locais
   (compile-time). Ex.: seletor em `apps/web/src/features/labels/` se houver
   mapeamento label→loopType.

**PR-2 (api — profile + prompt):**
4. `loop-profiles.ts`: adicionar `LoopToolset`, `toolset?` em `LoopProfileDef`, e
   `orchestrator` em `BUILTIN_LOOP_PROFILES`.
5. `orchestrator.ts` `buildPrompt`: branch `profile.toolset === 'board-only'`
   (substitui a seção de escopo).
6. `orchestrator.ts` fechamento de iteração: short-circuit do gate de `git diff`
   vazio quando `board-only`.

**PR-3 (persistência opcional do toolset):**
7. Se quiser expor `toolset` em perfis custom por-board: adicionar coluna
   `toolset String?` ao model `LoopProfile` (`schema.prisma:409`) + migration, e
   mapear em `loop-profiles.service.ts`. **Opcional** — o perfil embutido não
   precisa de coluna nova.

## 2.6 Pontos de integração

- **loopType → perfil:** `resolveLoopProfile` já resolve `'orchestrator'` se
  presente em `BUILTIN_LOOP_PROFILES`. Uma **task** com `loopType='orchestrator'`
  (ou um assignee/label mapeado) roda como board-manager.
- **buildPrompt:** único ponto onde o mandato muda (§2.4).
- **Validação final:** `orchestrator.ts:571` usa `profile.validation` —
  `regression-only` é seguro.
- **US-COLAB4:** `@mention` de um agent cujo perfil é `orchestrator` cria uma task
  `loopType='orchestrator'` — integra naturalmente.

## 2.7 DOD verificável

- [ ] `npm run build && npm run lint && npm test` verdes (incluindo o pacote
  shared).
- [ ] `resolveLoopProfile('orchestrator')` retorna o perfil novo (spec em
  `loop-profiles.spec.ts` se existir; senão criar).
- [ ] `buildPrompt(phase, orchestratorProfile, ...)` **não** contém a frase
  "editando os arquivos reais do projeto" e **contém** "NÃO PODE editar" (teste de
  string no prompt — o `buildPrompt` é determinístico).
- [ ] Uma story com uma task `loopType='orchestrator'` entra em In Progress, roda
  ≥1 iteração e **fecha sem exigir `git diff` não-vazio** (teste de integração com
  o `MockAgentRunner` — ADR-0014).
- [ ] Perfis existentes (`feature`/`bug`/`refactor`) inalterados (regressão).

## 2.8 Riscos / invariantes / retrocompatibilidade

- **Invariante 3:** o board-manager CRIA tasks — deve respeitar
  `TASK_CREATION_COLUMNS` (garantido em `CardsService.create:279`). Não burlar.
- **Invariante 6/7:** o board-manager também é acordado por story→In Progress e
  serializado por epic. Sem exceção.
- **Risco:** o toolset é imposto por **prompt**, não por sandbox — o agent
  *poderia* desobedecer. Mitigação v1: o gate de `git diff` vazio deixa de ser
  falha (§2.4) mas um `git diff` **não-vazio** de um board-manager deve ser
  **logado como warning** (ele não deveria ter editado). Registre no ADR-0031 que
  a restrição é cooperativa; enforcement real (allow/deny de tools) fica para
  runners futuros (`AgentRunner` é plugável — `agent-runner.interface.ts:AGENT_RUNNER`).
- **Retrocompat:** `toolset` ausente = `full` = comportamento atual.

---
---

# US-COLAB3 — Wakeup queue idempotente + coalescing (persistente)

## 3.1 Estado atual (verificado)

**Todo o wakeup é 100% in-process e efêmero.** O estado-de-verdade hoje é a
**coluna do board no Postgres** (nada de fila persistida). Cadeia verificada:

- Gatilho: `CardsService.move` detecta story→In Progress
  (`cards.service.ts:578-588`) e chama
  `await this.orchestrator.onStoryEnterInProgress(id)`. Também há retomada quando
  se adiciona task a story já em progresso
  (`maybeResumeLoopOnTaskAdded`, `cards.service.ts:376-407`) e hook simétrico de
  saída `onStoryLeaveInProgress` (`cards.service.ts:600`).
- `Orchestrator.onStoryEnterInProgress(storyId)` (`orchestrator.ts:110-207`):
  - Idempotência: `if (this.sessions.get(storyId)) return;` (`orchestrator.ts:111`).
  - Limite: `if (!this.sessions.canStart()) { ...aguardando slot... return; }`
    (`orchestrator.ts:113-117`) — `AGENT_MAX_CONCURRENT_SESSIONS`, default 3.
  - **Serialização por epic:** `findConflictingActiveStory(storyId)`
    (`orchestrator.ts:126`) — se conflita, **apenas loga e retorna** (o wakeup é
    **perdido**; só volta via `resumeDeferredForStory` quando a outra terminar).
  - Cria sessão em memória: `this.sessions.start(storyId)`
    (`orchestrator.ts:139`), inicia watchdog e `this.startAuto(storyId)`.
- `startAuto(storyId)` (`orchestrator.ts:1120-1149`): `setInterval` em
  `this.autoTimers: Map<storyId, handle>` que tica `stepStory` na cadência
  `AGENT_AUTO_STEP_INTERVAL_MS` (default 1500ms). `finishAuto`
  (`orchestrator.ts:1160-1181`) faz `clearInterval`, remove a sessão, limpa
  watchdog e chama `resumeDeferredForStory`.
- **Única "persistência" hoje** = `reconcileOnBoot()` (`orchestrator.ts:92-108`):
  no boot, relê o Postgres (`type:'story'` em coluna "In Progress") e
  **re-dispara** `onStoryEnterInProgress` para cada uma. É assim que o sistema
  "sobrevive a restart": ele **recomputa** a partir das colunas do board.
- **Sessões** vivem em `AgentSessionManager`
  (`apps/api/src/modules/ai-engine/session-manager/agent-session-manager.ts`):
  `Map<storyId, AgentSession>` em memória, estados `running|idle|dead`,
  `canStart()`, `start()`, `activeStoryIds()`, `remove()`. **Doc do próprio
  arquivo diz que este é o ponto plugável** para uma fila real (BullMQ) no futuro
  — mas o v1 **proíbe Redis** (ADR-0019, invariante 7).

## 3.2 Gap

Três problemas concretos que a fila in-process tem:

1. **Wakeups perdidos por conflito de serialização:** quando
   `findConflictingActiveStory` retorna conflito, o wakeup **some** — só
   ressuscita se `resumeDeferredForStory` reencontrar a story via varredura do
   board. Não há registro explícito de "esta story está esperando um wakeup".
2. **Não sobrevive a restart de forma explícita:** `reconcileOnBoot` recomputa
   pelo board, mas **perde intenção** (ex.: "acordar por task nova adicionada",
   "acordar por resposta de HITL") — só reconstrói o caso "story está em In
   Progress". Wakeups com razão específica somem no restart.
3. **Não coalesce:** múltiplos gatilhos para a mesma story (mover + adicionar 3
   tasks em sequência) hoje são naturalmente idempotentes **em memória** (o
   `if (this.sessions.get)` absorve), mas **não há registro auditável** nem
   coalescing explícito — e sob concorrência de eventos rápidos o comportamento é
   implícito.

Precisamos de uma **fila de wakeups persistida no Postgres, idempotente e com
coalescing** (merge por story), que:
- sobreviva a restart (fonte de verdade explícita, além das colunas do board);
- deduplice/mescle wakeups da mesma story (um único registro `pending` por story);
- **não** introduza Redis/BullMQ (invariante 7) — o processamento continua
  in-process, apenas o **estado da fila** vira durável.

## 3.3 Contrato proposto

### Prisma — novo model `WakeupQueue` (`apps/api/prisma/schema.prisma`)

```prisma
// EP-COLAB / US-COLAB3 — fila de wakeups durável, idempotente e com coalescing.
// Substitui a fila 100% in-process: o PROCESSAMENTO continua in-process (sem
// Redis, invariante 7 / ADR-0019), mas o ESTADO da fila é persistido para
// sobreviver a restart e para coalescer (merge) wakeups duplicados por story.
model WakeupQueue {
  id      String @id @default(uuid())
  storyId String
  story   Card   @relation("WakeupStory", fields: [storyId], references: [id], onDelete: Cascade)

  // Coalescing: no máximo UM wakeup 'pending' por story. Um novo wakeup para uma
  // story que já tem 'pending' faz MERGE (atualiza reason/attempts), não cria
  // linha nova. Garantido pelo índice único parcial abaixo.
  status WakeupStatus @default(pending)

  // Por que a story precisa acordar (auditoria + retomada correta pós-restart).
  reason WakeupReason @default(story_in_progress)

  // Contagem de coalescing: quantos wakeups foram mesclados neste registro.
  attempts Int @default(1)

  // Serialização por epic (invariante 7): a fila registra o epic para o
  // processador respeitar "uma story por epic" ao drenar.
  epicId String?

  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  claimedAt   DateTime? // quando o processador in-process pegou este item
  processedAt DateTime? // quando concluiu (status=done/failed)

  // Coalescing forte: só pode existir 1 wakeup NÃO-terminal por story.
  // (Postgres suporta índice único parcial; ver nota de migration abaixo.)
  @@unique([storyId, status])
  @@index([status])
  @@index([epicId])
}

enum WakeupStatus {
  pending // aguardando o processador
  claimed // sendo processado por uma sessão in-process
  done    // processado com sucesso
  failed  // falhou (mantido para auditoria/retry)
}

enum WakeupReason {
  story_in_progress // story entrou/está em In Progress (gatilho clássico)
  task_added        // task nova adicionada a story em progresso (BUG-09)
  hitl_answered     // humano respondeu uma pergunta pendente
  manual_step       // "Rodar 1 iteração" / stepOnce
  reconcile         // re-enfileirado no boot a partir do board
}
```

> **Nota de migration (coalescing correto):** `@@unique([storyId, status])`
> permite um `pending` **e** um `done` simultâneos (o par muda). Para garantir
> **um único wakeup NÃO-terminal por story** de forma robusta, o ideal é um
> **índice único parcial** (Postgres): `CREATE UNIQUE INDEX
> "WakeupQueue_storyId_active_key" ON "WakeupQueue"("storyId") WHERE status IN
> ('pending','claimed');`. Prisma não expressa índice parcial no schema (v5) —
> adicione-o **manualmente no SQL da migration** gerada (`npm run db:migrate --
> --create-only --name add_wakeup_queue`, depois edite o `.sql`). Isso é a
> garantia de coalescing.

> **Relação reversa em `Card`:** adicione ao model `Card`
> `wakeups WakeupQueue[] @relation("WakeupStory")` (linha nas "Relações filhas",
> junto de `iterations Iteration[]`).

### Contrato compartilhado (opcional, `packages/shared/src/enums.ts`)

Se o web precisar exibir o motivo do wakeup (ex.: badge "na fila"), exporte os
enums como constantes shared (padrão do projeto — `as const`):

```ts
// packages/shared/src/enums.ts — opcional, só se o web consumir
export const WAKEUP_STATUS = ['pending', 'claimed', 'done', 'failed'] as const;
export type WakeupStatus = (typeof WAKEUP_STATUS)[number];

export const WAKEUP_REASON = [
  'story_in_progress', 'task_added', 'hitl_answered', 'manual_step', 'reconcile',
] as const;
export type WakeupReason = (typeof WAKEUP_REASON)[number];
```

### Serviço de fila (`apps/api/src/modules/ai-engine/wakeup-queue.service.ts`, novo)

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/db/prisma.service';

/**
 * US-COLAB3 — fila de wakeups durável e idempotente com coalescing.
 * O PROCESSAMENTO segue in-process (Orchestrator); esta camada só garante que a
 * INTENÇÃO de acordar uma story seja durável e deduplicada.
 */
@Injectable()
export class WakeupQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfileira (ou coalesce) um wakeup. Idempotente: se já existe um wakeup
   * NÃO-terminal para a story, faz MERGE (incrementa attempts, atualiza reason)
   * em vez de criar linha nova. Retorna o registro vigente.
   */
  async enqueue(input: {
    storyId: string;
    reason: WakeupReason;
    epicId?: string | null;
  }): Promise<void> {
    // upsert por (storyId + estado ativo). Como o índice único é parcial, use
    // uma transação: tenta atualizar o pending existente; se 0 linhas, cria.
    await this.prisma.$transaction(async (tx) => {
      const active = await tx.wakeupQueue.findFirst({
        where: { storyId: input.storyId, status: { in: ['pending', 'claimed'] } },
        select: { id: true },
      });
      if (active) {
        await tx.wakeupQueue.update({
          where: { id: active.id },
          data: { attempts: { increment: 1 }, reason: input.reason },
        });
      } else {
        await tx.wakeupQueue.create({
          data: { storyId: input.storyId, reason: input.reason, epicId: input.epicId ?? null },
        });
      }
    });
  }

  /** Marca um wakeup como reivindicado pelo processador in-process. */
  async claim(storyId: string): Promise<void> {
    await this.prisma.wakeupQueue.updateMany({
      where: { storyId, status: 'pending' },
      data: { status: 'claimed', claimedAt: new Date() },
    });
  }

  /** Fecha o wakeup (sucesso). */
  async complete(storyId: string): Promise<void> {
    await this.prisma.wakeupQueue.updateMany({
      where: { storyId, status: { in: ['pending', 'claimed'] } },
      data: { status: 'done', processedAt: new Date() },
    });
  }

  /** Reabre wakeups 'claimed' órfãos no boot (a sessão in-process morreu). */
  async recoverOnBoot(): Promise<{ storyId: string; reason: WakeupReason }[]> {
    const orphans = await this.prisma.wakeupQueue.findMany({
      where: { status: 'claimed' },
      select: { storyId: true, reason: true },
    });
    await this.prisma.wakeupQueue.updateMany({
      where: { status: 'claimed' },
      data: { status: 'pending', claimedAt: null },
    });
    return orphans as never;
  }
}
```

## 3.4 Integração no `Orchestrator` (pontos exatos)

1. **Injetar** `WakeupQueueService` no `Orchestrator` (construtor) e registrar no
   módulo `ai-engine` (provider).
2. **Enfileirar** em vez de/além de acordar direto. Nos gatilhos:
   - `cards.service.ts:587` (`onStoryEnterInProgress`) →
     `enqueue({storyId, reason:'story_in_progress', epicId})`.
   - `maybeResumeLoopOnTaskAdded` (`cards.service.ts:406`) →
     `enqueue({..., reason:'task_added'})`.
   - resposta de HITL que retoma → `reason:'hitl_answered'`.
   - `stepOnce` (`orchestrator.ts:1152`) → `reason:'manual_step'`.
3. **Coalescing do conflito de serialização:** hoje quando
   `findConflictingActiveStory` retorna conflito, o wakeup é perdido
   (`orchestrator.ts:126-137`). Com a fila, o registro **permanece `pending`** →
   `resumeDeferredForStory` (`orchestrator.ts:1189-1231`) drena a fila em vez de
   varrer só o board, e o wakeup **não se perde**.
4. **Claim/complete:** em `onStoryEnterInProgress`, após passar os guards e criar
   a sessão (`orchestrator.ts:139`), chamar `queue.claim(storyId)`. Em
   `finishAuto` (`orchestrator.ts:1160`), chamar `queue.complete(storyId)` **antes**
   de `resumeDeferredForStory`.
5. **Boot:** em `reconcileOnBoot` (`orchestrator.ts:92`), primeiro
   `await queue.recoverOnBoot()` (reabre `claimed` órfãos), depois **enfileira**
   as stories em In Progress achadas no board com `reason:'reconcile'`, e então
   drena a fila. Assim a fila e o board convergem.

> **Sem Redis (invariante 7):** o `setInterval`/`AgentSessionManager` continuam
> sendo o executor. A fila é só **estado durável** no Postgres. Não adicione
> BullMQ nem worker externo.

## 3.5 Plano PR-a-PR

**PR-1 (schema + migration):**
1. `schema.prisma`: adicionar model `WakeupQueue`, enums `WakeupStatus`/
   `WakeupReason`, e a relação reversa `wakeups WakeupQueue[]` em `Card`.
2. `npm run db:migrate -- --create-only --name add_wakeup_queue`; **editar o
   `.sql`** para trocar o índice por um **índice único parcial** (§3.3 nota).
   Aplicar com `npm run db:migrate:deploy`.

**PR-2 (serviço de fila):**
3. Criar `apps/api/src/modules/ai-engine/wakeup-queue.service.ts` (§3.3).
4. Registrar como provider no módulo `ai-engine` e injetar no `Orchestrator`.

**PR-3 (integração no engine):**
5. Alterar `onStoryEnterInProgress`, `finishAuto`, `reconcileOnBoot`,
   `resumeDeferredForStory`, `stepOnce` (§3.4). Alterar os gatilhos em
   `cards.service.ts` para enfileirar.
6. Manter `AgentSessionManager` como executor (não substituir).

**PR-4 (shared opcional + web):**
7. Se o web exibir status de fila: exportar `WAKEUP_STATUS`/`WAKEUP_REASON`
   (§3.3), `npm run build -w @kanban-ai/shared`, e consumir onde relevante.

## 3.6 Pontos de integração

- **Gatilhos:** `cards.service.ts` (move, task-added), `orchestrator.ts`
  (stepOnce, HITL resume).
- **Serialização:** `resumeDeferredForStory` (`orchestrator.ts:1189`) passa a
  drenar a fila.
- **Boot:** `reconcileOnBoot` (`orchestrator.ts:92`) + `recoverOnBoot`.
- **Sessões:** `AgentSessionManager` inalterado como executor (extensão futura
  BullMQ documentada no próprio arquivo — não fazer no v1).

## 3.7 DOD verificável

- [ ] `npm run build && npm run lint && npm test` verdes.
- [ ] Migration aplicada; `\d "WakeupQueue"` mostra a tabela + índice único
  parcial `WHERE status IN ('pending','claimed')`.
- [ ] **Coalescing:** disparar 3 wakeups seguidos para a mesma story cria **1**
  linha `pending` com `attempts=3` (spec de `WakeupQueueService`).
- [ ] **Idempotência:** `enqueue` concorrente para a mesma story não viola o
  índice único (transação/`findFirst`+create).
- [ ] **Sobrevive a restart:** com uma story `claimed` e a "API reiniciando",
  `recoverOnBoot()` a devolve para `pending` e `reconcileOnBoot` a reprocessa
  (teste de integração com `MockAgentRunner`).
- [ ] **Sem regressão de serialização:** duas stories do mesmo epic continuam
  serializadas; a segunda fica `pending` e é drenada quando a primeira completa.
- [ ] Nenhuma dependência de Redis/BullMQ adicionada (`package.json` inalterado
  nesse aspecto).

## 3.8 Riscos / invariantes / retrocompatibilidade

- **Invariante 7 (in-process, sem Redis):** respeitado — a fila é só estado
  Postgres; o executor segue `setInterval`/`AgentSessionManager`.
- **Invariante 6:** o gatilho continua sendo story→In Progress; a fila é a
  camada durável **entre** o gatilho e o executor.
- **Risco de índice parcial:** Prisma não o descreve no schema → **tem** que ser
  editado na migration à mão; um `migrate reset` regenera e **perde** a edição se
  a migration for recriada. Documente isso no ADR-0032 e mantenha a migration
  versionada.
- **Retrocompat:** enquanto a fila não é drenada, o comportamento antigo (acordar
  direto) pode coexistir; migre os gatilhos de forma que `enqueue` + drenar
  produza o **mesmo** efeito observável (story acorda). Nada no board muda de
  contrato.
- **Risco de fila "presa":** um `claimed` órfão (crash) é recuperado no boot;
  adicione um watchdog opcional (reusar `AGENT_WATCHDOG_INTERVAL_MS`) que reabra
  `claimed` muito antigos — **opcional**, não bloqueante.

---
---

# US-COLAB4 — `@mention` delegation no backlog-chat

## 4.1 Estado atual (verificado)

- **Assignees = agents** (`schema.prisma:395-406`): `Assignee { id, boardId,
  name, model?, instructions }`. Relação N:N com `Card` via `CardAssignee`
  (`schema.prisma:477`). CRUD em `AssigneesService`
  (`apps/api/src/modules/assignees/assignees.service.ts`): `findAll(boardId?)`,
  `create({boardId, name, model?, instructions?})`, `remove(id)`.
- **Anexar assignee a um card** já existe: `POST /cards/:id/assignees` com
  `attachAssigneeSchema = { assigneeId: z.string().uuid() }`
  (`cards.schema.ts:110-114`; controller `cards.controller.ts:116-121` →
  `CardsService.attachAssignee(id, dto)`). Emite `assignee.attached`
  (`events.ts:68`).
- **Criar task** passa **sempre** por `CardsService.create`
  (`cards.service.ts:285`), que garante os invariantes (task só em Backlog/To Do
  `cards.service.ts:279`, sem pontos `cards.service.ts:287`) e auto-retoma o loop
  (`maybeResumeLoopOnTaskAdded`). **`CreateCardDto` NÃO aceita `assigneeIds`**
  (`cards.schema.ts:5-27`) — assignees são anexados por **rota separada**.
- **backlog-chat** materializa tasks numa story via
  `BacklogChatOrchestrator.materializeStoryTasks(storyCardId, tasks[])`
  (`backlog-chat.orchestrator.ts:1143-1186`) — loop de `this.cards.create({
  type:'task', ..., parentId: story.id })`. Endpoint:
  `POST /backlog-chat/:storyId/tasks` (`backlog-chat.controller.ts:148-153`).
- **Mensagem do usuário** entra por `sendMessage(sessionId, text, channel)`
  (`backlog-chat.orchestrator.ts:226-258`): persiste a msg (`role:'user'`) e
  dispara `runTurn` em background. Endpoint: `POST /backlog-chat/:cid/messages`
  (`backlog-chat.controller.ts:71-77`).
- **Contrato compartilhado** do backlog-chat em `packages/shared/src/backlog-chat.ts`:
  `BacklogProposalTask` (`:182`), `MaterializeStoryTaskInput` (`:249`),
  `BACKLOG_MAIN_CHANNEL='main'` (`:23`), markers `<<<KANBAN_TASKS>>>` etc.
  (`:336-344`). É o lugar canônico para adicionar o contrato de menção.
- **Loop profiles** (US-COLAB2) são resolvidos por `loopType` da task
  (`resolveLoopProfile`, `loop-profiles.ts:59`). Um "perfil" mencionável mapeia
  para um `loopType` (`feature`/`bug`/`refactor`/`orchestrator`).

## 4.2 Gap

Não há forma de, **a partir do texto do chat**, delegar trabalho a um agent:
escrever `@backend` numa mensagem hoje é texto puro. Queremos que
`@<nome-do-assignee-ou-perfil>` em uma mensagem do backlog-chat:
1. seja **parseado** (extrair as menções do texto);
2. **crie uma task** (via `CardsService.create`, respeitando invariantes) na story
   corrente da sessão;
3. **atribua** a task ao assignee mencionado (via `attachAssignee`) e/ou defina o
   `loopType` do perfil mencionado.

## 4.3 Contrato proposto

### Parser de menções (`packages/shared/src/backlog-chat.ts`)

Contrato **puro e testável** no pacote shared (consumido por api; opcionalmente
web para realce):

```ts
// packages/shared/src/backlog-chat.ts

/** US-COLAB4 — uma diretiva de delegação extraída de uma mensagem do chat. */
export interface MentionDirective {
  /** Handle mencionado, sem o '@' (ex.: 'backend', 'orchestrator'). */
  handle: string;
  /**
   * Título da task derivado do texto após a menção (até o fim da linha ou
   * próxima menção). Pode ser vazio se a menção estiver sozinha.
   */
  taskTitle: string;
}

/** Regex canônica de menção: '@' seguido de [A-Za-z0-9_-]+ (case-insensitive). */
export const MENTION_PATTERN = /@([A-Za-z0-9_-]+)/g;

/**
 * Extrai as diretivas de menção de um texto de chat. Retrocompatível: texto sem
 * '@' retorna []. Usada pelo backlog-chat para delegar tasks a agents.
 */
export function parseMentions(text: string): MentionDirective[] {
  const out: MentionDirective[] = [];
  if (!text) return out;
  const matches = [...text.matchAll(MENTION_PATTERN)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const handle = m[1];
    const start = (m.index ?? 0) + m[0].length;
    const end = matches[i + 1]?.index ?? text.length;
    const taskTitle = text.slice(start, end).trim().replace(/\s+/g, ' ');
    out.push({ handle, taskTitle });
  }
  return out;
}
```

> **Resolução do handle → alvo:** o `handle` pode bater em **(a)** um `Assignee`
> pelo `name` (case-insensitive) do board, e/ou **(b)** um `LoopProfileId`
> (`feature`/`bug`/`refactor`/`orchestrator`). Política sugerida (documente no
> ADR-0033): tentar assignee primeiro; se não achar, tentar loopType; se ambos,
> anexar assignee **e** setar loopType. Se nenhum, ignorar a menção (ou responder
> um aviso no chat) — **nunca** criar task órfã sem alvo.

### Sem mudança de schema

Reusa `Assignee` + `CardAssignee` + `Card.loopType`. **Nenhuma** coluna nova.

## 4.4 Integração no `BacklogChatOrchestrator`

Ponto de entrada: `sendMessage(sessionId, text, channel)`
(`backlog-chat.orchestrator.ts:226`). **Antes** de disparar `runTurn`, processe
as menções (elas são determinísticas e não precisam da CLI):

```ts
// dentro de sendMessage, após persistir a msg do usuário (linha ~236) e antes
// do void this.runTurn(...):
const directives = parseMentions(text);
if (directives.length) {
  await this.delegateFromMentions(sessionId, directives, channel);
}
```

Novo método privado (usa APIs já existentes — não reinventar):

```ts
/**
 * US-COLAB4 — cria+atribui uma task por menção. Reusa CardsService.create
 * (invariantes garantidos) e CardsService.attachAssignee. Resolve o card story
 * da sessão (mesmo caminho de materializeStoryTasks).
 */
private async delegateFromMentions(
  sessionId: string,
  directives: MentionDirective[],
  channel: string,
): Promise<void> {
  // 1. resolver a story-card da sessão (reusar o helper de resolveStoryCard /
  //    o mesmo lookup de materializeStoryTasks: Card com backlogChatSessionId).
  const story = await this.prisma.card.findFirst({
    where: { backlogChatSessionId: sessionId, type: 'story' },
    select: { id: true, boardId: true },
  });
  if (!story) return; // sem story materializada ainda: ignore (ou avise no chat)

  for (const d of directives) {
    // 2. resolver o alvo: assignee por nome (case-insensitive) e/ou loopType.
    const assignee = (await this.assignees.findAll(story.boardId)).find(
      (a) => a.name.toLowerCase() === d.handle.toLowerCase(),
    );
    const loopType = ['feature', 'bug', 'refactor', 'orchestrator'].includes(
      d.handle.toLowerCase(),
    )
      ? d.handle.toLowerCase()
      : undefined;
    if (!assignee && !loopType) continue; // menção desconhecida: ignore

    // 3. criar a task (invariantes garantidos em CardsService.create).
    const task = await this.cards.create({
      boardId: story.boardId,
      type: 'task',
      title: d.taskTitle || `Delegado para @${d.handle}`,
      parentId: story.id,
      ...(loopType ? { loopType } : {}),
    });

    // 4. atribuir o assignee, se resolvido (rota já existente).
    if (assignee) {
      await this.cards.attachAssignee(task.id, { assigneeId: assignee.id });
    }
  }
}
```

> **Injeção:** `BacklogChatOrchestrator` já injeta `CardsService` (usado em
> `materializeStoryTasks`) e `PrismaService`. Adicione `AssigneesService` ao
> construtor e ao módulo `backlog-chat` (provider/import do `AssigneesModule`).

## 4.5 Plano PR-a-PR

**PR-1 (contrato shared — os DOIS lados):**
1. `packages/shared/src/backlog-chat.ts`: adicionar `MentionDirective`,
   `MENTION_PATTERN`, `parseMentions`.
2. `npm run build -w @kanban-ai/shared`. Spec unitária de `parseMentions`
   (casos: sem menção, uma menção, várias, menção sozinha, handles com `-`/`_`).

**PR-2 (api — delegação):**
3. `backlog-chat.orchestrator.ts`: injetar `AssigneesService`; adicionar
   `delegateFromMentions`; chamar em `sendMessage` antes de `runTurn`.
4. `backlog-chat.module.ts`: importar `AssigneesModule` (ou prover
   `AssigneesService`).
5. Reusar `CardsService.create`/`attachAssignee` (não duplicar lógica).

**PR-3 (web — opcional, realce/UX):**
6. `apps/web/src/features/backlog-chat/`: usar `MENTION_PATTERN`/`parseMentions`
   para realçar `@handle` no input e mostrar as tasks criadas (o realtime
   `card.created`/`assignee.attached` já atualiza o board — ADR-0012). Nenhuma
   rota nova necessária.

## 4.6 Pontos de integração

- **Parser:** `packages/shared/src/backlog-chat.ts` (puro, testável).
- **Entrada de chat:** `BacklogChatOrchestrator.sendMessage`
  (`backlog-chat.orchestrator.ts:226`).
- **Criação de task:** `CardsService.create` (`cards.service.ts:285`) — **único**
  caminho (invariantes). NÃO criar task direto no Prisma.
- **Atribuição:** `CardsService.attachAssignee` (`cards.controller.ts:116` /
  `cards.service.ts`) — reusar.
- **Perfil (US-COLAB2):** `@orchestrator` seta `loopType='orchestrator'` →
  integra com o board-manager.
- **Realtime:** `card.created` (`events.ts:31`) e `assignee.attached`
  (`events.ts:68`) já são emitidos por `create`/`attachAssignee` → o board
  atualiza sozinho.

## 4.7 DOD verificável

- [ ] `npm run build && npm run lint && npm test` verdes (incluindo shared).
- [ ] `parseMentions('@backend corrige o login')` → `[{handle:'backend',
  taskTitle:'corrige o login'}]`; `parseMentions('sem mencao')` → `[]`; múltiplas
  menções separadas corretamente (spec unitária).
- [ ] `sendMessage` com `@<assignee-existente> <texto>` cria **uma** task na story
  da sessão, na coluna To Do/Backlog (invariante 3), e a **atribui** ao assignee
  (verificar `CardAssignee` + evento `assignee.attached`).
- [ ] `@<perfil>` (`@feature`/`@orchestrator`) cria task com `loopType` = perfil.
- [ ] Menção desconhecida (`@ninguem`) **não** cria task órfã.
- [ ] Texto sem menção não muda o comportamento atual do chat (retrocompat —
  `runTurn` segue igual).
- [ ] Teste de integração em `backlog-chat.orchestrator.spec.ts` cobrindo os
  casos acima.

## 4.8 Riscos / invariantes / retrocompatibilidade

- **Invariante 3:** a task nasce via `CardsService.create` → coluna
  Backlog/To Do garantida. NÃO burlar criando direto no Prisma.
- **Invariante 5:** task não recebe `points` (o `create` já rejeita).
- **Invariante 6:** se a story já está em In Progress,
  `maybeResumeLoopOnTaskAdded` (disparado por `create`) retoma o loop — a task
  delegada por menção entra no loop naturalmente.
- **Risco:** menção ambígua (mesmo nome de assignee e de loopType). Política
  explícita no ADR-0033 (assignee primeiro; ou anexar assignee **e** setar
  loopType). Determinística e documentada.
- **Risco:** spam de menções cria muitas tasks. Mitigação v1: criar no máximo
  1 task por menção distinta por mensagem (dedup por `handle` na mesma msg).
- **Retrocompat:** sem `@` → `parseMentions` retorna `[]` → nada muda.

---
---

## Apêndice A — Comandos de validação (todas as US)

```bash
# Build + lint + testes (obrigatório antes de concluir QUALQUER US)
npm run build && npm run lint && npm test

# Banco (US-COLAB1 e US-COLAB3)
npm run db:migrate            # gera + aplica em dev
npm run db:migrate:deploy     # aplica migrations existentes (CI/restrito)
npm run db:seed               # re-semeia após reset

# Smoke do backend
curl localhost:3333/health

# Build só do pacote de contratos (após mexer em packages/shared)
npm run build -w @kanban-ai/shared
```

> **Ambiente restrito (Prisma sem TCP de saída):** rode operações de banco dentro
> da rede do Docker — ver [`CONTRIBUTING.md`](../../CONTRIBUTING.md#banco-de-dados-em-ambientes-restritos).

## Apêndice B — Regra de ouro do contrato compartilhado

Qualquer mudança em `packages/shared/src/*` (enums, domain, backlog-chat) é
consumida por **web E api**. Ao mudar um contrato:
1. edite `packages/shared`;
2. `npm run build -w @kanban-ai/shared` (o pacote é CommonJS);
3. corrija os erros de tipo que aparecem **nos dois lados** (o TypeScript aponta);
4. só então rode `npm run build && npm run lint && npm test` no monorepo.

## Apêndice C — Índice de símbolos verificados (âncoras rápidas)

| Símbolo / arquivo | Onde | Uso na spec |
|---|---|---|
| `Card` model | `apps/api/prisma/schema.prisma:89` | US-COLAB1 (`tenantId`), US-COLAB3 (relação `wakeups`) |
| `CardsService.findAll` | `apps/api/src/modules/cards/cards.service.ts:46` | US-COLAB1 (filtro tenant) |
| `listCardsQuerySchema` | `apps/api/src/modules/cards/cards.schema.ts:36` | US-COLAB1 |
| `CardsService.create` | `.../cards.service.ts:285` | US-COLAB4 (criação de task) |
| `TASK_CREATION_COLUMNS` | `packages/shared/src/enums.ts:72` | invariante 3 |
| `LoopProfileId` | `packages/shared/src/enums.ts:44` | US-COLAB2 |
| `BUILTIN_LOOP_PROFILES` / `LoopProfileDef` | `.../ai-engine/loop-profiles/loop-profiles.ts:18` / `:6` | US-COLAB2 |
| `resolveLoopProfile` | `.../loop-profiles.ts:59` | US-COLAB2, US-COLAB4 |
| `Orchestrator.buildPrompt` | `.../ai-engine/orchestrator.ts:2579` | US-COLAB2 (prompt restrito) |
| `Orchestrator.onStoryEnterInProgress` | `.../orchestrator.ts:110` | US-COLAB3 |
| `Orchestrator.reconcileOnBoot` | `.../orchestrator.ts:92` | US-COLAB3 |
| `Orchestrator.startAuto/finishAuto` | `.../orchestrator.ts:1120` / `:1160` | US-COLAB3 |
| `Orchestrator.resumeDeferredForStory` | `.../orchestrator.ts:1189` | US-COLAB3 |
| `AgentSessionManager` | `.../session-manager/agent-session-manager.ts` | US-COLAB3 (executor) |
| `CardsService.move` (story→In Progress) | `.../cards.service.ts:578` | invariante 6, US-COLAB3 gatilho |
| `maybeResumeLoopOnTaskAdded` | `.../cards.service.ts:376` | US-COLAB3 gatilho, US-COLAB4 |
| `Assignee` model / `AssigneesService` | `schema.prisma:395` / `.../assignees/assignees.service.ts` | US-COLAB4 |
| `attachAssignee` / `attachAssigneeSchema` | `cards.controller.ts:116` / `cards.schema.ts:110` | US-COLAB4 |
| `BacklogChatOrchestrator.sendMessage` | `.../backlog-chat/backlog-chat.orchestrator.ts:226` | US-COLAB4 |
| `materializeStoryTasks` | `.../backlog-chat.orchestrator.ts:1143` | US-COLAB4 (padrão) |
| `parseMentions` (novo) | `packages/shared/src/backlog-chat.ts` | US-COLAB4 |
| WS events (`card.created`, `assignee.attached`, `story.entered_in_progress`) | `packages/shared/src/events.ts:31/68/135` | integração realtime |
| `apiClient.getCards` | `apps/web/src/shared/services/apiClient.ts:106` | US-COLAB1 (web) |
