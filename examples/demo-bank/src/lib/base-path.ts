/**
 * WHERE MAPLE IS MOUNTED.
 *
 * The demo is served in place at demos.vendo.run/maple, so `basePath` in
 * next.config.ts is this constant — that is what moves the pages, the `/_next`
 * assets, `next/link` hrefs and `useRouter().push` under the prefix, and what
 * strips it back off `request.nextUrl.pathname` on the way in.
 *
 * What Next does NOT touch is any URL the app builds itself: `fetch("/api/…")`,
 * a raw `<a href>`, a `<form action>`, a `window.location` assignment, a
 * redirect's Location header, Auth.js's own route base. Those go through
 * `withBasePath` — and so does the OpenAPI spec's server url, which is how the
 * prefix reaches the agent's host tool calls.
 */
export const BASE_PATH = "/maple";

/** An app-absolute path (`/api/accounts`) as the browser must request it. */
export function withBasePath(path: string): string {
  return `${BASE_PATH}${path}`;
}
