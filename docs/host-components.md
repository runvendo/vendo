# Registering host components

Give the agent your app's own components. Registered components render inside generated views pixel-identical to your product — nothing is more on-brand. Three files, all mechanical:

## 1. Descriptors (React-free — feeds the server prompt + validation)

```ts
// src/vendo/host-components/descriptors.ts
import { z } from "zod";
import { hostComponent, toHostRegistry } from "@vendoai/components/descriptors";

export const sparklineDescriptor = hostComponent(
  "MapleSparkline",                       // PascalCase; primitives' names are rejected
  "Tiny inline trend line. Use next to a stat. `data` is chronological.", // the agent READS this
  z.object({ data: z.array(z.number()).min(2) }),  // JSON-safe props only
  { version: "1" },                       // optional; bump on BREAKING prop/behavior changes
);

export const myHostComponents = toHostRegistry([sparklineDescriptor]);
```

`hostComponent` fails at build time on non-PascalCase names, reserved primitive names, or an empty description. Write descriptions like API docs — they are what the model uses to choose components.

## 2. Adapters (React — compiled into the sandbox bundle only)

```tsx
// src/vendo/host-components/impls.tsx
import { bindHostImpl } from "@vendoai/components";
import { Sparkline } from "@/components/charts/sparkline";      // your REAL component
import { sparklineDescriptor } from "./descriptors";

const MapleSparkline = bindHostImpl(sparklineDescriptor, (p, runtime) => (
  // p = schema-validated JSON props; runtime = stage-injected capabilities
  // ({ vendo.dispatch, nodeId }) — absent outside the stage.
  <Sparkline data={p.data} stroke="var(--vendo-fg)" />
));

export const myHostImpls = { MapleSparkline };
```

The adapter gets schema-validated props (invalid props render a contained fallback; render-time throws are error-bounded per node). It is also where host-world inputs are translated: host CSS vars → `--vendo-*` tokens, callbacks → `vendo.dispatch`.

## 3. Sandbox bundle (two lines + a vite config)

```ts
// vendo-sandbox/entry.ts
import { installVendoHost } from "@vendoai/components/sandbox";
import { myHostImpls } from "../src/vendo/host-components/impls";
// Optional css: rules your components need inside the sandbox (e.g. the
// Tailwind utilities they use) — manual today, extractor-emitted later.
installVendoHost(myHostImpls, { css: MY_HOST_CSS });
```

`installVendoHost` throws on a name collision with the built-in catalog — rename (prefix with your app name) rather than shadow.

```ts
// vendo-sandbox/vite.config.mts  (.mts if your app is not type:module)
import { vendoHostPreset } from "@vendoai/stage/build";
export default vendoHostPreset({ entry: "entry.ts", version: "my-app" });
```

Serve the artifact as the stage's `bundleSource` (demo-bank copies it to `public/vendo/` at predev).

## 4. Wire the registry

Pass `[...prewiredComponents, ...myHostComponents]` wherever the registry goes:

- the `VendoProvider`/`VendoStage` `components` prop (validates generated host-node props);
- the engine's `components` config (`createVendoAgent({ components })`) so `render_view` rejects unknown names and schema-invalid host props server-side, where the model can repair them;
- the `VendoShellProvider` `components` prop so reopened saved views can detect registry drift (below);
- your agent's system prompt: list them under a HOST COMPONENTS section with `componentPromptCatalog(myHostComponents)` from `@vendoai/components/descriptors` so the model prefers them and uses exact prop names.

## Versioning & saved vendos

Saved vendos outlive your registry. When a view is saved, the host stamps `name → version` for every host component it uses (`stampHostComponents(node, registry)` from `@vendoai/shell`); the `version` comes from the descriptor's `{ version }` option (unset means `"1"`). On reopen, `useReopenVendo` diffs the stamp against the live registry and returns `drift: { missing, changed }` — renamed/removed components land in `missing`, version-bumped ones in `changed` — so the host can show a "components changed since this was saved" note (`.fl-drift-note`) instead of degrading silently. Bump `version` on breaking prop/behavior changes; pre-versioning records never warn retroactively.

## Error story

- Bad registration (name/description/schema) → throws at module load, breaking the build.
- Schema-invalid props from the model → rejected server-side in `render_view` as a correctable tool error (when the engine gets `components`), then re-validated at genui resolution (contained placeholder) and in the adapter (inline fallback).
- Unknown component name → a correctable `render_view` error server-side; a visible "Unknown component" notice per node if one still reaches the view.
- Adapter/render throw → per-node error boundary; siblings render.
- Registry drift on a saved view → quiet per-view note naming the changed components (see Versioning).

## Constraints

- Props cross a JSON boundary: no functions, no React nodes, no Dates. Icons by name, dates as ISO strings.
- The sandbox ships no host CSS: components styled by CSS-in-JS/inline styles/SVG attributes port as-is; Tailwind/external-stylesheet components need their CSS delivered into the bundle (extractor work) or an adapter that restyles.
- Host CSS variables don't exist in the sandbox — map them to `--vendo-*` tokens in the adapter.
