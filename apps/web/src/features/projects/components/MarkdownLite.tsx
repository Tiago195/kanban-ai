import { useMemo } from "react";

import {
  parseMarkdownBlocks,
  type InlineSegment,
  type MarkdownBlock,
} from "../lib/markdownLite";

/**
 * US-F4.2 — render do markdown "lite" dos neurônios (resolve o débito da
 * US-F2.8: nada de markdown cru com frontmatter à vista). O parse é puro
 * (`lib/markdownLite.ts`) e o render é 100% elementos React — sem
 * `dangerouslySetInnerHTML`, sem superfície de XSS.
 */
export function MarkdownLite({
  text,
  onLinkClick,
}: {
  text: string;
  /**
   * US-F5.4 — navegação interna da Wiki: quando presente, um link cujo href o
   * resolver reconhece (retorna uma ação) vira clicável; os demais continuam
   * texto sublinhado NÃO navegável (a postura da F4.2: URLs arbitrárias
   * escritas por agents não abrem dentro do app).
   */
  onLinkClick?: (href: string) => (() => void) | null;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div data-testid="markdown-lite" style={{ fontSize: 13, lineHeight: 1.55, display: "grid", gap: 8 }}>
      {blocks.map((block, index) => (
        <Block key={index} block={block} onLinkClick={onLinkClick} />
      ))}
    </div>
  );
}

function Block({
  block,
  onLinkClick,
}: {
  block: MarkdownBlock;
  onLinkClick?: (href: string) => (() => void) | null;
}) {
  switch (block.kind) {
    case "heading": {
      const size = Math.max(13, 19 - block.level * 1.5);
      return (
        <div style={{ fontWeight: 700, fontSize: size, marginTop: block.level <= 2 ? 6 : 2 }}>
          <Segments segments={block.segments} onLinkClick={onLinkClick} />
        </div>
      );
    }
    case "code":
      return (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            background: "var(--code-bg, rgba(127,127,127,0.08))",
            padding: 10,
            borderRadius: 8,
            margin: 0,
          }}
        >
          {block.text}
        </pre>
      );
    case "list":
      return (
        <ul style={{ margin: 0, paddingLeft: 20, listStyle: "disc", display: "grid", gap: 2 }}>
          {block.items.map((item, index) => (
            <li key={index}>
              <Segments segments={item} onLinkClick={onLinkClick} />
            </li>
          ))}
        </ul>
      );
    // US-UX.5 — citação (`>`) e régua (`---`) saíam LITERAIS na tela (débito
    // declarado da F4.2, visível na Wiki). Aditivo: os blocos existentes não
    // mudam, então o painel de memória (outro consumidor) segue igual.
    case "quote":
      return (
        <blockquote
          data-testid="md-quote"
          style={{
            margin: 0,
            padding: "2px 12px",
            borderLeft: "3px solid var(--border)",
            color: "var(--text-muted)",
          }}
        >
          <Segments segments={block.segments} onLinkClick={onLinkClick} />
        </blockquote>
      );
    case "rule":
      return (
        <hr
          data-testid="md-rule"
          style={{ border: 0, borderTop: "1px solid var(--border)", margin: "4px 0", width: "100%" }}
        />
      );
    case "para":
      return (
        <p style={{ margin: 0 }}>
          <Segments segments={block.segments} onLinkClick={onLinkClick} />
        </p>
      );
  }
}

function Segments({
  segments,
  onLinkClick,
}: {
  segments: InlineSegment[];
  onLinkClick?: (href: string) => (() => void) | null;
}) {
  return (
    <>
      {segments.map((segment, index) => {
        switch (segment.kind) {
          case "code":
            return (
              <code
                key={index}
                style={{
                  fontSize: "0.92em",
                  background: "var(--code-bg, rgba(127,127,127,0.12))",
                  padding: "1px 4px",
                  borderRadius: 4,
                }}
              >
                {segment.text}
              </code>
            );
          case "bold":
            return <strong key={index}>{segment.text}</strong>;
          // US-UX.5 — itálico (`*x*`/`_x_`): recursivo porque o rodapé
          // graphify carrega um link DENTRO do itálico (segue navegável).
          case "em":
            return (
              <em key={index}>
                <Segments segments={segment.segments} onLinkClick={onLinkClick} />
              </em>
            );
          case "link": {
            // US-F5.4 — link interno da Wiki navega via handler; o resto
            // segue a postura da F4.2 (ponytail): texto sublinhado NÃO
            // navegável — abrir URLs arbitrárias escritas por agents dentro
            // do app não é desejável.
            const href = segment.href;
            const navigate = onLinkClick ? onLinkClick(href) : null;
            if (navigate) {
              return (
                <a
                  key={index}
                  href="#"
                  title={href}
                  data-testid="md-link"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate();
                  }}
                >
                  {segment.text}
                </a>
              );
            }
            return (
              <span key={index} style={{ textDecoration: "underline" }} title={href}>
                {segment.text}
              </span>
            );
          }
          default:
            return <span key={index}>{segment.text}</span>;
        }
      })}
    </>
  );
}
