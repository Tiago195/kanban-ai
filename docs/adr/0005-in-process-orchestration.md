# ADR-0005 — Orquestração in-process com watchdog e adapter plugável

**Status:** Aceito

## Contexto

Quando uma story entra em "In Progress", um agent precisa ser acordado e trabalhar
em iterações encadeadas até fechar o DOD e validar. Precisamos de robustez
(retomar após quedas) sem introduzir infraestrutura pesada no v1.

## Decisão

Orquestração **in-process, sem Redis no v1**:

- Story → In Progress **dispara um evento** que acorda o agent; ao terminar uma
  iteração, a próxima é encadeada.
- Um **watchdog `setInterval` (~2 min)** verifica a sessão enquanto a story está
  viva em In Progress e retoma o fluxo se travou; morre em Review/Done ou stop
  manual.
- O **`AgentSessionManager` fica atrás de uma interface plugável**, para ser
  trocado por **BullMQ + Redis** no futuro sem tocar no `Orchestrator` nem no
  domínio.

**4 salvaguardas obrigatórias** (todas in-process):

1. **Reconciliação no boot** — varrer stories em In Progress no Postgres e recriar
   watchdogs (estado de verdade = banco).
2. **Limite de concorrência** — máx `N` sessões; excedente aguarda slot.
3. **Idempotência do watchdog** — não inicia segunda iteração se já há uma
   `running`; só age em `dead`/`idle` travado.
4. **Encerramento limpo** — `AbortSignal` no subprocess (stop hard).

**Stop manual em dois modos:** *graceful* (não inicia a próxima) e *hard/abort*
(interrompe imediatamente).

## Consequências

- Simplicidade operacional no v1 (nenhum serviço extra).
- Estado de verdade no Postgres → sobrevive a restart.
- Caminho de evolução claro para BullMQ/Redis via a interface do session manager.
- Ver mecânica completa em [docs/loop-engine.md](../loop-engine.md).
