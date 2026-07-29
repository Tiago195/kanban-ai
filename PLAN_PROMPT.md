# Prompt de Planejamento — kanban-ai (fundação do repositório)

> Cole este arquivo (ou seu conteúdo) no **modo plan** para gerar o plano de
> implementação da **fundação** do projeto `kanban-ai`.

---

## Contexto

Vamos construir um **Kanban Agile controlado por AIs autônomas**. Diferente de um
board comum, os *assignees* NÃO são humanos: são **agents autônomos** que executam
trabalho de desenvolvimento de software em **loop**. O produto já existe como
**protótipo funcional** num único arquivo HTML (`docs/reference/kanban.html`), que
deve ser tratado como a **especificação funcional de referência**.

O objetivo AGORA **não é** implementar o produto inteiro. É entregar a **FUNDAÇÃO
do repositório**: documentação de arquitetura, guias para desenvolvimento com AI,
convenções, e scaffolding de código executável (estrutura de pastas, configs,
schema Prisma, interfaces-chave stubadas, health-check rodando). O produto real
será desenvolvido depois — em grande parte pelas próprias AIs — em cima desta base.

Repositório-alvo: `/home/tmeireles/dev/demo/kanban-ai` (vazio).

---

## Ideia central do produto (para o plano entender o domínio)

Hierarquia de artefatos: **Epic → Story → Task**.

- O **board principal** exibe apenas **stories** (colunas: To Do, In Progress, Review, Done).
- **Epic** é um nível acima; não aparece no board principal. Seu fluxo é **derivado**
  automaticamente das stories filhas (se uma story vai para In Progress, o epic vai
  para In Progress; etc.). Ninguém move o epic diretamente.
- **Tasks** vivem dentro de uma story, exibidas num **mini-kanban** dentro do modal da
  story (com drag-and-drop próprio). Modais abrem em **cascata lado a lado**
  (Epic → Story → Task), nunca sobrepostos.
- Só é possível **criar task** nas colunas **Backlog/To Do**.
- Stories têm **story points** (1,2,3,5,8,13), **DOD** (Definition of Done),
  **descrição**, **labels** (removíveis), **assignees** (agents autônomos, criáveis).
  > NOTA: o **DOR (Definition of Ready) foi removido no v1**. Não reintroduzir.

### Loop engine de AI (o núcleo)

Quando uma **story entra em "In Progress"**, um **evento acorda um agent** que passa a
trabalhar em **iterações encadeadas**:

1. Cada iteração entende o que precisa ser feito, onde mexer e os efeitos colaterais;
   registra um **diário de iteração minucioso** (para a próxima iteração ler) + um
   **comentário resumido** do que foi feito; e deixa claro **o que a próxima iteração
   deve fazer**.
2. Ao longo das iterações, a AI vai **marcando os itens de DOD** das tasks.
3. Quando **todos os DOD** estão marcados, uma **iteração final de validação** roda:
   valida empiricamente TUDO que foi implementado, fazendo **teste de mesa** dos
   **fluxos afetados** (a story declara quais fluxos/áreas do código ela afeta —
   campo `affectedFlows`).
4. Se a validação final **encontra problemas**, ela **cria uma nova task** na story
   (com todos os campos e uma **ligação `derivedFrom`/`dependsOn`** com a task de
   origem), para a próxima AI atacar com contexto completo.

O comportamento individual do loop **depende do tipo de label** (feature, bug, etc.) —
cada tipo tem seu **loop profile** (individualidades a mapear).

Comunicação em tempo real é via **WebSocket** (sem F5 para ver mudanças).

---

## Decisões de arquitetura JÁ TOMADAS (o plano deve respeitar)

### Monorepo (npm workspaces — usar **npm**, não pnpm)

```
kanban-ai/
├── apps/
│   ├── web/        # Frontend
│   └── api/        # Backend
├── packages/
│   └── shared/     # Tipos/contratos compartilhados (DTOs, enums de status, eventos WS)
├── docs/
│   ├── reference/  # kanban.html (spec funcional de referência) + notas
│   └── adr/        # Architecture Decision Records
├── AGENTS.md       # raiz
├── ARCHITECTURE.md
├── CONTRIBUTING.md
└── README.md
```

