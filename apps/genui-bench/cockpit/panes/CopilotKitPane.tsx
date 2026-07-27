"use client";
/**
 * CopilotKit pane — renders the lane's harness-component intents through OUR
 * registered components (that is the CopilotKit paradigm: their runtime
 * routes tool calls; the host app owns the components).
 */
import type { CopilotKitRaw } from "../../lanes/copilotkit";
import type { PaneProps } from "../pane-props";
import { harnessRegistry, isHarnessComponentName } from "./harness-components";
import { PaneFootnote, PaneNonOk } from "./pane-chrome";

const FOOTNOTE =
  "CopilotKit — registered-components paradigm — shows how it drives predefined components, not open-ended generation";

export default function CopilotKitPane({ result }: PaneProps) {
  const raw = result.status === "ok" ? (result.raw as CopilotKitRaw | undefined) : undefined;
  return (
    <div data-pane="copilotkit">
      {result.status !== "ok" ? (
        <PaneNonOk result={result} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {raw?.text ? <p style={{ margin: 0, fontSize: 13, color: "#c9c9d4" }}>{raw.text}</p> : null}
          {(raw?.intents ?? []).map((intent, i) => {
            if (!isHarnessComponentName(intent.name)) return null;
            const Component = harnessRegistry[intent.name] as React.ComponentType<Record<string, unknown>>;
            return <Component key={i} {...intent.props} />;
          })}
          {(raw?.toolCalls ?? []).filter((c) => !isHarnessComponentName(c.name)).length > 0 ? (
            <p data-tool-trace style={{ margin: 0, fontSize: 11, color: "#8b8b96" }}>
              tool calls:{" "}
              {(raw?.toolCalls ?? [])
                .filter((c) => !isHarnessComponentName(c.name))
                .map((c) => c.name)
                .join(" → ")}
            </p>
          ) : null}
          {(raw?.intents ?? []).length === 0 && !raw?.text ? (
            <pre style={{ fontSize: 11, overflow: "auto", maxHeight: 240 }}>
              {JSON.stringify(raw ?? result, null, 2)}
            </pre>
          ) : null}
        </div>
      )}
      <PaneFootnote>{FOOTNOTE}</PaneFootnote>
    </div>
  );
}
