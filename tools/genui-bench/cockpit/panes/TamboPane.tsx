"use client";
/**
 * Tambo pane — renders their orchestration's component picks through OUR
 * registered harness components (that is the Tambo paradigm: their hosted
 * service chooses a registered component + props; the host app renders it).
 */
import type { TamboRaw } from "../../lanes/tambo";
import type { PaneProps } from "../pane-props";
import { harnessRegistry, isHarnessComponentName } from "./harness-components";
import { PaneFootnote, PaneNonOk } from "./pane-chrome";

const FOOTNOTE =
  "Tambo — registered-components paradigm — their orchestration picks and props OUR predefined components, not open-ended generation";

export default function TamboPane({ result }: PaneProps) {
  const raw = result.status === "ok" ? (result.raw as TamboRaw | undefined) : undefined;
  return (
    <div data-pane="tambo">
      {result.status !== "ok" ? (
        <PaneNonOk result={result} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {raw?.text ? <p style={{ margin: 0, fontSize: 13, color: "#c9c9d4" }}>{raw.text}</p> : null}
          {(raw?.components ?? []).map((pick, i) => {
            if (!isHarnessComponentName(pick.name)) return null;
            const Component = harnessRegistry[pick.name] as React.ComponentType<Record<string, unknown>>;
            return <Component key={i} {...pick.props} />;
          })}
          {(raw?.components ?? []).length === 0 && !raw?.text ? (
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
