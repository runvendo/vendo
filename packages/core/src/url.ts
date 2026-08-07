/**
 * THE one owner of prefix-joining (spec 2026-08-06 §B1).
 *
 * A deployment's public URL carries its WHOLE path — `https://site.com/maple` —
 * and every URL Vendo builds attaches that prefix exactly ONCE. Every other join
 * idiom in this repo was a bare concat, which is how #866 (login redirect drops
 * the base path), #867 (returnTo double-prefix) and #914 (host-tool
 * double-prefix) all produced `/maple/maple/…` or `/…` with the prefix missing.
 * There is one implementation, here, and the callers import it.
 */

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Resolution origin for a path-only base — never reaches the network; only its
 *  path/search survive `joinPath`. */
const RELATIVE_BASE_ORIGIN = "http://vendo.invalid";

/** Whether `path` is `prefix` itself or lives under it, on a SEGMENT boundary —
 *  `/maple/api` is under `/maple`, `/maplesyrup` is not. `""` holds everything. */
function underPathPrefix(prefix: string, path: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/** The public spelling of a path: prefixed exactly once. A path that already
 *  carries the prefix (a prefix-preserving mount) is left alone. */
export function withPathPrefix(prefix: string, path: string): string {
  return underPathPrefix(prefix, path) ? path : `${prefix}${path}`;
}

/** The local spelling of a path: the public prefix taken back off. A path
 *  outside the prefix is left alone. */
export function stripPathPrefix(prefix: string, path: string): string {
  if (prefix === "" || !underPathPrefix(prefix, path)) return path;
  const stripped = path.slice(prefix.length);
  return stripped === "" ? "/" : stripped;
}

function normalizeMount(mount: string): string {
  if (mount === "" || mount === "/") return "";
  return `/${mount.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * Reduce a base URL to its canonical origin and path prefix, failing LOUD on a
 * malformed value — a bad base silently falling back to request-derived origins
 * ships wrong URLs to every client. `path` is `""` when there is none, and is
 * NEVER stripped when there is one.
 */
function parseBase(baseUrl: string | URL): URL {
  let url: URL;
  try {
    url = new URL(baseUrl instanceof URL ? baseUrl.href : baseUrl);
  } catch {
    throw new TypeError(`baseUrl must be an absolute http(s) URL, got ${JSON.stringify(String(baseUrl))}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`baseUrl must be an absolute http(s) URL, got ${JSON.stringify(String(baseUrl))}`);
  }
  return url;
}

export function publicBase(baseUrl: string | URL): { origin: string; path: string } {
  const url = parseBase(baseUrl);
  if (url.username || url.password) {
    throw new TypeError("baseUrl cannot contain credentials");
  }
  return { origin: url.origin, path: normalizeMount(url.pathname) };
}

/**
 * THE join. `base` keeps its whole path; `pathOrUrl` is appended exactly once —
 * a `pathOrUrl` that already carries the base's prefix is left alone. An
 * absolute `pathOrUrl` (any scheme) passes through untouched, so a login page on
 * another domain rides the same rule.
 *
 * A base's userinfo rides through untouched: this is a pure joiner, and a
 * basic-auth host API base (`VENDO_HOST_API_URL`) is legitimate server-side. The
 * no-credentials rule belongs to `publicBase`, which parses PUBLIC URLs.
 */
export function joinUrl(base: string | URL, pathOrUrl: string): URL {
  if (ABSOLUTE_URL.test(pathOrUrl)) return new URL(pathOrUrl);
  const url = parseBase(base);
  const path = normalizeMount(url.pathname);
  const suffix = pathOrUrl === ""
    ? (path === "" ? "/" : path)
    : withPathPrefix(path, pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`);
  const joined = new URL(suffix, url.origin);
  joined.username = url.username;
  joined.password = url.password;
  return joined;
}

/**
 * The same join for a base that may be a bare PATH — the browser client's
 * `baseUrl` default is `/api/vendo`, and a same-origin fetch must stay
 * same-origin. Returns the spelling it was given: a path stays a path, an
 * absolute base stays absolute.
 */
export function joinPath(base: string, pathOrUrl: string): string {
  if (ABSOLUTE_URL.test(base)) return joinUrl(base, pathOrUrl).href;
  if (ABSOLUTE_URL.test(pathOrUrl)) return pathOrUrl;
  const normalized = base.startsWith("/") ? base : `/${base}`;
  const joined = joinUrl(`${RELATIVE_BASE_ORIGIN}${normalized}`, pathOrUrl);
  return `${joined.pathname}${joined.search}${joined.hash}`;
}

/**
 * The ONE first-contact error when the client and the server disagree about
 * where the wire is mounted. Both sides are named, and the fix is the last
 * sentence — a mount mismatch reads as a mysterious 404 otherwise, on a surface
 * whose own pages render perfectly.
 */
export function mountMismatchMessage(sides: {
  clientBaseUrl: string;
  requested: string;
  /** Browser only: the path prefix the page itself is served under. */
  pageMount?: string;
}): string {
  const mount = sides.pageMount;
  const observed = mount !== undefined && mount !== ""
    ? `this page is served under ${JSON.stringify(mount)}`
    : "the deployment is mounted somewhere else";
  const fix = mount === undefined || mount === ""
    ? "set VENDO_BASE_URL to the app's FULL public URL (path prefix included) and pass that same prefix as <VendoProvider baseUrl=\"…/api/vendo\">"
    : `pass baseUrl=${JSON.stringify(withPathPrefix(mount, "/api/vendo"))} to <VendoProvider>, and set VENDO_BASE_URL to the app's FULL public URL (path prefix included)`;
  return `[vendo] wire mount mismatch: the client asked for ${sides.requested} with baseUrl ${JSON.stringify(sides.clientBaseUrl)}, but ${observed}. Fix: ${fix}.`;
}
