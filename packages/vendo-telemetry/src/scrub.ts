/**
 * Error-detail scrubber for the cloud telemetry lane. `errorDetail` is the
 * only free-text property Vendo ever sends, so anything that could identify
 * a person, machine, or credential is replaced with a fixed token before the
 * value leaves the process. The CLI scrubs at the call site and client.ts
 * scrubs again as defense-in-depth; both use this one function.
 */

const MAX_LEN = 200;

/**
 * Redaction passes, applied in order. Order matters: specific key shapes go
 * before the broad hex/base64 nets, and paths go before the base64 net (a
 * long slash-joined path is base64-alphabet and would otherwise be eaten as
 * "[secret]" instead of "[path]").
 */
const PASSES: ReadonlyArray<[RegExp, string]> = [
  // Vendo Cloud API keys.
  [/vnd_[0-9a-f]{40}/g, "[secret]"],
  // PostHog project keys.
  [/phc_[A-Za-z0-9]+/g, "[secret]"],
  // OpenAI-style secret keys.
  [/sk-[A-Za-z0-9_-]{8,}/g, "[secret]"],
  // Bearer tokens ("Bearer eyJ...").
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[secret]"],
  // Long hex runs (sha/uuid-like material, 32+).
  [/\b[0-9a-fA-F]{32,}\b/g, "[secret]"],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Windows drive paths (C:\Users\... or C:/Users/...).
  [/\b[A-Za-z]:[\\/][^\s:*?"<>|),']+/g, "[path]"],
  // Unix and home-relative paths with 2+ components. Segments stop at ":" so
  // a stack frame's ":line:col" suffix survives ("[path]:42:7"). Lone "/tmp"
  // style single segments carry nothing identifying and pass through.
  [/~?(?:\/[^\s/:*?"<>|),']+){2,}\/?/g, "[path]"],
  // Long base64-ish runs (tokens, blobs, 32+ of the base64/url alphabet).
  [/[A-Za-z0-9+/=_-]{32,}/g, "[secret]"],
];

/**
 * Redact identifying material from an error message, collapse whitespace,
 * and cap the result at 200 chars — truncation happens AFTER redaction so a
 * secret can never straddle the cut. Never throws; non-strings return "".
 */
export function scrubErrorDetail(input: string): string {
  if (typeof input !== "string") return "";
  try {
    let s = input;
    for (const [pattern, token] of PASSES) s = s.replace(pattern, token);
    s = s.replace(/\s+/g, " ").trim();
    return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
  } catch {
    // Same never-throw contract as the rest of the package: on any surprise,
    // send nothing rather than risk sending something unscrubbed.
    return "";
  }
}
