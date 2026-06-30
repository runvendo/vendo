"use client";

/**
 * The render surface for Flowlet UI nodes in Maple.
 *
 * Looks up the prewired impl by name and renders it. Defensive prop coercion:
 * the render_ui tool types props as `unknown`, so the model sometimes sends a
 * JSON *string* instead of an object — parse it so the component gets real
 * props rather than a char-indexed spread.
 *
 * Generated (non-component) nodes are the F3b sandbox's job; until ENG-180
 * lands they show a placeholder.
 */
import type { ComponentType, ReactNode } from "react";
import { motion } from "framer-motion";
import type { UINode } from "@flowlet/core";
import { prewiredImpls } from "@flowlet/components";

const impls = prewiredImpls as Record<string, ComponentType<Record<string, unknown>>>;

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

function coerceProps(props: unknown): Record<string, unknown> {
  if (typeof props === "string") {
    try {
      const parsed = JSON.parse(props);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (props && typeof props === "object") return props as Record<string, unknown>;
  return {};
}

export function renderNode(node: UINode): ReactNode {
  if (node.kind === "component") {
    const Impl = impls[node.name];
    if (!Impl) return <div data-testid="unimpl-node">{node.name} (no impl)</div>;
    return (
      <Reveal>
        <Impl {...coerceProps(node.props)} />
      </Reveal>
    );
  }
  return <div data-testid="generated-placeholder">[generated UI — rendered in the F3b sandbox]</div>;
}
