import type { Json, ToolOutcome, Tree, TreeQuery, UIPayload } from "@vendoai/core";
import { VENDO_TREE_FORMAT } from "@vendoai/core";

export interface BridgeContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface BridgeCallResult {
  content: BridgeContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type ServerToolCaller = (request: {
  name: string;
  arguments: { appId: string; ref: string; args: Json };
}) => Promise<BridgeCallResult>;

export type RenderPayload = (
  id: string,
  payload: UIPayload,
  data?: Record<string, Json>,
  queryErrors?: string[],
) => void;

export type RenderNotice = (label: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPayload(value: unknown): value is UIPayload {
  return isRecord(value) && typeof value.formatVersion === "string";
}

function isToolOutcome(value: unknown): value is ToolOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "ok") return Object.hasOwn(value, "output");
  if (value.status === "error") {
    return isRecord(value.error)
      && typeof value.error.code === "string"
      && typeof value.error.message === "string";
  }
  if (value.status === "pending-approval") return typeof value.approvalId === "string";
  if (value.status === "blocked") return typeof value.reason === "string";
  return false;
}

function textContent(result: BridgeCallResult): string {
  return result.content
    .filter((block): block is BridgeContentBlock & { type: "text"; text: string } => (
      block.type === "text" && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

function resultOutput(result: BridgeCallResult): Json {
  if (result.structuredContent !== undefined) return result.structuredContent as Json;
  const text = textContent(result);
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

function resultMessage(result: BridgeCallResult): string {
  return textContent(result) || "The MCP host rejected the app call.";
}

export async function callApp(
  callServerTool: ServerToolCaller,
  id: string,
  ref: string,
  args: Json,
): Promise<ToolOutcome> {
  try {
    const result = await callServerTool({
      name: "vendo_apps_call",
      arguments: { appId: id, ref, args },
    });
    if (result.isError) {
      return { status: "error", error: { code: "mcp", message: resultMessage(result) } };
    }
    const output = resultOutput(result);
    return isToolOutcome(output) ? output : { status: "ok", output };
  } catch (error) {
    return {
      status: "error",
      error: {
        code: "mcp",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function decodePointer(path: string): string[] | undefined {
  if (path === "") return [];
  if (!path.startsWith("/")) return undefined;
  const parts = path.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  return parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))
    ? undefined
    : parts;
}

type JsonContainer = Record<string, Json> | Json[];

function childAt(container: JsonContainer, key: string): Json | undefined {
  return Array.isArray(container) ? container[Number(key)] : container[key];
}

function assignChild(container: JsonContainer, key: string, value: Json): boolean {
  if (!Array.isArray(container)) {
    container[key] = value;
    return true;
  }
  if (!/^\d+$/.test(key)) return false;
  container[Number(key)] = value;
  return true;
}

export function setQueryData(
  data: Record<string, Json>,
  query: TreeQuery,
  output: Json,
): { data: Record<string, Json>; error?: string } {
  const parts = decodePointer(query.path);
  if (parts === undefined) return { data, error: `Query "${query.tool}" has an invalid data path.` };
  if (parts.length === 0) {
    return isRecord(output)
      ? { data: structuredClone(output) as Record<string, Json> }
      : { data, error: `Query "${query.tool}" did not return an object for the root data path.` };
  }

  const next = structuredClone(data) as Record<string, Json>;
  let cursor: JsonContainer = next;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const following = parts[index + 1]!;
    const current = childAt(cursor, part);
    if (isRecord(current) || Array.isArray(current)) {
      cursor = current as JsonContainer;
      continue;
    }
    const child: JsonContainer = /^\d+$/.test(following) ? [] : {};
    if (!assignChild(cursor, part, child)) {
      return { data, error: `Query "${query.tool}" has a non-numeric array path segment.` };
    }
    cursor = child;
  }
  if (!assignChild(cursor, parts.at(-1)!, output)) {
    return { data, error: `Query "${query.tool}" has a non-numeric array path segment.` };
  }
  return { data: next };
}

interface ResolveQueriesOptions {
  call: (id: string, ref: string, args: Json) => Promise<ToolOutcome>;
  currentVersion: () => number;
  renderPayload: RenderPayload;
}

export async function resolveQueries(
  id: string,
  payload: UIPayload,
  version: number,
  options: ResolveQueriesOptions,
): Promise<void> {
  if (payload.formatVersion !== VENDO_TREE_FORMAT) return;
  const tree = payload as unknown as Tree;
  const queries = tree.queries ?? [];
  if (queries.length === 0) return;

  const outcomes = await Promise.all(queries.map((query) => options.call(id, query.tool, query.input ?? {})));
  if (version !== options.currentVersion()) return;

  let data = structuredClone(tree.data ?? {}) as Record<string, Json>;
  const errors: string[] = [];
  for (const [index, outcome] of outcomes.entries()) {
    const query = queries[index]!;
    if (outcome.status !== "ok") {
      const detail = outcome.status === "error"
        ? outcome.error.message
        : outcome.status === "blocked"
          ? outcome.reason
          : `waiting for approval ${outcome.approvalId}`;
      errors.push(`Query "${query.tool}" failed: ${detail}`);
      continue;
    }
    const updated = setQueryData(data, query, outcome.output);
    data = updated.data;
    if (updated.error) errors.push(updated.error);
  }
  options.renderPayload(id, payload, data, errors);
}

export interface ShimRuntime {
  callApp(id: string, ref: string, args: Json): Promise<ToolOutcome>;
  onToolInput(args: unknown): void;
  onToolResult(result: { structuredContent?: unknown }): void;
}

export function createShimRuntime(options: {
  callServerTool: ServerToolCaller;
  renderPayload: RenderPayload;
  renderNotice: RenderNotice;
}): ShimRuntime {
  let appId: string | undefined;
  let pendingPayload: UIPayload | undefined;
  let renderVersion = 0;

  const call = (id: string, ref: string, args: Json) => callApp(options.callServerTool, id, ref, args);

  const flushOpenResult = (): void => {
    if (!appId || !pendingPayload) return;
    const payload = pendingPayload;
    pendingPayload = undefined;
    const version = ++renderVersion;
    options.renderPayload(appId, payload);
    void resolveQueries(appId, payload, version, {
      call,
      currentVersion: () => renderVersion,
      renderPayload: options.renderPayload,
    });
  };

  return {
    callApp: call,
    onToolInput(args) {
      if (isRecord(args) && typeof args.appId === "string") appId = args.appId;
      flushOpenResult();
    },
    onToolResult(result) {
      if (!isPayload(result.structuredContent)) {
        options.renderNotice("Invalid app result", "vendo_apps_open did not return a format-tagged UI payload.");
        return;
      }
      pendingPayload = result.structuredContent;
      flushOpenResult();
    },
  };
}
