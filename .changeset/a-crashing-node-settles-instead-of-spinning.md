---
"@vendoai/ui": minor
---

Two real defects in the tree renderer, and one dead extension point removed.

- The node error boundary cleared its own latched error on every re-render
  while a payload was streaming, so a node that kept throwing re-rendered
  itself until React's nested-update guard crashed the whole surface the
  boundary exists to contain. It now retries only when an input actually
  changes — a new prefix, a new node, or the flip to the final payload.
- The jail's zod shim answered `then` with another chainable node, which made
  every schema (and the module object itself) a thenable whose callback never
  fires: one `await` inside a generated component hung the island forever.
  `then` is absent now, and `in` agrees. Only `then` — it is the whole thenable
  protocol, and `.catch(fallback)` is a real zod method the shim still answers.
- `registerTreeRenderer` is removed from `@vendoai/ui/tree`. The payload
  renderer registry served exactly one format and had no caller anywhere;
  `PayloadView` checks the format tag directly. `InClientVenue` and `PinDrift`
  are no longer re-exported from the tree subpath — import them from
  `@vendoai/ui`, which is where they are declared.
