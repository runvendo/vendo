"use client";

/**
 * The render surface for Flowlet UI nodes in Maple.
 *
 * Looks up the prewired impl by name and renders it. Defensive prop coercion:
 * the render_ui tool types props as `unknown`, so the model sometimes sends a
 * JSON *string* instead of an object — parse it so the component gets real
 * props rather than a char-indexed spread.
 *
 * Prewired components are trusted and render in-process. Generated (untrusted)
 * UI renders through the F3b sandbox (FlowletStage) now that ENG-180 has landed.
 * The scripted demo uses prewired components; the sandbox is the safety net for
 * any genuinely generated node.
 */
import type { ComponentType, ReactNode } from "react";
import { motion } from "framer-motion";
import type { UINode } from "@flowlet/core";
import { stripEmojiDeep } from "@flowlet/core";
import { FlowletStage } from "@flowlet/react";
import { prewiredImpls, prewiredComponents } from "@flowlet/components";
import { DemoConnectCard } from "./DemoConnectCard";

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
  let obj: Record<string, unknown> = {};
  if (typeof props === "string") {
    try {
      const parsed = JSON.parse(props);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      obj = {};
    }
  } else if (props && typeof props === "object") {
    obj = props as Record<string, unknown>;
  }
  // Defense in depth: the model is told not to emit emoji, but strip any that
  // slip through so the rendered UI stays emoji-free regardless.
  return stripEmojiDeep(obj);
}

export function renderNode(node: UINode): ReactNode {
  if (node.kind === "component") {
    // The agent renders a Connect card (name "Connect") when it needs a toolkit
    // the user hasn't connected. It's a demo-host component, not a prewired impl.
    if (node.name === "Connect") {
      const props = coerceProps(node.props);
      const toolkit = typeof props.toolkit === "string" ? props.toolkit : "";
      const reason = typeof props.reason === "string" ? props.reason : undefined;
      return (
        <Reveal>
          <DemoConnectCard toolkit={toolkit} reason={reason} />
        </Reveal>
      );
    }
    const Impl = impls[node.name];
    if (!Impl) return <div data-testid="unimpl-node">{node.name} (no impl)</div>;
    return (
      <Reveal>
        <Impl {...coerceProps(node.props)} />
      </Reveal>
    );
  }
  return (
    <Reveal>
      <FlowletStage node={node} components={prewiredComponents} />
    </Reveal>
  );
}
