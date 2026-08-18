// @vitest-environment jsdom
/**
 * The approval-ref TITLE seam.
 *
 * The pack mints the ref's one line (`approvalSummary`, this package) and the
 * shipped `<VendoApprovalEmbed>` (@vendoai/ui) titles the card with that same
 * line for the rest of the request's life — waiting, approved, declined,
 * expired. Two packages that never import each other, joined by one string, so
 * each side's own suite could only ever agree with itself: the mint said
 * "Awaiting user approval: …" and the settled receipt printed it, unchanged,
 * directly over "Approved — ran".
 *
 * Nothing on either side of the string is arranged here. A real store, a real
 * guard and the real pack park a real call and mint the real envelope; the real
 * decide path executes it; the resolution the embed reads back is the one
 * `createByoApprovals` actually serves. The only double is the transport.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  vendoApprovalRefSchema,
  type AgentRunner,
  type ApprovalId,
  type Principal,
  type RunContext,
  type ToolDescriptor,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore, createStoreOps } from "@vendoai/store";
import { VendoProvider, VendoToolResult, createVendoClient } from "@vendoai/ui";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createByoApprovals } from "../src/byo-approvals.js";
import { buildVendoToolPack } from "../src/pack.js";

const BASE = "https://host.test/api/vendo";
const principal: Principal = { kind: "user", subject: "user_seam" };
/** The pack's frozen context tuple: a chat that is not Vendo's, user present. */
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_seam" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.innerHTML = "";
});

const nullRunner: AgentRunner = async () => ({ status: "ok", summary: "noop", toolCalls: [] });

/** One host tool that lists a person's todos — the exact call the defect was
 *  reported on, and a `write` grade so the guard's ask rule parks it. */
const listTodos: ToolDescriptor = {
  name: "host_getTodos",
  description: "List your todos",
  inputSchema: { type: "object", properties: { owner: { type: "string" } } },
  risk: "write",
};

const host: ToolRegistry = {
  descriptors: async () => [listTodos],
  execute: async () => ({ status: "ok", output: { open: 3 } }),
};

/** Real store, real guard, real parking registry — the composition the umbrella
 *  hands a BYO loop. */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "vendo-approval-title-seam-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const store = createStore({ dataDir: join(root, ".data") });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  const guard = createGuard({ store, policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } });
  const byo = createByoApprovals({ guard, tools: guard.bind(host), ops: createStoreOps(store) });
  const pack = await buildVendoToolPack({ registry: byo.registry, runner: nullRunner });
  const tool = pack.find((entry) => entry.name === `vendo_${listTodos.name}`);
  if (tool === undefined) throw new Error("the pack never wrapped the host tool");
  return { guard, byo, tool };
}

// --- rendering, without a component-test harness in this package -------------

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(element: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => act(() => root.unmount()));
  await act(async () => { root.render(element); });
}

/** Poll the painted DOM. The budget is the test's own — a tighter inner clock
 *  would report a product bug whenever the machine is merely busy. */
async function until<T>(what: string, probe: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    let found: T | null | undefined | false;
    await act(async () => {
      found = probe();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
  }
}

/** One real parked call, minted by the real pack. */
async function park(tool: Awaited<ReturnType<typeof harness>>["tool"]) {
  return vendoApprovalRefSchema.parse(await tool.execute({ owner: "ada" }, { ctx, callId: "call_todos" }));
}

describe("the approval ref's one line, from the mint to the settled card", () => {
  it("mints WHAT is waiting, and no state the request will outlive", async () => {
    const { tool } = await harness();
    const ref = await park(tool);
    // The guard's own preview vocabulary, so the model still reads the call…
    expect(ref.summary).toContain(listTodos.name);
    expect(ref.summary).toContain("ada");
    // …and not one word of lifecycle: this line is minted once and rendered
    // under every later state of the request.
    expect(ref.summary).not.toMatch(/awaiting|pending|approved|declined|expired/i);
  });

  it("titles the settled receipt with what was asked, and lets the state line say the state", async () => {
    const { guard, byo, tool } = await harness();
    const ref = await park(tool);

    // The decision, through the real approval API the wire serves.
    await guard.approvals.decide(ref.approvalId, { approve: true }, principal);
    const resolutions = new Map([[ref.approvalId, await byo.read(ref.approvalId, principal)]]);
    expect(resolutions.get(ref.approvalId)).toMatchObject({ state: "executed" });

    // The consumer: the shipped embed, reading that resolution over the wire.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : (input as { url: string }).url);
      const id = url.pathname.split("/").pop() as ApprovalId;
      const resolution = resolutions.get(id);
      if (resolution === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(resolution), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    cleanups.push(() => { globalThis.fetch = realFetch; });

    await mount(createElement(VendoProvider, {
      client: createVendoClient({ baseUrl: BASE }),
      children: createElement(VendoToolResult, { output: ref }),
    }));

    const card = await until("the settled receipt", () => {
      const article = document.querySelector<HTMLElement>('[data-vendo-embed="approval"]');
      return article !== null && article.textContent!.includes("Approved — ran") ? article : null;
    });
    // The title is the ask; the state line is the only thing claiming a state.
    expect(card.querySelector(".fl-approval-ask")!.textContent).toBe(ref.summary);
    expect(card.textContent).not.toMatch(/awaiting/i);
  });
});
