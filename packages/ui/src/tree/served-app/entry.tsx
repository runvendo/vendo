import type { Json, ToolOutcome, Tree, UIPayload } from "@vendoai/core";
import { createRoot } from "react-dom/client";
import { PayloadView } from "../renderer.js";

type JsonRecord = Record<string, Json>;

const asRecord = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;

const responseOutcome = async (response: Response): Promise<ToolOutcome> => {
  const body = asRecord(await response.json().catch(() => null));
  if (response.ok && body !== undefined && Object.hasOwn(body, "result")) {
    return { status: "ok", output: body.result ?? null };
  }
  const error = asRecord(body?.error);
  return {
    status: "error",
    error: {
      code: typeof error?.code === "string" ? error.code : "served-app",
      message: typeof error?.message === "string"
        ? error.message
        : `served app request failed (${response.status})`,
    },
  };
};

const callFunction = async (action: string, payload?: Json): Promise<ToolOutcome> => {
  if (!action.startsWith("fn:")) {
    return {
      status: "error",
      error: { code: "served-app", message: `scaffold cannot call host action "${action}"` },
    };
  }
  try {
    return await responseOutcome(await fetch(`/fn/${encodeURIComponent(action.slice(3))}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: payload ?? {} }),
    }));
  } catch (error) {
    return {
      status: "error",
      error: {
        code: "served-app",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

const mount = async (): Promise<void> => {
  const element = document.querySelector<HTMLElement>("#vendo-served-tree");
  if (element === null) throw new Error("The served-app tree mount is missing");
  const [treeResponse, componentsResponse] = await Promise.all([
    fetch("/tree.json"),
    fetch("/components.json"),
  ]);
  if (!treeResponse.ok || !componentsResponse.ok) {
    throw new Error("The served-app tree scaffold is incomplete");
  }
  const tree = await treeResponse.json() as Tree;
  const components = await componentsResponse.json() as Record<string, string>;
  const payload = (Object.keys(components).length === 0
    ? tree
    : { ...tree, components }) as unknown as UIPayload;
  createRoot(element).render(
    <PayloadView
      payload={payload}
      components={{}}
      onAction={({ action, payload: args }) => callFunction(action, args)}
    />,
  );
};

Object.assign(globalThis, { VendoServedTreeRenderer: Object.freeze({ mount }) });
void mount();
