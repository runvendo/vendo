/**
 * The refine panel (unified try surface, Task 11): a conversational front-end
 * to the refine engine, over the try server's `/api/refine` endpoints. Type a
 * correction ("disable the delete tools") → POST /api/refine → each proposed
 * change renders as a review card (file, summary, whole-file diff, warnings)
 * → Approve/Dismiss per card → Apply approved POSTs /api/refine/apply. The
 * writes land in the TEMP profile only; the success note points at
 * `vendo init` + `vendo sync` for the permanent path (the retired `vendo
 * refine` command's job moved into sync's AI enrichment; this panel is the
 * refine ENGINE's surviving surface).
 *
 * DELIBERATE design point: this panel is a DEDICATED input, never
 * AI-classification of main-chat messages — a correction typed here is
 * unmistakably a correction, so agent prompts are never silently misrouted
 * into refine (and chat never silently mutates the profile).
 *
 * Failure posture: honest end to end. A 4xx/5xx shows the server's own error
 * message (refineErrorMessage), a malformed response is rejected whole, and
 * nothing ever renders as applied without a 2xx from the apply endpoint.
 *
 * Styling rides the house inline `var(--vendo-color-*)` idiom — the panel
 * carries its own themeCssVariables scope. The diff tints alone are
 * fixed red/green: diff semantics must read the same on every profile theme.
 */
import type { VendoTheme } from "@vendoai/core";
import { themeCssVariables } from "@vendoai/ui";
import { useState, type CSSProperties } from "react";
import type { TryProfile } from "../../try/profile.js";

// The refine endpoints are siblings of the wire mount on the SAME origin that
// served this bundle (both venues serve the page themselves), so plain
// absolute paths are correct — the boot object carries no refine URL.
const REFINE_URL = "/api/refine";
const REFINE_APPLY_URL = "/api/refine/apply";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// ---------------------------------------------------------------------------
// Pure helpers — node-tested in try-refine.test.ts, no DOM anywhere.
// ---------------------------------------------------------------------------

/** Mirrors selectSurfaceMode's strictness: only `capabilities.refine === true`
 *  (the tolerant profile parse lets anything through) renders the affordance —
 *  a keyless server reports false and the panel simply does not exist. */
export function refineEnabled(profile: TryProfile | null): boolean {
  const capabilities = (profile as { capabilities?: unknown } | null)?.capabilities;
  return (capabilities as { refine?: unknown } | null | undefined)?.refine === true;
}

export type DiffLineKind = "add" | "del" | "meta" | "context";

/** One diff line → its tint class. The engine emits whole-file diffs (every
 *  old line `-`, every new line `+`, two header lines) — red/green/meta is
 *  the entire dialect. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** One review card, as the panel renders it. */
export interface RefineCard {
  id: number;
  file: string;
  summary: string;
  diff: string;
  warnings: string[];
}

export interface RefineRun {
  runId: string;
  cards: RefineCard[];
  /** How many proposals the engine dropped as invalid — surfaced as a count
   *  so an all-dropped run doesn't read as "the model had no opinion". */
  dropped: number;
}

/** Tolerant projection of POST /api/refine's response: optional fields
 *  degrade (summary falls back to the file name, junk warnings are dropped),
 *  but a response missing the load-bearing fields is rejected WHOLE — null,
 *  never a half-rendered review the apply step couldn't honor. */
export function projectRefineRun(value: unknown): RefineRun | null {
  if (typeof value !== "object" || value === null) return null;
  const { runId, changes, dropped } = value as { runId?: unknown; changes?: unknown; dropped?: unknown };
  if (typeof runId !== "string" || runId === "" || !Array.isArray(changes)) return null;
  const cards: RefineCard[] = [];
  for (const entry of changes) {
    const candidate = entry as { id?: unknown; file?: unknown; summary?: unknown; diff?: unknown; warnings?: unknown } | null;
    if (typeof candidate?.id !== "number" || typeof candidate.file !== "string" || typeof candidate.diff !== "string") return null;
    cards.push({
      id: candidate.id,
      file: candidate.file,
      summary: typeof candidate.summary === "string" && candidate.summary !== "" ? candidate.summary : candidate.file,
      diff: candidate.diff,
      warnings: Array.isArray(candidate.warnings)
        ? candidate.warnings.filter((warning): warning is string => typeof warning === "string")
        : [],
    });
  }
  return { runId, cards, dropped: Array.isArray(dropped) ? dropped.length : 0 };
}

export type RefineDecision = "approved" | "dismissed";

