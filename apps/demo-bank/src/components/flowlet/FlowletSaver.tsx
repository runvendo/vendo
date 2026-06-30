"use client";

/**
 * Watches the shared thread and captures each generated component view as a
 * "saved view" — so the closing beat can show the clock, receipt, and rule as
 * persistent, reopenable cards.
 */
import { useEffect, useRef } from "react";
import { useFlowletChat } from "@flowlet/react";
import type { UINode } from "@flowlet/core";

export interface SavedView {
  id: string;
  label: string;
  node: UINode;
}

function asObject(props: unknown): Record<string, unknown> {
  if (typeof props === "string") {
    try {
      const p = JSON.parse(props);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

function labelFor(node: Extract<UINode, { kind: "component" }>): string {
  const p = asObject(node.props);
  if (node.name === "TimeOfDayClock") return "Time-of-day spending";
  if (node.name === "Callout") return typeof p.title === "string" ? p.title : "Rule";
  if (typeof p.title === "string") return p.title;
  return node.name;
}

export function FlowletSaver({ onSave }: { onSave: (v: SavedView) => void }) {
  const { messages } = useFlowletChat();
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const m of messages) {
      for (const part of m.parts ?? []) {
        if (part.type !== "data-ui") continue;
        const node = (part as { data?: UINode }).data;
        if (!node || node.kind !== "component") continue;
        if (seen.current.has(node.id)) continue;
        seen.current.add(node.id);
        onSave({ id: node.id, label: labelFor(node), node });
      }
    }
  }, [messages, onSave]);

  return null;
}
