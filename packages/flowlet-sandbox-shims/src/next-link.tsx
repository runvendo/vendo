/**
 * `next/link` shim. Renders an anchor with the same prop surface; a click
 * navigates the HOST app via the reserved flowlet.navigate action instead of
 * doing real in-sandbox navigation (which would be a dead link, or worse an
 * iframe navigation). `default` export mirrors `next/link`.
 */
import { createElement, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { navigate } from "./dispatch";

export interface LinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string | { pathname?: string };
  children?: ReactNode;
  // Accepted for API-compat; ignored in the sandbox.
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

function hrefString(href: LinkProps["href"]): string {
  return typeof href === "string" ? href : (href.pathname ?? "");
}

export default function Link({ href, children, onClick, prefetch: _p, replace: _r, scroll: _s, ...rest }: LinkProps) {
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
