# Registering host components

Give the agent your app's own components. Registered components render inside generated views pixel-identical to your product — nothing is more on-brand. Three files, all mechanical:

## 1. Descriptors (React-free — feeds the server prompt + validation)

```ts
// src/flowlet/host-components/descriptors.ts
import { z } from "zod";
import { hostComponent, toHostRegistry } from "@flowlet/components/descriptors";

export const sparklineDescriptor = hostComponent(
  "MapleSparkline",                       // PascalCase; primitives' names are rejected
  "Tiny inline trend line. Use next to a stat. `data` is chronological.", // the agent READS this
  z.object({ data: z.array(z.number()).min(2) }),  // JSON-safe props only
);

export const myHostComponents = toHostRegistry([sparklineDescriptor]);
```

`hostComponent` fails at build time on non-PascalCase names, reserved primitive names, or an empty description. Write descriptions like API docs — they are what the model uses to choose components.

## 2. Adapters (React — compiled into the sandbox bundle only)

```tsx
// src/flowlet/host-components/impls.tsx
import { bindHostImpl } from "@flowlet/components";
import { Sparkline } from "@/components/charts/sparkline";      // your REAL component
import { sparklineDescriptor } from "./descriptors";

const MapleSparkline = bindHostImpl(sparklineDescriptor, (p) => (
  <Sparkline data={p.data} stroke="var(--flowlet-fg)" />  // translate host-only inputs here
));

export const myHostImpls = { MapleSparkline };
```

The adapter gets schema-validated props (invalid props render a contained fallback; render-time throws are error-bounded per node). It is also where host-world inputs are translated: host CSS vars → `--flowlet-*` tokens, callbacks → `flowlet.dispatch`.

## 3. Sandbox bundle (two lines + a vite config)

```ts
// flowlet-sandbox/entry.ts
import { installFlowletHost } from "@flowlet/components/sandbox";
import { myHostImpls } from "../src/flowlet/host-components/impls";
installFlowletHost(myHostImpls);
```

```ts
// flowlet-sandbox/vite.config.mts  (.mts if your app is not type:module)
import { flowletHostPreset } from "@flowlet/stage/build";
export default flowletHostPreset({ entry: "entry.ts", version: "my-app" });
```

Serve the artifact as the stage's `bundleSource` (demo-bank copies it to `public/flowlet/` at predev).

## 4. Wire the registry

Pass `[...prewiredComponents, ...myHostComponents]` wherever the registry goes: the `FlowletProvider`/`FlowletStage` `components` prop (validates generated host-node props) and your agent's system prompt (list them under a HOST COMPONENTS section so the model prefers them).

## Error story

- Bad registration (name/description/schema) → throws at module load, breaking the build.
- Schema-invalid props from the model → validated twice: at genui resolution (contained placeholder) and in the adapter (inline fallback).
- Unknown component name → a visible "Unknown component" notice in the view, per node.
- Adapter/render throw → per-node error boundary; siblings render.

## Constraints

- Props cross a JSON boundary: no functions, no React nodes, no Dates. Icons by name, dates as ISO strings.
- The sandbox ships no host CSS: components styled by CSS-in-JS/inline styles/SVG attributes port as-is; Tailwind/external-stylesheet components need their CSS delivered into the bundle (extractor work, ENG-197) or an adapter that restyles.
- Host CSS variables don't exist in the sandbox — map them to `--flowlet-*` tokens in the adapter.
