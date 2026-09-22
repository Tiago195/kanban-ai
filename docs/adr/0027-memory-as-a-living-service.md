# ADR-0027 — Memória como serviço vivo (colmeia)

**Status:** Aceito

**Data:** 2026-08-11

## Contexto

O `kanban-ai` executa trabalho de desenvolvimento em **sessões de AI efêmeras**:
o loop engine dá `spawn` na Copilot CLI para cada iteração
([ADR-0016](0016-copilot-cli-subprocess-adapter.md)), a API roda no host para
enxergar o FS do repo-alvo ([ADR-0019](0019-api-runs-on-host-not-docker.md)) e o
MCP oferece um segundo plano de controle
([ADR-0020](0020-mcp-server-second-control-plane.md)). Cada iteração nasce, faz
seu trabalho e **morre** — o contexto acumulado dentro daquele processo se perde
quando ele termina. O que sobrevive entre iterações hoje é apenas o que o loop
persiste explicitamente (handoff, diff acumulado, DOD, affectedFlows).

Isso gera **perda de memória entre sessões**: descobertas, convenções aprendidas,
becos sem saída já explorados e o "porquê" de decisões locais não são retidos de
forma estruturada. A próxima iteração — ou outro agent trabalhando em paralelo num
worktree isolado ([ADR-0008](0008-git-worktree-per-execution.md)) — recomeça
frequentemente do zero, repete erros e re-descobre o que uma sessão anterior já
sabia. À medida que múltiplos agents colaboram, o custo dessa amnésia cresce: não
há um substrato compartilhado onde o conhecimento vá se sedimentando como numa
**colmeia**.

Os documentos existentes **não bastam** para resolver isso:

- **`AGENTS.md`** carrega regras e guard-rails de _como_ trabalhar, mas é
  prescritivo e relativamente estático; não é um registro que cada sessão
  atualiza com o que aprendeu.
- **`ARCHITECTURE.md`** descreve a visão macro e os fluxos; é panorama, não
  memória operacional granular por assunto.
- **`CONTRIBUTING.md`** cobre convenções e setup; é onboarding, não conhecimento
  vivo acumulado.
- Os **ADRs** registram decisões pontuais e datadas; capturam _um_ "porquê" por
  vez, não o conhecimento contínuo e evolutivo de um domínio.

Nenhum deles é um **serviço de memória vivo**: uma base de conhecimento
granular (neurônios `.md` versionados), consultável e **escrevível** pelos agents
com controle de concorrência, para que o aprendizado de uma sessão fique
disponível — e confiável — para as próximas. Este ADR registra a decisão de criar
esse serviço, sua fonte de conteúdo é o board excalidraw `5WqltgG6Kq8`
(seções 18–24).

## Decisão

Criar um **serviço de memória vivo** dentro do `kanban-ai`, organizado em **duas
camadas** com papéis bem separados (híbrido A + E do board, seções 19–20):

- **Camada 1 — Conteúdo (fonte da verdade):** um repositório **git de verdade**,
  interno ao serviço, onde a memória vive como neurônios `.md` versionados.
- **Camada 2 — Índice + locks (coordenação em tempo real):** um índice
  **descartável/reconstruível** em Postgres + eventos WS para presença e locks.

### Camada 1 — Conteúdo: git como fonte da verdade

O serviço hospeda um **repositório git real e próprio** — a "ferramenta de
memória". A memória é escrita como se fosse um repositório do GitHub (arquivos
`.md` versionados, com `commit` / `branch` / `diff` / `blame` / `history`), mas o
`remote` é o **próprio serviço**, não o repositório do projeto-alvo.

- **Bare repo em volume próprio.** O git da memória é um **bare repository** num
  **volume dedicado do serviço**, com ciclo de vida independente do repo-alvo. Ele
  não é um clone do projeto nem convive com o working tree dele.
- **Fora do repositório do projeto.** Os neurônios **NÃO vivem no repo do
  projeto-alvo** (decisão do usuário, seção 20). Isso resolve o problema original
  da amnésia sem inflar `clone`/`deploy` do projeto: a memória viaja pelo git do
  serviço, não pelo git do produto. Complementa — não contradiz — a análise de
  "Context Repositories" da seção 18: aqui o isolamento é total, no git do serviço.
- **`isomorphic-git` como núcleo.** A implementação de referência é
  **`isomorphic-git`** — git em **JavaScript puro**, que roda dentro da API
  NestJS/Node do `kanban-ai` ([ADR-0003](0003-nestjs-fastify.md)) **sem binário
  nativo**, ideal para começar.
  `libgit2` (via bindings) fica como caminho de evolução se performance/escala
  exigirem depois.
- **Neurônios `.md` versionados.** Cada unidade de memória é um arquivo markdown
  (texto puro), granular por assunto (feature, função, objetivo de endpoint,
  convenção aprendida, beco sem saída). Markdown mantém **humanos e AIs lendo e
  escrevendo o mesmo formato**, sem _lock-in_, e o git dá **auditoria e rollback
  nativos** ("o que a AI sabia quando?").

**Por que git de verdade (e não um banco):** preserva `branch` / `merge` / _PR-like_
/ `diff` / `blame` que se quer ("seguindo os repos do GitHub"), mantém o mesmo
formato para humano e AI, e traz versionamento/auditoria de graça. Fica
**descartado o Dolt** (banco versionado): só faria sentido se a memória fosse
tabela, não markdown.

Camadas opcionais, **sem virar dependência core**: **DiffMem** para _retrieval_
por `git log`/`grep` (sem vector DB) e um **espelho (push) para um GitHub dedicado
só à memória**, quando se quiser backup/colaboração externa.

### Camada 2 — Índice + WS: coordenação descartável sobre o git

Sobre o git da Camada 1 fica uma **camada de coordenação** cujo único papel é
tornar a memória **consultável e observável em tempo real** — nunca ser dona do
conteúdo. Ela reúne o **índice em Postgres**, os **locks de edição** (presença) e
o canal de **eventos WebSocket** que propaga ambos.

- **Índice Postgres descartável/reconstruível.** O Postgres guarda uma
  **projeção derivada** dos neurônios `.md` (ex.: caminho, título, tags, resumo,
  `commit` de origem, ponteiros para busca) para servir listagem, filtro e
  _retrieval_ rápido sem varrer o git a cada consulta. Ele é **100%
  reconstruível**: pode ser apagado e **reindexado do zero** relendo o git (o
  `HEAD` de cada neurônio é a verdade). Por isso **não há migração de dados de
  memória** para preservar — o índice é cache, não arquivo. Isso é o mesmo
  princípio do [ADR-0004](0004-prisma-postgres.md) aplicado à memória: o Postgres
  é infraestrutura de consulta, e a **fonte da verdade continua no git** da
  Camada 1.
