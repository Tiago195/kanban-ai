# ADR-0018 — Estado `awaiting-input` mantido in-process (sem migration)

**Status:** Aceito (parcialmente superado por [ADR-0022](0022-hitl-survives-restart-via-cli-session-id.md) quanto à sobrevivência a restart)

## Contexto

O fluxo HITL ([ADR-0017](0017-streaming-hitl-websocket.md)) introduz um estado de
espera: quando a AI faz uma pergunta, a iteração **pausa** aguardando a resposta
do usuário (`awaiting-input`). A pergunta pendente, o handle do subprocesso e o
`resolve` da Promise precisam viver em algum lugar. A questão: **persistir** esse
estado (novo valor no enum `ExecState`/`AgentSessionState` + colunas para a
pergunta, exigindo migration) **ou** mantê-lo **in-process**.

O produto tem a restrição de **preferir não exigir migration** (o `awaiting-input`
seria o único ponto onde uma migration aditiva mínima seria aceitável).

## Decisão

Manter o estado de espera **in-process**, no `AgentSessionManager` (memória):

- A `PendingQuestion` (`{ taskId, questionId, prompt, options?, resolve, timer }`)
  fica na sessão da story. `waitForAnswer` retorna uma Promise que o runner
  aguarda; `resolveQuestion` a resolve com a resposta e retoma a iteração.
- **Não** há novo valor persistido de enum nem colunas novas — **nenhuma
  migration**. O `execState` do card não ganha `awaiting-input`; o indicador
  "aguardando você" é **derivado** do evento `agent.question` (WS) e some com
  `agent.answered`.
- Órfãos após restart: o subprocesso morre junto com o processo da API; a sessão
  é reconciliada por `reconcileOnBoot` como qualquer sessão morta (nova iteração
  em vez de uma espera pendurada). Um `AGENT_HITL_TIMEOUT_MS` (default 600000ms)
  também rejeita esperas longas demais.

## Rationale

- O estado de espera é **efêmero** — está atado a um **processo vivo** com um
  `resolve` em memória e um stdin aberto. Persistir o "aguardando" sem o processo
  vivo não teria como retomar de verdade após restart; exigiria re-spawn com
  transcript, o que é uma evolução futura, não requisito desta fatia.
- Evita migration e mantém o schema estável.
- `reconcileOnBoot` + timeout cobrem o caso de crash/restart de forma segura.

## Consequências

- Zero migration nesta fatia.
- Uma pergunta pendente **não sobrevive** a um restart da API — vira sessão morta
  reconciliada. Aceitável dado o caráter efêmero e a raridade do evento.
- Se no futuro quisermos retomar após restart, será preciso persistir o transcript
  e re-spawnar com contexto — registrar em ADR próprio quando/se necessário.
