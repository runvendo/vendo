/**
 * spec §16 law 3 — the ONE definition of what a DEVELOPER string looks like.
 *
 * A TEST ORACLE, and nothing else (ruling 14). It has exactly one reader: the
 * law's sweep over every chrome surface (test/chrome/consumer-voice-law.test.tsx
 * and its e2e twin). Every pattern here was seen LIVE on a consumer surface
 * during the redesign wave.
 *
 * It was briefly a RUNTIME gate too — `admissibleDescription` asked it whether a
 * descriptor's sentence could occupy a consent card's plain-words line. Ruling
 * 14 reversed that, and the reason generalizes: a regex set cannot be the
 * authority for what a person may read. It admitted raw JSON, raw exceptions and
 * model instructions (false negatives) while silently deleting good host copy
 * like "Funds do not leave your account until you approve." (false positives,
 * with no production trace). As an oracle its false negatives are just gaps in a
 * test; as a gate they were lies on a bank customer's screen. The runtime
 * answer is a fixed precedence ladder instead — `consentWords` in
 * chrome/build-beat.tsx.
 *
 * It lives OUTSIDE src/chrome deliberately: the law's source sweep scans that
 * tree for developer configuration phrases, and this file has to spell those
 * phrases out in order to recognize them.
 */

/** What a developer string LOOKS like, label first so a violation can say why. */
export const CONSUMER_VOICE_VIOLATIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ["an id-shaped token", /\b[a-z]{2,6}_[A-Za-z0-9]{4,}/],
  ["code-call syntax", /\b[A-Za-z_$][\w$]*\(\s*[\w$"'{[]/],
  ["a dotted identifier path", /\b[a-z]{2,}[A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]+)+\b/],
  ["an environment variable", /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/],
  ["a configuration instruction", /pass a |set VENDO_|createVendo\(/],
  ["a model instruction", /\be\.g\.|\bdivide by \d|\bdo not\b|\binteger cents\b/i],
  // The extraction's own fallback description for an unannotated host route
  // ("POST /api/demo/pin"): the wire's most common developer sentence, and the
  // one the demo hosts were shipping.
  ["an HTTP route line", /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\//],
  ["an API route path", /(?:^|\s)\/(?:api|v\d)\//],
];

/** Real user content is not our plumbing: an email address or a URL a person
 *  typed (or a tool is sending) belongs on the screen, so it is lifted out
 *  before the patterns run. */
const USER_CONTENT = /[\w.+-]+@[\w.-]+|https?:\/\/\S+/g;

/** The first violation in `text`, as "label: match" — undefined when the text
 *  reads as something a person was meant to read. */
export function consumerVoiceViolation(text: string): string | undefined {
  const scrubbed = text.replace(USER_CONTENT, " ");
  for (const [label, pattern] of CONSUMER_VOICE_VIOLATIONS) {
    const hit = pattern.exec(scrubbed);
    if (hit !== null) return `${label}: ${hit[0]}`;
  }
  return undefined;
}

/** Whether a sentence may be shown to a person as-is. */
export function isConsumerSafe(text: string): boolean {
  return consumerVoiceViolation(text) === undefined;
}
