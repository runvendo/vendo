"use client";

/**
 * The render surface for Flowlet UI nodes in Maple.
 *
 * One output model: all AI-generated UI renders through the sandbox
 * (SandboxStage) now that ENG-180 has landed. The one host-rendered exception
 * is the Connect OAuth card, which the demo host owns and trusts directly.
 * Defensive prop coercion: host component props (the Connect card) come in as
 * `unknown`, so the model sometimes sends a JSON *string* instead of an object
 * — parse it so the component gets real props rather than a char-indexed spread.
 */
import type { ReactNode } from "react";
import type { UINode } from "@flowlet/core";
import { stripEmojiDeep } from "@flowlet/core";
import { DemoConnectCard } from "./DemoConnectCard";
import { SandboxStage } from "./SandboxStage";

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
  // The agent renders a Connect card (name "Connect") when it needs a toolkit
  // the user hasn't connected. It's a host-rendered, trusted component — the
  // one exception to the sandbox-only rendering model.
  if (node.kind === "component" && node.name === "Connect") {
    const props = coerceProps(node.props);
    const toolkit = typeof props.toolkit === "string" ? props.toolkit : "";
    const reason = typeof props.reason === "string" ? props.reason : undefined;
    // Entrance motion is owned by the shell's FluidReveal (ENG-205) — a host
    // wrapper here would double-animate.
    return <DemoConnectCard toolkit={toolkit} reason={reason} />;
  }

  // Every other UI the agent produces is a "generated" node, rendered
  // untrusted inside the sandbox.
  if (node.kind === "generated") {
    return <SandboxStage node={node} />;
  }

  // Unexpected: some other component node slipped through (only "Connect" is
  // host-rendered). Fail loud but contained rather than rendering blank.
  return <div data-testid="unexpected-node">{node.name} (not renderable)</div>;
}
