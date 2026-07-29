# ADR-0009 — Sem autenticação no v1

**Status:** Aceito

## Contexto

O v1 é **single-tenant local**: roda na máquina do desenvolvedor para orquestrar
agents de AI sobre repositórios locais. Autenticação completa adicionaria
complexidade sem valor imediato nesta fase.

## Decisão

**Não implementar login/autenticação no v1.** Deixar apenas o **ponto de extensão**
previsto (guards do Nest) para quando multi-tenant/remoto for necessário.

## Consequências

- Setup e desenvolvimento mais rápidos.
- A API **não** deve ser exposta publicamente no v1.
- Introduzir auth depois é aditivo (guards + estratégia), sem reescrever o domínio.
