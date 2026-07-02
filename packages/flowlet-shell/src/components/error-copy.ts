/**
 * Map a raw stream/transport error onto copy fit for the thread. Raw provider
 * text (billing notices, SDK invariants, stack fragments) must never reach the
 * screen — the demo rule is "no raw errors on screen", so everything funnels
 * through this table. The raw message is still available to developers via the
 * element's `title` attribute and the console.
 */
export interface FriendlyError {
  /** Short, human copy shown in the error surface. */
  message: string;
  /** Whether a retry is likely to succeed (drives the Retry affordance). */
  retryable: boolean;
}

const RULES: { test: RegExp; copy: string; retryable: boolean }[] = [
  {
    test: /credit balance|billing|quota|payment/i,
    copy: "The assistant hit a service limit. Please try again in a moment.",
    retryable: true,
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

/** The raw detail, safe to hang on a `title` attribute for debugging. */
export function errorDetail(raw: unknown): string {
  return typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw ?? "");
}
