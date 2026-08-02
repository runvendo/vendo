"use client";
/**
 * The generated app, running inside a host document (see app/embed/README of
 * intent below). This is the runtime half of the Vendo pane: the lane's
 * AppDocument renders through the production @vendoai/ui pipeline exactly the
 * way examples/demo-bank mounts one — VendoProvider (the host's real
 * .vendo/theme.json) → AppFrame → TreeView with the production Kit registry,
 * the host's own component registry, and jailed generated components. The ONLY
 * substitution is the tool transport: where demo-bank's embed calls
 * client.apps.call (the vendo server's guard path), this POSTs {host, tool,
 * input} to /api/tools, which executes the host fixture's canned-data tools.
 * Queries resolve through it at mount, actions fire through it on click, and an
 * ok mutation re-resolves the queries so the app behaves live.
 *
 * Read-only mode (split-compare): queries still resolve — you need data to see
 * the UI — while actions are blocked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppDocument, Json, ToolOutcome, TreeQuery, VendoTheme } from "@vendoai/core";
import { VendoProvider } from "@vendoai/ui";
import { AppFrame } from "@vendoai/ui/tree";
import { hostComponents } from "../../cockpit/panes/host-registries";
import type { HostName } from "../../runner/types";

/** The pane's tool transport — the one production substitution. */
async function callTool(
  hostName: HostName,
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

export function HostApp({
  host,
  theme,
  document: appDocument,
  readOnly,
}: {
  host: HostName;
  theme: VendoTheme;
  document: AppDocument;
  readOnly: boolean;
}) {
  const queries = useMemo(
    () => ((appDocument.tree?.queries as TreeQuery[] | undefined) ?? []),
    [appDocument],
  );
  const [data, setData] = useState<Record<string, Json>>({});

  // The fixture-backed twin of the runtime's open()-time query resolution:
  // each named query's result lands at JSON Pointer "/" + name, i.e. under
  // the bare name key in the data model the renderer walks.
  const resolveQueries = useCallback(async () => {
    if (queries.length === 0) return;
    const entries = await Promise.all(
      queries.map(async (query): Promise<[string, Json] | undefined> => {
        const outcome = await callTool(host, query.tool, (query.input ?? {}) as Record<string, unknown>);
        return outcome.status === "ok" ? [query.name, outcome.output] : undefined;
      }),
    );
    setData(Object.fromEntries(entries.filter((entry): entry is [string, Json] => entry !== undefined)));
  }, [queries, host]);

  useEffect(() => {
    // Mount-time (and document-change) query resolution: the fetches settle
    // asynchronously, so no render cascades out of this effect.
    const resolve = () => void resolveQueries();
    resolve();
  }, [resolveQueries]);

  const onAction = useCallback(
    async ({ action, payload }: { nodeId: string; action: string; payload?: Json }): Promise<ToolOutcome> => {
      if (readOnly) {
        return { status: "blocked", reason: "read-only compare view" };
      }
      const outcome = await callTool(host, action, (payload ?? {}) as Record<string, unknown>);
      // A landed mutation re-resolves the bound queries — the live loop.
      if (outcome.status === "ok") void resolveQueries();
      return outcome;
    },
    [host, readOnly, resolveQueries],
  );

  if (appDocument.tree === undefined) {
    return <EmbedNote>This document has no tree surface to render.</EmbedNote>;
  }
  return (
    <VendoProvider theme={theme}>
      <AppFrame
        surface={{
          kind: "tree",
          payload: appDocument.tree,
          ...(appDocument.components === undefined ? {} : { components: appDocument.components }),
        }}
        components={hostComponents[host]}
        data={data}
        onAction={onAction}
      />
    </VendoProvider>
  );
}

export function EmbedNote({ children }: { children: React.ReactNode }) {
  return (
    <div data-embed-note="" style={{ padding: 12, fontSize: 13, opacity: 0.7 }}>
      {children}
    </div>
  );
}
