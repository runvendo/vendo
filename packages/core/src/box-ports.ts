/**
 * The ports a Vendo app's box listens on. THREE, and no more.
 *
 * | Port | Who owns it | Who reaches it |
 * |---|---|---|
 * | `VENDO_APP_PORT` (8080) | the served app (`.vendo/run`) | the host, the wire proxy, keepalive |
 * | `VENDO_DEV_PORT` (5173) | the template's Vite dev server | the live preview |
 * | 8811 | the harness control port | the host's session/control calls |
 *
 * The dev port is DECLARED, not discovered. A preview URL is built from it
 * before the dev server has necessarily booted (`SandboxMachine.url(port)`), so
 * nothing may negotiate it at runtime: the host that mints the URL and the
 * template that binds the socket read this one number. That is also why the
 * template pins `strictPort` — drifting to 5174 would make the preview a silent
 * 404 rather than a loud failure.
 *
 * It lives in core because both halves must import the SAME constant and they
 * sit in different layers: the host side is `@vendoai/harnesses`, the binding
 * side is the box template. A second literal is how the two drift apart.
 */

/** The served app's port — what `$PORT` defaults to inside a box. */
export const VENDO_APP_PORT = 8080;

/** The template dev server's port, and the env var that carries it into a box. */
export const VENDO_DEV_PORT = 5173;

/** The env var name the host sets and the template reads. One spelling. */
export const VENDO_DEV_PORT_ENV = "VENDO_DEV_PORT";

/**
 * Resolve the dev port from a box's environment, falling back to the declared
 * default. Total: a missing, empty, non-numeric or out-of-range value is the
 * default, never a throw and never a NaN bound to a socket.
 */
export function devPortFrom(env: Record<string, string | undefined>): number {
  const raw = env[VENDO_DEV_PORT_ENV];
  if (raw === undefined || raw.trim() === "") return VENDO_DEV_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : VENDO_DEV_PORT;
}
