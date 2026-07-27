import type { VendoKnowledgeCitation } from "@vendoai/core";
import type { UIMessage } from "ai";
import { useState } from "react";
import { sourcesFor } from "./message-data.js";

/** Knowledge K1 — the origin byline's kind label (mockup: "Product docs"). */
function kindLabel(kind: VendoKnowledgeCitation["kind"]): string {
  if (kind === "glossary") return "Glossary";
  if (kind === "api") return "API reference";
  return "Product docs";
}

const DocIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19a2 2 0 0 1 2-2h13" />
  </svg>
);

/** One citation chip: the bordered pill that expands (click; hover on pointer
    devices, via CSS) into the snippet popover with the origin byline. */
function CitationChip({ citation }: { citation: VendoKnowledgeCitation }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`fl-cite${open ? " fl-cite--open" : ""}`}>
      <button
        type="button"
        className="fl-cite-btn"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <DocIcon />
        {citation.title}
      </button>
      <span className="fl-cite-pop" role="note">
        <span className="fl-cite-ptitle"><DocIcon />{citation.title}</span>
        <span className="fl-cite-psnippet">&ldquo;{citation.snippet}&rdquo;</span>
        <span className="fl-cite-porigin">
          {typeof citation.source === "string" && citation.source.length > 0 ? (
            <>
              {citation.source}
              <span className="fl-cite-sep" aria-hidden="true">·</span>
            </>
          ) : null}
          {kindLabel(citation.kind)}
          <span className="fl-cite-sep" aria-hidden="true">·</span>
          {citation.visibility}
        </span>
      </span>
    </span>
  );
}

/** Knowledge K1 — the turn's knowledge trust surface, rendered at the bottom
    of an assistant turn (signed mockups, Surface 2): the labelled SOURCES chip
    row for a grounded answer, the muted searched-line for a structured
    refusal, and the amber flag for an engine outage. All three render from
    the `data-vendo-citations` part's outcome — never from free text. */
export function TurnCitations({ message }: { message: UIMessage }) {
  const { citations, refused, unavailable, unverified } = sourcesFor(message);
  if (citations.length === 0 && !refused && !unavailable) return null;
  return (
    <>
      {citations.length > 0 ? (
        <div className="fl-cites" data-vendo-citations="">
          <div className="fl-cites-label">Sources</div>
          <div className="fl-cites-row">
            {citations.map(citation => (
              <CitationChip key={`${citation.docId}::${citation.chunkId ?? ""}`} citation={citation} />
            ))}
          </div>
        </div>
      ) : null}
      {unavailable ? (
        <div className="fl-know-unavail" role="status" data-vendo-knowledge-unavailable="">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5" /><path d="M12 18.2v.1" />
          </svg>
          <span>
            I couldn&apos;t check the docs just now — the knowledge base is temporarily
            unreachable, so this answer isn&apos;t verified against the documentation.
          </span>
        </div>
      ) : null}
      {unverified && !unavailable ? (
        <div className="fl-know-unavail" role="status" data-vendo-knowledge-unverified="">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5" /><path d="M12 18.2v.1" />
          </svg>
          <span>
            I couldn&apos;t check this answer against the documentation just now — the
            evidence check didn&apos;t run, so treat these sources as unverified.
          </span>
        </div>
      ) : null}
      {refused && !unavailable && citations.length === 0 ? (
        <div className="fl-know-searched" data-vendo-knowledge-searched="">
          <svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.5-4.5" />
          </svg>
          Searched the knowledge base — no matching documentation
        </div>
      ) : null}
    </>
  );
}
