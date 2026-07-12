import type { RunContext, ToolCall, ToolDescriptor, ToolOutcome } from "@vendoai/core";
import type { Connector } from "./connector.js";
import { normalizeToolName } from "./names.js";

interface ComposioTool {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  toolkit_slug?: unknown;
  toolkit?: { slug?: unknown };
  input_parameters?: unknown;
}

interface ComposioPage {
  items?: unknown;
  data?: { items?: unknown; next_cursor?: unknown } | unknown;
  next_cursor?: unknown;
}

const MAX_PAGES = 50;

function errorOutcome(message: string): ToolOutcome {
  return { status: "error", error: { code: "connector-error", message } };
}

function pageParts(payload: ComposioPage): { items: ComposioTool[]; nextCursor?: string } {
  const nested =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as { items?: unknown; next_cursor?: unknown })
      : undefined;
  const rawItems = payload.items ?? nested?.items ?? (Array.isArray(payload.data) ? payload.data : undefined);
  if (!Array.isArray(rawItems)) throw new Error("Composio tools response did not contain an items array");
  const cursor = payload.next_cursor ?? nested?.next_cursor;
  return {
    items: rawItems as ComposioTool[],
    nextCursor: typeof cursor === "string" && cursor.length > 0 ? cursor : undefined,
  };
}

function responseError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  return fallback;
}

export function composioConnector(config: {
  apiKey: string;
  entityId?: (ctx: RunContext) => string;
  apps?: string[];
  baseUrl?: string;
}): Connector {
  const baseUrl = (config.baseUrl ?? "https://backend.composio.dev").replace(/\/$/, "");
  const normalizedToRaw = new Map<string, string>();

  async function fetchTools(app?: string): Promise<ComposioTool[]> {
    const tools: ComposioTool[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${baseUrl}/api/v3/tools`);
      if (app !== undefined) url.searchParams.set("toolkit_slug", app);
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, { headers: { "x-api-key": config.apiKey, accept: "application/json" } });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Composio tools request failed with ${response.status}: ${text.slice(0, 200)}`);
      }
      let payload: ComposioPage;
      try {
        payload = JSON.parse(text) as ComposioPage;
      } catch {
        throw new Error("Composio tools response was not valid JSON");
      }
      const parsed = pageParts(payload);
      tools.push(...parsed.items);
      cursor = parsed.nextCursor;
      if (!cursor) return tools;
      if (seenCursors.has(cursor)) throw new Error(`Composio pagination loop at cursor ${cursor}`);
      seenCursors.add(cursor);
    }

    throw new Error(`Composio tools pagination exceeded ${MAX_PAGES} pages`);
  }

  return {
    name: "composio",

    async descriptors(): Promise<ToolDescriptor[]> {
      normalizedToRaw.clear();
      const appFilters = config.apps === undefined ? [undefined] : config.apps;
      const pages = await Promise.all(appFilters.map((app) => fetchTools(app)));
      const descriptors: ToolDescriptor[] = [];

      for (const item of pages.flat()) {
        const raw = typeof item.slug === "string" ? item.slug : typeof item.name === "string" ? item.name : undefined;
        const toolkit =
          typeof item.toolkit_slug === "string"
            ? item.toolkit_slug
            : typeof item.toolkit?.slug === "string"
              ? item.toolkit.slug
              : undefined;
        if (!raw || !toolkit) throw new Error("Composio tool is missing its slug or toolkit slug");
        const name = normalizeToolName(toolkit, raw);
        if (normalizedToRaw.has(name)) throw new Error(`Composio tool-name collision: ${name}`);
        normalizedToRaw.set(name, raw);
        descriptors.push({
          name,
          description: typeof item.description === "string" ? item.description : raw,
          inputSchema:
            item.input_parameters && typeof item.input_parameters === "object" && !Array.isArray(item.input_parameters)
              ? (item.input_parameters as Record<string, unknown>)
              : {},
          risk: "write",
        });
      }

      return descriptors;
    },

    async execute(call: ToolCall, ctx: RunContext): Promise<ToolOutcome> {
      const raw = normalizedToRaw.get(call.tool);
      if (!raw) {
        return { status: "error", error: { code: "not-found", message: `Unknown Composio tool: ${call.tool}` } };
      }

      try {
        const response = await fetch(`${baseUrl}/api/v3/tools/execute/${encodeURIComponent(raw)}`, {
          method: "POST",
          headers: {
            "x-api-key": config.apiKey,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            user_id: config.entityId?.(ctx) ?? ctx.principal.subject,
            arguments: call.args,
          }),
        });
        const text = await response.text();
        let payload: { successful?: unknown; data?: unknown; error?: unknown };
        try {
          payload = JSON.parse(text) as typeof payload;
        } catch {
          return errorOutcome(`Composio execute response was not valid JSON (${response.status})`);
        }
        if (!response.ok || payload.successful !== true) {
          return errorOutcome(responseError(payload, `Composio execution failed with ${response.status}`));
        }
        return { status: "ok", output: payload.data };
      } catch (error) {
        return errorOutcome(error instanceof Error ? error.message : "Composio execution failed");
      }
    },
  };
}
