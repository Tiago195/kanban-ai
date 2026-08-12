# ADR-0030 — Multi-tenant por coluna `tenantId` nullable

**Status:** Aceito

**Data:** 2026-08-12

## Contexto

O board hoje é **single-tenant**: todos os cards vivem num único espaço, sem
isolamento por projeto/cliente. O v1 assume isso deliberadamente
([ADR-0009](0009-no-auth-v1.md) — sem autenticação no v1).

A análise das ferramentas de referência (**Hermes Kanban**) mostra o multi-tenant
implementado da forma mais barata possível: **uma coluna** de tenant nas tasks,
com filtro na leitura. O kanban-ai já tem um precedente conceitual de **escopo**
na memória viva ([ADR-0027](0027-memory-as-a-living-service.md)): a escrita é
classificada por escopo (`WRITE_SCOPE`/`MemoryPolicyService.scopeFor`), com leitura
global e escrita restrita. O multi-tenant do board **ecoa** esse padrão de escopo.

Introduzir tenancy destrava operar múltiplos projetos/clientes no mesmo deploy sem
duplicar infraestrutura — mas precisa ser **retrocompatível**, já que não há auth
no v1 e o comportamento atual (um espaço único) deve continuar valendo por default.

## Decisão

Adicionar uma coluna **`tenantId` nullable** ao model `Card` (Prisma), com filtro
opcional na query do board e no escopo.

- `tenantId = null` ⇒ **comportamento atual** (espaço único), 100% retrocompatível.
- Quando presente, a listagem/board **isola** cards por tenant.
- **Política de filtro: estrito.** Quando a query passa `tenantId`, `findAll`
  aplica `where.tenantId = tenantId` — retorna **apenas** cards com esse tenantId
  exato. Cards globais (`tenantId = null`) **não** vazam para dentro de um tenant.
  Sem `tenantId` na query, nenhuma cláusula é adicionada → todos os cards do board
  (retrocompat). Se o produto quiser "tenant + globais", trocar por
  `where.OR = [{ tenantId }, { tenantId: null }]` é uma decisão explícita futura,
  não o default.
- A tenancy **não** introduz autenticação (segue o ADR-0009); é apenas
  particionamento lógico de dados. Amarrar tenant a identidade fica para um ADR
  futuro se/quando auth entrar.
- O escopo de tenant conversa com o padrão de escopo da memória viva (ADR-0027),
  mas **não** os acopla neste ADR — a memória permanece com sua própria política.

O schema Prisma exato, a migration, os pontos de filtro (board query) e os specs
estão em [`docs/specs/ep-colab.md`](../specs/ep-colab.md) (US-COLAB1).
Implementação: coluna `Card.tenantId String?` + `@@index([boardId, tenantId])`
(migration `add_card_tenant_id`), campo opcional `tenantId?` em
`CardBase` (`packages/shared/src/domain.ts`), filtro em `CardsService.findAll`
(`if (tenantId) where.tenantId = tenantId`), `tenantId` opcional em
`listCardsQuerySchema`/`createCardSchema` e param opcional em
`apiClient.getCards`.

## Consequências

- **Positivas:** multi-projeto/cliente no mesmo deploy; mudança mínima (1 coluna +
  filtro); retrocompatível (null = hoje); alinhado ao vocabulário de escopo já
  existente.
- **Negativas / riscos:** sem auth (ADR-0009), o isolamento é **lógico**, não uma
  fronteira de segurança — não confiar nele para separar dados sensíveis entre
  clientes até existir autenticação/autorização. Toda query de leitura de cards
  precisa passar a considerar o filtro para evitar vazamento cruzado acidental;
  cobrir com specs.
- **Invariantes preservados:** hierarquia Epic→Story→Task e as regras de criação
  de task não mudam; `tenantId` é ortogonal a `type`/`parentId`.
