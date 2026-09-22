# EP-F3 / US-F3.3 — Mapa regra-a-regra do `buildPrompt`

> **Público-alvo:** quem for implementar a **US-F3.5** (`outputSchema` Zod no
> lugar do protocolo de marcadores `<<<KANBAN_RESULT>>>`). Este documento **não
> é código**: ele decide, para cada regra que o `buildPrompt` hoje ensina à AI,
> **onde ela passa a morar** quando as linhas de FORMATO do prompt sumirem.
> Todas as afirmações de "onde vive hoje" foram **verificadas no código em
> `HEAD`** — caminhos e linhas reais, não memória.
>
> Fontes primárias:
> - `apps/api/src/modules/ai-engine/orchestrator.ts` — `buildPrompt` (linhas
>   4333–4806) e `runIteration` (linhas 831–1589).
> - `apps/api/src/modules/ai-engine/runners/agent-runner.interface.ts` — o
>   contrato `AgentRunResult` (linhas 86–160).
> - **Oráculo da US-F3.2** — `apps/api/src/modules/ai-engine/runners/`
>   `cli-bridge.characterization.spec.ts` e `cli-contract.characterization.spec.ts`
>   (fixam o que o parsing REALMENTE faz hoje; os 9 achados estão registrados
>   como **BUG-BRIDGE1** no backlog — não consertar aqui).
> - `packages/shared/src/domain.ts` — `StructuredEvidence` (366),
>   `isVerifiableEvidence` (379–387), `minimumArtifactSatisfied` (425+),
>   `CompletionMetadata` (798).
> - `apps/api/src/modules/ai-engine/loop-profiles/loop-profiles.ts` — perfil
>   `orchestrator` com `toolset: 'board-only'` (linhas 67–86).

---

## 1. Como ler este mapa

O prompt tem dois tipos de linha:

- **FORMATO** — "emita um bloco EXATAMENTE assim", o esqueleto JSON do
  `KANBAN_RESULT`/`KANBAN_QUESTION` (orchestrator.ts:4711–4739 e 4783–4789).
  Essas linhas **somem** na US-F3.5: o `outputSchema` as substitui.
