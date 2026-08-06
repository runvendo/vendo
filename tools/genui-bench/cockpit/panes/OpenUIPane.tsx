"use client";
/**
 * OpenUI pane — renders the lane's openui-lang program with THEIR runtime
 * (@openuidev/react-lang `Renderer`) and THEIR component library + theme
 * (@openuidev/react-ui — honest, not re-skinned), per the spec's
 * competitor-pane rule. Query()/Mutation() bindings resolve at render time
 * through a toolProvider that POSTs `/api/tools` — the same canned fixture
 * executors every lane runs against. A program that binds a tool the host
 * does not expose shows that query's error in place, which is the honest
 * render of a hallucinated binding.
 */
import "@openuidev/react-ui/index.css";
import { useMemo } from "react";
import { Renderer } from "@openuidev/react-lang";
import { openuiLibrary, ThemeProvider } from "@openuidev/react-ui";
import type { ToolOutcome } from "@vendoai/core";
import type { OpenUIRaw } from "../../lanes/openui";
import type { HostName } from "../../runner/types";
import type { PaneProps } from "../pane-props";
import { PaneFootnote, PaneNonOk } from "./pane-chrome";

const FOOTNOTE = "openui-lang · their runtime + component library · same prompt + tools, bound at render";

/** Function-map toolProvider over the bench's tool transport: every name the
 *  program binds maps to a POST /api/tools call; an error outcome throws so
 *  their runtime surfaces it on the query. */
function toolProviderFor(
  host: HostName,
  tools: readonly string[],
): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return Object.fromEntries(
    tools.map((tool) => [
      tool,
      async (args: Record<string, unknown>) => {
        const response = await fetch("/api/tools", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ host, tool, input: args ?? {} }),
        });
        const outcome = (await response.json()) as ToolOutcome;
        if (outcome.status === "ok") return outcome.output;
        if (outcome.status === "error") throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
        // The canned fixtures never gate (no approvals/consent), so any other
        // outcome status is itself the surprise worth surfacing on the query.
        throw new Error(`tool outcome ${outcome.status}`);
      },
    ]),
  );
}

export default function OpenUIPane({ result, host }: PaneProps) {
  const raw = result.status === "ok" ? (result.raw as OpenUIRaw | undefined) : undefined;
  const toolProvider = useMemo(
    () => toolProviderFor(host, raw?.toolsReferenced ?? []),
    [host, raw],
  );
  return (
    <div data-pane="openui">
      {result.status === "ok" && raw ? (
        <ThemeProvider>
          <Renderer
            response={raw.program}
            library={openuiLibrary}
            isStreaming={false}
            toolProvider={toolProvider}
          />
        </ThemeProvider>
      ) : (
        <PaneNonOk result={result} />
      )}
      <PaneFootnote>
        {FOOTNOTE}
        {raw?.model ? ` · ${raw.model}` : ""}
      </PaneFootnote>
    </div>
  );
}