- **Eventos WS para realtime.** Mutações na memória (novo neurônio, edição,
  mudança de estado de _lock_ `FREE`/`EDITING`/`REVIEW`, presença de agents)
  emitem **eventos WebSocket tipados**, reaproveitando o padrão já adotado no
  board ([ADR-0012](0012-realtime-ws-invalidates-cache.md)): o WS carrega
  **dicas de invalidação**, não o payload de estado. O cliente (outro agent, o
  MCP de [ADR-0020](0020-mcp-server-second-control-plane.md), ou a UI) reage
  **refazendo o fetch** contra o índice, mantendo **um único caminho de verdade**
  e evitando divergência. Assim, quando um agent grava um aprendizado, os demais
  o enxergam sem _polling_.
- **Locks de edição vivem aqui, não no git (seções 19–20).** O git da Camada 1
  não expressa "quem está editando **agora**"; essa presença em tempo real é
  responsabilidade da Camada 2. Cada lock é um **lease com TTL renovado por
  heartbeat**: o agent (ou humano) **adquire** o lock antes de editar um neurônio,
  **renova** por `heartbeat` enquanto trabalha e o lock **expira sozinho** se a
  sessão morrer — nunca fica preso. O índice guarda, por caminho, o **estado**
  (`FREE`/`EDITING`/`REVIEW`) e o **holder** (`ai:<sessao>` ou `human:<user>`), e
  publica cada transição via os eventos WS acima. Como **lock não é conteúdo**, ele
  **não pertence ao git**: mora no Postgres/WS, junto com o restante da coordenação
  descartável. O lock é **consultivo** (advisory) — coordena os participantes do
  serviço, não tranca o filesystem.
- **Papel de cache (nunca autoridade).** O índice + WS existem para **velocidade
  e coordenação** — acelerar busca, refletir presença e propagar _locks_. Em
  qualquer divergência entre índice e git, **o git vence**; basta reindexar. A
  Camada 2 pode ser derrubada e recriada sem perda, o que a mantém **barata de
  operar** e alinhada ao isolamento da API no host ([ADR-0019](0019-api-runs-on-host-not-docker.md)).

### Ordem de escrita — por que essa sequência garante consistência

Toda mutação de memória segue uma **ordem de escrita fixa**, invariante da
Camada 2:

**`git commit` (Camada 1) → reindexa Postgres → emite evento WS.**

1. **`git commit` primeiro (fonte da verdade).** A mutação é persistida no
   repositório de memória **antes de qualquer outra coisa**. Só depois que o
   `commit` está durável — com um `HEAD`/SHA novo — é que o dado passa a
   "existir" para o resto do sistema. A fonte da verdade nunca fica **atrás** do
   índice: no pior caso ela fica **à frente** (git já tem o commit, índice ainda
   não), e essa é justamente a direção segura.
