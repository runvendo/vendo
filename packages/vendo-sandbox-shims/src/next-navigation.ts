/**
 * Minimal `next/navigation` shim. `useRouter().push/replace` (and `redirect`)
 * route the host app via vendo.navigate. `redirect`/`notFound` throw to unwind
 * the render (Next semantics, caught by the sandbox error boundary); the
 * router history methods and the read hooks that have no route channel are safe
 * no-ops / empty values so they never crash a render or event handler.
 */
import { navigate } from "./dispatch.js";

export function useRouter() {
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href),
    // No history channel exists between the sandbox and the host router, so
    // back/forward can't do anything real. They are safe no-ops rather than
    // throwing, because these are wired to onClick handlers and an exception
    // there would crash the component instead of just being inert.
    back: () => {
      /* no-op: no host history bridge */
    },
    forward: () => {
      /* no-op: no host history bridge */
    },
    refresh: () => {
      /* no-op: the host owns refresh */
    },
    prefetch: () => {
      /* no-op */
    },
  };
}

export function usePathname(): string {
  return "";
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}

/** No route channel exists in the sandbox yet, so there are no dynamic route
 *  params to surface — return an empty object rather than crash a component
 *  that reads `params.id`. */
export function useParams<T extends Record<string, string | string[]> = Record<string, string | string[]>>(): T {
  return {} as T;
}

/** Recognizable codes so a host/error-boundary can tell these apart from real
 *  errors (mirrors Next's NEXT_REDIRECT / NEXT_NOT_FOUND digests). */
export const REDIRECT_ERROR_CODE = "VENDO_REDIRECT";
export const NOT_FOUND_ERROR_CODE = "VENDO_NOT_FOUND";

/** `redirect(url)` in Next THROWS to unwind rendering so the protected content
 *  below it never renders. We must do the same: kick off the navigation, then
 *  throw. A no-op-return would let the guarded component render its protected
 *  branch before/if navigation resolves. In the sandbox this throw hits the
 *  error boundary — exactly the "stop rendering protected content" behavior. */
export function redirect(url: string): never {
  // Fire-and-forget (we throw immediately and cannot await); catch so a blocked
  // navigation doesn't become an unhandled rejection.
  void navigate(url).catch(() => {});
  throw Object.assign(new Error(`[vendo] redirect(${url})`), { code: REDIRECT_ERROR_CODE });
}

/** `notFound()` in Next THROWS NEXT_NOT_FOUND to stop rendering and show the
 *  not-found segment. Throw likewise so the invalid content below never renders;
 *  in the sandbox the error boundary catches it. */
export function notFound(): never {
  throw Object.assign(new Error("[vendo] notFound()"), { code: NOT_FOUND_ERROR_CODE });
}

/** No layout-segment routing in the sandbox — mirror Next's "no segment" values. */
export function useSelectedLayoutSegment(): string | null {
  return null;
}

export function useSelectedLayoutSegments(): string[] {
  return [];
}
