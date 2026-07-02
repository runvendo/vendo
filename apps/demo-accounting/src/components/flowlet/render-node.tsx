"use client";

/**
 * The render surface for Flowlet UI nodes in Cadence.
 *
 * One output model: ALL AI-generated UI renders through the sandbox
 * (SandboxStage) — Cadence has no host-rendered exceptions (no Connect card:
 * the demo's integrations are pre-connected, so the agent never requests a
 * connect flow).
 */
import type { ReactNode } from "react";
import { motion } from "framer-motion";
import type { UINode } from "@flowlet/core";
import { SandboxStage } from "./SandboxStage";

/** Tasteful entrance so each generated view "arrives" rather than popping in. */
function Reveal({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function renderNode(node: UINode): ReactNode {
  // Every UI the agent produces is a "generated" node, rendered untrusted
  // inside the sandbox (host components resolve in the sandbox bundle).
  if (node.kind === "generated") {
    return (
      <Reveal>
        <SandboxStage node={node} />
      </Reveal>
    );
  }

  // Unexpected: a bare component node slipped through (Cadence host-renders
  // nothing). Fail loud but contained rather than rendering blank.
  return <div data-testid="unexpected-node">{node.name} (not renderable)</div>;
}
