# ADR-0041 — Sidecar graphify: grafo de conhecimento servido por MCP/HTTP

**Status:** Aceito

## Contexto

O EP-F1 introduz o **graphify** (grafo de conhecimento de código) como fonte de
contexto estrutural para o loop engine e para os agents. O graphify é um pacote
**Python** (PyPI `graphifyy`) cujo servidor MCP suporta dois transportes: stdio
(um processo por cliente) e **Streamable HTTP** (`serve_http`, MCP spec
2025-03-26 — um processo compartilhado servindo N clientes).

O stack do kanban-ai é 100% Node/TypeScript em 3 containers (`postgres`, `api`,
`web`) com `network_mode: host` (docker-compose.yml). Precisamos decidir **onde
esse processo Python vive** e **qual grafo ele serve**, sem tocar em nenhum
comportamento existente (o cliente MCP no Nest é a US-F1.4; a construção dos
grafos é a US-F1.3).

Restrições relevantes:

- `network_mode: host` é o padrão dos 3 serviços atuais — um serviço novo em
  rede docker própria não seria alcançável pelos demais (que não estão em rede
  docker nenhuma).
- Os clones dos Projects vivem no volume nomeado `kanban_projects`
  (`PROJECTS_DIR=/data/projects`, ADR-0038) — o graphify precisa enxergá-los
  para servir grafos por projeto (`project_path` nos tools).
- O grafo **global** do graphify vive em `~/.graphify/global-graph.json` do
  usuário que roda o processo (`graphify/global_graph.py`), e o CLI `global add`
  agrega grafos de N projetos nele.

## Decisão

### 1. Sidecar HTTP em container próprio — não Python embutido no processo Node

O graphify sobe como **4º serviço** do compose (`graphify`,
`docker/graphify.Dockerfile`), expondo o MCP por **Streamable HTTP** em
`http://127.0.0.1:${GRAPHIFY_MCP_PORT:-8129}/mcp`. Alternativa rejeitada:
embutir Python no processo/imagem da API (spawn de `python -m graphify.serve`
por stdio a partir do Nest). Isso acoplaria o ciclo de vida do grafo ao da API
(restart da API = índice frio), exigiria Python + deps na imagem Node, e
multiplicaria processos (um servidor stdio por cliente MCP). O transporte HTTP
existe exatamente para o caso "um processo compartilhado, N clientes"
(`serve_http` mantém o índice quente e faz hot-reload do graph.json dentro dos
tool handlers).

### 2. Um grafo POR Project, endereçado por `project_path` — não grafo global

O isolamento por projeto é **nativo** do servidor: o serve injeta um argumento
opcional `project_path` no schema de TODOS os tools em runtime (`serve.py:1710`
— "Multi-project support: every tool accepts an optional project_path"), e
`_resolve_graph_path` mapeia `project_path` →
`<project_path>/<GRAPHIFY_OUT>/graph.json`, com LRU de contextos por grafo.

Decisão: **um grafo por Project**, materializado em
`/home/graphify/.graphify/projects/<projectId>/graphify-out/graph.json`
(dentro do volume `kanban_graphify_home`). O cliente (US-F1.4) passa
`project_path=/home/graphify/.graphify/projects/<projectId>` em cada chamada.
Isolamento fica **por construção** — nenhum tool enxerga outro projeto sem
pedir por ele (o furo do filtro por `repo_tag` desaparece) — e apagar um
Project é apagar o diretório dele, sem manifesto nem re-agregação.

O positional do entrypoint segue apontando `~/.graphify/global-graph.json`
apenas como grafo **default** do processo (o CLI exige um path; chamadas sem
`project_path` caem nele). Ele não precisa existir — a carga é lazy, por tool.

### 3. `GRAPHIFY_OUT` RELATIVO no serve; absoluto SÓ no build

`_resolve_graph_path` faz `Path(project_path) / GRAPHIFY_OUT / "graph.json"`.
Em Python, juntar um segundo componente **absoluto** descarta o primeiro:

```
Path('/data/projects/abc') / 'graphify-out'        → /data/projects/abc/graphify-out   ✅
Path('/data/projects/abc') / '/home/graphify/out'  → /home/graphify/out                ❌ colapsa
```

Um `GRAPHIFY_OUT` absoluto no processo do **serve** faria TODOS os
`project_path` resolverem para o MESMO grafo — **vazamento silencioso entre
projetos, sem erro nenhum**. É exatamente a "otimização" que alguém faria
depois para redirecionar a saída; não faça.

Decisão: o processo do **serve** NUNCA recebe `GRAPHIFY_OUT` (fica no default
relativo `graphify-out`). Quem redireciona a saída é o processo de **build**
(US-F1.3), rodando com `GRAPHIFY_OUT` **absoluto** =
`/home/graphify/.graphify/projects/<projectId>/graphify-out`. Assim os dois se
encontram no mesmo path sem que o serve jamais veja um valor absoluto.

### 4. PyPI pinado — não build do fonte

A imagem instala **`graphifyy[mcp]==0.9.51`** do PyPI. O Dockerfile upstream
builda do fonte "para incluir o transporte HTTP antes de chegar ao PyPI" — isso
está **desatualizado**: o wheel 0.9.51 já contém `serve_http`/`--transport`
(a tag do fonte é o mesmo commit da versão publicada). Buildar de um checkout
local (`~/dev/fontes/graphify`) quebraria o compose em qualquer outra máquina.
O pin garante reprodutibilidade; bump é mudança consciente e revisável.