### Frontend — `apps/web`
- **React + Vite + TypeScript**.
- **shadcn/ui + Tailwind** para componentes.
- **Arquitetura feature-based**:
  ```
  src/
  ├── assets/
  ├── features/            # módulos isolados por funcionalidade de negócio
  │   └── <feature>/
  │       ├── components/  # componentes exclusivos da feature
  │       ├── hooks/       # hooks específicos
  │       ├── services/    # chamadas de API
  │       ├── types/       # tipagens locais
  │       └── index.ts     # ponto de entrada (exporta só o público)
  ├── shared/              # genéricos reutilizáveis
  │   ├── components/      # UI genérica
  │   ├── hooks/
  │   ├── services/        # apiClient
  │   ├── utils/
  │   └── types/
  ├── main.tsx
  └── App.tsx
  ```
- Features previstas (mapear a partir do artifact): `board`, `epics`, `stories`,
  `tasks`, `labels`, `assignees`, `ai-engine` (visão de iterações/loop no cliente),
  `realtime`.

### Backend — `apps/api`
- **NestJS com adapter Fastify** (estrutura opinativa + performance).
- **Prisma** sobre **Postgres**.
- Estrutura modular/feature-based:
  ```
  server/src/
  ├── modules/
  │   ├── boards/
  │   ├── cards/          # Epic/Story/Task, hierarquia, points, DOD
  │   ├── labels/
  │   ├── assignees/      # agents autônomos
  │   └── ai-engine/      # LOOP ENGINE (núcleo)
  │       ├── loop-profiles/   # feature, bug, etc.
  │       ├── iterations/       # diário de iterações
  │       ├── orchestrator.ts   # acorda AI quando story→in progress
  │       ├── session-manager/  # AgentSessionManager in-process (interface plugável)
  │       ├── runners/          # AgentRunner (interface) + CopilotCliRunner (v1)
  │       └── validators/       # iteração final de validação de fluxos
  ├── realtime/           # WebSocket gateway + eventos
  ├── workspaces/         # gestão de git worktree do repo-alvo
  ├── shared/             # config, db (Prisma), errors, logger, utils
  ├── prisma/             # schema.prisma, migrations, seed
  └── main.ts
  ```

### Loop engine — decisões
- **AgentRunner** é uma **interface plugável**. Implementação v1: **Copilot CLI**
  (o backend chama a Copilot CLI como subprocesso e captura o resultado).
- Deve ser possível **escolher qual agent/modelo roda** por task/loop
  (ex: opus, gpt, etc.).
- **Projeto-alvo**: cada board/story aponta para um **repositório-alvo** (git local
  ou remoto). Cada execução usa um **git worktree isolado**.
- **Orquestração simples in-process (SEM Redis no v1)**:
  - Story → In Progress **dispara um evento** que "acorda" o agent; ao terminar uma
    iteração, a próxima já começa (encadeamento).
  - Um **watchdog `setInterval` de 2 min**, ativo enquanto a story está viva em
    In Progress, verifica se a sessão do agent está acordada/rodando; se algo
    interrompeu o fluxo, envia mensagem para a **mesma sessão** para retomar.
  - O interval **morre** quando a story vai para Review/Done ou alguém **para
    manualmente**.
  - O **`AgentSessionManager` fica atrás de uma interface plugável** para poder ser
    trocado por **BullMQ + Redis** no futuro sem mexer no resto.
  - **4 salvaguardas obrigatórias** (todas in-process, sem Redis):
    1. **Reconciliation no boot**: ao subir, varrer stories em In Progress no Postgres
       e **recriar os watchdogs** (estado de verdade no banco, não na memória).
    2. **Limite de concorrência**: máx N sessões ativas; excedente aguarda slot.
    3. **Idempotência do watchdog**: o "cutucão" de 2 min **não** inicia uma segunda
       iteração se uma já estiver rodando (cada sessão tem estado
       `running`/`idle`/`dead`; watchdog só age em `dead`/`idle-travado`).
    4. **Encerramento limpo**: cancelar a iteração em curso via **AbortSignal** ao
       subprocess do Copilot CLI.
  - **Stop manual tem DOIS modos, ambos disponíveis**:
    - **Graceful**: espera a iteração atual finalizar e **não inicia a próxima**.
    - **Hard/abort**: **interrompe tudo imediatamente** (AbortSignal no subprocess).

### Persistência
- **Postgres** + **Prisma**.
- Modelar (a partir do artifact): Board, Card (com discriminador Epic/Story/Task,
  hierarquia via `parentId`), colunas/status, StoryPoints, DOD items, Label,
  Assignee (agent), Comment, Activity, AffectedFlow, Iteration (diário),
  LoopProfile, e ligações `derivedFrom`/`dependsOn` entre tasks.
