// Inert package-wide stub for the `fluidkit` animation library. Wired in via
// `resolve.alias` in ../../vitest.config.ts so NO test worker ever loads the
// real library (or its `motion` peer). See that config for the full rationale;
// in short: fluidkit is a decorative enhancement layer that is not under test
// in this package, and loading it in vitest is a flake hazard —
//   1. `motion`'s frameloop keeps a `requestAnimationFrame` perpetually
//      outstanding. Under jsdom that rAF is backed by a Node `setInterval` that
//      outlives vitest's environment teardown and then dereferences a stripped
//      `window`, surfacing as unhandled "window is not defined" errors.
//   2. The first dynamic `import("fluidkit")` triggers vite's in-worker
//      transform of the fluidkit+motion chunk — multi-second on a loaded CI —
//      stalling the worker past `findBy*` windows and timing out unrelated
//      async assertions.
//
// The stub renders the same `aria-hidden`-compatible placeholder spans the real
// components sit inside, so the surfaces under test mount identically without
// any animation machinery. `VoiceBall` and `Thinking` are the only fluidkit
// exports that packages/ui/src dynamically imports (voice-blob.tsx,
// fluid-thinking.tsx). The type-only import of the REAL prop types keeps these
// stubs honest against fluidkit 0.5's contract.
import type { VoiceBallProps, ThinkingProps, MorphSurfaceProps } from "fluidkit";

export function VoiceBall({ size, mode }: VoiceBallProps) {
  return <span data-fluidkit-stub="voice-ball" data-mode={mode} style={{ width: size, height: size }} />;
}

export function Thinking({ label, size }: ThinkingProps) {
  return <span data-fluidkit-stub="thinking" aria-label={label} style={{ width: size, height: size }} />;
}

export function MorphSurface({ open, openContent, closedContent }: MorphSurfaceProps) {
  return <div data-fluidkit-stub="morph-surface" data-open={open}>{open ? openContent : closedContent}</div>;
}
