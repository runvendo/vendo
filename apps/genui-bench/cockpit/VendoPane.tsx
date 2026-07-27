"use client";
/**
 * The Vendo pane IS the real runtime (spec: "no approximations"): the lane's
 * AppDocument renders through the production @vendoai/ui pipeline exactly the
 * way apps/demo-bank mounts a generated app — VendoProvider (theme) →
 * AppFrame → PayloadView/TreeView with the production Kit registry, prewired
 * primitives, and jailed generated components. The ONLY substitution is the
 * tool transport: where demo-bank's embed calls client.apps.call (the vendo
 * server's guard path), this pane POSTs {host, tool, input} to /api/tools,
 * which executes the host fixture's canned-data tools. Queries resolve
 * through it at mount, actions fire through it on click, and an ok mutation
 * re-resolves the queries so the app behaves live.
 *
 * Split-compare (compareWith) renders both documents side by side read-only:
 * queries still resolve (you need data to see the UI), actions are blocked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppDocument, Json, ToolOutcome, TreeQuery, VendoTheme } from "@vendoai/core";
import { VendoProvider } from "@vendoai/ui";
import { AppFrame } from "@vendoai/ui/tree";
import type { HostFixture, LaneResult } from "../runner/types";
import type { PaneProps } from "./pane-props";

/** The pane's tool transport — the one production substitution. */
async function callTool(
  hostName: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    const response = await fetch("/api/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: hostName, tool, input }),
    });
    if (!response.ok) {
      return { status: "error", error: { code: "transport", message: `/api/tools answered ${response.status}` } };
    }
    return (await response.json()) as ToolOutcome;
  } catch (error) {
    return {
      status: "error",
      error: { code: "transport", message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function VendoDocument({
  document,
  host,
  readOnly,
}: {
  document: AppDocument;
  host: HostFixture;
  readOnly: boolean;
}) {
  const queries = useMemo(
    () => ((document.tree?.queries as TreeQuery[] | undefined) ?? []),
    [document],
  );
  const [data, setData] = useState<Record<string, Json>>({});

  // The fixture-backed twin of the runtime's open()-time query resolution:
  // each named query's result lands at JSON Pointer "/" + name, i.e. under
  // the bare name key in the data model the renderer walks.
  const resolveQueries = useCallback(async () => {
    if (queries.length === 0) return;
    const entries = await Promise.all(
      queries.map(async (query): Promise<[string, Json] | undefined> => {
        const outcome = await callTool(host.name, query.tool, (query.input ?? {}) as Record<string, unknown>);
        return outcome.status === "ok" ? [query.name, outcome.output] : undefined;
      }),
    );
    setData(Object.fromEntries(entries.filter((entry): entry is [string, Json] => entry !== undefined)));
  }, [queries, host.name]);

  useEffect(() => {
    void resolveQueries();
  }, [resolveQueries]);

  const onAction = useCallback(
    async ({ action, payload }: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome> => {
      if (readOnly) {
        return { status: "blocked", reason: "read-only compare view" };
      }
      const outcome = await callTool(host.name, action, (payload ?? {}) as Record<string, unknown>);
      // A landed mutation re-resolves the bound queries — the live loop.
      if (outcome.status === "ok") void resolveQueries();
      return outcome;
    },
    [host.name, readOnly, resolveQueries],
  );

  if (document.tree === undefined) {
    return <PaneNote>This document has no tree surface to render.</PaneNote>;
  }
  return (
    <VendoProvider theme={host.theme as Partial<VendoTheme>}>
      <AppFrame
        surface={{
          kind: "tree",
          payload: document.tree,
          ...(document.components === undefined ? {} : { components: document.components }),
        }}
        data={data}
        onAction={onAction}
      />
    </VendoProvider>
  );
}

function PaneNote({ children }: { children: React.ReactNode }) {
  return (
    <div data-vendo-pane-note="" style={{ padding: 12, fontSize: 13, opacity: 0.75 }}>
      {children}
    </div>
  );
}

function resultDocument(result: LaneResult): AppDocument | undefined {
  return result.status === "ok" ? result.document : undefined;
}

export function VendoPane({ result, host, compareWith }: PaneProps) {
  if (result.status === "no-key") {
    return <PaneNote>No model key — set ANTHROPIC_API_KEY in the repo-root .env.</PaneNote>;
  }
  if (result.status === "failed") {
    return <PaneNote>Generation failed: {result.error}</PaneNote>;
  }
  const document = resultDocument(result);
  if (document === undefined) {
    return <PaneNote>The run carries no document.</PaneNote>;
  }

  if (compareWith !== undefined) {
    const compareDocument = resultDocument(compareWith);
    return (
      <div data-vendo-pane-compare="" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <VendoDocument document={document} host={host} readOnly />
        {compareDocument === undefined
          ? <PaneNote>The compared run carries no document.</PaneNote>
          : <VendoDocument document={compareDocument} host={host} readOnly />}
      </div>
    );
  }
  return <VendoDocument document={document} host={host} readOnly={false} />;
}

export default VendoPane;
