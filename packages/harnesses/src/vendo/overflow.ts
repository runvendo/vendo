/**
 * Did the provider refuse because the PROMPT did not fit?
 *
 * There is no status code for it. Every provider answers an oversized prompt
 * with its own sentence, on a 400 that looks exactly like the 400 for a malformed
 * request, and the only thing that tells them apart is the prose. So this file is
 * a pattern set — an unglamorous shape, and the honest one, which is why it is
 * ported from somebody who already collected the sentences from real traffic
 * rather than guessed at them.
 *
 * The exclusion half is the part worth reading twice. "Too many tokens, please
 * wait before trying again" is Bedrock THROTTLING, and a caller that treats it as
 * an overflow answers a rate limit by summarizing the thread and calling straight
 * back — turning one 429 into two, at the exact moment the provider asked for
 * fewer. The overflow patterns are matched only after the non-overflow patterns
 * have had their say.
 */

/**
 * Ported from pi-mono `packages/ai/src/utils/overflow.ts` (MIT, Mario Zechner):
 * the 25 OVERFLOW_PATTERNS (L37-63) minus the 3 NON_OVERFLOW_PATTERNS (L74-78),
 * so a 429 is never read as an overflow. pi's silent-overflow and length-stop
 * cases need a usage/window pair we do not have at the error site — not ported.
 */
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 400/413 with no body
] as const;

/** Rate limiting and unavailability, which several providers word in tokens.
 *  Matching one of these settles the question before the set above is consulted. */
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock, via its own error formatter
  // OURS, not pi's. The line above matches the prefix pi's OWN formatter adds,
  // which this stack never sees: `@ai-sdk/amazon-bedrock` hands us the service's
  // sentence unprefixed on `doGenerate` and prefixed with the raw exception NAME
  // (`ThrottlingException:`, not `Throttling error:`) on `doStream`, and the
  // header's whole worked example then fell through to the generic `too many
  // tokens` pattern below — answering a throttle by summarizing the thread and
  // calling straight back, which is the exact failure that paragraph was written
  // to prevent. Matching on the QUOTA is what made that guard partial: Bedrock
  // names a different one each time it is hit (tokens, tokens per day,
  // requests). The instruction is the constant, and it is also the whole
  // distinction — a prompt that does not fit never comes to fit by waiting.
  /please wait before trying again/i, // AWS Bedrock throttling, whichever quota it names
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
] as const;

/** The provider's own words, wherever the SDK put them. A `fullStream` error part
 *  carries `unknown`: an `APICallError` in the normal case, a bare string from
 *  some proxies. Anything with no sentence in it cannot be classified and is not. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" ? message : "";
}

export function isContextOverflow(error: unknown): boolean {
  const text = errorText(error);
  if (text === "" || NON_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
