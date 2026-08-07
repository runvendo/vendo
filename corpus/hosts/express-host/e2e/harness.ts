import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type VendoStore } from "@vendoai/store";
import {
  scriptedModel,
  textTurn,
  toolCallTurn,
  ZERO_USAGE,
  type LanguageModelV3StreamPart as StreamPart,
} from "@vendoai-fixtures/test-kit/stream-turns";
import type { LanguageModel, UIMessage } from "ai";
import { createRelayServer } from "../src/server/index.js";

// The scripted model and its stream parts come from the shared kit
// (`@vendoai-fixtures/test-kit/stream-turns`); re-exported here so this harness
// stays the single import every e2e in this host reaches for.
export { scriptedModel, textTurn, toolCallTurn, ZERO_USAGE, type StreamPart };

export interface TestHost {
  baseUrl: string;
  server: Server;
  store: VendoStore;
  tasks: ReturnType<typeof createRelayServer>["tasks"];
  close(): Promise<void>;
}

async function reserveLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (address === null || typeof address === "string") throw new Error("Relay port probe did not bind TCP");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function startTestHost(
  model: LanguageModel,
  options: { trustedOrigin?: boolean; development?: boolean } = {},
): Promise<TestHost> {
  const dataDir = await mkdtemp(join(tmpdir(), "relay-express-e2e-"));
  const store = createStore({ dataDir });
  const port = options.trustedOrigin === true ? await reserveLoopbackPort() : 0;
  const previousBaseUrl = process.env.VENDO_BASE_URL;
  if (options.trustedOrigin === true) process.env.VENDO_BASE_URL = `http://127.0.0.1:${port}`;
  // The composition reads NODE_ENV once, at createVendo time, to decide whether
  // the development-only routes get mounted at all (#989). Under vitest it is
  // "test", so a `development: true` opt-in has to be spelled here for any e2e
  // that reaches a dev-only route — this host's `dev` script sets
  // NODE_ENV=development, which is what those e2es stand in for.
  const previousNodeEnv = process.env.NODE_ENV;
  if (options.development === true) process.env.NODE_ENV = "development";
  let relay: ReturnType<typeof createRelayServer>;
  try {
    relay = createRelayServer({ model, store });
  } finally {
    if (previousBaseUrl === undefined) delete process.env.VENDO_BASE_URL;
    else process.env.VENDO_BASE_URL = previousBaseUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  let server: Server;
  try {
    // Let the eager composition migration settle before a bind failure enters
    // cleanup; closing PGlite while it is still opening can mask the listen error.
    await store.ensureSchema();
    server = await new Promise<Server>((resolve, reject) => {
      const listening = relay.app.listen(port, "127.0.0.1", (error?: Error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        if (listening.address() === null) {
          reject(new Error("Relay test host reported listening without an address"));
          return;
        }
        resolve(listening);
      });
      listening.once("error", reject);
    });
  } catch (error) {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    store,
    tasks: relay.tasks,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await store.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export interface SseRead {
  parts: Array<Record<string, unknown>>;
}

export async function readSse(response: Response): Promise<SseRead> {
  if (!response.ok) throw new Error(`SSE request failed: ${response.status} ${await response.text()}`);
  const raw = await response.text();
  if (!raw.endsWith("\n\n")) throw new Error("SSE response did not end with a blank line");
  return {
    parts: raw.slice(0, -2).split("\n\n")
      .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
      .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>),
  };
}

export function partsOfType(read: SseRead, type: string): Array<Record<string, unknown>> {
  return read.parts.filter((part) => part.type === type);
}

export function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Mid-stream approval sync (build contract §1.4): an interactive harness turn
// BLOCKS INSIDE the guarded call awaiting the tap, holding the SAME request
// open rather than parking the turn for a client-driven resume (the pre-flip
// shape this file's `respondToApproval` used to replay: re-post the thread
// with the parked tool part flipped to `approval-responded`). A test that
// needs to decide, or merely observe, an approval while its turn is still in
// flight reads the open response progressively instead of draining it first.
// ---------------------------------------------------------------------------

/** The `data-vendo-approval` wire part's payload (01-core §16). */
export interface VendoApprovalWireData {
  toolCallId: string;
  risk: string;
  approvalId?: string;
  invalidatedGrant?: { id: string; grantedAt: string };
}

export interface MidStreamRead {
  /** Resolves with the approval card's data the MOMENT it lands on the wire —
   *  before the turn itself completes. The synchronization point a test acts
   *  on: decide the approval while the guarded call is still blocked awaiting
   *  it. */
  approval: Promise<VendoApprovalWireData>;
  /** Resolves with the fully drained stream once the turn ends: decided,
   *  denied, or timed out at the frozen `APPROVAL_WAIT_MS` bound. */
  done: Promise<SseRead>;
}

/** Read a still-open `/threads` SSE response, exposing the approval card as
 *  soon as it arrives rather than only once the whole turn finishes. */
export function readSseMidStream(response: Response): MidStreamRead {
  let resolveApproval!: (data: VendoApprovalWireData) => void;
  const approval = new Promise<VendoApprovalWireData>((resolve) => {
    resolveApproval = resolve;
  });
  const done = (async (): Promise<SseRead> => {
    if (!response.ok) throw new Error(`SSE request failed: ${response.status} ${await response.text()}`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parts: Array<Record<string, unknown>> = [];
    let notified = false;
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.startsWith("data: ") || block === "data: [DONE]") continue;
        const part = JSON.parse(block.slice("data: ".length)) as Record<string, unknown>;
        parts.push(part);
        if (!notified && part.type === "data-vendo-approval") {
          notified = true;
          resolveApproval(part.data as VendoApprovalWireData);
        }
      }
    }
    return { parts };
  })();
  return { approval, done };
}

export function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
