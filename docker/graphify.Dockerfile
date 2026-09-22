# ─────────────────────────────────────────────────────────────────────────────
# Sidecar graphify — servidor MCP do grafo de conhecimento (US-F1.1, ADR-0041).
#
# Instala `graphifyy[mcp]` PINADO do PyPI — NÃO builda do fonte: o wheel
# publicado 0.9.51 já contém o transporte Streamable HTTP (`serve_http` +
# `--transport http`), e um build a partir de um checkout local (~/dev/...)
# quebraria o compose em qualquer outra máquina. O extra `[mcp]` puxa
# mcp + starlette + uvicorn, necessários para o transporte HTTP.
#
# graph.json NUNCA é baked na imagem — vem de volume em runtime: os grafos
# (um por Project) vivem sob ~/.graphify do usuário do container (volume
# `kanban_graphify_home` no compose), FORA dos clones — é isso que permite
# montar os clones dos Projects :ro sem sujar o repo-alvo (ADR-0041 §3).
#
# Roda como usuário NÃO-root: com `network_mode: host` no compose o serviço
# fica exposto na rede do host (bind 127.0.0.1, mas defesa em profundidade).
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim

# Versão pinada — bump consciente, nunca `latest` (reprodutibilidade).
RUN pip install --no-cache-dir "graphifyy[mcp]==0.9.51"

# Wrapper HTTP de build+affected (US-F1.6) — convive com o servidor MCP no
# mesmo container; o compose sobe os dois e derruba o container se um morrer.
COPY docker/graphify_build_server.py /opt/graphify_build_server.py

# Usuário não-root com HOME próprio. O ~/.graphify é criado JÁ na imagem, com
# dono graphify, para que o volume nomeado montado ali herde essas permissões
# na primeira subida (senão o Docker o criaria como root e o serve não leria).
RUN useradd --create-home --uid 10001 graphify \
  && mkdir -p /home/graphify/.graphify \
  && chown -R graphify:graphify /home/graphify/.graphify
USER graphify
WORKDIR /home/graphify

# O compose sobrescreve o entrypoint para exigir GRAPHIFY_API_KEY antes do
# exec (fail-fast — ver docker-compose.yml). Este default serve para uso
# manual da imagem (stdio, debug).
ENTRYPOINT ["python", "-m", "graphify.serve"]
