/**
 * `next/link` shim. Renders an anchor with the same prop surface; a click
 * navigates the HOST app via the reserved vendo.navigate action instead of
 * doing real in-sandbox navigation (which would be a dead link, or worse an
 * iframe navigation). `default` export mirrors `next/link`.
 */
import { createElement, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { navigate } from "./dispatch.js";

type QueryValue = string | number | boolean | ReadonlyArray<string | number | boolean> | null | undefined;

/** The subset of Next's UrlObject we can honor in the sandbox. */
export interface UrlObject {
  pathname?: string;
  query?: Record<string, QueryValue>;
  hash?: string;
}

export interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string | UrlObject;
  children?: ReactNode;
  // Accepted for API-compat; ignored in the sandbox.
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

function hrefString(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  const pathname = href.pathname ?? "";
  let search = "";
  if (href.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(href.query)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.append(key, String(value));
      }
    }
    const qs = params.toString();
    if (qs) search = `?${qs}`;
  }
  const hash = href.hash ? (href.hash.startsWith("#") ? href.hash : `#${href.hash}`) : "";
  return `${pathname}${search}${hash}`;
}

/** Only same-app local paths should be hijacked into an in-host navigate; the
 *  host router rejects everything else, which would make those links dead.
 *  Falls through to the browser for: hash-only anchors, any scheme
 *  (https:/http:/mailto:/tel:/…), protocol-relative `//host` externals, and
 *  `download` links. Relative and `/absolute` app paths are intercepted. */
function isLocalAppPath(url: string, download: unknown): boolean {
  if (download != null && download !== false) return false; // let the browser download
  if (!url) return false;
  if (url.startsWith("#")) return false; // in-page anchor
  if (url.startsWith("//")) return false; // protocol-relative → external origin
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return false; // has a URL scheme → external
  return true;
}

export default function Link({ href, children, onClick, prefetch: _p, replace: _r, scroll: _s, ...rest }: LinkProps): import("react").ReactElement {
  const url = hrefString(href);
  return createElement(
    "a",
    {
      ...rest,
      href: url,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        // Let the user's handler run first; it may cancel navigation.
        onClick?.(event);
        if (event.defaultPrevented) return;
        // Let the browser handle open-in-new-tab / open-in-window and any
        // non-primary (middle/right) button — only a plain primary click
        // becomes an in-host navigate.
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (rest.target && rest.target !== "_self") return;
        // Only hijack local app paths; external/mailto/tel/hash/download links
        // must reach the browser (the host router would reject them → dead link).
        if (!isLocalAppPath(url, rest.download)) return;
        event.preventDefault();
        // Fire-and-forget: navigate() returns the raw bridge Promise, which
        // rejects on a blocked navigation. Catch here so a denied click logs
        // instead of surfacing as an unhandled rejection.
        void navigate(url).catch((err: unknown) => {
          if (typeof console !== "undefined") {
            console.warn(`[vendo] Link navigation to "${url}" was blocked:`, err);
          }
        });
      },
    },
    children,
  );
}

/** Next 16's `next/link` also exports `useLinkStatus`; a component importing it
 *  would fail module instantiation without this. In-sandbox navigation is
 *  synchronous (no prefetch/pending transition), so it's always not-pending. */
export function useLinkStatus(): { pending: boolean } {
  return { pending: false };
}