2. **Reindexa depois.** Com o `commit` já gravado, a projeção no Postgres é
   atualizada a partir do git (relendo o(s) neurônio(s) afetado(s) no novo
   `HEAD`). Como o índice é **derivado e reconstruível** (ver "Índice Postgres
   descartável/reconstruível"), a reindexação é **idempotente**: reprocessar o
   mesmo `commit` produz o mesmo resultado. Ela pode ser reexecutada sem risco de
   duplicar ou corromper estado.
3. **Emite WS por último.** O evento WebSocket — que carrega apenas **dicas de
   invalidação**, não payload de estado (padrão do
   [ADR-0012](0012-realtime-ws-invalidates-cache.md)) — só é publicado **depois**
   que git e índice já refletem a mutação. Assim, quando um cliente reage ao
   evento **refazendo o fetch** contra o índice, o dado que ele busca **já está
   lá**.

**Por que essa ordem garante consistência:**

- **O git nunca fica atrás.** Gravar a fonte da verdade primeiro elimina a janela
  em que o índice ou um consumidor de WS conheceriam um estado que o git ainda
  não tem. Qualquer divergência transitória é sempre "git à frente do índice", que
  converge sozinha; nunca "índice à frente do git", que exigiria desfazer.
- **Falhas pós-`commit` são recuperáveis, não corruptoras.** Se o processo cair
  **depois do `commit` mas antes de reindexar**, o dado já está seguro no git; a
  projeção **converge no próximo `reindex`** (agendado, sob demanda, ou por
  reconstrução total relendo o `HEAD`). Se cair **depois de reindexar mas antes de
  emitir o WS**, git e índice já estão corretos — perde-se apenas a notificação
  em tempo real, e o próximo fetch (ou o próximo evento) reconcilia os clientes.
  Em nenhum cenário de crash a fonte da verdade fica inconsistente.
- **WS nunca "mente".** Emitir o evento por último impede anunciar um estado que
  a fonte da verdade ainda não possui — um cliente jamais é acordado para buscar
  um neurônio/commit que o índice (e o git) ainda não conhecem, evitando fetch em
  vazio e leitura suja.

Corolário operacional: a Camada 2 pode ser **derrubada e recriada a qualquer
momento** sem perda (basta reindexar do git), exatamente porque a ordem de escrita
mantém o git como âncora única de verdade e trata índice + WS como efeitos
derivados e reexecutáveis.

### Modelo de estados do neurônio (FREE/EDITING/REVIEW)

Cada neurônio (arquivo `.md` versionado, identificado pelo seu **path**) tem, no
índice da Camada 2, um **estado de coordenação** que descreve o que está
acontecendo com ele **agora**. São três estados — `FREE`, `EDITING` e `REVIEW`
(seções 22–24 do board) — e o neurônio **transita** entre eles ao longo do seu
ciclo de vida. O estado **não vive no git** (não é conteúdo): é presença/coordenação
e mora no Postgres/WS, junto com o `holder` e o `baseCommit` do lock. Toda
transição é publicada via os eventos WS da Camada 2, para que os demais
participantes reajam sem _polling_.

- **`FREE` — ninguém segurando.** O estado de repouso: não há edição em curso nem
  revisão pendente. O `HEAD` do neurônio no git é a verdade corrente e qualquer
  agent/humano pode **ler** livremente (leitura é sempre global, não passa por
  lock) e **pleitear** uma edição.
- **`EDITING` — alguém trabalhando (com `holder`).** Um agent (`ai:<sessao>`) ou
  humano (`human:<user>`) **adquiriu o lease** e está preparando uma mutação. O
  índice registra o `holder`, o `baseCommit` (o `HEAD` que o holder leu) e o TTL.
- **`REVIEW` — mutação em disputa/arbitragem.** O neurônio precisa de decisão
  humana ou de um agent-árbitro antes de fechar: ou porque houve **conflito
  semântico** que o git não resolve, ou porque uma proposta veio **de fora do
  escopo** do autor. Enquanto está em `REVIEW`, o `HEAD` "estável" continua válido
  para leitura; o que aguarda é a mutação proposta.

**Ciclo de vida ponta a ponta (transições):**

1. **`FREE` → `EDITING` (aquisição de lease advisory).** Antes de editar, o agent
   chama `memory.acquire`, que **retorna o `baseCommit`** (o `HEAD` atual daquele
   path) e marca o estado como `EDITING (holder)`. O lease é **advisory** — é
   **presença/aviso, não um portão de escrita**: sinaliza "estou mexendo aqui
   agora" para reduzir colisões, mas **não tranca** o filesystem nem serializa a
   escrita (a serialização por lock mataria o paralelismo que a colmeia quer). O
   lease tem **TTL renovado por `heartbeat`** enquanto o holder trabalha e
   **expira sozinho** se a sessão morrer — nunca fica preso. A escrita em si é
   **otimista, branch-por-agent** (ramo efêmero `mem/ai/<sessao>/<path>`), com
   merge 3-way na hora de fechar; o lease cobre apenas a janela de coordenação, e
   um lock estrito só se justifica para uma eventual **região crítica**.
2. **`EDITING` → `FREE` (caminho feliz: escrita aceita).** Ao fechar, o agent
   chama `memory.write` **enviando o `baseCommit`** que recebeu em `acquire`
   (**compare-and-swap**). Se o `HEAD` do path **não mudou**, o serviço faz o
   merge do ramo do agent, segue a **ordem de escrita** (`git commit` → reindexa
   Postgres → emite WS), poda o ramo `mem/ai/<sessao>/*` e o neurônio **volta a
   `FREE`**. O evento `memory.updated` avisa que o `HEAD` do neurônio mudou.
3. **`EDITING` → `EDITING` (stale detectado: re-ler/rebase).** Se, no
   `memory.write`, o `HEAD` **mudou** desde o `baseCommit` (outro agent fechou uma
   mutação no meio), o serviço **rejeita com `409`** (anti-_lost-update_). O agent
   então **re-lê o novo `HEAD`, faz rebase** da sua mudança e tenta de novo — sem
   sobrescrever cegamente o trabalho alheio. Enquanto isso o neurônio permanece em
   `EDITING`.
4. **`EDITING` → `REVIEW` (conflito semântico ou fora de escopo).** Dois gatilhos
   levam à revisão: **(a) conflito semântico** — o git resolve sozinho _hunks_
   disjuntos (linhas diferentes), mas quando há **duas verdades no mesmo trecho**
   o merge **para**, o neurônio entra em `REVIEW` e é emitido `memory.conflict`
   com os **dois lados + o `baseCommit`**; **(b) escrita fora de escopo** — pela
   política padrão (recomendada, configurável por projeto), um agent escreve
   **direto** apenas nos neurônios do **módulo da sua story**; uma proposta para
   **fora do escopo** não é aplicada direto, vira **entrada em `REVIEW`**. Em ambos
   os casos o índice emite `memory.review` (neurônio entrou em revisão).
5. **`REVIEW` → `FREE` (arbitragem fecha).** Um **árbitro** — agent revisor ou
   humano — decide o texto final e chama `memory.resolve`. Só então a mutação
   arbitrada é commitada (seguindo a mesma ordem de escrita), o ramo é podado e o
   neurônio **volta a `FREE`**. Se a proposta for descartada, o `HEAD` estável
   permanece e o neurônio também retorna a `FREE`.

**O lock é aviso/presença, não portão de escrita.** O `EDITING` **não bloqueia**
ninguém: não tranca o filesystem, não serializa a escrita e não impede outro
participante de pleitear ou até fechar uma mutação no mesmo path. Ele apenas
**anuncia presença** ("`ai:<sessao>` está mexendo aqui agora") para que os demais
**escolham** recuar, coordenar ou seguir — reduzindo colisões por cortesia, não
por bloqueio. A consequência de projeto é direta: como o lock **não** garante
exclusão mútua, quem **de fato** protege contra _lost-update_ é o **compare-and-swap**
do `memory.write` (o `409` anti-stale da transição `EDITING` → `EDITING`), **não**
o lock. Fosse o lock um portão, ele **serializaria** as edições e mataria o
paralelismo que a colmeia existe para ter; por isso ele é deliberadamente
**advisory**.

**Lease com TTL + `heartbeat` libera sessão morta.** Porque o holder é uma sessão
de AI **efêmera** que pode morrer a qualquer momento (crash, timeout, kill do
`spawn`), um lock que "trancasse de verdade" viraria um **deadlock**: o path
ficaria preso em `EDITING` para sempre, com o holder inexistente. O lease evita
isso por construção — ele tem **TTL** e só continua vivo enquanto o holder manda
`heartbeat`. Se a sessão morre, os `heartbeat`s cessam, o **TTL expira** e o
serviço **devolve o neurônio a `FREE`** automaticamente (emitindo a transição via
WS), sem intervenção humana e sem estado preso. A renovação por `heartbeat`
distingue "holder ainda trabalhando" de "holder morto" **sem** precisar de um
_release_ explícito — que uma sessão que caiu nunca chamaria.

Invariante do modelo: o estado é sempre **coordenação sobre o git**, nunca
autoridade sobre o conteúdo. O git (Camada 1) continua a fonte da verdade; o
estado do neurônio, o `holder`, o `baseCommit` e a fila de `REVIEW` são projeções
descartáveis da Camada 2 — some tudo, reindexa do git e a coordenação se
reconstrói.

### Escrita otimista, branch-por-agent e compare-and-swap

O modelo de estados acima descreve _quando_ um neurônio transita entre `FREE`,
`EDITING` e `REVIEW`. Esta subseção detalha o **protocolo git-level** que sustenta
essas transições: como cada agent escreve **otimista** e como o serviço garante que
nenhuma mutação sobrescreva cegamente o trabalho de outro (_lost-update_). O
mecanismo tem três peças — o **ramo efêmero por agent**, o **merge 3-way** no
fechamento e o **`409` anti-stale** quando o `HEAD` diverge do `baseCommit`
(seções 22–24 do board).

**Ramo efêmero `mem/ai/<sessao>/<path>`.** Escrever é **otimista**: o agent nunca
edita o `HEAD` do neurônio diretamente. Ao adquirir o lease (`FREE` → `EDITING`), o
`memory.acquire` devolve o `baseCommit` — o SHA do `HEAD` daquele path **no momento
da leitura** — e o agent grava suas alterações num **ramo próprio, isolado e
descartável**, nomeado `mem/ai/<sessao>/<path>`:

- **`mem/`** é o _namespace_ reservado aos ramos de trabalho de memória (nunca
  colidem com ramos de conteúdo estável).
- **`ai/<sessao>`** identifica **de quem** é o ramo — a sessão de AI holder
  (`ai:<sessao>`); um humano usaria `human/<user>`. Isolar por sessão garante que
  **dois agents editando o mesmo path ao mesmo tempo** trabalhem em ramos
  distintos, sem se pisarem: cada um parte do seu `baseCommit` e escreve em
  paralelo.
- **`<path>`** amarra o ramo ao neurônio específico, tornando-o **granular**: um
  ramo por (sessão × neurônio), não um ramo-monólito por sessão.

O ramo é **efêmero**: existe só durante a janela `EDITING` e é **podado**
(`git branch -D` do ramo `mem/ai/<sessao>/*`) assim que a mutação fecha — seja no
caminho feliz (`EDITING` → `FREE`), seja quando a arbitragem resolve
(`REVIEW` → `FREE`). Se a sessão morre e o lease expira por TTL (ver "Lease com TTL
+ `heartbeat`"), o ramo órfão também é elegível a poda: como não é conteúdo estável,
descartá-lo não perde a fonte da verdade (que continua no `HEAD` do path).

**Merge 3-way no release.** Ao fechar, o agent chama `memory.write` **enviando o
`baseCommit`** que recebeu em `acquire`. O serviço então integra o ramo do agent ao
`HEAD` do path via **merge 3-way**, usando três referências:

- **base (ancestral comum):** o `baseCommit` — o estado que o agent leu antes de
  editar;
- **lado A ("ours"):** o `HEAD` atual do path no git da memória;
- **lado B ("theirs"):** a ponta do ramo `mem/ai/<sessao>/<path>` do agent.

Comparando cada lado **contra o ancestral comum**, o git aplica automaticamente as
mudanças que não se sobrepõem — o caso comum quando dois agents tocam **_hunks_
disjuntos** (linhas/seções diferentes) do mesmo neurônio. O 3-way é o que permite
**paralelismo real** sem lock de escrita: edições concorrentes convergem sozinhas
enquanto não colidem no mesmo trecho. Quando o merge **fecha limpo**, o serviço
segue a **ordem de escrita** canônica (`git commit` → reindexa Postgres → emite WS),
poda o ramo e o neurônio volta a `FREE` (evento `memory.updated`). Só quando há
**duas verdades no mesmo trecho** — conflito que o 3-way não resolve — a mutação
para e o neurônio entra em `REVIEW` (ver a transição `EDITING` → `REVIEW`), sem
tentar adivinhar um vencedor.

**`409` anti-stale quando o `HEAD` diverge do `baseCommit`.** O `memory.write` é um
**compare-and-swap**: antes de merjar, o serviço compara o `HEAD` **atual** do path
com o `baseCommit` que o agent enviou. Dois desfechos:

- **`HEAD` == `baseCommit` (não divergiu):** ninguém fechou uma mutação naquele
  path desde a leitura do agent. O CAS **sucede**, o merge 3-way procede e a
  escrita é aceita.
- **`HEAD` != `baseCommit` (divergiu):** outro holder fechou uma mutação **no meio**
  do trabalho deste agent — o `baseCommit` está **stale**. O serviço **rejeita a
  escrita com `409`** (anti-_lost-update_) **em vez de** sobrescrever o `HEAD` mais
  novo. O `409` mantém o neurônio em `EDITING` e devolve ao agent a informação de
  que o alvo mudou.

Ao receber o `409`, o agent **não reenvia a mesma mutação**: ele **re-lê o novo
`HEAD`** (obtendo um `baseCommit` atualizado), **faz rebase** do seu ramo
`mem/ai/<sessao>/<path>` sobre esse `HEAD` — reconciliando sua mudança com o que o
outro agent gravou — e **tenta o `memory.write` de novo** com o `baseCommit` novo.
O ciclo **re-ler → rebase → retry** repete até o CAS suceder (ou até um conflito
semântico levar o neurônio a `REVIEW`). É esse compare-and-swap — **não** o lock
advisory — que **de fato** protege contra _lost-update_: como o lock é só
presença/aviso e não serializa escrita, é o `409` sobre o `baseCommit` que garante
que toda mutação aceita foi calculada sobre o estado mais recente do neurônio.

**Fluxo ponta a ponta (caminho feliz + contenção):**

1. `memory.acquire` → `FREE` → `EDITING`, retorna `baseCommit` (`HEAD` do path).
2. Agent edita no ramo efêmero `mem/ai/<sessao>/<path>` (escrita otimista, isolada).
3. `memory.write(baseCommit)` → **CAS**: se `HEAD == baseCommit`, merge 3-way
   (base = `baseCommit`, ours = `HEAD`, theirs = ramo do agent).
4. **Merge limpo** → ordem de escrita (`commit` → reindexa → WS), poda o ramo,
   `EDITING` → `FREE` (`memory.updated`).
5. **`HEAD` divergiu** → `409` anti-stale → agent re-lê `HEAD`, rebase, volta ao
   passo 3 (permanece em `EDITING`).
6. **Conflito no mesmo trecho** → merge para, `EDITING` → `REVIEW`
   (`memory.conflict` com os dois lados + `baseCommit`), resolvido por árbitro
   (`REVIEW` → `FREE`).

### Resolução de conflito semântico (REVIEW → árbitro)

O compare-and-swap e o merge 3-way (subseção anterior) resolvem sozinhos o **caso
comum** — _hunks_ disjuntos convergem, `HEAD` stale gera `409` e o agent rebaseia.
Mas há um caso que **nenhuma automação deve resolver sozinha**: quando duas
mutações afirmam **duas verdades no mesmo trecho** do neurônio. Aqui o git não tem
como eleger um vencedor sem **perder conhecimento**, e escolher errado é pior do
que não escolher. Esta subseção detalha o **protocolo de arbitragem** que fecha
esse caso (seções 22–24 do board).

**Entrada em `REVIEW` — os dois gatilhos.** O neurônio deixa `EDITING` e entra em
`REVIEW` por um de dois motivos (ver a transição `EDITING` → `REVIEW`):

- **(a) Conflito semântico.** No `memory.write`, o CAS **sucede** (o `baseCommit`
  não estava stale), mas o merge 3-way **para**: as duas mudanças tocam o **mesmo
  trecho** com conteúdos incompatíveis. O git não resolve — a mutação **não é
  commitada** — e o neurônio entra em `REVIEW`. Este é o gatilho central desta
  task: é uma **disputa de conteúdo**, não um `409` de _timing_.
- **(b) Escrita fora de escopo.** Pela política padrão (recomendada, configurável
  por projeto), um agent escreve **direto** apenas nos neurônios do **módulo da sua
  story**. Uma proposta para **fora do escopo** não é aplicada direto: vira
  **entrada em `REVIEW`** para que um árbitro com autoridade sobre aquele domínio
  decida. É o mesmo destino (`REVIEW`), por um motivo de **governança**, não de
  colisão textual.

Em ambos os casos o índice da Camada 2 registra o estado `REVIEW` e emite
`memory.review` (transição de estado — o neurônio entrou em revisão), preservando
o `HEAD` estável: enquanto a disputa não fecha, **a leitura continua servindo o
`HEAD` corrente** (a proposta é que fica pendente, não a verdade atual).

**Evento `memory.conflict` — o que ele carrega.** Especificamente no gatilho (a),
além do `memory.review`, o serviço emite um `memory.conflict` **descrevendo a
disputa** para que o árbitro decida sem re-derivar o contexto. Seguindo o padrão
de eventos da Camada 2 ([ADR-0012](0012-realtime-ws-invalidates-cache.md)), o
payload carrega **referências e ponteiros**, não o conteúdo inteiro embutido:

- **`path`** — qual neurônio está em disputa (a identidade do neurônio é o path).
- **`baseCommit`** — o ancestral comum sobre o qual os dois lados foram calculados
  (o `HEAD` que o holder leu no `acquire`); é a **âncora** para o árbitro comparar.
- **os dois lados** — ponteiros para reconstruir a disputa: o **`HEAD` atual**
  (`ours`, o que está estável no git) e o **ramo do agent** `mem/ai/<sessao>/<path>`
  (`theirs`, a proposta que parou no merge). Com `base` + `ours` + `theirs`, o
  árbitro vê exatamente o conflito de 3 vias.
- **`holder`** — quem propôs a mutação em disputa (`ai:<sessao>` ou `human:<user>`),
  para atribuição e para notificar o autor quando a arbitragem fechar.

Como todo evento da Camada 2, o `memory.conflict` é **dica de invalidação**: o
cliente (um agent revisor, o MCP de
[ADR-0020](0020-mcp-server-second-control-plane.md) ou a UI) reage **buscando** o
detalhe do conflito contra o índice, mantendo um único caminho de verdade.

**O árbitro — agent revisor ou humano.** Quem fecha um `REVIEW` é um **árbitro**,
e ele pode ser de dois tipos, sem diferença de protocolo:

- **Agent revisor** — um agent com autoridade/escopo sobre aquele domínio (ex.: o
  dono do módulo do neurônio), que analisa `base`/`ours`/`theirs` e decide o texto
  final de forma autônoma. É o caminho que mantém a colmeia **fluindo sem humano no
  loop** quando a decisão é tratável por AI.
- **Humano** — quando a disputa exige julgamento que a política reserva a pessoas
  (ex.: neurônio sensível, conflito de decisão de produto, ou escalonamento após o
  agent revisor declinar). O `REVIEW` é justamente o ponto de **HITL** do serviço
  de memória.

**`memory.resolve` — entradas e os dois desfechos.** O árbitro fecha a disputa
chamando `memory.resolve`, informando o `path`, o `baseCommit` da disputa e a
**decisão**. Há **dois desfechos**, e **ambos** levam `REVIEW` → `FREE`:

1. **Mutação arbitrada aceita.** O árbitro fornece o **texto final** (a
   reconciliação das duas verdades, ou a escolha de um lado). O serviço commita
   essa mutação arbitrada **seguindo a mesma ordem de escrita canônica**
   (`git commit` → reindexa Postgres → emite WS), **poda o ramo**
   `mem/ai/<sessao>/<path>` e o neurônio volta a `FREE`. Um `memory.updated` avisa
   que o `HEAD` mudou.
2. **Proposta descartada.** O árbitro decide que a proposta em disputa **não
   entra**. Nada é commitado, o **`HEAD` estável permanece** como estava, o ramo do
   agent é **podado** e o neurônio também retorna a `FREE`. Nenhuma verdade nova é
   gravada — a decisão foi **manter** o conteúdo corrente.

Em qualquer desfecho, fechar o `REVIEW` **drena a disputa da fila** e reemite a
transição de estado via WS (`REVIEW` → `FREE`), para que os demais participantes —
inclusive o `holder` original que aguardava — reajam sem _polling_. O
`memory.resolve` valida o `baseCommit` da mesma forma que o `memory.write`: se o
`HEAD` estável avançou enquanto o `REVIEW` estava aberto, a decisão do árbitro é
reconciliada contra o novo `HEAD` antes de commitar, preservando o invariante de
que **o git nunca fica atrás** e que toda mutação aceita foi calculada sobre o
estado mais recente.

**Fluxo ponta a ponta da arbitragem:**

1. `memory.write(baseCommit)` → CAS sucede, mas o merge 3-way **para** (mesmo
   trecho) — ou uma proposta chega **fora de escopo**.
2. `EDITING` → `REVIEW`: o índice registra o estado, emite `memory.review` e — no
   caso de conflito semântico — `memory.conflict` (`path`, `baseCommit`, `ours`,
   `theirs` = ramo do agent, `holder`). O `HEAD` estável continua servindo leitura.
3. Um **árbitro** (agent revisor ou humano) recebe o evento, busca o detalhe no
   índice e analisa `base`/`ours`/`theirs`.
4. O árbitro chama **`memory.resolve`** com a decisão:
   - **aceita** → commit da mutação arbitrada (ordem de escrita `commit` → reindexa
     → WS), poda o ramo, `memory.updated`;
   - **descarta** → mantém o `HEAD` estável, poda o ramo, nada é commitado.
5. `REVIEW` → `FREE`: a disputa sai da fila, a transição é emitida via WS e o
   neurônio volta ao repouso.

Invariante da arbitragem: **o serviço nunca resolve um conflito semântico
sozinho**. O merge 3-way só fecha o que é **inequívoco** (hunks disjuntos); toda
disputa de conteúdo no mesmo trecho e toda escrita fora de escopo passam por
`REVIEW` + árbitro. O git (Camada 1) segue fonte da verdade; a fila de `REVIEW`, o
`holder` e o estado são projeções descartáveis da Camada 2 — some tudo, reindexa
do git e a coordenação se reconstrói.

## Consequências

**Positivas**

- **Memória compartilhada, versionada e auditável.** Os neurônios `.md` vivem num
  git real, então ganham `history`/`blame`/`diff` de graça: dá para perguntar "o
  que a AI sabia quando?" e reverter aprendizado errado. O conhecimento de uma
  sessão fica disponível para as próximas e para agents paralelos — fechando a
  amnésia descrita no Contexto sem depender do worktree efêmero
  ([ADR-0008](0008-git-worktree-per-execution.md)).
- **Índice descartável = resiliência barata.** Como a Camada 2 (Postgres + WS) é
  100% reconstruível a partir do git, um crash ou corrupção do índice não perde
  conhecimento: basta reindexar. O git nunca fica atrás (ordem de escrita
  commit → reindexa → WS), então nenhuma falha parcial "mente" para os agents.
- **Leitura sem acoplamento ao produto.** A memória tem repositório próprio e
  isolado, em volume dedicado do serviço, então não infla `clone`/`deploy` do
  projeto-alvo nem mistura o ciclo de vida do conhecimento operacional com o do
  produto.
- **Reaproveita a fundação existente.** Encaixa nos ADRs que já valem: a API no
  host hospeda o serviço ([ADR-0019](0019-api-runs-on-host-not-docker.md)), o MCP
  é o canal de leitura/escrita ([ADR-0020](0020-mcp-server-second-control-plane.md))
  e os eventos WS de invalidação seguem o padrão já adotado
  ([ADR-0012](0012-realtime-ws-invalidates-cache.md)) — sem inventar um transporte
  novo.

**Negativas / custos**

- **Duas camadas para manter em sincronia.** Ter git + índice implica uma ordem de
  escrita disciplinada e um caminho de reindexação sempre correto; a regra
  commit → reindexa → WS precisa ser respeitada em todo caminho de escrita, senão o
  índice diverge do git.
- **Concorrência otimista tem custo cognitivo.** Escrita branch-por-agent +
  compare-and-swap sobre `baseCommit` resolve conflitos de forma segura, mas exige
  detectar o CAS-miss, reabrir o neurônio no commit novo e, quando o conflito é
  semântico, escalar para `REVIEW` + árbitro — mais complexo que um lock pessimista
  simples.
- **Locks como presença (lease/TTL/heartbeat) são advisory.** Coordenam, não
  garantem exclusão forte; um agent que ignore o lease ainda esbarra no CAS, mas a
  UX de presença depende de heartbeats corretos e expiração de lease bem calibrada.
- **Mais uma peça operacional no processo da API.** O git próprio + índice + WS
  rodam no mesmo processo NestJS/Node; ganha-se simplicidade de deploy, mas a API
  passa a carregar o volume dedicado da memória e o custo de I/O de git.

**Riscos / a acompanhar**

- **Paridade dos contratos `memory.*`.** Os eventos WS citados no ADR
  (`memory.*`) precisam nascer como contratos type-safe em `packages/shared`
  (enums/DTOs/events) quando a implementação começar; enquanto forem só prosa do
  ADR, há risco de divergência entre a doc e o código.
- **Crescimento do git da memória.** Sem política de compactação/retenção, o
  repositório de neurônios cresce indefinidamente; vale definir, na implementação,
  como o histórico é podado sem perder auditabilidade.
- **Escopo ainda é fundação.** Este ADR fixa a decisão de design (2 camadas); a
  implementação real (serviço, índice, MCP tools, eventos) virá depois e pode expor
  ajustes finos — especialmente na resolução de conflito semântico e na calibração
  de TTL/heartbeat.

## Alternativas consideradas

Antes de decidir pelo serviço de memória de duas camadas (git como fonte da
verdade + índice Postgres/WS), avaliamos abordagens mais simples de "onde guardar
o conhecimento". Todas foram **rejeitadas** por não entregarem uma memória
**granular, versionada, consultável e escrevível com controle de concorrência**.

- **Comentários no código — rejeitado.** Deixar o "porquê" e o aprendizado como
  comentários no próprio código-fonte acopla a memória ao ponto exato do arquivo,
  se perde em refactors e não sobrevive a mudanças de estrutura. Não é
  **consultável por assunto** (não dá para perguntar "o que já sabemos sobre o
  loop engine?"), não tem estado de edição (`FREE`/`EDITING`/`REVIEW`) nem
  presença, e mistura conhecimento operacional com o produto — poluindo o diff do
  projeto-alvo. Fere o objetivo de uma base **granular por assunto** independente
  do layout do código.

- **`AGENTS.md` por todo o repo — rejeitado.** Espalhar `AGENTS.md` em cada pasta
  cobre _regras de como trabalhar_, mas esses arquivos são **prescritivos e
  relativamente estáticos** (guard-rails), não um registro que **cada sessão
  atualiza** com o que descobriu. Vivem no repo do projeto (inflam
  `clone`/`deploy`), não têm índice para _retrieval_ rápido, nem locks/presença
  para escrita concorrente por múltiplos agents. Como já dito no Contexto, os
  `AGENTS.md` **não bastam**: são onboarding, não conhecimento vivo acumulado.

- **`.gitignore` (arquivos locais não versionados) — rejeitado.** Guardar a
  memória em arquivos ignorados pelo git é o **oposto** do que queremos: sem
  versionamento não há `history`/`blame`/`diff` ("o que a AI sabia quando?"), sem
  rastro auditável e — pior — **local a um único worktree**. Como cada execução
  roda em um git worktree isolado
  ([ADR-0008](0008-git-worktree-per-execution.md)), arquivos ignorados **não são
  compartilhados** entre sessões nem entre agents paralelos: a memória morreria
  junto com o worktree, reproduzindo exatamente a amnésia que este ADR combate.

- **Memória só no git do projeto-alvo — rejeitado.** Versionar os neurônios `.md`
  dentro do próprio repositório do produto resolveria versionamento e auditoria,
  mas **infla `clone`/`deploy`** do projeto com conhecimento operacional das AIs,
  mistura o ciclo de vida da memória com o do produto (uma reversão de release
  apagaria aprendizado válido) e força a memória a viajar pelo git do produto. Por
  decisão explícita do usuário (Decisão, Camada 1), os neurônios **NÃO vivem no
  repo do projeto-alvo**: a memória tem **repositório git próprio e isolado**, em
  volume dedicado do serviço, com ciclo de vida independente.

### Como esta decisão se conecta aos ADRs existentes

O serviço de memória vivo não é uma peça isolada; ele fecha lacunas abertas por
três decisões anteriores da fundação:

- **[ADR-0019](0019-api-runs-on-host-not-docker.md) — API roda no host.** A API
  no host é quem enxerga o FS do repo-alvo e **hospeda o serviço de memória**
  (git próprio + índice + WS) no mesmo processo NestJS/Node. É esse
  posicionamento que permite manter o **git da memória em volume dedicado do
  serviço**, separado do repo-alvo, sem depender de container — coerente com o
  isolamento que o ADR-0019 já estabeleceu para a API.

- **[ADR-0020](0020-mcp-server-second-control-plane.md) — MCP como 2º plano de
  controle.** O MCP é o canal natural pelo qual os agents **leem e escrevem** a
  memória (consultar neurônios, adquirir lock, gravar aprendizado). A memória vira
  mais um recurso exposto por esse segundo plano de controle, e os **eventos WS**
  da Camada 2 permitem que o MCP e a UI reajam a mutações **sem _polling_**,
  reaproveitando o padrão de invalidação já adotado no projeto.

- **[ADR-0008](0008-git-worktree-per-execution.md) — git worktree por execução.**
  É justamente o isolamento por worktree que **cria** o problema de amnésia: cada
  execução nasce em um worktree efêmero e o que ela aprende não é visto pelas
  outras. Este ADR é a **contraparte** disso: um substrato de memória
  **compartilhado e persistente**, fora do worktree, onde o conhecimento de uma
  sessão fica disponível para as próximas e para agents paralelos — exatamente o
  que arquivos locais/ignorados (ver acima) não conseguem oferecer.

## Emenda — 2026-08-30 (US-F2.10/EP-F2): cutover para o grafo — boa parte desta decisão está revogada

O EP-F2 mediu o serviço descrito acima funcionando de verdade e o resultado
obrigou a revisão: **a arquitetura de coordenação deste ADR estava
tecnicamente correta e funcionalmente inútil**, porque o elo que justificava
tudo — o *recall* (a memória chegar à próxima sessão) — praticamente nunca
funcionou. Esta emenda registra o cutover (`GRAPHIFY_MEMORY_RECALL` e
`GRAPHIFY_AFFECTED_FLOWS` com default **ligado**) e delimita o que fica de pé.

### A evidência medida (por que revogar)

- **US-F2.1 (oráculo de characterization, `memory-recall.characterization.spec.ts`):**
  o recall legado fazia `contains` da **frase inteira** (`título + nomes de
  flows` concatenados) contra o índice. Com qualquer `affectedFlow` presente,
  nada casa; com termo vazio, devolve **5 neurônios arbitrários** (os mais
  recentes); e a falha é **100% silenciosa** — "memória vazia" e "memória
  quebrada" eram indistinguíveis para a IA e para o operador. A colmeia
  acumulava conhecimento que **não voltava**.
- **US-F2.5 (`memory-recall-graph.spec.ts` + validação empírica contra o
  sidecar real):** no mesmo cenário, o `LIKE` devolve `[]` e a travessia do
  grafo devolve o neurônio certo — recuperado **porque a task toca o arquivo**
  (aresta `describes`, ADR-0041/US-F2.4), não porque compartilha palavras.
- **US-F2.7:** o blast radius derivado do grafo achou **7 arquivos afetados
  não declarados** pela IA numa iteração real deste próprio repo (commit
  `8f3d27f`).

### O que esta emenda REVOGA

- **Git como fonte da verdade da memória (Camada 1 como repositório).** O
  bare repo próprio + `isomorphic-git` saem. Os neurônios viram **arquivos
  `.md` simples** no clone do Project (`<clone>/.hive/**.md`, materializados
  pela US-F2.4), indexados pelo grafo de conhecimento do graphify (ADR-0041).
- **Camada 2 inteira — índice Postgres, locks e eventos `memory.*`.** O
  `MemoryIndex` global, o lease advisory (TTL/heartbeat), o modelo
  `FREE`/`EDITING`/`REVIEW`, o CAS por `baseCommit`/`409`, os ramos
  `mem/ai/<sessao>/*` e a arbitragem por `REVIEW` deixam de existir. No alvo,
  a **API é a única escritora** (canal `learnings` do resultado da iteração,
  serializado por task — US-F2.6): não há escritores concorrentes externos
  para coordenar, então o aparato de coordenação protege um cenário que não
  ocorre mais.
- **O control plane `/memory/*` + as 12 tools MCP `memory_*` +
  `MEMORY_API_TOKENS`** (deprecados na US-F2.8; deleção mecânica na US-F2.3 —
  tabela de destinos em `docs/specs/ep-f2-rewire-consumidores.md`). Agents
  externos consultam o MCP do graphify diretamente.

### O que se PERDE (perdas conscientes, sem eufemismo)

- **Histórico/blame do aprendizado.** "O que a AI sabia quando?" deixa de ter
  resposta nativa: o `.md` no `.hive/` é a única versão. O rollback de um
  aprendizado errado vira edição manual, não `git revert`.
- **Identidade e escopo por agent.** O graphify tem UMA `--api-key`: some o
  `holder` estável, o escopo de escrita por módulo (`classifyWrite`) e a
  atribuição de autoria. Mitigação de fato: sem endpoints de escrita externos,
  a chave única protege só leitura.
- **Arbitragem de conflito.** Sem escritores concorrentes não nasce `REVIEW`;
  se um dia houver múltiplos escritores de memória de novo, o problema de
  *lost-update* volta e precisará de solução nova (este ADR continua sendo o
  registro de como foi resolvido uma vez).

### O que se GANHA

- **Recall que funciona** — recuperação por estrutura (a task toca o arquivo →
  o arquivo tem aresta `describes` → o neurônio volta), com a evidência medida
  acima, e **falha honesta**: quando o grafo não está `ready` ou o sidecar
  está fora, a IA recebe aviso explícito no prompt ("Memória do projeto
  INDISPONÍVEL"), o card recebe Activity e o boot avisa o operador quando a
  frota inteira está sem memória (`GRAPHIFY_API_KEY` ausente com o recall
  ligado). **Sem fallback para o LIKE** — decisão da US-F2.5, reavaliada e
  mantida neste cutover: o oráculo da F2.1 prova que o fallback devolveria
  `[]` nos mesmos cenários, ou seja, ele só re-mascararia a falha (o defeito
  original) sem recuperar nada.
- **Menos peças operacionais**: sai o bare repo + índice + scheduler de
  GC/lease do processo da API; a ordem de escrita disciplinada
  (`commit → reindexa → WS`) deixa de ser um invariante a policiar.

### O que SOBREVIVE (a premissa original continua valendo)

- **Neurônios `.md` granulares, legíveis e escrevíveis por humanos e AIs** —
  o coração deste ADR está intacto; mudou o **substrato** (arquivo no clone +
  grafo, em vez de git próprio + índice), não o **formato** nem o objetivo
  (fechar a amnésia entre sessões, ADR-0008).
- **A separação "conteúdo vs. índice descartável"**: o grafo do graphify é
  100% reconstruível a partir dos `.md` (rebuild), exatamente como o índice
  Postgres era — o princípio do ADR-0004 segue aplicado, com outra engine.
- **O diagnóstico do Contexto** (sessões efêmeras perdem conhecimento; os
  documentos estáticos não bastam) permanece válido e é o que o grafo passa a
  servir.

### Rollback e remoção

`GRAPHIFY_MEMORY_RECALL=false` / `GRAPHIFY_AFFECTED_FLOWS=false` restauram o
comportamento legado **byte-idêntico** (provado pelas specs de paridade das
US-F2.5/F2.7 — é a rede de segurança do épico). O substrato velho vive até a
**US-F2.3**, que deleta o módulo `memory/` seguindo a tabela de destinos da
US-F2.8; a partir dela o rollback deixa de existir e esta emenda passa a
descrever o único caminho.

## Emenda — 2026-08-30 (US-F2.3/EP-F2): a deleção prevista acima foi EXECUTADA

A emenda da US-F2.10 delimitou o que estava revogado e previu: *"o substrato
velho vive até a US-F2.3 … a partir dela o rollback deixa de existir"*. Esta
emenda registra que a US-F2.3 aconteceu — o que segue abaixo é o estado real
do sistema, e o corpo deste ADR passa a ser histórico.

### O que foi deletado (seguindo `docs/specs/ep-f2-rewire-consumidores.md`)

- **O módulo `apps/api/src/modules/memory/` inteiro** (~5.2k linhas): bare
  repo + `isomorphic-git` (Camada 1), índice/CAS/merge 3-way (Camada 2),
  locks/lease, REVIEW/arbitragem, bootstrap/semeadura, GC, scheduler, guard e
  registro de tokens.
- **O control plane `/memory/*`** (11 rotas) e **as 12 tools MCP `memory_*`**.
- **`MEMORY_*` envs** (`MEMORY_GIT_DIR`, `MEMORY_SCHEDULER_ENABLED`,
  `MEMORY_LOCK_SWEEP_INTERVAL_MS`, `MEMORY_GC_INTERVAL_MS`,
  `MEMORY_API_TOKENS`) e o bloco `config.memory`.
- **Os tipos/eventos do substrato** em `packages/shared`: eventos
  `memory.*`, DTOs de lock/CAS/REVIEW, `Neuron`, `AgentId`, `Owner`,
  `MemoryLockState`/`MemoryAccessMode`; `MemoryNeuronSummary`/`Detail`
  perderam os campos de coordenação (`lockState`/`holder`/`stale`/
  `archivedAt`/`headCommit`).
- **Os neurônios existentes no bare repo** — apagados sem migração e sem
  arquivamento (decisão do dono). Os `.md` já materializados em
  `<clone>/.hive/` são o dado vivo.
- **O rollback `GRAPHIFY_MEMORY_RECALL=false`** deixou de restaurar o LIKE
  (não existe mais LIKE): agora só DESLIGA o recall. O oráculo da US-F2.1
  (`memory-recall.characterization.spec.ts`) foi aposentado junto — o
  comportamento que ele fixava (e os 8 achados) está registrado no épico.

### O que mudou de lugar (sobreviventes)

- `neuron-format.ts` (formato v2, `appendLearning` lazy) →
  `apps/api/src/shared/neuron-format.ts`.
- `detectModules` → `apps/api/src/modules/projects/detect-modules.ts`
  (o Explorer `repoInfo` sempre foi consumidor — correção ao doc da F2.9, que
  o dava como morto).
- A escrita de learnings → `ProjectHiveService.mutateHiveFile` (o `.hive/`
  do clone é a fonte da verdade; `materialize()` deixou de existir — quem
  escreve avisa o grafo via rebuild incremental).
- `withNamespace` NÃO sobreviveu (correção ao §5.4 do doc da F2.9): sem bare
  repo compartilhado não há namespace — o isolamento por Project é o próprio
  clone.

### A resposta ao lost-update (o que o CAS/merge protegia)

Dois agents anexando ao mesmo neurônio era o cenário que o aparato de
coordenação resolvia. A resposta mínima honesta implementada:

1. **A API é a única escritora** (decisão da F2.8 §2.1; sem control plane não
   há escritor externo) e roda em **um único processo Node**.
2. `mutateHiveFile` faz o read-modify-write **síncrono, sem await entre a
   leitura e o rename** — em Node single-thread duas escritas nunca se
   intercalam dentro do processo, qualquer que seja a concorrência de stories
   (`AGENT_SERIALIZE_BY_REPO` continua sendo um guard adicional opcional, e a
   serialização por epic/`inFlight` reduz a janela a quase nada).
3. A escrita é **atômica no FS** (tmp + rename) contra corrupção por crash.

Teto conhecido e documentado no código (`project-hive.service.ts`): a
garantia é single-process. Se um dia houver um segundo escritor (outra
instância da API, um worker), o lost-update volta — e este ADR continua sendo
o registro de como o problema foi resolvido uma vez.

### O que segue vivo (e por quê)

- O model Prisma **`MemoryIndex`** ainda existe no schema — a remoção é a
  **US-F2.12**, bloqueada pelo EP-F4. Nota da execução da F2.3: depois desta
  deleção ele ficou **sem nenhum consumidor de produção** (o fallback do
  Explorer, seu último leitor, morreu aqui).
- `ProjectHiveService` (leitura + escrita do `.hive/`), o formato v2 de
  neurônio e o recall por grafo — o coração da premissa original (fechar a
  amnésia entre sessões) nas mãos do novo substrato.

## Emenda — 2026-08-30 (US-F2.12/EP-F2): o índice foi aposentado — Camada 2 integralmente desmontada

A pendência registrada acima ("o model Prisma `MemoryIndex` ainda existe no
schema — a remoção é a US-F2.12") foi executada: migration
`20260830120000_f212_drop_memory_index` dropa a tabela e o model saiu do
`schema.prisma`.

Por que o DROP destrutivo é seguro (a decisão não é nova — é consequência):

- O model era a **projeção derivada** de neurônios do git da memória, e esse
  substrato foi apagado na US-F2.3 (decisões do dono: o git da memória sai,
  os neurônios são apagados). Projeção de fonte que não existe não tem o que
  preservar.
- **Zero consumidores de produção** desde a F2.3 — o fallback do Project
  Explorer era o último leitor e morreu lá; a verificação da F2.12 confirmou
  zero referências de código em `apps/api`, `apps/mcp`, `apps/web` e
  `packages/shared`.
- Este próprio ADR o definiu como *"cache, não arquivo… não há migração de
  dados de memória para preservar"* (ADR-0004 aplicado à memória).

Com isso a **Camada 2 está integralmente desmontada**: módulo, control plane,
tools MCP, envs, tipos (F2.3) e agora o storage (F2.12). O que segue vivo é o
listado na emenda da F2.3: `ProjectHiveService` + `.hive/` no clone, formato
v2 de neurônio e recall por grafo.