- Storage do protótipo usa chaves `EP-`/`US-`/`TK-` e enum de status — considerar
  como referência de domínio.

### Sem auth no v1
- Single-tenant local. Deixar apenas o ponto de extensão (guards) previsto, sem
  implementar login.

### Realtime
- **WebSocket** para refletir mudanças sem F5. Definir o **contrato de eventos**
  (ex: `card.moved`, `iteration.appended`, `story.entered_in_progress`,
  `agent.session.state_changed`, `task.derived`) em `packages/shared`.

---

## Documentação de desenvolvimento com AI (entregar nesta fundação)

- **`AGENTS.md` na raiz** + um **`AGENTS.md` por módulo** relevante (especialmente
  `ai-engine`, `cards`, `realtime`, `workspaces`), descrevendo: propósito do módulo,
  contratos/interfaces, invariantes, o que NÃO mexer, como testar, e convenções.
- **`ARCHITECTURE.md`**: visão macro (diagrama textual do fluxo
  web ↔ api ↔ ai-engine ↔ repo-alvo), boundaries entre módulos, contrato WS,
  e a mecânica do loop engine.
- **`CONTRIBUTING.md` / convenções**: padrões de código, naming, estrutura de
  pastas, commits, como rodar/testar, como a AI deve trabalhar no repo (guard-rails).
- **ADRs** em `docs/adr/`: registrar as decisões acima (monorepo npm, NestJS+Fastify,
  Prisma, orquestração in-process com watchdog + adapter plugável, AgentRunner
  plugável, git worktree por execução, remoção do DOR no v1, etc.).
- **Doc dedicado do Loop Engine** (ex: `docs/loop-engine.md`): estados da sessão,
  ciclo de iteração, diário, gate de DOD, iteração de validação final, criação de
  task derivada, loop profiles por label, stop graceful vs hard, watchdog e as 4
  salvaguardas, e o ponto de extensão para BullMQ.
- **Copiar o artifact** `kanban.html` para `docs/reference/` como spec funcional.

---

## O que a fundação deve ENTREGAR concretamente (escopo do plano)

1. **Docs completos** listados acima.
2. **Scaffolding executável**:
   - Monorepo npm workspaces configurado (raiz + `apps/web`, `apps/api`,
     `packages/shared`).
   - `apps/api`: NestJS+Fastify subindo com **health-check** (`GET /health`
     respondendo), Prisma conectado ao Postgres com `schema.prisma` modelado e uma
     **migration inicial** + **seed** (baseado no seed do artifact), WebSocket gateway
     básico ativo, e **interfaces-chave stubadas** (`AgentRunner`,
     `AgentSessionManager`, `LoopProfile`, `Orchestrator`, `WorkspaceService`) com
     TODOs claros.
   - `apps/web`: React+Vite+TS+Tailwind+shadcn inicializado, `apiClient` e cliente
     WS configurados, App raiz + layout mínimo, estrutura de `features/`+`shared/`
     criada com um placeholder navegável (não precisa portar o board inteiro).
   - `packages/shared`: enums de status, DTOs de card, e **contrato de eventos WS**
     tipados, consumidos por web e api.
   - Configs: TypeScript, ESLint/Prettier, `.env.example` (DATABASE_URL, portas,
     modelo default do agent), `docker-compose.yml` para Postgres local, scripts npm
     na raiz (`dev`, `build`, `lint`, `db:migrate`, `db:seed`).
3. **Validação**: `npm run build` e `npm run lint` passam; `GET /health` responde;
   `npm run dev` sobe web + api; migration aplica; seed popula.

---

## O que o plano deve produzir

- Uma **lista de fases/tarefas** ordenada com dependências, cobrindo docs + scaffolding.
- Para cada tarefa: objetivo, arquivos/dirs afetados, e critério de "pronto".
- Destacar **decisões ainda em aberto** que o plano identificar (ex: nomes exatos de
  tabelas Prisma, formato do payload que o CopilotCliRunner envia/recebe, estratégia
  de detecção de "iteração terminou").
- **Não** implementar o produto completo — parar na fundação executável descrita acima.

## Restrições
- Usar **npm** (não pnpm/yarn).
- Não reintroduzir **DOR**.
- Manter tudo **type-safe** e com boundaries claros (guard-rails para AI).
- Preferir ferramentas de ecossistema (CLIs de scaffold: `nest new`, `vite`,
  `shadcn init`, `prisma init`) em vez de escrever boilerplate à mão quando possível.
