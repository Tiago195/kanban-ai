# backlog

<!-- Stories de correção derivadas do QA rodada 2 (2026-08-06). Prioridade: 🔴 crítico > 🟠 alto > 🟡 médio > 🟢 baixo -->

# in progress



# done
<!-- apenas ultimas 2 tarefas, para n poluir o arquivo -->

- [x] 🟢 **US: Verificar/consertar drag-and-drop por teclado (dnd-kit) no board** _(finding: obs-dnd-keyboard)_ — **CONCLUÍDA 2026-08-07 (KeyboardSensor + coordinateGetter horizontal custom; validado empiricamente via Playwright + DB)**
  - **Causa-raiz:** o `BoardView` registrava apenas `PointerSensor` — **faltava o `KeyboardSensor`**, então não havia dnd por teclado. Ao adicionar o `KeyboardSensor` com o `sortableKeyboardCoordinates` padrão do dnd-kit (otimizado p/ listas **verticais**), ArrowLeft/Right miravam o card vizinho mais próximo — quase sempre na **mesma coluna** — e o card nunca trocava de coluna. Além disso, retornar a coordenada como **centro** da coluna fazia o `collisionRect` (que o dnd-kit ancora pelo **canto superior-esquerdo**) invadir a coluna seguinte, resolvendo `over` para um card distante.
  - **O que foi feito** (`apps/web/src/features/board/components/BoardView.tsx`, só front, sem tocar contrato):
    - Adicionado `KeyboardSensor` aos **dois** `useSensors` (board principal de stories e task-board).
    - Implementado `boardKeyboardCoordinates` (`KeyboardCoordinateGetter` custom): ArrowLeft/Right navegam entre as **colunas droppable** (`column:<id>`) — detecta a coluna atual pela posição do card e salta para a **borda esquerda** da coluna vizinha (alinhando o `collisionRect` dentro dela, sem invadir a próxima). ArrowUp/Down delegam ao `sortableKeyboardCoordinates` padrão (reordenar dentro da coluna).
  - **Validação empírica (Playwright + DB real):**
    - Card focável: `role=button`, `tabindex=0`, `aria-roledescription=sortable` ✔.
    - **Backlog → To Do só pelo teclado** (focus + Space + ArrowRight + Space): live region "dropped over **To Do**"; DB confirmou `US-274` mudou de `Backlog` → `To Do` ✔.
    - **To Do → Backlog** (ArrowLeft): DB confirmou retorno a `Backlog` ✔ (card restaurado ao estado original).
    - Movimento é de **exatamente uma coluna** por seta (colisão resolve só para a coluna-alvo) ✔.
    - `tsc web` ✔, `eslint` ✔, **`npm run build` + `npm run lint` na raiz verdes** (fundação intacta) ✔.


- [x] 🟢 **US: Normalizar granularidade da decomposição de proposta do PO** _(finding: bug-proposal-decomp-inconsistent)_ — **CONCLUÍDA 2026-08-07 (prompt do PO tornado determinístico; validado via render do prompt)**
  - **Causa-raiz:** o prompt do PO (`apps/api/src/modules/backlog-chat/skill/backlog-po.prompt.ts`) tratava `tasks` como "OPCIONAL — rascunhe se o humano pedir **OU se a decomposição for óbvia**". A cláusula subjetiva ("óbvia") + o `tasks` no JSON-template de exemplo faziam o modelo decidir caso a caso → EP-324 veio com tasks por story, EP-340/EP-344 sem tasks (granularidade desigual, não-determinística). Contraria ainda o ADR-0024, que define tasks como **sob demanda** (botão "✨ Sugerir tasks"), com refinamento no board.
  - **O que foi feito** (mudança só de prompt, sem tocar contrato/schema):
    - Regra de `tasks` reescrita para **determinística e alinhada ao ADR-0024**: padrão = **NÃO rascunhar tasks**; só incluir quando o humano **pedir explicitamente**; removida a cláusula "óbvia". Quando pedido, aplicar a MESMA decisão a **todas** as stories (todas com tasks ou nenhuma) → granularidade consistente.
    - Removido o campo `"tasks"` do **JSON-template de exemplo** (era um nudge que induzia o modelo a incluí-lo); `affectedFlows` passou a ser o último campo (sem trailing comma).
  - **Validação empírica:** render do prompt (`buildBacklogPrompt`) confirma: regra determinística "SOB DEMANDA" **presente**; template **não** mostra mais `"tasks"`; string "óbvia" **ausente**; JSON-template **estruturalmente válido** (sem trailing comma). `tsc api` ✔, `eslint` backlog-chat ✔, specs backlog-chat **10/10** ✔.
