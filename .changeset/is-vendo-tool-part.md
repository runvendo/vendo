---
"@vendoai/core": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

New `isVendoToolPart(part)`, exported from `@vendoai/vendo/react` and
`@vendoai/ui`. It is the one branch a BYO chat surface needs to tell Vendo's
tool parts from its own:

```tsx
import { isVendoToolPart, VendoToolResult } from "@vendoai/vendo/react";

if (isVendoToolPart(part)) {
  return <VendoToolResult key={key} output={part.output} />;
}
// your own parts fall through to your own rendering
```

It owns the whole question. Before this, a host had to know that Vendo
namespaces its tools under `vendo_` and had to match the part shape by hand —
`part.type === "dynamic-tool"`, which quietly missed the `tool-<name>` shape
Mastra also streams. The helper matches on the tool NAME, so both shapes are
covered and a host's own `dynamic-tool` parts are never caught by it.

It is a TypeScript type predicate, so `part.output` and `part.state` typecheck
inside the branch with no cast.

It answers "is this Vendo's", never "is it finished" — a part still streaming
carries no output and `<VendoToolResult>` renders nothing for it, so
`part.state === "output-available"` stays the host's own visible check for
wherever they want to show a running one.

Also new: `VENDO_TOOL_PREFIX` from `@vendoai/core`, the single home for the
`vendo_` namespace both the tool pack and the renderer read.
`VENDO_TOOL_PACK_PREFIX` is unchanged and now re-exports it.
