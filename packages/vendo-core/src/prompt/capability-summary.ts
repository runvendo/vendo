/**
 * Generated capability summary (context-engineering spec §7): a compact,
 * user-terms digest of the LIVE toolset, produced wherever the toolset is
 * actually known (chat: per-run after tool ingestion; voice: when the
 * VoiceToolDef list is composed). Pure — consumers map their tool shapes into
 * ToolSummaryInput; this module imports nothing.
 */

export interface ToolSummaryInput {
  name: string;
  description?: string;
  tier: "read" | "act" | "critical";
  source: "host" | "integration";
  /** Toolkit id for integration tools (e.g. "gmail"). */
  toolkit?: string;
}

/**
 * Render the summary block, or "" when there is nothing to say. `connectable`
 * is the host's catalog of toolkits the user could connect but has not.
 */
export function capabilitySummary(
  tools: ToolSummaryInput[],
  connectable: string[] = [],
): string {
  const hostReads = tools.filter((t) => t.source === "host" && t.tier === "read");
  const hostActions = tools.filter((t) => t.source === "host" && t.tier !== "read");
  const connected = [
    ...new Set(
      tools
        .filter((t) => t.source === "integration")
        .map((t) => t.toolkit)
        .filter((t): t is string => Boolean(t)),
    ),
  ];
  const notConnected = connectable.filter((t) => !connected.includes(t));

  const lines: string[] = [];
  if (hostReads.length) {
    lines.push(`- Read the app's own data: ${hostReads.map((t) => t.name).join(", ")}.`);
  }
  if (hostActions.length) {
    lines.push(
      `- Act in the app (each pauses for the user's approval): ${hostActions
        .map((t) => t.name)
        .join(", ")}.`,
    );
  }
  if (connected.length) {
    lines.push(`- Connected integrations you can use now: ${connected.join(", ")}.`);
  }
  if (notConnected.length) {
    lines.push(
      `- Connectable but NOT connected (offer to connect, never claim): ${notConnected.join(", ")}.`,
    );
  }
  if (!lines.length) return "";
  return ["WHAT YOU CAN DO RIGHT NOW (live toolset):", ...lines].join("\n");
}
