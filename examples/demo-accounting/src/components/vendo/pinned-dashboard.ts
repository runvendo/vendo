import type { UIPayload } from "@vendoai/core";

/** ENG-230 — the Cadence home slot's pinned dashboard: a `vendo-genui/v2` tree
 *  mounted in place through the ENG-223 pin path (no server round trip), so the
 *  slot's FILLED state is reachable in the demo. Uses Cadence's own catalog
 *  components (CadenceMissingDocsHero, CadenceDocProgress, CadenceStatusBadge). */
export const cadencePinnedDashboard: UIPayload = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [
    { id: "root", component: "Surface", children: ["stack"] },
    { id: "stack", component: "Stack", props: { gap: 14 }, children: ["title", "hero", "progress", "badge"] },
    { id: "title", component: "Text", props: { text: "Document collection", variant: "heading" } },
    { id: "hero", component: "CadenceMissingDocsHero", props: { missingCount: 8, clientCount: 12, badgeLabel: "Chase list" } },
    { id: "progress", component: "CadenceDocProgress", props: { value: 7, max: 10 } },
    { id: "badge", component: "CadenceStatusBadge", props: { text: "3 need review", variant: "review", dot: true } },
  ],
};
