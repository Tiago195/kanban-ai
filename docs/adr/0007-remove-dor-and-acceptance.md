# ADR-0007 — Remover DOR e `acceptance` no v1 (só DOD)

**Status:** Aceito

## Contexto

O protótipo inicial cogitou **DOR (Definition of Ready)** e um campo `acceptance`
além do **DOD (Definition of Done)**. Ao desenhar o loop engine, ficou claro que o
único gate necessário para o ciclo autônomo é o **DOD**: a iteração final de
validação dispara quando **todos os itens de DOD** estão marcados. DOR e
`acceptance` adicionavam superfície de modelo e UI sem papel no motor.

## Decisão

**Remover DOR e `acceptance` do modelo no v1.** O único checklist é o **DOD**.

- Schema Prisma, seed, enums de `packages/shared` e a UI **não** incluem DOR nem
  `acceptance`.
- **Não reintroduzir** sem um novo ADR que o justifique.

## Consequências

- Modelo e UI mais enxutos; o gate do loop engine é inequívoco (DOD).
- Guard-rail explícito para AIs: qualquer PR que adicione DOR/`acceptance` deve ser
  rejeitado a menos que acompanhe um ADR revertendo esta decisão.
