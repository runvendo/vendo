/**
 * Link — the host's OWN pages, by name. `to` names a route the host registered;
 * the press is handed to the host's `onNavigate`, so the host's own router does
 * the moving and keeps its transitions.
 *
 * A target the registry does not carry renders as plain text. That is the whole
 * security posture: generated output SELECTS among the host's routes, it never
 * authors a URL, so there is no offsite or `javascript:` target for it to emit —
 * and a param it does fill is URL-encoded before it reaches the path.
 *
 * NO `href`, deliberately. A registered path is written the way the host's
 * router takes it, which is not the way the browser does: Maple is mounted at
 * `/maple`, so `router.push("/accounts")` lands correctly while an `href` of the
 * same string 404s. Only the host can spell the URL, so this renders the link
 * SEMANTICS (role, focus, Enter) and leaves the address to the host.
 */
import type { PropsWithChildren } from "react";
import { resolveVendoRoute } from "@vendoai/apps/contract";
import { useVendoNavigate, useVendoRoutes } from "../routes.js";
import { font, t, transitionFor } from "./tokens.js";

export interface LinkProps {
  /** The registered route's name. */
  to?: string;
  /** Values for the route path's `:params`. */
  params?: Record<string, string>;
  label?: string;
}

export function Link({ to, params, label, children }: PropsWithChildren<LinkProps>) {
  const routes = useVendoRoutes();
  const navigate = useVendoNavigate();
  const nav = to === undefined ? undefined : resolveVendoRoute(routes, to, params);
  const content = label ?? children;
  if (nav === undefined || navigate === undefined) {
    return <span data-kit="Link" style={font}>{content}</span>;
  }
  return (
    <a
      data-kit="Link"
      data-path={nav.path}
      role="link"
      tabIndex={0}
      onClick={() => navigate(nav)}
      onKeyDown={(event) => {
        if (event.key === "Enter") navigate(nav);
      }}
      style={{
        ...font,
        color: t.accent,
        cursor: "pointer",
        textDecoration: "underline",
        textUnderlineOffset: "2px",
        transition: transitionFor("color"),
      }}
    >
      {content}
    </a>
  );
}
