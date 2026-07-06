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

export default function Link({ href, children, onClick, prefetch: _p, replace: _r, scroll: _s, ...rest }: LinkProps): import("react").ReactElement {
  const target = hrefString(href);
  return createElement(
    "a",
    {
      ...rest,
      href: target,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onClick?.(event);
        navigate(target);
      },
    },
    children,
  );
}
