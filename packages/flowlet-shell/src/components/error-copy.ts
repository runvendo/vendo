/**
 * Map a raw stream/transport error onto copy fit for the thread. Raw provider
 * text (billing notices, SDK invariants, stack fragments) must never reach the
 * DOM — not visible text, not a title/tooltip, not the accessibility tree; the
 * demo rule is "no raw errors on screen", so everything funnels through this
 * table. The raw message goes to the console (`logErrorDetail`) for developers.
 */
export interface FriendlyError {
  /** Short, human copy shown in the error surface. */
  message: string;
  /** Whether a retry is likely to succeed (drives the Retry affordance). */
  retryable: boolean;
}

const RULES: { test: RegExp; copy: string; retryable: boolean }[] = [
  {
    // Billing/quota won't clear on its own — offering Retry would just fail
    // again in front of the audience, so no Retry affordance here.
    test: /credit balance|billing|quota|payment/i,
    copy: "The assistant hit a service limit. Give it a few minutes and try again.",
    retryable: false,
  },
  {
    test: /rate limit|too many requests|overloaded|429|529/i,
    copy: "The assistant is busy right now. Give it a few seconds and try again.",
    retryable: true,
  },
  {
    test: /network|fetch failed|failed to fetch|load failed|econn|disconnected|offline|abort/i,
    copy: "Connection lost. Check your network and try again.",
    retryable: true,
  },
  {
    test: /messages must not be empty|invalid prompt/i,
    copy: "That didn't go through — start a fresh message below.",
    retryable: false,
  },
];

export function friendlyError(raw: unknown): FriendlyError {
  const text =
    typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw ?? "");
  for (const rule of RULES) {
    if (rule.test.test(text)) return { message: rule.copy, retryable: rule.retryable };
  }
  return { message: "Something went wrong. Please try again.", retryable: true };
}

/** Console-log the raw detail for developers — the DOM never carries it. */
export function logErrorDetail(raw: unknown): void {
  const text =
    typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw ?? "");
  if (text) console.error("[flowlet] chat error:", text);
}