### 5. Postura de segurança

Com `network_mode: host` o processo escuta **na rede do host**, então:

- **bind fixo em `127.0.0.1`** — nunca `0.0.0.0` (exporia o grafo, que contém
  estrutura e trechos de código dos repos, à rede inteira);
- **`GRAPHIFY_API_KEY` obrigatória** — o entrypoint do compose recusa subir sem
  ela (fail-fast), porque o `serve_http` normaliza chave vazia para "sem auth";
- **porta default 8129**, configurável — não o 8080 default do upstream (porta
  comum demais para um serviço no host);
- imagem roda como **usuário não-root** (uid 10001), como o upstream;
- `kanban_projects` montado **`:ro`** — decisão deliberada. O que sustenta o
  `:ro` NÃO é só "o serve só lê" (verdade, mas insuficiente): é a decisão §3
  de o **build escrever FORA do clone** (`GRAPHIFY_OUT` absoluto sob o HOME do
  sidecar). O default do graphify é escrever `graphify-out/` DENTRO do repo
  escaneado — o que sujaria o working tree do repo-alvo, onde os agents
  trabalham. Se um build futuro regredir ao default, ele **quebra no `:ro`**
  em vez de poluir o clone: comportamento desejado.

## Consequências

**Positivas**
- Grafo servido por um processo compartilhado, quente, com ciclo de vida
  independente da API (restart da API não recarrega o índice).
- Zero mudança de comportamento existente: nenhum código TypeScript tocado;
  quem não definir `GRAPHIFY_API_KEY` vê apenas o serviço `graphify` em
  restart-loop com erro explicativo — postgres/api/web sobem normalmente.
- Reprodutível em qualquer máquina: imagem 100% PyPI, sem dependência de
  checkout local ou proxy de host.

**Negativas / cuidados**
- **Chave única compartilhada**: o graphify autentica por UMA api-key, sem
  identidade por agent — diferente do `MEMORY_API_TOKENS`
  (`token:agentId:scope`, ADR-0027/EP-C). Qualquer portador da chave lê o grafo
  de QUALQUER Project (basta passar o `project_path` dele). Auditoria por agent
  e escopo por projeto ficam para quando o upstream tiver OAuth (follow-up declarado no
  próprio `serve_http`) ou para um proxy nosso.
- **Localhost ≠ isolado**: com bind em 127.0.0.1, qualquer processo local
  (inclusive agents rodando no host) alcança a porta — a api-key é a única
  barreira; por isso ela é obrigatória e sem default.
- O serviço sobe **antes de existir grafo**: sem `global-graph.json` o servidor
  responde e os tools retornam erro legível por chamada (carga é lazy, por
  handler — nunca derruba o processo). Popular o grafo é a **US-F1.3**.
- **QUESTÃO ARQUITETURAL ABERTA (bloqueia US-F1.3/F1.5/F1.6): não existe
  caminho de BUILD.** O container roda SÓ o servidor MCP e a API Nest não tem
  Python — hoje não há onde executar o scan (`graphify <repo>`) nem o
  `affected` (subcomando de CLI, não tool MCP). Opções, a decidir na US-F1.3:
  - (a) **wrapper HTTP fino no próprio sidecar** expondo build+affected —
    alinhado com o que a US-F1.6 já prevê; o build lê o clone (`:ro` basta) e
    escreve no HOME (rw). Custo: um processo/rotas extra no sidecar.
  - (b) **instalar graphify também na imagem da API** — custo: runtime Python
    inteiro na imagem Node e duas instalações a manter na mesma versão.
  - (c) **`docker exec` no sidecar a partir da API** — custo: exige montar o
    socket do Docker na API (equivalente a root no host); risco inaceitável.
  - (d) **container efêmero por build** — custo: a API precisa falar com o
    Docker (mesmo problema do socket) ou de um runner externo.
- Upgrade do graphify é manual (bump do pin no Dockerfile + rebuild).

## Alternativas consideradas

- **stdio spawn por cliente (Python na imagem da API)** — rejeitada: acopla
  ciclos de vida, engorda a imagem Node com um runtime Python, índice frio a
  cada spawn.
- **Grafo GLOBAL agregado (`global add` → `~/.graphify/global-graph.json`)** —
  rejeitada: com `project_path` nativo, a agregação (global_add, manifest,
  prefixação de `repo_tag`) é complexidade sem função. Isolamento por
  construção substitui filtro por prefixo, e remover um Project vira apagar um
  diretório em vez de re-agregar o grafo.
- **Um container graphify por Project** — rejeitada: compose é estático,
  Projects são dinâmicos; `project_path` nos tools + volume `:ro` já cobre.
- **Build do fonte no Dockerfile (como o upstream)** — rejeitada: comentário
  upstream desatualizado; dependeria de um path local inexistente nas outras
  máquinas.
- **Rede docker dedicada em vez de `network_mode: host`** — rejeitada: os
  outros 3 serviços estão em host mode e não a enxergariam; criaria dois
  regimes de rede no mesmo compose.

## Referências

- Complementa: [ADR-0038](0038-project-clone-in-volume-enables-containerized-api.md)
  (volume `kanban_projects`), [ADR-0027](0027-memory-as-a-living-service.md)
  (contraste do modelo de auth `MEMORY_API_TOKENS`),
  [ADR-0020](0020-mcp-server-second-control-plane.md) (MCP como plano de controle).
- Épico: EP-F1 (US-F1.1; cliente Nest na US-F1.4; construção do grafo na US-F1.3).
