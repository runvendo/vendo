/** Emoji / pictographic-symbol code-point ranges, plus variation selectors and
 *  the zero-width joiner used to compose multi-part emoji. */
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{1FB00}-\u{1FBFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{25FF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Strip emoji/pictographs from a string and tidy the whitespace they leave. */
export function stripEmoji(input: string): string {
  return input
    .replace(EMOJI_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** Recursively strip emoji from every string inside a JSON-like value. Used to
 *  defensively sanitize model-generated UI props before they render. */
export function stripEmojiDeep<T>(value: T): T {
  if (typeof value === "string") return stripEmoji(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => stripEmojiDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripEmojiDeep(v);
    return out as T;
  }
  return value;
}
