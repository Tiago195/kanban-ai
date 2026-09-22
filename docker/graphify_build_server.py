"""Wrapper HTTP do sidecar graphify: BUILD + AFFECTED (US-F1.6, ADR-0041).

O container do graphify roda o servidor MCP (somente-leitura). Este processo
convive com ele no MESMO container e fecha o furo de build do ADR-0041
(opção (a) da "questão arquitetural aberta"): expõe por HTTP o scan/rebuild
de grafo por Project e o blast radius (`affected`), para o cliente Nest
(US-F1.4) e o loop engine (US-F1.3/F1.5).

Contrato (síncrono — o mais simples que serve à US-F1.3: o caller faz um POST
e, quando a resposta chega, o graph.json já está no lugar; timeout é do lado
do caller + GRAPHIFY_BUILD_TIMEOUT aqui):

  POST /build    {"projectId": str, "files"?: [str repo-relativo], "force"?: bool}
                 → 200 {"ok": true, "projectId", "graphPath", "nodes",
                        "edges", "durationMs", "incremental"}
                 Sem "files": build/rebuild completo (AST, sem LLM).
                 Com "files": rebuild incremental SÓ desses arquivos — usa o
                 merge incremental do graphify (build_merge via _rebuild_code),
                 que preserva os nós dos arquivos ausentes do chunk; paths que
                 não existem mais no clone são tratados como deletados.

  POST /affected {"projectId": str, "seed": str, "depth"?: int,
                  "relations"?: [str]}
                 → 200 {"ok": true, "seed", "hits": [...], "text"}

  POST /projection {"projectId": str, "focus"?: str, "community"?: int,
                    "search"?: str, "depth"?: int, "limit"?: int}
                 → 200 {"ok": true, "mode", "focus", "nodes", "edges",
                        "communities", "totalNodes", "totalEdges", "truncated"}
                 (US-F4.1) Projeção ESTRUTURADA do grafo para a UI, com o
                 corte decidido AQUI (o graph.json real tem ~3500 nós — cru
                 no browser é inútil): overview = top-N god nodes por grau;
                 focus = BFS a partir de um nó; community = nós de uma
                 comunidade; search = casamento por label/arquivo (sem
                 arestas). Lê o graph.json DIRETO (JSON estruturado) em vez
                 de parsear o texto das tools MCP — o débito frágil de regex
                 sobre texto registrado na US-F2.5 não entra na UI.

  POST /reflect  {"projectId": str}
                 → 200 {"ok": true, "projectId", "out", "skipped",
                        "durationMs", "log"}
                 (US-F5.2) Roda `graphify reflect` sobre os memory docs do
                 clone (`<clone>/.hive/memory/*.md`, formato canônico da
                 US-F5.1) com `--graph` no graph.json do Project (quando
                 existe) e `--if-stale` (no-op barato quando o LESSONS.md já
                 é mais novo que todas as entradas). Escreve
                 `reflections/LESSONS.md` no out-dir do Project e o overlay
                 `.graphify_learning.json` ao lado do graph.json (nós
                 preferred/tentative/contested com proveniência). `skipped`
                 não-nulo = nada a fazer (sem memory docs, rebuild em voo ou
                 --if-stale fresco).

  POST /learning {"projectId": str}
                 → 200 {"ok": true, "projectId", "generated", "generatedAt",
                        "docs", "nodes", "deadEnds", "corrections"}
                 (US-UX.3) Leitura ESTRUTURADA do que o `graphify reflect`
                 (US-F5.2) já grava em disco e nenhuma UI via: o overlay
                 `.graphify_learning.json` (nós preferred/tentative/contested
                 com veredito, placar, proveniência e `stale` RECOMPUTADO na
                 leitura via code_fingerprint) + os becos sem saída e
                 correções agregados dos memory docs do clone. Overlay/memória
                 ausentes NÃO são erro: `generated: false` (estado vazio
                 honesto na UI).

  POST /wiki     {"projectId": str}
                 → 200 {"ok": true, "projectId", "articles", "skipped",
                        "durationMs"}
                 (US-F5.4) Gera a wiki navegável do Project em
                 `<out-dir>/wiki/` (index.md + um artigo por comunidade +
                 artigos de god node) chamando `graphify.wiki.to_wiki`
                 DIRETO com o grafo — o CLI `export wiki` exige o
                 `.graphify_analysis.json`, que o NOSSO build (via
                 `_rebuild_code`) nunca escreve; a filiação de comunidade já
                 vive nos atributos dos nós do graph.json (mesma fonte do
                 /projection). `skipped` não-nulo = rebuild em voo (flock) ou
                 grafo sem comunidades.

  POST /wiki-list {"projectId": str}
                 → 200 {"ok": true, "generated": bool, "generatedAt",
                        "articles": [{"slug", "title"}]}
                 (US-F5.4) Lista os artigos gerados. Wiki ausente NÃO é erro:
                 `generated: false` (estado vazio honesto na UI).

  POST /wiki-article {"projectId": str, "slug": str}
                 → 200 {"ok": true, "slug", "title", "content"}
                 (US-F5.4) Lê UM artigo (markdown). `slug` é segmento único
                 (sem separador/`..`) e o path resolvido é validado dentro do
                 diretório da wiki — trust boundary: `../` nunca escapa.

  POST /remove   {"projectId": str}
                 → 200 {"ok": true, "projectId"}
                 (US-F1.3) Remove ~/.graphify/projects/<projectId> inteiro.
                 Idempotente: diretório ausente também responde 200. Apagar o
                 Project é apagar o diretório dele (ADR-0041 §2 — sem
                 global_remove/manifesto); o volume do sidecar só é gravável
                 daqui, então o DELETE do Project na API delega a limpeza a
                 esta rota.

Segurança (mesma postura do MCP, ADR-0041 §5): bind FIXO em 127.0.0.1,
GRAPHIFY_API_KEY obrigatória (fail-fast na subida; 401 sem/errada — aceita
`Authorization: Bearer <chave>` ou `X-API-Key`, como o serve_http).

Por que o build roda em SUBPROCESSO e não in-process: graphify.paths lê
GRAPHIFY_OUT UMA vez, no import — um processo longevo não consegue variar o
destino por Project. Cada build ganha um processo curto com GRAPHIFY_OUT
ABSOLUTO = ~/.graphify/projects/<projectId>/graphify-out (o único lugar onde
absoluto é permitido, ADR-0041 §3). ESTE processo nunca roda com GRAPHIFY_OUT
setado (guard na subida) — setá-lo aqui colapsaria o path do /affected e, por
tabela, denunciaria o mesmo erro no serve.

Concorrência: o subprocess chama graphify.watch._rebuild_code com
block_on_lock=True — o flock por diretório de saída (_rebuild_lock,
watch.py) serializa builds do MESMO Project; Projects diferentes têm
out-dirs (e locks) diferentes e rodam em paralelo.
"""
from __future__ import annotations

