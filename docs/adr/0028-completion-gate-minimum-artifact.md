# ADR-0028 — Gate de completude por artefato mínimo verificável

**Status:** Aceito (implementado — US-ROB1)

**Data:** 2026-08-12

## Contexto

O loop engine só marca um item do DOD (ou uma task) como `done` a partir do que o
agent auto-reporta no resultado da iteração (`KANBAN_RESULT`). O contrato de
evidência já existe e é parcialmente verificável:

- `packages/shared/src/domain.ts:304-326` define `StructuredEvidence`
  (`checks: EvidenceCheck[]`, `filesChanged?`, `note?`) e a função
  `isVerifiableEvidence(evidence)`, que só retorna `true` quando há **ao menos um
  check com `passed === true`** (string livre nunca é verificável).
- O gate de `done` no orchestrator (`apps/api/src/modules/ai-engine/orchestrator.ts`,
  região ~574-620) e a validação empírica por `affectedFlows`
  (`apps/api/src/modules/ai-engine/validators/validation.runner.ts`) já rodam.

O problema apontado pela análise das ferramentas de referência (**NanoClaw** — gate
de completude anti-"falso sucesso"; reforçado pelo **Hermes**) é que
`isVerifiableEvidence` é **genérico**: aceita qualquer check `passed=true`, sem
exigir que o **tipo de artefato** entregue corresponda ao **tipo de trabalho** que
a iteração alegou fazer. Um agent pode fechar um item que exigia código novo sem
produzir diff, desde que reporte um check verde qualquer — um "falso sucesso".

Não há hoje o conceito de **classe de resultado** nem de **artefato mínimo
obrigatório por classe**. Este é um dos itens de maior ROI do épico
[EP-ROB](../specs/ep-rob-robustez.md).

## Decisão

Introduzir um **gate de completude por artefato mínimo verificável**, que
**estende** (não reescreve) o contrato e o gate existentes.

1. **Classe de resultado (`ResultClass`)** no contrato compartilhado
   (`packages/shared`): classifica o que a iteração alegou entregar — p.ex.
   `code` (exige diff não-vazio), `test` (exige check de teste `passed=true`),
   `flow` (exige que o arquivo declarado em `affectedFlows` exista/seja
   verificável), `verification` (fechamento de DOD de verificação, que
   legitimamente não gera diff).

2. **`minimumArtifactSatisfied(evidence, resultClass, context)`**: função pura em
   `packages/shared` que decide se o artefato mínimo da classe foi satisfeito,
   reusando `isVerifiableEvidence` para os checks. O gate de `done` no orchestrator
   passa a **exigir** essa satisfação além do que já verifica.

3. **Flag `AGENT_REQUIRE_MIN_ARTIFACT`** (default **off**, ligada explicitamente):
   quando ligada, fechar um item sem o artefato mínimo da sua classe é **recusado
   e escala** (via `escalateToHuman`), em vez de aceitar o falso sucesso.

A regra de negócio já consolidada em correções anteriores (fechar DOD de
**verificação** não exige diff; a atestação por item nunca é bloqueada por diff
vazio) é **preservada** pela classe `verification`.

O contrato TypeScript exato, o mapeamento classe→artefato e o ponto de integração
(linhas) estão em [`docs/specs/ep-rob-robustez.md`](../specs/ep-rob-robustez.md)
(US-ROB1).

## Consequências

- **Positivas:** `done` deixa de fechar por "falso sucesso"; a evidência passa a
  ser verificada **por classe**; sem Redis nem serviço externo; retrocompatível
  (flag off = comportamento atual; string livre legada segue aceita onde já era).
- **Negativas / riscos:** classificar mal a `ResultClass` pode bloquear um
  fechamento legítimo — por isso a flag nasce off e a classe `verification`
  protege os fechamentos de DOD sem diff. Um agent malicioso ainda pode reportar
  uma classe errada; a defesa complementar continua sendo a regra nano (1 item/
  iteração, ids validados) + o cap de improdutivas DOD-aware.
- **Invariantes preservados:** não reintroduz DOR/acceptance (ADR-0007); o único
  gate continua sendo o DOD, agora com verificação de artefato por classe.
