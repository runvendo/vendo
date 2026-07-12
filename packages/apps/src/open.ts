import {
  VENDO_TREE_FORMAT,
  VendoError,
  validateTree,
  type AppDocument,
  type Json,
  type RunContext,
  type StoreAdapter,
  type Tree,
  type UIPayload,
} from "@vendoai/core";
import type { AppCaller } from "./call.js";
import type { MachineSessions } from "./machine.js";
import type { OpenSurface } from "./runtime.js";

const isObject = (value: unknown): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePointer = (pointer: string): string[] | null => {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return null;
  const encoded = pointer.slice(1).split("/");
  if (encoded.some((part) => /~(?![01])/u.test(part))) return null;
  return encoded.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
};

type JsonContainer = Record<string, Json> | Json[];
const arrayIndex = (part: string): number | null => /^(0|[1-9][0-9]*)$/.test(part) ? Number(part) : null;

const child = (target: JsonContainer, part: string): Json | undefined => {
  if (Array.isArray(target)) {
    const index = arrayIndex(part);
    return index === null ? undefined : target[index];
  }
  return target[part];
};

const assignChild = (target: JsonContainer, part: string, value: Json): boolean => {
  if (Array.isArray(target)) {
    const index = arrayIndex(part);
    if (index === null) return false;
    target[index] = value;
    return true;
  }
  target[part] = value;
  return true;
};

const setQueryData = (data: Record<string, Json>, pointer: string, value: Json): boolean => {
  const parts = decodePointer(pointer);
  if (parts === null) return false;
  if (parts.length === 0) {
    if (!isObject(value)) return false;
    Object.assign(data, structuredClone(value));
    return true;
  }
  let target: JsonContainer = data;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];
    if (part === undefined || next === undefined) return false;
    let current = child(target, part);
    if (!isObject(current) && !Array.isArray(current)) {
      current = arrayIndex(next) === null ? {} : [];
      if (!assignChild(target, part, current)) return false;
    }
    target = current as JsonContainer;
  }
  const final = parts.at(-1);
  if (final === undefined) return false;
  return assignChild(target, final, structuredClone(value));
};

const bytesToDataUri = (bytes: Uint8Array, contentType = "image/png"): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${contentType};base64,${globalThis.btoa(binary)}`;
};

/** 06-apps §§1–2 — construct the invisible-graduation open surface. */
export const createAppOpener = (
  machines: MachineSessions,
  caller: AppCaller,
  store: StoreAdapter,
): ((app: AppDocument, ctx: RunContext) => Promise<OpenSurface>) => async (app, ctx) => {
  const authorization = await machines.mintRun(app, ctx);
  if (app.ui === "http") {
    if (!machines.available()) throw new VendoError("sandbox-unavailable", "sandbox execution is unavailable");
    const machine = machines.peek(app.id);
    if (machine !== undefined) {
      if (machine.url === undefined) {
        throw new VendoError("sandbox-unavailable", "adapter cannot serve http apps");
      }
      try {
        return { kind: "http", url: await machine.url(8080) };
      } catch {
        throw new VendoError("sandbox-unavailable", "adapter cannot serve http apps");
      }
    }
    machines.wake(app, ctx, authorization);
    const cover = await store.blobs(`app:${app.id}`).get("cover.png");
    return cover === null
      ? { kind: "resuming" }
      : { kind: "resuming", cover: bytesToDataUri(cover.bytes, cover.contentType) };
  }

  if (app.tree === undefined || app.tree.formatVersion !== VENDO_TREE_FORMAT) {
    throw new VendoError("validation", "tree app has no registered ui payload");
  }
  const validation = validateTree({ ...app.tree, components: app.components });
  if (!validation.ok) throw new VendoError("validation", validation.error.message);
  const tree: Tree = structuredClone(validation.tree);
  delete tree.components;
  const data: Record<string, Json> = structuredClone(tree.data ?? {});

  for (const query of tree.queries ?? []) {
    let result: Awaited<ReturnType<AppCaller["callQuery"]>>;
    try {
      result = await caller.callQuery(app, query.tool, query.input ?? {}, ctx, authorization);
    } catch (error) {
      if (error instanceof VendoError && error.code === "sandbox-unavailable") throw error;
      continue;
    }
    const { outcome, uiEnvelope } = result;
    if (outcome.status !== "ok") continue;
    if (uiEnvelope) continue;
    setQueryData(data, query.path, outcome.output);
  }
  tree.data = data;
  return app.components === undefined
    ? { kind: "tree", payload: tree as unknown as UIPayload }
    : {
      kind: "tree",
      payload: tree as unknown as UIPayload,
      components: structuredClone(app.components),
    };
};
