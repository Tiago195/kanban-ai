import { useMemo, useState, type ReactNode } from "react";
import { parseChatSegments, type ChatSegment } from "@kanban-ai/shared";

/**
 * Renderiza o corpo de uma mensagem do agente de forma amigável ("estilo
 * Claude"): prosa com markdown leve (negrito/código inline), blocos de tool
 * call colapsáveis e um selo de conclusão da iteração. O texto cru continua
 * intacto no banco — a limpeza acontece só aqui, no render.
 */
export function AgentMessageBody({ text }: { text: string }): ReactNode {
  const segments = useMemo(() => parseChatSegments(text), [text]);

  if (segments.length === 0) {
    return <div className="chat-bubble-text chat-muted">…</div>;
  }

  return (
    <div className="chat-bubble-text">
      {segments.map((seg, i) => (
        <SegmentView key={i} seg={seg} />
      ))}
    </div>
  );
}

function SegmentView({ seg }: { seg: ChatSegment }): ReactNode {
  if (seg.type === "tool") return <ToolBlock title={seg.title} command={seg.command} lines={seg.lines} />;
  if (seg.type === "result") return <ResultBadge summary={seg.summary} done={seg.done} />;
  return <Prose text={seg.text} />;
}

/** Bloco de comando/ferramenta, colapsável — some no meio da conversa. */
function ToolBlock({ title, command, lines }: { title: string; command?: string; lines?: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-tool">
      <button type="button" className="chat-tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="chat-tool-icon">⚡</span>
        <span className="chat-tool-title">{title}</span>
        {lines ? <span className="chat-tool-lines">{lines}</span> : null}
        <span className="chat-tool-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && command ? (
        <pre className="chat-tool-body">
          <code>{command}</code>
        </pre>
      ) : null}
    </div>
  );
}

/** Selo de conclusão da iteração (a partir do KANBAN_RESULT). */
function ResultBadge({ summary, done }: { summary?: string; done?: boolean }): ReactNode {
  return (
    <div className={"chat-result" + (done ? " is-done" : "")}>
      <span className="chat-result-icon">{done ? "✅" : "📝"}</span>
      <span className="chat-result-text">{summary || (done ? "Iteração concluída." : "Iteração registrada.")}</span>
    </div>
  );
}

/**
 * Prosa com markdown leve inline: **negrito** e `código`. Sem lib externa —
 * tokenização simples e segura (React escapa o conteúdo automaticamente).
 */
function Prose({ text }: { text: string }): ReactNode {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className="chat-p">
          {renderInline(p)}
        </p>
      ))}
    </>
  );
}

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(INLINE_RE);
  parts.forEach((part, i) => {
    if (!part) return;
    if (part.startsWith("**") && part.endsWith("**")) {
      out.push(<strong key={i}>{part.slice(2, -2)}</strong>);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      out.push(
        <code key={i} className="chat-code">
          {part.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(<span key={i}>{part}</span>);
    }
  });
  return out;
}
