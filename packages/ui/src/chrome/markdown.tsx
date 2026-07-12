import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Module-level so the array reference is stable across (streaming) re-renders —
// react-markdown re-initializes its pipeline when the plugins prop identity changes.
const REMARK_PLUGINS = [remarkGfm];

/**
 * Assistant text as GitHub-flavored markdown (the `.fl-md` design). react-markdown
 * escapes raw HTML by default (no rehype-raw), so no markup is injected — safe for
 * model-authored text. Streams fine: re-parsing each partial is cheap at chat sizes.
 */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`fl-md${streaming ? " fl-md--streaming" : ""}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{text}</ReactMarkdown>
    </div>
  );
}
