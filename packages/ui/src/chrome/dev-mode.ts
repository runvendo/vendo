/** Dev-only console rails, SSR-safe. Next/webpack shims statically replace
 *  `process.env.NODE_ENV`; under bundlers without a process global the check
 *  simply stays off (rails are advisory, never load-bearing). */
export function developmentMode(): boolean {
  return typeof process !== "undefined" && process.env?.NODE_ENV === "development";
}
