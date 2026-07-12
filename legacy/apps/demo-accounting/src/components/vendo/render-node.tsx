"use client";

/**
 * The render surface for Vendo UI nodes in Cadence.
 *
 * One output model: ALL AI-generated UI renders through the sandbox
 * (SandboxStage) — Cadence has no host-rendered exceptions (no Connect card:
 * the demo's integrations are pre-connected, so the agent never requests a
 * connect flow).
 */
import type { ReactNode } from "react";
import type { UINode } from "@vendoai/core";
import { SandboxStage } from "./SandboxStage";

export function renderNode(node: UINode): ReactNode {
  // Every UI the agent produces is a "generated" node, rendered untrusted
  // inside the sandbox (host components resolve in the sandbox bundle).
  // Entrance motion is owned by the shell's FluidReveal (ENG-205) — a host
  // wrapper here would double-animate.
  if (node.kind === "generated") {
    return <SandboxStage node={node} />;
  }

  // Unexpected: a bare component node slipped through (Cadence host-renders
  // nothing). Fail loud but contained rather than rendering blank.
  return <div data-testid="unexpected-node">{node.name} (not renderable)</div>;
}