/** Verdict toggle: pressing the other verdict flips, re-pressing the same
 *  verdict clears back to undecided (undecided cards are simply not applied). */
export function toggleDecision(
  decisions: Record<number, RefineDecision>,
  id: number,
  verdict: RefineDecision,
): Record<number, RefineDecision> {
  const next = { ...decisions };
  if (next[id] === verdict) delete next[id];
  else next[id] = verdict;
  return next;
}

/** The apply payload: approved card ids, ascending. */
export function approvedIds(decisions: Record<number, RefineDecision>): number[] {
  return Object.entries(decisions)
    .filter(([, verdict]) => verdict === "approved")
    .map(([id]) => Number(id))
    .sort((left, right) => left - right);
}

/** The error line an unhappy response renders: the server's own message when
 *  it sent one (the endpoints answer `{ error: { message } }`), otherwise an
 *  honest HTTP-status line — never a fake success. */
export function refineErrorMessage(status: number, body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim() !== "" ? message : `Refine failed (HTTP ${status}).`;
}

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------

function diffLineStyle(kind: DiffLineKind): CSSProperties {
  if (kind === "add") return { background: "rgba(22, 163, 74, 0.12)", color: "#15803d" };
  if (kind === "del") return { background: "rgba(220, 38, 38, 0.10)", color: "#b91c1c" };
  if (kind === "meta") return { opacity: 0.6 };
  return {};
}

const smallButtonStyle = (active: boolean): CSSProperties => ({
  font: "inherit",
  fontSize: 12,
  lineHeight: 1,
  padding: "6px 10px",
  borderRadius: 999,
  cursor: "pointer",
  border: `1px solid var(--vendo-color-${active ? "accent" : "border"}, #e3e3e8)`,
  background: active ? "var(--vendo-color-accent, #111111)" : "var(--vendo-color-surface, #f7f7f8)",
  color: active ? "var(--vendo-color-accent-text, #ffffff)" : "var(--vendo-color-text, #1a1a1e)",
});

function RefineCardView({ card, decision, onDecide }: {
  card: RefineCard;
  decision: RefineDecision | undefined;
  onDecide: (verdict: RefineDecision) => void;
}) {
  return (
    <article
      style={{
        marginTop: 10,
        borderRadius: 10,
        overflow: "hidden",
        border: `1px solid var(--vendo-color-${decision === "approved" ? "accent" : "border"}, #e3e3e8)`,
        opacity: decision === "dismissed" ? 0.55 : 1,
      }}
    >
      <div style={{ padding: "8px 10px", background: "var(--vendo-color-surface, #f7f7f8)" }}>
        <div style={{ fontFamily: MONO, fontSize: 11.5 }}>{card.file}</div>
        <div style={{ fontSize: 12, marginTop: 2, color: "var(--vendo-color-muted, #6b6b76)" }}>{card.summary}</div>
        {card.warnings.map((warning, index) => (
          <div key={index} style={{ fontSize: 11.5, marginTop: 4, color: "#b45309" }}>Warning: {warning}</div>
        ))}
      </div>
      <pre
        aria-label={`Diff for ${card.file}`}
        style={{ margin: 0, padding: "8px 10px", fontSize: 11, lineHeight: 1.5, fontFamily: MONO, overflow: "auto", maxHeight: 180 }}
      >
        {card.diff.split("\n").map((line, index) => (
          <div key={index} style={diffLineStyle(classifyDiffLine(line))}>{line === "" ? " " : line}</div>
        ))}
      </pre>
      <div style={{ display: "flex", gap: 8, padding: "8px 10px", borderTop: "1px solid var(--vendo-color-border, #e3e3e8)" }}>
        <button type="button" aria-pressed={decision === "approved"} onClick={() => onDecide("approved")} style={smallButtonStyle(decision === "approved")}>
          Approve
        </button>
        <button type="button" aria-pressed={decision === "dismissed"} onClick={() => onDecide("dismissed")} style={smallButtonStyle(false)}>
          Dismiss
        </button>
      </div>
    </article>
  );
}

type RefinePhase = "idle" | "running" | "review" | "applying" | "applied";

async function postJson(url: string, payload: unknown): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
}

/** The Refine affordance + panel: a small button in the try chrome (rendered
 *  by try-app only when the profile reports the capability) that opens a
 *  compact anchored panel. */
