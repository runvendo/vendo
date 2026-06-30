import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { stripEmoji } from "@flowlet/core";

export interface StreamingTextProps {
  text: string;
  streaming?: boolean;
}

/** Allow only safe link/image schemes; drop javascript:, data:, bare paths. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url, "https://flowlet.local");
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:"
      ? url
      : "";
  } catch {
    return "";
  }
}

/**
 * Renders assistant text as GitHub-flavored markdown. react-markdown escapes raw
 * HTML by default (no rehype-raw), so no markup is injected. Streams fine: the
 * growing `text` re-parses each tick, and the caret trails the content.
 */
export function StreamingText({ text, streaming = false }: StreamingTextProps) {
  return (
    <div className="fl-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
        }}
      >
        {stripEmoji(text)}
      </ReactMarkdown>
      {streaming && <span className="fl-caret" aria-hidden="true" />}
    </div>
  );
}
