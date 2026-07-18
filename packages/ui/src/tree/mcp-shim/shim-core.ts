import type { Json, ToolOutcome, TreeQueryV2, UIPayload } from "@vendoai/core";
import { isPlainObject as isRecord, VENDO_TREE_FORMAT_V2 } from "@vendoai/core";

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

export const OPEN_IN_PRODUCT_KIND = "vendo/open-in-product@1" as const;

/** MCP-only link-out envelope for rung-4 apps. It deliberately lives outside
 * core's frozen UIPayload union: full HTTP rendering is deferred, and the shim
 * only needs enough trusted metadata to render a safe open-in-product card. */
export interface OpenInProductPayload {
  kind: typeof OPEN_IN_PRODUCT_KIND;
  url: string;
  productName: string;
  appName?: string;
}

function isPayload(value: unknown): value is UIPayload {
  return isRecord(value) && typeof value.formatVersion === "string";
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isOpenInProductPayload(value: unknown): value is OpenInProductPayload {
  return isRecord(value)
    && value.kind === OPEN_IN_PRODUCT_KIND
    && isHttpUrl(value.url)
    && typeof value.productName === "string"
    && value.productName.length > 0
    && (value.appName === undefined || (typeof value.appName === "string" && value.appName.length > 0));
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

export function setQueryData(
  data: Record<string, Json>,
  query: TreeQueryV2,
  output: Json,
): { data: Record<string, Json>; error?: string } {
  // v2 spec §2 — a query's result lives at "/" + name: always a single
  // top-level key (names are identifier-checked by validateTreeV2). Own-
  // property define so a hostile name like __proto__ becomes data, never the
  // prototype.
  const next = structuredClone(data) as Record<string, Json>;
  Object.defineProperty(next, query.name, {
    value: structuredClone(output),
    enumerable: true,
    writable: true,
    configurable: true,
  });
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
  if (payload.formatVersion !== VENDO_TREE_FORMAT_V2) return;
  const tree = payload as unknown as { data?: Record<string, Json>; queries?: TreeQueryV2[] };
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
          : outcome.status === "connect-required"
            ? outcome.connect.message
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
  renderOpenInProduct: (open: OpenInProductPayload) => void;
  renderNotice: RenderNotice;
}): ShimRuntime {
  let appId: string | undefined;
  let pendingOpen: { kind: "payload"; value: UIPayload } | { kind: "link"; value: OpenInProductPayload } | undefined;
  let renderVersion = 0;

  const call = (id: string, ref: string, args: Json) => callApp(options.callServerTool, id, ref, args);

  const flushOpenResult = (): void => {
    if (!appId || !pendingOpen) return;
    const open = pendingOpen;
    pendingOpen = undefined;
    const version = ++renderVersion;
    if (open.kind === "link") {
      options.renderOpenInProduct(open.value);
      return;
    }
    const payload = open.value;
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
      if (isOpenInProductPayload(result.structuredContent)) {
        pendingOpen = { kind: "link", value: result.structuredContent };
        flushOpenResult();
        return;
      }
      if (!isPayload(result.structuredContent)) {
        options.renderNotice("Invalid app result", "vendo_apps_open did not return a format-tagged UI payload.");
        return;
      }
      pendingOpen = { kind: "payload", value: result.structuredContent };
      flushOpenResult();
    },
  };
}