export function TryRefine({ theme }: { theme: VendoTheme }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [phase, setPhase] = useState<RefinePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<RefineRun | null>(null);
  const [decisions, setDecisions] = useState<Record<number, RefineDecision>>({});

  const submit = async (): Promise<void> => {
    const correction = message.trim();
    if (correction === "" || phase === "running" || phase === "applying") return;
    setPhase("running");
    setError(null);
    setRun(null);
    setDecisions({});
    try {
      const response = await postJson(REFINE_URL, { message: correction });
      if (!response.ok) {
        setError(refineErrorMessage(response.status, response.body));
        setPhase("idle");
        return;
      }
      const projected = projectRefineRun(response.body);
      if (projected === null) {
        setError("Refine returned an unreadable response.");
        setPhase("idle");
        return;
      }
      setRun(projected);
      setPhase("review");
    } catch {
      setError("Could not reach the refine endpoint.");
      setPhase("idle");
    }
  };

  const applyApproved = async (): Promise<void> => {
    const ids = approvedIds(decisions);
    if (run === null || ids.length === 0 || phase === "applying") return;
    setPhase("applying");
    setError(null);
    try {
      const response = await postJson(REFINE_APPLY_URL, { runId: run.runId, changeIds: ids });
      if (!response.ok) {
        setError(refineErrorMessage(response.status, response.body));
        setPhase("review");
        return;
      }
      setPhase("applied");
    } catch {
      setError("Could not reach the refine endpoint.");
      setPhase("review");
    }
  };

  const approvedCount = approvedIds(decisions).length;
  const busy = phase === "running" || phase === "applying";

  return (
    <div style={{ ...themeCssVariables(theme), position: "relative" } as CSSProperties}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={smallButtonStyle(open)}
      >
        Refine
      </button>
      {open ? (
        <section
          aria-label="Refine this demo"
          style={{
            position: "absolute",
            top: "calc(100% + 10px)",
            right: 0,
            width: "min(400px, 90vw)",
            maxHeight: "min(70vh, 560px)",
            overflowY: "auto",
            zIndex: 30,
            padding: 14,
            borderRadius: 12,
            border: "1px solid var(--vendo-color-border, #e3e3e8)",
            background: "var(--vendo-color-background, #ffffff)",
            color: "var(--vendo-color-text, #1a1a1e)",
            boxShadow: "0 12px 32px rgba(0, 0, 0, 0.14)",
            textAlign: "left",
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Tell it what to fix, e.g. 'disable the delete tools'"
              aria-label="Correction"
              disabled={busy}
              style={{
                flex: 1,
                font: "inherit",
                fontSize: 12.5,
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid var(--vendo-color-border, #e3e3e8)",
                background: "var(--vendo-color-surface, #f7f7f8)",
                color: "inherit",
              }}
            />
            <button type="submit" disabled={busy || message.trim() === ""} style={smallButtonStyle(true)}>
              {phase === "running" ? "Refining…" : "Send"}
            </button>
          </form>
          {phase === "running" ? (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--vendo-color-muted, #6b6b76)" }}>
              Reviewing your correction against the extracted tools…
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" style={{ margin: "10px 0 0", fontSize: 12, color: "#b91c1c" }}>{error}</p>
          ) : null}
          {run !== null && run.cards.length === 0 ? (
            <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--vendo-color-muted, #6b6b76)" }}>
              No changes proposed{run.dropped > 0 ? ` (${run.dropped} dropped as invalid)` : ""}. Try a more specific correction.
            </p>
          ) : null}
          {run?.cards.map((card) => (
            <RefineCardView
              key={`${run.runId}:${card.id}`}
              card={card}
              decision={decisions[card.id]}
              onDecide={(verdict) => {
                setDecisions((current) => toggleDecision(current, card.id, verdict));
                // New verdicts after an apply re-open the review (the cached
                // run stays applicable server-side until the next run).
                if (phase === "applied") setPhase("review");
              }}
            />
          ))}
          {run !== null && run.cards.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                disabled={approvedCount === 0 || busy || phase === "applied"}
                onClick={() => void applyApproved()}
                style={{ ...smallButtonStyle(true), opacity: approvedCount === 0 || phase === "applied" ? 0.5 : 1 }}
              >
                {phase === "applying" ? "Applying…" : `Apply approved${approvedCount > 0 ? ` (${approvedCount})` : ""}`}
              </button>
              {phase === "applied" ? (
                <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--vendo-color-muted, #6b6b76)" }}>
                  Applied to this demo. <code style={{ fontFamily: MONO }}>npx vendo init</code> installs the
                  agent for real, and <code style={{ fontFamily: MONO }}>vendo sync</code> keeps its tools
                  enriched as your code changes.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
