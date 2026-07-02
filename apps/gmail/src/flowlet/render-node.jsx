/**
 * The render surface for Flowlet UI nodes in the Gmail clone. One output
 * model: all AI-generated UI renders through the egress-jailed sandbox
 * (SandboxStage). No host-rendered exceptions in this demo.
 */
import React from "react";
import { motion } from "framer-motion";
import { SandboxStage } from "./SandboxStage";

/** Tasteful entrance so each generated view "arrives" rather than popping in. */
function Reveal({ children }) {
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

export function renderNode(node) {
  if (node.kind === "generated") {
    return (
      <Reveal>
        <SandboxStage node={node} />
      </Reveal>
    );
  }
  // Unexpected: only generated nodes should reach the host renderer here.
  return <div data-testid="unexpected-node">{node.name} (not renderable)</div>;
}
