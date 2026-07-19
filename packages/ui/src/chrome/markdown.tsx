import { isValidElement, memo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCopyFeedback } from "./clipboard.js";
import { LONG_TEXT_CAP, truncateHead } from "./truncate.js";

// Module-level so the array reference is stable across (streaming) re-renders —
// react-markdown re-initializes its pipeline when the plugins prop identity changes.
const REMARK_PLUGINS = [remarkGfm];

/** Lane pick 8A — fenced code with a slim header bar: language chip (parsed
    from the fence's `language-*` class), a wrap toggle, and an ALWAYS-visible
    Copy. The old hover-revealed copy never existed on touch. The copied text
    is the block's rendered content, read off the DOM so it matches exactly
    what the reader sees. */
function CodeBlock(props: ComponentProps<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, copy] = useCopyFeedback();
  const [wrap, setWrap] = useState(false);
  // The fence language rides the child <code class="language-x"> element.
  const child = Array.isArray(props.children) ? props.children[0] : props.children;
  const codeClass = isValidElement(child)
    ? String((child.props as { className?: string }).className ?? "")
    : "";
  const language = /language-([\w+-]+)/.exec(codeClass)?.[1];
  return (
    <div className="fl-codeblock">
      <div className="fl-codehead">
        <span className="fl-codehead-lang">{language ?? "code"}</span>
        <button
          type="button"
          className={`fl-codehead-wrap${wrap ? " fl-codehead-wrap--on" : ""}`}
          aria-pressed={wrap}
          onClick={() => setWrap(value => !value)}
        >
          wrap
        </button>
        <button
          type="button"
          className="fl-copy"
          aria-label="Copy code"
          onClick={() => copy(pre.current?.textContent ?? "")}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre {...props} ref={pre} style={wrap ? { whiteSpace: "pre-wrap" } : undefined} />
    </div>
  );
}

/** Lane pick 8B — data-grade cells: numeric/date-like content right-aligns
    with tabular figures so money and dates line up like a ledger. An explicit
    GFM alignment (react-markdown emits a style) always wins. */
const cellText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(cellText).join("");
  if (isValidElement(node)) return cellText((node.props as { children?: ReactNode }).children);
  return "";
};
const NUMERIC_CELL = /^(?=.*\d)[\s\d$€£¥%+−\-–—.,:()\/kKmMbB]*$/;
function DataCell(tag: "td" | "th") {
  return function Cell({ style, className, ...rest }: ComponentProps<"td">) {
    const numeric = style?.textAlign === undefined && NUMERIC_CELL.test(cellText(rest.children).trim());
    const Tag = tag;
    return (
      <Tag
        {...rest}
        style={style}
        className={[className, numeric ? "fl-td-num" : undefined].filter(Boolean).join(" ") || undefined}
      />
    );
  };
}

/** Lane pick 8E — while the turn still streams, every table carries one
    forming row (skeleton shimmer in the table's own rhythm) so a growing
    table reads as "more arriving" instead of jumping raggedly. */
function StreamingTbody(props: ComponentProps<"tbody">) {
  return (
    <tbody {...props}>
      {props.children}
      <tr className="fl-tr-forming" aria-hidden="true">
        <td colSpan={99}><span className="fl-skeleton-bar" /></td>
      </tr>
    </tbody>
  );
}

// Stable component maps (react-markdown re-initializes when identity changes);
// streaming swaps in the forming-row tbody, so it needs its own stable map.
const TD = DataCell("td");
const TH = DataCell("th");
const MD_COMPONENTS = { pre: CodeBlock, td: TD, th: TH };
const MD_COMPONENTS_STREAMING = { ...MD_COMPONENTS, tbody: StreamingTbody };

/** Lane pick 8D — a restored long reply with real structure renders as a
    scannable outline: each h2/h3 section folds, first section open. Never
    while streaming, and only for restored bodies (same gate as collapse —
    a reply the reader just watched arrive stays flat). */
const SECTION_HEAD = /^(##\s+|###\s+)(.+)$/;
function splitSections(text: string): { title: string; body: string }[] | null {
  const lines = text.split("\n");
  const sections: { title: string; body: string[] }[] = [{ title: "", body: [] }];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const head = fenced ? null : SECTION_HEAD.exec(line);
    if (head) sections.push({ title: head[2]!.trim(), body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  // Only worth folding with 2+ real sections; a lone heading reads fine flat.
  if (sections.length < 3) return null;
  return sections
    .map(section => ({ title: section.title, body: section.body.join("\n").trim() }))
    .filter(section => section.title.length > 0 || section.body.length > 0);
}

function FoldSection({ title, open: initialOpen, children }: { title: string; open: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <section className={`fl-mdsec${open ? " fl-mdsec--open" : ""}`}>
      <button type="button" className="fl-mdsec-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        {title}
      </button>
      {open ? <div className="fl-mdsec-body">{children}</div> : null}
    </section>
  );
}

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
 *  - restored huge bodies bound their parse/DOM cost: structured ones fold into
 *    sections (8D), unstructured ones truncate under the 3D fade-fold. Only
 *    restored bodies collapse — a message the reader just watched stream in
 *    must not snap shut — and never while streaming.
 */
function MarkdownImpl({ text, streaming, restored }: { text: string; streaming?: boolean; restored?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = restored === true && !streaming && text.length > LONG_TEXT_CAP;
  const components = streaming ? MD_COMPONENTS_STREAMING : MD_COMPONENTS;
  // 8D — structured restored bodies fold by section instead of truncating.
  const sections = collapsible ? splitSections(text) : null;
  if (sections) {
    return (
      <div className={`fl-md${streaming ? " fl-md--streaming" : ""}`}>
        {sections.map((section, index) =>
          section.title.length === 0 ? (
            <ReactMarkdown key={index} remarkPlugins={REMARK_PLUGINS} components={components}>{section.body}</ReactMarkdown>
          ) : (
            <FoldSection key={index} title={section.title} open={index <= 1}>
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>{section.body}</ReactMarkdown>
            </FoldSection>
          ),
        )}
      </div>
    );
  }
  const shown = collapsible && !expanded ? truncateHead(text) : text;
  const body = (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>{shown}</ReactMarkdown>
  );
  if (!collapsible) {
    return <div className={`fl-md${streaming ? " fl-md--streaming" : ""}`}>{body}</div>;
  }
  // Lane pick 3D — the collapsed head sits under a gradient fade with a
  // centered pill instead of a hard cut + inline link.
  return (
    <div className="fl-md">
      <div className={`fl-fold${expanded ? " fl-fold--open" : ""}`}>
        {body}
        <div className="fl-fold-veil">
          <button type="button" className="fl-more fl-fold-pill" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            {expanded ? "Show less" : `Show full message (${(text.length / 1000).toFixed(0)}k chars)`}
          </button>
        </div>
      </div>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
