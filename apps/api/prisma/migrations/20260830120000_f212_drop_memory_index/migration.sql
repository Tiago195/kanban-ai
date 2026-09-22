-- US-F2.12 — Aposenta o model `MemoryIndex` (última peça da Camada 2 do ADR-0027).
-- DESTRUTIVA e irreversível, mas SEGURA: a tabela era PROJEÇÃO DERIVADA e
-- DESCARTÁVEL dos neurônios do git da memória — um substrato que não existe
-- mais (deletado na US-F2.3; o dado vivo são os `.md` em `<clone>/.hive/`).
-- Zero consumidores de produção desde a F2.3 (o fallback do Project Explorer
-- era o último leitor) e o próprio ADR-0027 define: "cache, não arquivo…
-- não há migração de dados de memória para preservar".
DROP TABLE "MemoryIndex";
