import { useState } from "react";

import type { ReviewComment } from "@kanban-ai/shared";

import {
  useAddReviewComment,
  useResolveReviewComment,
  useReviewComments,
} from "../hooks/useReviewComments";

/**
 * US-OBS3 — painel mínimo de comentários inline de review de um card.
 *
 * Lista os comentários (arquivo:linha), permite adicionar um novo e resolver os
 * existentes. Atualiza-se sozinho via realtime (`review.comment_added`).
 */
export function ReviewCommentsPanel({
  cardId,
  author = "human:me",
}: {
  cardId: string;
  author?: string;
}) {
  const { data: comments = [], isLoading } = useReviewComments(cardId);
  const add = useAddReviewComment(cardId);
  const resolve = useResolveReviewComment(cardId);

  const [filePath, setFilePath] = useState("");
  const [line, setLine] = useState("1");
  const [body, setBody] = useState("");

  const canSubmit = filePath.trim() !== "" && body.trim() !== "" && Number(line) > 0;

  function submit() {
    if (!canSubmit) return;
    add.mutate(
      { filePath: filePath.trim(), line: Number(line), body: body.trim(), author },
      {
        onSuccess: () => {
          setBody("");
        },
      },
    );
  }

  return (
    <div className="review-comments">
      <h4 className="review-comments-title">Review inline</h4>

      {isLoading ? (
        <p className="review-comments-empty">Carregando comentários…</p>
      ) : comments.length === 0 ? (
        <p className="review-comments-empty">Nenhum comentário de review.</p>
      ) : (
        <ul className="review-comments-list">
          {comments.map((c: ReviewComment) => (
            <li key={c.id} className={c.resolved ? "review-comment resolved" : "review-comment"}>
              <div className="review-comment-loc">
                {c.filePath}:{c.line}
              </div>
              <div className="review-comment-body">{c.body}</div>
              <div className="review-comment-meta">
                <span>{c.author}</span>
                {c.resolved ? (
                  <span className="review-comment-status">resolvido</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => resolve.mutate(c.id)}
                    disabled={resolve.isPending}
                  >
                    Resolver
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="review-comment-form">
        <input
          type="text"
          placeholder="caminho/do/arquivo.ts"
          value={filePath}
          onChange={(e) => setFilePath(e.target.value)}
        />
        <input
          type="number"
          min={1}
          placeholder="linha"
          value={line}
          onChange={(e) => setLine(e.target.value)}
        />
        <textarea
          placeholder="Comentário…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <button type="button" onClick={submit} disabled={!canSubmit || add.isPending}>
          Comentar
        </button>
      </div>
    </div>
  );
}
