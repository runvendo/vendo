import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LONG_TEXT_CAP, truncateHead } from "./truncate.js";

// Module-level so the array reference is stable across (streaming) re-renders —
// react-markdown re-initializes its pipeline when the plugins prop identity changes.
const REMARK_PLUGINS = [remarkGfm];

/**
 * Assistant text as GitHub-flavored markdown (the `.fl-md` design). react-markdown
 * escapes raw HTML by default (no rehype-raw), so no markup is injected — safe for
 * model-authored text.
 *
 * ENG-218 — solidity under extreme content:
 *  - `memo`: a growing streamed turn re-renders the WHOLE list on every token.
 *    Memoizing means only the block whose `text` actually changed re-parses;
 *    every settled turn above it is skipped instead of re-parsing per token
 *    (the O(thread²) markdown cost the issue calls out).
 *  - collapse: a RESTORED huge body (pasted logs, model dumps reopened from
 *    history) parses/renders only its head until expanded, bounding both parse
 *    time and DOM node count. Only restored bodies auto-collapse — a message the
 *    reader just watched stream in must not snap shut once it settles — and
 *    never while streaming (the live tail must stay visible).
 */
function MarkdownImpl({ text, streaming, restored }: { text: string; streaming?: boolean; restored?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = restored === true && !streaming && text.length > LONG_TEXT_CAP;
  const shown = collapsible && !expanded ? truncateHead(text) : text;
  return (
    <div className={`fl-md${streaming ? " fl-md--streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{shown}</ReactMarkdown>
      {collapsible ? (
        <button type="button" className="fl-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? "Show less" : `Show full message (${(text.length / 1000).toFixed(0)}k chars)`}
        </button>
      ) : null}
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