import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Bind SEMPRE 127.0.0.1 (ADR-0041 §5) — só a porta é configurável.
HOST = "127.0.0.1"
PORT = int(os.environ.get("GRAPHIFY_BUILD_PORT", "8130"))
API_KEY = (os.environ.get("GRAPHIFY_API_KEY") or "").strip()
PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", "/data/projects"))
# Mesmo layout que o serve resolve para project_path (ADR-0041 §2/§3).
GRAPHS_ROOT = Path.home() / ".graphify" / "projects"
BUILD_TIMEOUT_S = int(os.environ.get("GRAPHIFY_BUILD_TIMEOUT", "1800"))
# US-F5.2 — reflect é determinístico e barato (sem LLM); teto curto próprio.
REFLECT_TIMEOUT_S = int(os.environ.get("GRAPHIFY_REFLECT_TIMEOUT", "120"))

# projectId é segmento único de path (cuid/uuid-like) — nunca separadores.
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _run_build(argv: list[str]) -> int:
    """Corpo do subprocesso de build (invocado como `<este arquivo> --build`).

    Roda com GRAPHIFY_OUT absoluto no env (o único lugar permitido, ADR-0041
    §3). argv: [repo, force("0"/"1"), *arquivos_absolutos]. Reutiliza
    _rebuild_code (AST puro, sem LLM): changed_paths=None = corpus completo;
    com lista = merge incremental (build_merge) preservando o resto;
    block_on_lock=True = serializa no flock do out-dir.

    US-F5.1 — a injeção de arestas sintéticas `describes` da colmeia
    (US-F2.4, `_merge_hive_edges`) foi APAGADA: `describes` nunca existiu no
    vocabulário de relações do graphify (o validate.py só checava a PRESENÇA
    do campo, por isso passou), e com o formato canônico de memory doc a
    ligação neurônio→código é feita por `source_nodes` no frontmatter,
    agregada nativamente pelo `graphify reflect` (US-F5.2).
    """
    from graphify.watch import _rebuild_code
    repo = Path(argv[0])
    force = argv[1] == "1"
    files = [Path(p) for p in argv[2:]]
    ok = _rebuild_code(repo, changed_paths=files or None, force=force,
                       block_on_lock=True)
    return 0 if ok else 1


def _graph_path(project_id: str) -> Path:
    return GRAPHS_ROOT / project_id / "graphify-out" / "graph.json"


