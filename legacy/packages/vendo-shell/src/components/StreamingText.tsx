import { useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { stripEmoji } from "@vendoai/core";
import "katex/dist/katex.min.css";

export interface StreamingTextProps {
  text: string;
  streaming?: boolean;
}

/** Allow only safe link/image schemes; drop javascript:, data:, bare paths. */
function safeUrl(url: string): string {
  try {
    const u = new URL(url, "https://vendo.local");
    return u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:"
      ? url
      : "";
  } catch {
    return "";
  }
}

/**
 * Balance an unterminated code fence while streaming so an in-progress block
 * renders as a `<pre>` immediately instead of as plain paragraphs that snap into
 * a code block the moment the closing ``` arrives.
 */
function balanceFences(md: string): string {
  const fences = (md.match(/```/g) ?? []).length;
  return fences % 2 === 1 ? `${md}\n\`\`\`` : md;
}

/** A code block with a hover Copy button — table stakes for streamed code. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = ref.current?.innerText ?? "";
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div className="fl-codeblock">
      <button type="button" className="fl-copy" onClick={copy} aria-label="Copy code">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/**
 * Renders assistant text as GitHub-flavored markdown. react-markdown escapes raw
 * HTML by default (no rehype-raw), so no markup is injected. Streams fine: the
 * growing `text` re-parses each tick, and a pseudo-element caret trails the last
 * rendered block (a sibling caret would drop onto its own line below it).
 */
export function StreamingText({ text, streaming = false }: StreamingTextProps) {
  const clean = stripEmoji(text);
  // Empty text would render an empty markdown <p> — a stray blank line under the
  // turn. Render nothing (or just the caret while still streaming).
  if (clean.trim() === "") {
    return streaming ? <span className="fl-caret" aria-hidden="true" /> : null;
  }
  return (
    <div className={`fl-md${streaming ? " fl-md--streaming" : ""}`}>
      <ReactMarkdown
        // Single-dollar inline math is OFF: in a finance host, "$87 ... $285"
        // in one paragraph would otherwise render the span between the amounts
        // as garbled italic math. Display math stays available via $$...$$.
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={safeUrl}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        }}
      >
        {streaming ? balanceFences(clean) : clean}
      </ReactMarkdown>
    </div>
  );
}