- **REGRA** — tudo o que cerca o formato ("no máximo 1 id", "não liste arquivos
  que não existem", "não emita os dois blocos"). Essas linhas precisam de
  **destino explícito**, senão o épico entrega parsing melhor e comportamento
  pior.

Cada regra recebe **exatamente um** destino:

| Destino | Significado |
|---|---|
| `schema` | vira constraint Zod verificável na forma do output (ex.: `.max(1)`, união discriminada, `superRefine` cross-field) |
| `guarda` | vira/continua verificação no **servidor** (o schema valida forma, não realidade — filesystem, estado do DOD, diff real) |
| `descrição` | vira `.describe()` do campo no schema **ou permanece texto de prompt** (orientação semântica/comportamental que nenhum tipo impõe) |

Seções do prompt que são **contexto**, não regra (profile/fase 4391–4397,
contexto hierárquico 4399–4436, memória 4562+, handoffs 4611+, histórico 4631+,
diff acumulado 4666+, lastro de irmãs/épico 4679–4697), estão fora do mapa —
elas continuam no prompt inalteradas.

**Nota importante sobre o bridge:** hoje o caminho real de produção passa por
`docker/copilot-cli-adapter.mjs`, e o oráculo da F3.2 prova que ele **descarta
`evidence` e `learnings` por completo** (`cli-bridge.characterization.spec.ts`,
teste "bloco KANBAN_RESULT completo — evidence e learnings são DESCARTADOS").
Ou seja: duas regras inteiras do prompt referem-se a campos que **nunca chegam
ao servidor** pelo protocolo de marcadores. O schema da US-F3.5 corrige isso de
graça — e isso é uma **mudança de comportamento**, não só de parsing (ver §5).

---

## 2. O mapa — regra a regra

### 2.1 Regras do bloco `KANBAN_RESULT`

| # | Regra (texto do prompt, resumido) | Onde vive hoje | Destino | Justificativa | Risco se sumir |
|---|---|---|---|---|---|
| R1 | **Regra nano**: "resolva APENAS 1 item do DOD por iteração; `dodTouched` com NO MÁXIMO 1 id" (orchestrator.ts:4700–4709 e 4744) | Prompt **+ servidor**: `runIteration` valida os ids reportados e faz `slice(0, 1)` pelo menor `position` — excedente é ignorado e logado (orchestrator.ts:1439–1465) | `schema` | `.max(1)` em `dodTouched` é a constraint mais barata do épico; a guarda do servidor continua como cinto | Sem o `.max(1)` e sem o texto, a AI volta a reportar N ids; a guarda salva o dado, mas a AI perde o feedback imediato e "gasta" trabalho adiantado que o servidor descarta |
| R2 | **Ids exatos do DOD**: "use os ids EXATOS listados acima", pertencentes a esta task e ainda não marcados (orchestrator.ts:4744) | Prompt **+ servidor**: filtro por `validIds` (itens não-`done` da task) em orchestrator.ts:1441–1442. O bridge NÃO valida nada (oráculo cli-contract: `dodTouched: [1, true, null]` vira `['1','true','null']` — "nenhum filtro de lixo") | `guarda` | Os ids são dinâmicos por task — só o servidor os conhece com certeza. (O schema PODE reforçar com `z.enum` dos ids pendentes injetados por iteração, mas a guarda é a autoridade) | Se a guarda sumir, ids alucinados/de outra task marcariam DOD alheio. Hoje ela é o único filtro real |
| R3 | **`proposedDod` só na fase de análise sem DOD**: "3 a 7 itens, strings curtas e verificáveis; NÃO use `dodTouched` nesta iteração" (orchestrator.ts:4527–4537, 4722–4724, 4742–4743 — linhas **condicionais**: só entram quando `dodItems.length === 0 && phase === 'analysis'`) | Prompt **+ servidor**: `ensureDodExists` só cria se a task não tem DOD (idempotente), aceita até **20** itens (não 7), e tem fallback genérico determinístico na análise (orchestrator.ts:1144–1152 e 3797–3848). O bridge preserva `proposedDod` e filtra strings vazias (oráculo cli-bridge, teste "proposedDod presente") | `schema` | Campo condicional é a vocação do schema: incluir `proposedDod` **apenas** no schema da iteração de análise-sem-DOD (o `buildPrompt` já sabe a condição) com `.min(3).max(7)`. Nota: o servidor aceita 20 — alinhar o cap na US-F3.5 ou documentar a folga | Se a condicionalidade sumir, a AI propõe DOD em qualquer fase (ignorado em silêncio pela idempotência) ou não propõe na análise — e a task nasce com o **fallback genérico** de 3 itens (orchestrator.ts:3820–3825), que não descreve a task |
| R4 | **`done: true` só com trabalho terminado e DOD todo marcado** (orchestrator.ts:4746) | Prompt **+ servidor (forte)**: o fechamento real NÃO depende do `done` da AI — `nextPhaseFor` só entra em `validation` com `dodAllDone` (loop-helpers.ts:93–103), e a task só vira `execState 'done'` quando a validação passa (orchestrator.ts:1251–1256). `canFinish` (1527–1537) exige `done && (dodAllDone \|\| diff não-vazio \|\| mock)` para o handoff `'done'` | `guarda` | Já existe e é a mais forte do sistema; o `done` da AI é um sinal, não uma decisão | Baixo para o fechamento (a guarda segura); mas sem o texto a AI emite `done:true` prematuro toda iteração, poluindo o liveness (`classifyRunLiveness`, orchestrator.ts:1748) e o anti-fantasma |
| R5 | **`evidence` obrigatória quando `done: true`** (orchestrator.ts:4755 e 4757–4768: "rode os checks antes; preencha `evidence` com o resultado concreto") | **ÓRFÃ no caminho default**: com `AGENT_REQUIRE_STRUCTURED_EVIDENCE=false` (default, config.ts:750) NADA impõe evidence — e pior, o **bridge descarta `evidence` sempre** (oráculo cli-bridge; BUG-BRIDGE1). A validação empírica do servidor roda de qualquer forma (validation.runner.ts:100+), mas é independente do campo | `schema` | `superRefine`: `done === true ⇒ evidence presente e não-vazia`. É cross-field e estático — exatamente o que Zod faz bem. O schema também **ressuscita o campo** que o bridge mata hoje | Sem o refine, tasks fecham sem rastro de verificação; `Iteration.evidence` fica `''` para sempre (hoje já fica, via bridge — o schema é a chance de consertar) |
| R6 | **Evidência ESTRUTURADA quando `AGENT_REQUIRE_STRUCTURED_EVIDENCE`**: "objeto com `checks`; ao menos UM check `passed: true`; texto livre NÃO fecha a task" (orchestrator.ts:4729–4735 e 4769–4776 — linhas condicionais à config) | Prompt **+ servidor**: gate de `done` em orchestrator.ts:1165–1190 via `isVerifiableEvidence` (domain.ts:379–387); reforçado por `minimumArtifactSatisfied` quando `AGENT_REQUIRE_MIN_ARTIFACT` (orchestrator.ts:1194–1228; domain.ts:425+). **Porém**: como o bridge descarta `evidence`, com a flag ligada **nenhuma task fecha hoje via marcadores** — o gate sempre acusa "não verificável" | `guarda` | "Ao menos um check passou" é declaração da AI; a autoridade é o servidor (que além do shape cruza com a validação empírica). O schema condicional pode impor o **shape** (`StructuredEvidence` em vez de string), mas o gate continua no servidor | Se o gate `isVerifiableEvidence` sumir, um `{checks:[{name:'x',passed:true}]}` inventado fecha task — o gate + a validação empírica juntos são a defesa. Regressão silenciosa clássica |
| R7 | **`affectedFlows` verificado contra o filesystem**: "não liste arquivos que não existem" (orchestrator.ts:4745) | Prompt **+ servidor (2 guardas)**: (a) `verifyFlowFiles` na validação — cada arquivo declarado é checado no worktree, default ligado (validation.runner.ts:76–91; config.ts:731); (b) anti-fantasma — `affectedFlows` com `git diff` vazio na implementação é ignorado e não persistido (orchestrator.ts:1402–1416 e 1480–1487) | `guarda` | Schema não enxerga filesystem nem diff; ambas as guardas já existem e ficam | Se `verifyFlowFiles` sumir, fluxos alucinados alimentam a validação final e o teste direcionado por fluxo roda contra arquivos fantasmas |
| R8 | **`affectedFlows` acumula, não substitui**: "acrescente/atualize com o que VOCÊ tocar" + lista dos já registrados (orchestrator.ts:4544–4552) | Prompt **+ servidor**: `persistAffectedFlows` faz merge por nome na story (orchestrator.ts:1480–1487; corpo em 3926+) | `descrição` | O merge já é do servidor; o que a AI precisa saber ("você é a fonte; registre onde mexeu") é semântico → `.describe()` do campo | Sem a orientação, a AI omite fluxos e a estratégia `flows+regression` acusa "Nenhum fluxo afetado declarado" (validation.runner.ts:50–55) — loop de derivação |
| R9 | **`nextStep` específico**: "a próxima iteração começa a partir dele" (orchestrator.ts:4747) | **ÓRFÃ** — nenhuma imposição em lugar nenhum; o bridge coage tipo errado para `''` em silêncio (oráculo cli-bridge, teste "tipos errados") | `descrição` | Especificidade é semântica pura; nenhum tipo impõe. O schema torna o campo **obrigatório** (formato), o `.describe()` carrega o "seja específico" | `nextStep` vago degrada o encadeamento: a continuação direcionada US-CTX3 reinjeta o `nextStep` literalmente no re-dispatch (orchestrator.ts:1639–1645) — lixo entra, lixo orienta |
| R10 | **`summary` = 1 linha do que fez** (orchestrator.ts:4718) | **ÓRFÃ** — e com bug: sem `summary` no bloco, o fallback do bridge usa a última linha do stdout, que é o próprio marcador `<<<END_KANBAN_RESULT>>>` (oráculo cli-bridge, teste "bloco mínimo"; BUG-BRIDGE1) | `descrição` | Obrigatoriedade vira formato (campo required no schema — mata o fallback bugado); "1 linha do que você fez" vira `.describe()` | Summaries-lixo poluem o histórico injetado nas próximas iterações (orchestrator.ts:4622–4631) e os comentários do card |
| R11 | **`learnings` opcionais, duráveis e VERDADEIROS**: "NÃO invente; só registre o que for verdadeiro e útil; omita se não houver nada" (orchestrator.ts:4728 e 4748–4754) | **ÓRFÃ e MORTA em produção**: o bridge descarta `learnings` por completo (oráculo cli-bridge; BUG-BRIDGE1) — o canal de memória viva via marcadores nunca funcionou. Quando o campo chega (runner JSONL direto), o servidor persiste sem validar veracidade (orchestrator.ts:1498–1520) | `descrição` | Veracidade/durabilidade é inimpingível por tipo; o shape (`{path, summary, scope?}`) vira schema-formato, a orientação vira `.describe()` | O schema vai **ligar um canal hoje morto**: aprendizados inventados passariam a ser persistidos na colmeia e reinjetados em toda iteração futura (orchestrator.ts:4571–4585). O `.describe()` anti-invenção precisa entrar JUNTO com a ressurreição do campo |

### 2.2 Regras do bloco `KANBAN_QUESTION` (HITL)

| # | Regra | Onde vive hoje | Destino | Justificativa | Risco se sumir |
|---|---|---|---|---|---|
| R12 | **"Se emitir KANBAN_QUESTION, NÃO emita KANBAN_RESULT nem `done`"** (orchestrator.ts:4802) | Prompt **+ bridge (por acidente de ordem)**: quando a AI emite os dois, a extração dá precedência à QUESTION e o RESULT inteiro (`done:true`, `dodTouched`) é descartado sem aviso (oráculo cli-bridge, teste "KANBAN_RESULT E KANBAN_QUESTION → a QUESTION vence") | `schema` | União discriminada (`result \| question`) torna **estruturalmente impossível** emitir os dois — a regra deixa de ser pedido e vira tipo | Se o novo protocolo aceitar os dois sem definir precedência, ou inverter a precedência atual (result vence), muda o comportamento de HITL: hoje a pergunta sempre ganha e a task espera o humano |
| R13 | **UMA pergunta objetiva por vez** (orchestrator.ts:4792) | Prompt **+ estrutura**: o bridge extrai um bloco de question; `onQuestion` é serial — `runIteration` aguarda a resposta antes de qualquer coisa (orchestrator.ts:1021–1075); o gate `getPending` impede nova iteração com pergunta pendente (orchestrator.ts:2161–2163) | `schema` | `question` é um objeto único no schema (não lista) — N perguntas por turno continuam impossíveis por construção | Baixo — a serialização do servidor segura; mas um schema que aceitasse `questions: []` quebraria o modelo one-shot de HITL |
| R14 | **2 a 4 `options` curtas quando a pergunta admitir alternativas; omitir quando genuinamente aberta** (orchestrator.ts:4793–4801) | **ÓRFÃ** — o bridge/adapter apenas coage tipos (options não-array vira `undefined`; itens coagidos via `String()` — oráculo cli-contract, teste "parseLine question"); nenhum lugar valida 2–4 | `schema` | `z.array(z.string()).min(2).max(4).optional()` impõe a contagem; o "quando admitir alternativas" (semântico) vai no `.describe()` | Perguntas sem options degradam a UX de HITL (o humano perde os chips de 1 clique — orchestrator.ts:1044–1053 persiste as options para reidratar) |

### 2.3 Regras comportamentais (fora do bloco de formato — **permanecem no prompt**)

Estas seções não fazem parte do formato `KANBAN_RESULT` e **não devem sair na
US-F3.5**; entram no mapa porque a fronteira "o que sai / o que fica" precisa
estar escrita. Onde o destino é `guarda`, é proposta de guarda **nova** (hoje
são cooperativas).

| # | Regra | Onde vive hoje | Destino | Justificativa | Risco se sumir |
|---|---|---|---|---|---|
| R15 | **Encadeamento/incrementalidade**: "você é uma iteração de um loop; foque em avançar, não em terminar tudo; não adiante outros itens" (orchestrator.ts:4343–4349 e 4705–4708) | Prompt + guardas parciais: a regra nano descarta DOD adiantado (R1); `classifyRunLiveness`/`applyContinuationPolicy` detectam iteração que só planejou (orchestrator.ts:1569–1590, 1596+) | `descrição` | É o contrato mental do loop; nenhum tipo o impõe. Permanece como texto de abertura do prompt | AI tenta "one-shot" da task inteira: iterações gigantes, mais contexto queimado, DOD adiantado descartado pelo servidor |
| R16 | **Plan mode (`startInPlanMode`)**: "NÃO edite/crie/apague arquivos; produza um PLANO; registre-o no `summary`/`nextStep`" (orchestrator.ts:4360–4381; flag vem da story via `buildContext`, 4323) | **ÓRFÃ** — 100% cooperativa. `startInPlanMode` só é usado em `buildContext`/`buildPrompt`; nenhum guard olha o diff de uma iteração plan-mode | `guarda` | O servidor JÁ tem o sinal para impor: `iterationDiff` + o flag. Espelhar o warn do board-only (orchestrator.ts:1423–1430) — logar desvio quando plan-mode produz diff não-vazio (e, se o dono quiser, descartar o diff) | Se o texto sair sem guarda nascer, plan mode vira decorativo: a AI edita código numa iteração que a story pediu como planejamento |
| R17 | **`board-only` (perfil orquestrador)**: "você NÃO PODE editar/criar/apagar NENHUM arquivo; só criar/atribuir/linkar cards via MCP; tasks só em Backlog/To Do" (orchestrator.ts:4443–4466; perfil em loop-profiles.ts:67–86) | Prompt + **guardas parciais**: (a) diff não-vazio em board-only gera warn de auditoria — explicitamente cooperativo, "enforcement real fica para runners futuros" (orchestrator.ts:1418–1430); (b) "tasks só em Backlog/To Do" É guarda real: `TASK_CREATION_COLUMNS` rejeita no serviço de cards (cards.service.ts:285–288; enums.ts:181); (c) o gate anti-fantasma é neutralizado para board-only (orchestrator.ts:1403) | `guarda` | A parte impositiva já mora no servidor (b) e o warn (a) existe; o destino é **manter ambos** e o texto do mandato permanece no prompt (é a persona da iteração, não formato). Enforcement por allow/deny de tools é dívida declarada no próprio código | Se o warn sumir, o orquestrador que codar passa despercebido; se `TASK_CREATION_COLUMNS` sumir, o board aceita task em qualquer coluna — quebra invariante do domínio |
| R18 | **Escopo/diretório de trabalho**: "faça TODAS as mudanças no `cwd`; não rode `cd` para fora; as mudanças devem aparecer no `git diff`" (orchestrator.ts:4468–4485) | Prompt + **guarda estrutural parcial**: o `cwd` do spawn é resolvido e imposto pelo servidor — sem repo-alvo válido a iteração é RECUSADA (`TargetProjectError` → `blocked-dep`, orchestrator.ts:920–960); e "mudanças devem aparecer no diff" é imposta pelo anti-fantasma + `canFinish` (R7/R4). Escrita FORA do cwd não é bloqueada (sem sandbox) | `descrição` | A parte impositiva já existe (spawn + diff); o restante é orientação de comportamento durante o run — fica no prompt | AI escreve em caminhos absolutos fora do repo-alvo; o diff sai vazio, o anti-fantasma acusa, mas os arquivos órfãos ficam no filesystem |
| R19 | **"NUNCA crie nada no repositório do próprio kanban-ai"** (orchestrator.ts:4486–4489) | Prompt + guarda parcial: o servidor nunca roda com `cwd` vazio/da API (orchestrator.ts:938–945 — "NUNCA seguimos com cwd vazio — isso rodaria o agent no diretório da API"), mas nada impede escrita ativa fora do cwd | `descrição` | Mesmo caso do R18: a metade garantível já é guarda; a metade restante é comportamental | Poluição do repo da ferramenta — mitigada pela guarda do cwd; o texto continua sendo a única defesa contra escrita deliberada fora |
| R20 | **Proibição de git que altera estado**: "NÃO PODE `git commit/add/branch/checkout/switch/merge/rebase/reset/stash/push/worktree`; deixe as mudanças no working tree; git de leitura ok" (orchestrator.ts:4498–4519) | **ÓRFÃ** — 100% cooperativa. Nenhum guard detecta commit/troca de branch; o próprio comentário do código só documenta a consequência (diff dessincronizado → derivação em loop, orchestrator.ts:4491–4497) | `guarda` | O servidor já captura baseline do tree antes do run (`captureTreeBaseline`, orchestrator.ts:954); comparar `HEAD`/branch antes-vs-depois é barato e transforma a regra em detecção real (warn/escalate). O texto permanece no prompt (comportamento durante o run) | É a órfã de maior raio de dano: um `git commit` da AI esvazia o `git diff`, o gate de validação passa a inspecionar nada, `affectedFlows` viram "inexistentes" e o sistema deriva tasks de correção em cascata |
| R21 | **Recovery status-only**: "NÃO produza trabalho entregável; só normalize o estado e peça intervenção humana" (recovery-lane.ts:47–62, injetado quando `recovery=true` em orchestrator.ts:4353–4356) | Prompt (cooperativo) + guarda parcial: o servidor troca o MODELO para o barato (`resolveDispatchModel`, recovery-lane.ts:32–40) e o scrub garante que o guard nunca vaza para trabalho normal (recovery-lane.spec.ts) — mas nada impede a lane de recovery de marcar DOD/produzir diff | `descrição` | Bloco condicional fora do formato; permanece como está. (Se um dia doer: guarda barata = ignorar `dodTouched`/`done` quando `recovery=true`) | Recovery produzindo entregável com modelo barato = trabalho de baixa qualidade entrando pela porta dos fundos |
| R22 | **Verifique o trabalho antes de `done`**: "rode `npm test`/`build`/`lint` no diretório atual; só marque `done` depois que passarem; sem como verificar, diga isso em `evidence`" (orchestrator.ts:4757–4777) | Prompt **+ servidor**: o gate de validação roda os checks reais do projeto de qualquer forma (validation.runner.ts:100–125) e reverte o `done` derivando correção — exatamente o que o próprio prompt anuncia (4760–4763) | `guarda` | Já existe e é empírica; o texto é antecipação (economiza uma rodada de derivação), vira `.describe()` de `done`/`evidence` | Sem o texto, mais `done` prematuros → mais derivações → mais iterações queimadas; a correção continua acontecendo, só que mais cara |
| R23 | **(US-F5.5, EP-F5) Grafo antes de grep + Wiki para orientação ampla**: seção "Grafo de conhecimento do projeto" — consulte o grafo pelas tools MCP do graphify (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `god_nodes`, com `project_path` do Project) ANTES de varrer arquivos; a busca casa **identificadores reais do código** (Step 0 do query.md — prosa em português não encontra nada); a **Wiki** (`GET /projects/:id/wiki`, US-F5.4) para "como isso se encaixa"; **NÃO** atualize o grafo (o loop reconstrói ao fim da iteração, US-F1.5). São as regras canônicas de `always_on/claude-md.md` **traduzidas** para a superfície real do agent — nunca a CLI `graphify query/path/explain/update`, que ele não tem. **Condicional**: só entra quando o recall da US-F2.5 provou grafo `ready` (`memoryGraph.ok`) e o Board tem Project — Board legado, grafo não-`ready` ou integração desligada ⇒ seção omitida (specs em `graph-prompt-rules.spec.ts`) | Prompt (cooperativa por natureza — orienta ONDE buscar contexto; nenhum guard verifica se a IA consultou o grafo) | `descrição` | Comportamental, fora do bloco de formato: permanece como texto do prompt na US-F3.5 (mesmo regime do R15) | Sem a seção, a IA varre o repo com grep a cada pergunta (mais tokens/iterações) ou — pior — tenta os comandos de CLI do texto canônico do graphify, que não existem no ambiente dela |

---

## 3. Regras órfãs — hoje existem SÓ como texto no prompt

Estas são as regras que **nenhum código impõe** (o oráculo da F3.2 é a
evidência de que o parsing não as valida; a leitura de `runIteration` é a
evidência de que o servidor também não). Para cada uma: o schema passa a
impô-la, ou continua sendo só pedido?

| Regra órfã | Evidência de que não é imposta | O schema impõe? |
|---|---|---|
| R5 — `evidence` obrigatória com `done:true` (flag default off) | Bridge descarta `evidence` sempre (oráculo cli-bridge); com `AGENT_REQUIRE_STRUCTURED_EVIDENCE=false` nenhum gate a exige (orchestrator.ts:1170–1174 só roda com a flag) | **SIM** — `superRefine` `done ⇒ evidence` |
| R14 — 2 a 4 `options` na pergunta HITL | Adapter só coage tipos; nenhuma contagem validada (oráculo cli-contract, "parseLine question") | **SIM** — `.min(2).max(4)` |
| R16 — plan mode não edita arquivos | `startInPlanMode` não é lido por nenhum guard pós-run (grep: só buildContext/buildPrompt) | **NÃO** — vira guarda de servidor (§4); schema não vê diff |
| R20 — proibição de git que altera estado | Nenhum check de HEAD/branch; só o comentário 4491–4497 documenta a consequência | **NÃO** — vira guarda de servidor (§4) |
| R21 — recovery não produz entregável | Guard puramente textual (`allowDeliverableWork:false` é string de prompt, recovery-lane.ts:59) | **NÃO** — continua pedido (guarda opcional futura) |
| R9 — `nextStep` específico | Bridge coage tipo errado para `''` sem aviso (oráculo cli-bridge, "tipos errados") | **PARCIAL** — obrigatoriedade sim; especificidade continua pedido (`.describe()`) |
| R10 — `summary` presente e conciso | Fallback do bridge produz `<<<END_KANBAN_RESULT>>>` como summary (oráculo cli-bridge, "bloco mínimo") | **PARCIAL** — presença sim (required); concisão continua pedido |
| R11 — `learnings` verdadeiros/duráveis | Bridge os descarta por inteiro (oráculo cli-bridge); quando chegam, servidor persiste sem validar (orchestrator.ts:1498–1520) | **NÃO** — shape sim, veracidade continua pedido. **Atenção**: o schema ressuscita um canal hoje morto (ver §5) |
| R17(a) — board-only não coda | Warn cooperativo explícito: "o enforcement real fica para runners futuros" (orchestrator.ts:1418–1430) | **NÃO** — continua warn de servidor; enforcement real é allow/deny de tools (fora do EP-F3) |
| R18/R19 — não escrever fora do cwd / não tocar o kanban-ai | Sem sandbox; só o cwd do spawn é imposto (orchestrator.ts:920–960) | **NÃO** — continua pedido (sandbox é outro épico) |

**Resumo do achado:** de 22 regras mapeadas, **10 são órfãs ou
majoritariamente órfãs**. O schema resgata 2 por inteiro (R5, R14) e 2 pela
metade (R9, R10); **4 precisam de guarda de servidor para deixarem de ser
pedido** (R16, R20 — novas; R17a, R21 — permanecem cooperativas por decisão
já registrada no código); 2 permanecem inimpingíveis (R11 veracidade,
R18/R19 escopo).

---

## 4. Regras que o schema NÃO consegue impor → guarda de servidor

O `outputSchema` valida a **forma da declaração**, nunca a **realidade**. Se
qualquer uma destas sair do servidor "porque agora tem schema", regride em
silêncio:

1. **R2 — ids de DOD válidos/da task/não-marcados** — depende do estado do
   banco. Guarda existente: orchestrator.ts:1441–1442. **Fica.**
2. **R1 — regra nano no servidor** — o `.max(1)` do schema rejeita o payload,
   mas o `slice(0,1)` por `position` (orchestrator.ts:1443–1465) é o que decide
   *qual* id vale quando algo escapa. **Fica** como cinto.
3. **R4 — `done` só fecha task via validação** — depende de `dodAllDone` +
   validação empírica (loop-helpers.ts:93–103; orchestrator.ts:1251–1256).
   **Fica** — é a espinha do loop.
4. **R6 — evidência verificável** (`isVerifiableEvidence`, orchestrator.ts:
   1165–1190) e **artefato mínimo por classe** (`minimumArtifactSatisfied`,
   1194–1228) — um check `passed:true` é declaração; só o servidor cruza com a
   validação empírica real. **Ficam.**
5. **R7 — arquivos de `affectedFlows` existem no filesystem**
   (validation.runner.ts:76–91) e **anti-fantasma** claims-sem-diff
   (orchestrator.ts:1402–1416). Schema não enxerga worktree nem `git diff`.
   **Ficam.**
6. **R16 — plan mode** — guarda **NOVA** proposta: diff não-vazio numa
   iteração `startInPlanMode` → warn (mínimo) espelhando o padrão board-only
   de orchestrator.ts:1423–1430.
7. **R20 — git que altera estado** — guarda **NOVA** proposta: comparar
   `HEAD`/branch antes-vs-depois do run (o baseline de orchestrator.ts:954 já
   existe); divergência → warn/escalate. É a órfã de maior raio de dano.
8. **R12 — precedência question > result** — se o transporte novo ainda
   permitir ambos em algum caminho degradado, a precedência atual (question
   vence, oráculo cli-bridge) precisa ser preservada no runner/servidor.

As guardas 6 e 7 **não são pré-requisito** da US-F3.5 (hoje também não
existem — não há regressão em não tê-las), mas são o destino registrado para
as duas órfãs comportamentais mais perigosas; sem este registro elas seriam
esquecidas para sempre.

---

## 5. Ordem de migração sugerida para a US-F3.5

Princípio: **cada passo compara contra o oráculo da F3.2 antes de seguir**, e
nada de guarda de servidor sai em passo nenhum.

1. **Passo 0 — congelar o oráculo.** Rodar
   `cli-bridge.characterization.spec.ts` + `cli-contract.characterization.spec.ts`
   verdes no baseline. Eles são o contrato "antes".

2. **Passo 1 — schema base (forma, sem mudança de regra).**
   `summary`/`nextStep`/`done` obrigatórios; `dodTouched: string[]`;
   `affectedFlows`/`proposedDod`/`learnings`/`evidence` com os shapes de
   `AgentRunResult` (agent-runner.interface.ts:86–160). União discriminada
   `result | question` (mata R12 por construção). Cada campo já nasce com o
   `.describe()` carregando as regras `descrição` deste mapa (R8, R9, R10,
   R11, R15, R22) — **no MESMO commit** em que as linhas de FORMATO
   (orchestrator.ts:4711–4739, 4783–4789) saem do prompt. Formato sem
   descrição = regressão instantânea de comportamento.

3. **Passo 2 — constraints que hoje têm guarda equivalente (risco zero).**
   `dodTouched.max(1)` (R1 — o servidor já faz slice); `options.min(2).max(4)`
   (R14); `proposedDod` condicional à fase de análise sem DOD (R3 — o
   `buildPrompt` já calcula a condição em 4527/4722).

4. **Passo 3 — os campos que o bridge matava (MUDANÇA DE COMPORTAMENTO —
   isolar e anunciar).** Com o schema, `evidence` e `learnings` passam a
   chegar ao servidor pela primeira vez no caminho de produção:
   - `evidence`: com `AGENT_REQUIRE_STRUCTURED_EVIDENCE=true` isso **destrava**
     o fechamento de tasks (hoje impossível via bridge — R6); com a flag off,
     `Iteration.evidence` deixa de ser sempre vazio. Adicionar o `superRefine`
     `done ⇒ evidence` (R5) **neste passo**, não antes — senão o refine rejeita
     outputs que hoje "funcionam".
   - `learnings`: liga a memória viva de verdade (R11). O `.describe()`
     anti-invenção ("NÃO invente; só o durável e verdadeiro") tem de estar no
     campo desde o Passo 1, porque a partir daqui o que a AI escrever é
     persistido na colmeia e reinjetado em toda iteração futura.

5. **Passo 4 — decidir os degenerados do fallback CONTRA o oráculo.** Os casos
   que hoje produzem `done:true` fantasma (prosa sem bloco, JSON inválido,
   marcador sem fechamento, question malformada — todos fixados no oráculo
   como BUG-BRIDGE1) precisam de decisão explícita no protocolo novo: schema
   inválido ⇒ **nunca** `done:true` (proposta: equivale ao fallback
   "processo encerrou sem evento result" do runner, que é `done:false` —
   cli-contract spec, teste "processo encerra SEM evento result"). Registrar
   cada divergência deliberada do oráculo no PR.

6. **Passo 5 — só depois, as guardas novas (PRs separados).** Plan-mode ×
   diff (R16) e git-HEAD check (R20). Não entram na US-F3.5 para não misturar
   "trocar transporte" com "criar enforcement" — mas ficam registradas aqui
   como o destino das duas órfãs mais perigosas.

**Janela de regressão a vigiar:** o intervalo entre remover as linhas de
FORMATO do prompt e o schema estar ativo é **zero por definição** (mesmo
commit); a janela real é entre o Passo 1 e o Passo 3 — nela, `evidence` e
`learnings` já são pedidos pelo `.describe()` mas o gate `done ⇒ evidence`
ainda não existe. É a mesma janela em que vivemos hoje (pior, até: hoje os
campos nem chegam), portanto aceitável — mas os Passos 1→3 devem ser
sequência curta, não backlog.

---

## 6. Contagem final

- **23 regras mapeadas** (R1–R22; R23 adicionada pela US-F5.5/EP-F5).
- Por destino: **schema = 6** (R1, R3, R5, R12, R13, R14) · **guarda = 8**
  (R2, R4, R6, R7, R16, R17, R20, R22) · **descrição = 9** (R8, R9, R10, R11,
  R15, R18, R19, R21, R23).
- Das 8 guardas, **6 já existem** no servidor (R2, R4, R6, R7, R17, R22) e
  **2 são propostas novas** (R16 plan-mode, R20 git) — hoje órfãs.
- **10 regras órfãs/majoritariamente órfãs** hoje (ver §3); o schema resgata
  4 (2 inteiras + 2 parciais).