def _count_graph(path: Path) -> tuple[int, int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    edges = data.get("links", data.get("edges", []))
    return len(data.get("nodes", [])), len(edges)


class Handler(BaseHTTPRequestHandler):
    server_version = "graphify-build/US-F1.6"

    # ── helpers ──────────────────────────────────────────────────────────
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        provided = self.headers.get("X-API-Key") or ""
        if not provided:
            scheme, _, token = (self.headers.get("Authorization") or "").partition(" ")
            if scheme.lower() == "bearer":
                provided = token.strip()
        return bool(provided) and hmac.compare_digest(provided, API_KEY)

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 1_000_000:
                return None
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            return data if isinstance(data, dict) else None
        except (ValueError, UnicodeDecodeError):
            return None

    def _project_dirs(self, project_id) -> tuple[Path, Path] | None:
        """Valida o projectId (trust boundary) e devolve (clone, out_dir)."""
        if not isinstance(project_id, str) or not _PROJECT_ID_RE.match(project_id):
            return None
        return PROJECTS_DIR / project_id, GRAPHS_ROOT / project_id / "graphify-out"

    # ── rotas ────────────────────────────────────────────────────────────
    def do_GET(self) -> None:  # noqa: N802 (contrato do BaseHTTPRequestHandler)
        if not self._authed():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authed():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        body = self._read_json()
        if body is None:
            self._send(400, {"ok": False, "error": "corpo JSON invalido"})
            return
        if self.path == "/build":
            self._handle_build(body)
        elif self.path == "/affected":
            self._handle_affected(body)
        elif self.path == "/projection":
            self._handle_projection(body)
        elif self.path == "/reflect":
            self._handle_reflect(body)
        elif self.path == "/learning":
            self._handle_learning(body)
        elif self.path == "/wiki":
            self._handle_wiki(body)
        elif self.path == "/wiki-list":
            self._handle_wiki_list(body)
        elif self.path == "/wiki-article":
            self._handle_wiki_article(body)
        elif self.path == "/remove":
            self._handle_remove(body)
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def _handle_build(self, body: dict) -> None:
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        repo, out_dir = dirs
        project_id = body["projectId"]
        if not repo.is_dir():
            self._send(404, {"ok": False, "error": f"clone nao encontrado: {repo}"})
            return

        raw_files = body.get("files") or []
        if not isinstance(raw_files, list) or not all(isinstance(f, str) for f in raw_files):
            self._send(400, {"ok": False, "error": "files deve ser lista de strings"})
            return
        files: list[str] = []
        for f in raw_files:
            # Repo-relativo, sem escapar do clone (trust boundary). O arquivo
            # NÃO precisa existir: path ausente = deletado (o _rebuild_code
            # remove os nós dele do grafo).
            p = Path(f)
            if p.is_absolute() or ".." in p.parts:
                self._send(400, {"ok": False, "error": f"path invalido: {f}"})
                return
            files.append(str(repo / p))

        incremental = bool(files)
        # force explícito, ou default True no build completo (o pedido é
        # autoritativo: um rebuild total pode legitimamente encolher o grafo,
        # e o force desarma o shrink-guard do to_json).
        force = bool(body.get("force", not incremental))

        out_dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        # ÚNICO lugar do sidecar onde GRAPHIFY_OUT absoluto é permitido
        # (ADR-0041 §3): redireciona a escrita para o HOME (rw), fora do
        # clone (:ro).
        env["GRAPHIFY_OUT"] = str(out_dir)
        t0 = time.monotonic()
        try:
            proc = subprocess.run(
                # US-F2.4: o subprocesso é ESTE arquivo em modo `--build` (um
                # arquivo só na imagem) — build + injeção de arestas da colmeia.
                [sys.executable, __file__, "--build", str(repo), "1" if force else "0", *files],
                env=env,
                cwd=str(out_dir.parent),  # cwd rw: escrita relativa acidental nunca cai no clone :ro
                capture_output=True,
                text=True,
                timeout=BUILD_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            self._send(504, {"ok": False, "error": f"build excedeu {BUILD_TIMEOUT_S}s"})
            return
        duration_ms = int((time.monotonic() - t0) * 1000)
        graph_path = _graph_path(project_id)
        if proc.returncode != 0 or not graph_path.is_file():
            tail = (proc.stdout + "\n" + proc.stderr).strip().splitlines()[-15:]
            self._send(500, {
                "ok": False,
                "error": "build falhou",
                "exitCode": proc.returncode,
                "log": tail,
            })
            return
        nodes, edges = _count_graph(graph_path)
        self._send(200, {
            "ok": True,
            "projectId": project_id,
            "graphPath": str(graph_path),
            "nodes": nodes,
            "edges": edges,
            "durationMs": duration_ms,
            "incremental": incremental,
        })

    def _handle_reflect(self, body: dict) -> None:
        """US-F5.2 — `graphify reflect` sobre os memory docs do clone.

        Mesma fronteira de confiança das demais rotas: projectId validado por
        `_project_dirs` (segmento único); os paths são TODOS derivados aqui
        (o caller nunca manda path); subprocess por argv, nunca shell=True.
        Concorrência: segura o flock do out-dir (`_rebuild_lock`) porque o
        reflect ESCREVE lá (LESSONS.md + `.graphify_learning.json` ao lado do
        graph.json); lock ocupado = rebuild em voo → skip (o grafo está
        prestes a mudar; o próximo reflect pega tudo — a chamada é
        best-effort e recorrente por design).
        """
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        repo, out_dir = dirs
        project_id = body["projectId"]
        memory_dir = repo / ".hive" / "memory"
        if not memory_dir.is_dir():
            # Sem memory docs não há o que agregar (o load do reflect faria
            # glob vazio e escreveria um LESSONS.md oco — poupamos o trabalho).
            self._send(200, {"ok": True, "projectId": project_id, "out": None,
                             "skipped": "sem memory docs (.hive/memory ausente)",
                             "durationMs": 0, "log": []})
            return
        graph_path = _graph_path(project_id)
        out_path = out_dir / "reflections" / "LESSONS.md"
        argv = [sys.executable, "-m", "graphify", "reflect",
                "--memory-dir", str(memory_dir),
                "--out", str(out_path),
                "--if-stale"]
        # Com o graph.json em mãos o reflect agrupa por comunidade, poda nós
        # que saíram do grafo e escreve o overlay; sem ele, degrada para o
        # LESSONS.md flat (contrato do próprio graphify).
        if graph_path.is_file():
            argv += ["--graph", str(graph_path)]
        out_dir.mkdir(parents=True, exist_ok=True)
        from graphify.watch import _rebuild_lock
        t0 = time.monotonic()
        with _rebuild_lock(out_dir, blocking=False) as got:
            if not got:
                self._send(200, {"ok": True, "projectId": project_id,
                                 "out": str(out_path),
                                 "skipped": "rebuild do grafo em andamento",
                                 "durationMs": 0, "log": []})
                return
            try:
                proc = subprocess.run(
                    argv,
                    # GRAPHIFY_OUT nunca está no env deste processo (guard do
                    # main); todos os paths vão por flag explícita.
                    cwd=str(out_dir.parent),
                    capture_output=True,
                    text=True,
                    timeout=REFLECT_TIMEOUT_S,
                )
            except subprocess.TimeoutExpired:
                self._send(504, {"ok": False,
                                 "error": f"reflect excedeu {REFLECT_TIMEOUT_S}s"})
                return
        duration_ms = int((time.monotonic() - t0) * 1000)
        tail = (proc.stdout + "\n" + proc.stderr).strip().splitlines()[-10:]
        if proc.returncode != 0:
            self._send(500, {"ok": False, "error": "reflect falhou",
                             "exitCode": proc.returncode, "log": tail})
            return
        # O CLI imprime "Lessons already up to date ..." no no-op do --if-stale.
        stale_skip = proc.stdout.startswith("Lessons already up to date")
        self._send(200, {
            "ok": True,
            "projectId": project_id,
            "out": str(out_path),
            "skipped": "LESSONS.md ja atualizado (--if-stale)" if stale_skip else None,
            "durationMs": duration_ms,
            "log": tail,
        })

    def _handle_learning(self, body: dict) -> None:
        """US-UX.3 — painel "O que a AI sabe": expõe o que o reflect já grava.

        SÓ leitura (como o /projection — nada de subprocess nem flock):
          - overlay `.graphify_learning.json` via `load_learning_overlay`, que
            RECOMPUTA `stale` por nó na leitura (hash do source_file vs
            `code_fingerprint` gravado — "o código mudou desde o aprendizado");
          - becos sem saída e correções via `load_memory_docs` +
            `aggregate_lessons` (determinístico, sem LLM — a MESMA agregação
            que gera o LESSONS.md, sem parsear markdown de volta).

        Mesma fronteira de confiança das demais rotas: projectId validado por
        `_project_dirs` (segmento único); paths TODOS derivados aqui (o caller
        nunca manda path). Overlay/memória ausentes NÃO são erro:
        `generated: false` (estado vazio honesto na UI).
        """
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        repo, out_dir = dirs
        project_id = body["projectId"]
        from graphify.reflect import (
            LEARNING_SIDECAR_NAME,
            aggregate_lessons,
            load_learning_overlay,
            load_memory_docs,
        )
        graph_path = _graph_path(project_id)
        sidecar = out_dir / LEARNING_SIDECAR_NAME
        generated_at = None
        if sidecar.is_file():
            try:
                raw = json.loads(sidecar.read_text(encoding="utf-8"))
                generated_at = raw.get("generated_at")
            except (OSError, ValueError):
                pass  # overlay corrompido degrada para {} no load abaixo
        overlay = load_learning_overlay(graph_path)  # best-effort → {}
        status_rank = {"preferred": 0, "tentative": 1, "contested": 2}
        nodes = [
            {
                "id": nid,
                "status": e.get("status"),
                "verdict": e.get("verdict"),
                "score": e.get("score", 0),
                "uses": e.get("uses", 0),
                "neg": e.get("neg", 0),
                "last": e.get("last", ""),
                "label": e.get("label", nid),
                "sourceFile": e.get("source_file") or None,
                "stale": bool(e.get("stale")),
                "provenance": e.get("provenance") or [],
            }
            for nid, e in sorted(
                overlay.items(),
                key=lambda kv: (status_rank.get(kv[1].get("status"), 9),
                                -float(kv[1].get("score", 0) or 0), kv[0]),
            )
        ]
        docs = load_memory_docs(repo / ".hive" / "memory")
        agg = aggregate_lessons(docs) if docs else None
        self._send(200, {
            "ok": True,
            "projectId": project_id,
            "generated": sidecar.is_file() or bool(docs),
            "generatedAt": generated_at,
            "docs": len(docs),
            "nodes": nodes,
            "deadEnds": [
                {"question": d.get("question", ""), "nodes": d.get("nodes", []),
                 "date": d.get("date", "")}
                for d in (agg["dead_ends"] if agg else [])
            ],
            "corrections": [
                {"question": c.get("question", ""),
                 "correction": c.get("correction", ""), "date": c.get("date", "")}
                for c in (agg["corrections"] if agg else [])
            ],
        })

    # ── US-F5.4 — Wiki do graphify (gerar + listar + ler) ────────────────

    def _wiki_dir(self, out_dir: Path) -> Path:
        return out_dir / "wiki"

    @staticmethod
    def _article_title(content: str, fallback: str) -> str:
        """Título do artigo = primeiro heading nível 1 do markdown."""
        for line in content.splitlines():
            if line.startswith("# "):
                return line[2:].strip() or fallback
        return fallback

    def _handle_wiki(self, body: dict) -> None:
        """US-F5.4 — gera a wiki do Project a partir do graph.json.

        Por que `to_wiki` DIRETO e não `graphify export wiki`: o CLI recusa
        exportar sem `.graphify_analysis.json` ("refusing to export wiki to
        prevent data loss"), e o nosso build (US-F1.6, `_rebuild_code`) nunca
        escreve esse sidecar — ele nasce do `graphify extract`, um caminho de
        CLI que não usamos. A filiação de comunidade que o analysis carregaria
        já vive nos atributos `community`/`community_name` dos nós do
        graph.json (a MESMA fonte que o /projection lê), então montamos o
        dict de comunidades daqui e chamamos a API Python — uma fonte de
        verdade, sem inventar artefato novo.

        Mesma fronteira das demais rotas: projectId validado por
        `_project_dirs`, paths todos derivados AQUI, sem subprocess (o
        to_wiki é computação pura sobre o grafo — não depende de
        GRAPHIFY_OUT). Escreve sob o flock do out-dir (to_wiki APAGA os .md
        antigos antes de reescrever); lock ocupado = rebuild em voo → skip
        (a chamada é best-effort e recorrente: o próximo build regenera).
        """
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        _, out_dir = dirs
        project_id = body["projectId"]
        graph_path = _graph_path(project_id)
        if not graph_path.is_file():
            self._send(404, {"ok": False, "error": f"grafo nao construido: {graph_path}"})
            return
        from graphify.affected import load_graph
        from graphify.analyze import god_nodes
        from graphify.watch import _rebuild_lock
        from graphify.wiki import to_wiki
        t0 = time.monotonic()
        with _rebuild_lock(out_dir, blocking=False) as got:
            if not got:
                self._send(200, {"ok": True, "projectId": project_id, "articles": 0,
                                 "skipped": "rebuild do grafo em andamento",
                                 "durationMs": 0})
                return
            try:
                g = load_graph(graph_path)
            except Exception as exc:  # grafo corrompido não derruba o processo
                self._send(500, {"ok": False, "error": f"falha ao carregar grafo: {exc}"})
                return
            communities: dict[int, list[str]] = {}
            labels: dict[int, str] = {}
            for nid, d in g.nodes(data=True):
                cid = d.get("community")
                if not isinstance(cid, int):
                    continue
                communities.setdefault(cid, []).append(nid)
                if cid not in labels and d.get("community_name"):
                    labels[cid] = str(d["community_name"])
            # `.graphify_labels.json` (escrito pelo build) tem precedência: é o
            # rótulo canônico da comunidade; `community_name` do nó é fallback.
            labels_path = out_dir / ".graphify_labels.json"
            if labels_path.is_file():
                try:
                    raw = json.loads(labels_path.read_text(encoding="utf-8"))
                    for k, v in raw.items():
                        if isinstance(v, str) and str(k).lstrip("-").isdigit():
                            labels[int(k)] = v
                except (OSError, ValueError):
                    pass
            if not communities:
                # to_wiki lança ValueError com dict vazio; grafo sem
                # comunidades não é erro do caller — é "nada a fazer".
                self._send(200, {"ok": True, "projectId": project_id, "articles": 0,
                                 "skipped": "grafo sem comunidades",
                                 "durationMs": 0})
                return
            try:
                n = to_wiki(g, communities, self._wiki_dir(out_dir),
                            community_labels=labels or None,
                            god_nodes_data=god_nodes(g))
            except Exception as exc:
                self._send(500, {"ok": False, "error": f"geracao da wiki falhou: {exc}"})
                return
        self._send(200, {
            "ok": True,
            "projectId": project_id,
            "articles": n,
            "skipped": None,
            "durationMs": int((time.monotonic() - t0) * 1000),
        })

    def _handle_wiki_list(self, body: dict) -> None:
        """US-F5.4 — lista os artigos da wiki. Ausente = `generated: false`."""
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        _, out_dir = dirs
        wiki_dir = self._wiki_dir(out_dir)
        index = wiki_dir / "index.md"
        if not index.is_file():
            self._send(200, {"ok": True, "generated": False, "generatedAt": None,
                             "articles": []})
            return
        articles = []
        for p in sorted(wiki_dir.glob("*.md")):
            if p.name == "index.md":
                continue
            try:
                title = self._article_title(p.read_text(encoding="utf-8"), p.stem)
            except OSError:
                title = p.stem
            articles.append({"slug": p.stem, "title": title})
        generated_at = datetime.fromtimestamp(index.stat().st_mtime, timezone.utc)
        self._send(200, {
            "ok": True,
            "generated": True,
            "generatedAt": generated_at.isoformat(),
            "articles": articles,
        })

    def _handle_wiki_article(self, body: dict) -> None:
        """US-F5.4 — lê UM artigo da wiki (trust boundary do slug).

        O caller NUNCA escolhe caminho livre: `slug` precisa ser segmento
        único (sem `/`, `\\`, NUL, nem `.`/`..`) e o path final resolvido
        (`realpath`, symlink incluso) precisa continuar DENTRO do diretório
        da wiki — um `../` jamais escapa.
        """
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        _, out_dir = dirs
        slug = body.get("slug")
        if (not isinstance(slug, str) or not (1 <= len(slug) <= 240)
                or any(c in slug for c in ("/", "\\", "\x00"))
                or slug in (".", "..")):
            self._send(400, {"ok": False, "error": "slug invalido"})
            return
        wiki_dir = self._wiki_dir(out_dir)
        target = wiki_dir / f"{slug}.md"
        try:
            resolved = target.resolve()
            inside = resolved.parent == wiki_dir.resolve() and resolved.suffix == ".md"
        except OSError:
            inside = False
        if not inside:
            self._send(400, {"ok": False, "error": "slug invalido"})
            return
        if not target.is_file():
            self._send(404, {"ok": False, "error": f"artigo nao encontrado: {slug}"})
            return
        try:
            content = target.read_text(encoding="utf-8")
        except OSError as exc:
            self._send(500, {"ok": False, "error": f"falha lendo artigo: {exc}"})
            return
        self._send(200, {
            "ok": True,
            "slug": slug,
            "title": self._article_title(content, slug),
            "content": content,
        })

    def _handle_remove(self, body: dict) -> None:
        """US-F1.3: apaga o diretório do grafo do Project (idempotente)."""
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        _, out_dir = dirs
        # _project_dirs valida o projectId como segmento único (trust boundary),
        # então target é sempre GRAPHS_ROOT/<projectId> — nunca fora do HOME.
        target = out_dir.parent
        shutil.rmtree(target, ignore_errors=True)
        self._send(200, {"ok": True, "projectId": body["projectId"]})

    def _handle_projection(self, body: dict) -> None:
        """US-F4.1 — projeção estruturada do grafo para a UI, corte no servidor.

        Modos (precedência quando mais de um param vem junto):
        search > focus > community > overview. Todos devolvem no MÁXIMO
        `limit` nós (default 150, teto 500) e `4*limit` arestas induzidas —
        um grafo de ~3500 nós NUNCA atravessa a rede inteiro; `truncated`
        sinaliza o estouro. Nós saem ordenados por grau (hubs primeiro),
        determinístico (desempate por id).
        """
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        repo, _ = dirs
        graph_path = _graph_path(body["projectId"])
        if not graph_path.is_file():
            self._send(404, {"ok": False, "error": f"grafo nao construido: {graph_path}"})
            return
        limit = body.get("limit", 150)
        depth = body.get("depth", 1)
        if not isinstance(limit, int) or not (1 <= limit <= 500):
            self._send(400, {"ok": False, "error": "limit deve ser int 1..500"})
            return
        if not isinstance(depth, int) or not (1 <= depth <= 3):
            self._send(400, {"ok": False, "error": "depth deve ser int 1..3"})
            return
        focus = body.get("focus")
        community = body.get("community")
        search = body.get("search")
        if focus is not None and not isinstance(focus, str):
            self._send(400, {"ok": False, "error": "focus deve ser string"})
            return
        if community is not None and not isinstance(community, int):
            self._send(400, {"ok": False, "error": "community deve ser int"})
            return
        if search is not None and not isinstance(search, str):
            self._send(400, {"ok": False, "error": "search deve ser string"})
            return

        # Mesma via do /affected: load_graph lê o graph.json direto (JSON
        # estruturado de verdade), sem depender do formato de texto do MCP.
        # ponytail: load por request (~centenas de ms no grafo de 3500 nós);
        # cache LRU como o do serve.py se a latência incomodar na F4.2.
        from graphify.affected import load_graph, resolve_seed
        try:
            g = load_graph(graph_path)
        except Exception as exc:  # grafo corrompido não derruba o processo
            self._send(500, {"ok": False, "error": f"falha ao carregar grafo: {exc}"})
            return

        degree = dict(g.degree())
        # Hubs primeiro, desempate por id — ordem estável entre respostas.
        by_relevance = lambda n: (-degree.get(n, 0), str(n))  # noqa: E731

        resolved_focus = None
        truncated = False
        if search is not None and search.strip():
            mode = "search"
            needle = search.strip().casefold()
            def _search_rank(nid):
                data = g.nodes[nid]
                norm = str(data.get("norm_label", "")).casefold()
                label = str(data.get("label", "")).casefold()
                sf = str(data.get("source_file", "") or "").casefold()
                if needle in (norm, label):
                    return 0                 # match exato de label primeiro
                if needle in norm or needle in label or needle in sf:
                    return 1
                return None
            ranked = [(r, n) for n in g.nodes for r in [_search_rank(n)] if r is not None]
            ranked.sort(key=lambda t: (t[0], by_relevance(t[1])))
            truncated = len(ranked) > limit
            selected = [n for _, n in ranked[:limit]]
        elif focus is not None and focus.strip():
            mode = "focus"
            resolved_focus = resolve_seed(g, focus.strip(), root=repo)
            selected = []
            if resolved_focus is not None:
                # BFS não-direcionada, camada a camada, vizinhos mais
                # conectados primeiro — expandir um nó na UI é isto.
                und = g.to_undirected(as_view=True)
                selected = [resolved_focus]
                seen = {resolved_focus}
                frontier = [resolved_focus]
                for _ in range(depth):
                    nxt = []
                    for n in frontier:
                        for m in sorted(und.neighbors(n), key=by_relevance):
                            if m in seen:
                                continue
                            if len(selected) >= limit:
                                truncated = True
                                break
                            seen.add(m)
                            selected.append(m)
                            nxt.append(m)
                        if truncated:
                            break
                    if truncated:
                        break
                    frontier = nxt
        elif community is not None:
            mode = "community"
            members = sorted(
                (n for n, d in g.nodes(data=True) if d.get("community") == community),
                key=by_relevance,
            )
            truncated = len(members) > limit
            selected = members[:limit]
        else:
            mode = "overview"
            ordered = sorted(g.nodes, key=by_relevance)
            truncated = len(ordered) > limit
            selected = ordered[:limit]

        # Arestas induzidas entre os nós selecionados (search não leva aresta:
        # o resultado é lista para virar um focus). Teto de 4*limit, mais
        # fortes primeiro (confidence_score desc), determinístico.
        edges = []
        if mode != "search" and selected:
            sub = g.subgraph(selected)
            all_edges = sorted(
                sub.edges(data=True),
                key=lambda e: (-float(e[2].get("confidence_score", 0) or 0),
                               str(e[0]), str(e[1])),
            )
            edge_cap = 4 * limit
            if len(all_edges) > edge_cap:
                truncated = True
                all_edges = all_edges[:edge_cap]
            edges = [
                {"source": s, "target": t,
                 "relation": str(d.get("relation", "related"))}
                for s, t, d in all_edges
            ]

        # Resumo de TODAS as comunidades do grafo (drill-down da UI),
        # maiores primeiro.
        comm_size: dict[int, int] = {}
        comm_name: dict[int, str] = {}
        for _, d in g.nodes(data=True):
            cid = d.get("community")
            if not isinstance(cid, int):
                continue
            comm_size[cid] = comm_size.get(cid, 0) + 1
            if cid not in comm_name and d.get("community_name"):
                comm_name[cid] = str(d["community_name"])
        communities = [
            {"id": cid, "name": comm_name.get(cid), "size": size}
            for cid, size in sorted(comm_size.items(), key=lambda kv: (-kv[1], kv[0]))
        ]

        def _node_out(nid):
            d = g.nodes[nid]
            cid = d.get("community")
            return {
                "id": str(nid),
                "label": str(d.get("label", nid)),
                "type": str(d.get("file_type", "code")),
                "sourceFile": d.get("source_file") or None,
                "community": cid if isinstance(cid, int) else None,
                "communityName": d.get("community_name")
                or (comm_name.get(cid) if isinstance(cid, int) else None),
                "degree": degree.get(nid, 0),
            }

        self._send(200, {
            "ok": True,
            "mode": mode,
            "focus": resolved_focus,
            "nodes": [_node_out(n) for n in selected],
            "edges": edges,
            "communities": communities,
            "totalNodes": g.number_of_nodes(),
            "totalEdges": g.number_of_edges(),
            "truncated": truncated,
        })

    def _handle_affected(self, body: dict) -> None:
        dirs = self._project_dirs(body.get("projectId"))
        if dirs is None:
            self._send(400, {"ok": False, "error": "projectId invalido"})
            return
        repo, _ = dirs
        seed = body.get("seed")
        if not isinstance(seed, str) or not seed.strip():
            self._send(400, {"ok": False, "error": "seed obrigatorio"})
            return
        graph_path = _graph_path(body["projectId"])
        if not graph_path.is_file():
            self._send(404, {"ok": False, "error": f"grafo nao construido: {graph_path}"})
            return
        depth = body.get("depth", 2)
        relations = body.get("relations") or None
        if not isinstance(depth, int) or depth < 1 or depth > 10:
            self._send(400, {"ok": False, "error": "depth deve ser int 1..10"})
            return
        if relations is not None and (
            not isinstance(relations, list) or not all(isinstance(r, str) for r in relations)
        ):
            self._send(400, {"ok": False, "error": "relations deve ser lista de strings"})
            return

        # API Python direto (sem subprocess/parsing de texto): affected só LÊ
        # o graph.json — não depende de GRAPHIFY_OUT. root=clone para seeds
        # em forma de path resolverem contra os source_file relativos.
        from graphify.affected import (
            DEFAULT_AFFECTED_RELATIONS,
            affected_nodes,
            format_affected,
            load_graph,
            resolve_seed,
        )
        rels = tuple(relations) if relations else DEFAULT_AFFECTED_RELATIONS
        try:
            graph = load_graph(graph_path)
        except Exception as exc:  # grafo corrompido não pode derrubar o processo
            self._send(500, {"ok": False, "error": f"falha ao carregar grafo: {exc}"})
            return
        resolved = resolve_seed(graph, seed, root=repo)
        if resolved is None:
            self._send(200, {
                "ok": True,
                "seed": None,
                "hits": [],
                "text": f"No unique node match for {seed}",
            })
            return
        hits = affected_nodes(graph, resolved, relations=rels, depth=depth)
        self._send(200, {
            "ok": True,
            "seed": resolved,
            "hits": [
                {
                    "nodeId": h.node_id,
                    "label": str(graph.nodes[h.node_id].get("label", h.node_id)),
                    "depth": h.depth,
                    "relation": h.via_relation,
                    "file": h.via_file or graph.nodes[h.node_id].get("source_file"),
                    "location": h.via_location,
                }
                for h in hits
            ],
            "text": format_affected(graph, seed, relations=rels, depth=depth, root=repo),
        })

    def log_message(self, fmt: str, *args) -> None:
        # stderr com prefixo próprio para não se confundir com o log do MCP.
        sys.stderr.write("[graphify-build] %s - %s\n" % (self.address_string(), fmt % args))


def main() -> None:
    if not API_KEY:
        print("[graphify-build] ERRO: GRAPHIFY_API_KEY nao definida — endpoint "
              "de build nao sobe sem auth (US-F1.6, ADR-0041 §5).", file=sys.stderr)
        sys.exit(1)
    if os.environ.get("GRAPHIFY_OUT"):
        # A armadilha do ADR-0041 §3: GRAPHIFY_OUT absoluto num processo
        # compartilhado colapsa TODOS os projetos no mesmo grafo. Este
        # processo (e o serve, vizinho de container) nunca podem recebê-lo.
        print("[graphify-build] ERRO: GRAPHIFY_OUT setado no ambiente do "
              "wrapper — proibido (ADR-0041 §3); ele so existe no subprocesso "
              "de build, por Project.", file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[graphify-build] escutando em http://{HOST}:{PORT} "
          f"(build timeout {BUILD_TIMEOUT_S}s)", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    # US-F2.4: modo subprocesso de build — desvia ANTES do guard de
    # GRAPHIFY_OUT do main() (aqui ele é obrigatório, não proibido).
    if len(sys.argv) > 1 and sys.argv[1] == "--build":
        sys.exit(_run_build(sys.argv[2:]))
    main()
