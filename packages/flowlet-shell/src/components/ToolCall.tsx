export interface ToolCallProps {
  /** Raw tool slug, e.g. `get_transactions` or `GMAIL_FETCH_EMAILS`. */
  toolName: string;
  /**
   * Vercel AI SDK v6 tool-part state:
   * `input-streaming` | `input-available` | `output-available` | `output-error`.
   */
  state: string;
  /** Present at `output-error`. */
  errorText?: string;
}

/** Humanize a tool slug: `set_rule` / `GMAIL_FETCH` -> `Set Rule` / `Gmail Fetch`. */
function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map a tool slug to a friendly, human-readable action label. */
function friendlyLabel(toolName: string): string {
  const exact: Record<string, string> = {
    get_transactions: "Reading transactions",
    set_rule: "Setting up rule",
  };
  if (exact[toolName]) return exact[toolName];
  if (/^GMAIL_/i.test(toolName)) return "Searching Gmail";
  if (/^SLACK_/i.test(toolName)) return "Posting to Slack";
  return humanize(toolName);
}

/**
 * A stateful tool-call chip. Switches on the AI SDK v6 tool-part state machine:
 * working (input-streaming/input-available) -> done (output-available) ->
 * error (output-error). Styling is intentionally minimal/neutral; the visual
 * theme is applied separately.
 */
export function ToolCall({ toolName, state, errorText }: ToolCallProps) {
  const label = friendlyLabel(toolName);

  if (state === "output-error") {
    return (
      <div className="fl-tool fl-tool-error" data-testid="tool-call" data-state={state}>
        <span className="fl-tool-icon" aria-hidden="true">✕</span>
        <span className="fl-tool-label">{label} failed</span>
        {errorText ? <span className="fl-tool-detail">{errorText}</span> : null}
      </div>
    );
  }

  if (state === "output-available") {
    return (
      <div className="fl-tool fl-tool-done" data-testid="tool-call" data-state={state}>
        <span className="fl-tool-icon" aria-hidden="true">✓</span>
        <span className="fl-tool-label">{label}</span>
      </div>
    );
  }

  // input-streaming | input-available -> still working.
  return (
    <div className="fl-tool fl-tool-working" data-testid="tool-call" data-state={state}>
      <span className="fl-tool-spinner" aria-hidden="true" />
      <span className="fl-tool-label">{label}</span>
    </div>
  );
}
