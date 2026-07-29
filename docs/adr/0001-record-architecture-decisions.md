# ADR-0001 — Registrar decisões de arquitetura via ADR

**Status:** Aceito

## Contexto

O produto será desenvolvido em grande parte por **agents de AI**, que precisam
entender rapidamente **por que** o projeto é do jeito que é para não reverter
decisões deliberadas.

## Decisão

Registrar decisões arquiteturais relevantes como **ADRs** curtos em `docs/adr/`,
numerados sequencialmente, no formato contexto → decisão → consequências.

## Consequências

- AIs e humanos têm uma fonte única e versionada dos porquês.
- Toda decisão que altere boundaries, stack ou invariantes deve virar (ou atualizar)
  um ADR.
