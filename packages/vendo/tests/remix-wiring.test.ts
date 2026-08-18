/**
 * The composition slot that takes the file `vendo sync` generates
 * (`.vendo/generated/remix-wiring.ts`), which binds a ported component's
 * envelope names to the host's own functions.
 *
 * The claim under test is that the generated file buys NO new machinery: its
 * tools arrive in the ONE registry every other tool arrives in, so the
 * deployment's guard grades them and the audit trail records them exactly as it
 * does a host tool. A second execution path would be invisible from a green
 * descriptor list — a tool can be listed and still run unguarded — so the
 * guard's verdict is asserted on a real call, not on presence alone.
 *
 * The two compositions are built ONCE, together: each one boots the full stack
 * against its own embedded Postgres, and composing per test spent the file's
 * whole budget on boots rather than on assertions.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paintedIn, SCREEN_FILE } from "@vendoai/apps";
import type { AppId, Json, Principal, RiskLabel, RunContext, ToolDefinition } from "@vendoai/core";
import { defineHarness } from "@vendoai/harnesses";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_remix_wiring" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "ses_remix_wiring" };

/** Every tool name the wiring below binds — two, across three bindings. */
const WIRED_TOOLS = ["account_summary_accounts", "transfer_panel_send"] as const;

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-remix-wiring-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return store;
}

/** What the generated file binds an envelope name to: the host's own function,
 *  already wrapped as a tool. `ran` is how a test tells "the guard let it
 *  through" from "the guard answered for it". */
const boundTool = (name: string, risk: RiskLabel, ran: string[]): ToolDefinition => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk,
  execute: async () => {
    ran.push(name);
    return { ok: true } as Json;
  },
});

/** The wiring as `vendo sync` writes it: keyed by slot, envelope name → tool,
 *  component name → the host/npm component the port renders as a hole. */
const wiring = (ran: string[]): CreateVendoConfig["remixWiring"] => ({
  AccountSummary: {
    tools: { account_summary_accounts: boundTool("account_summary_accounts", "read", ran) },
    holes: { Sparkline: () => null },
  },
  TransferPanel: {
    // The same envelope the other slot reads, bound to the same host tool — two
    // remixable components fetching one thing is the normal case, not a clash.
    tools: {
      account_summary_accounts: boundTool("account_summary_accounts", "read", ran),
      transfer_panel_send: boundTool("transfer_panel_send", "write", ran),
    },
  },
});

async function compose(remixWiring?: CreateVendoConfig["remixWiring"]): Promise<Vendo> {
  return createVendo({
    // Never reached: nothing here drives a turn, and a real model would make
    // this test measure a provider instead of the composition.
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store: await tempStore(),
    guard: { policy: { rules: [{ match: { risk: "write" }, action: "block" }] } },
    ...(remixWiring === undefined ? {} : { remixWiring }),
  });
}

const names = async (vendo: Vendo): Promise<string[]> =>
  (await vendo.actions.descriptors()).map(({ name }) => name).sort();

const call = (tool: string): { id: string; tool: string; args: Record<string, never> } =>
  ({ id: `call_${tool}`, tool, args: {} });

describe("the generated wiring, in a composition", () => {
  const ran: string[] = [];
  let wired: Vendo;
  let bare: Vendo;

  // Two full stacks, so the budget is the one the file's other full-stack cases
  // carry — vitest's 30s HOOK default is tighter than a single composition needs
  // on a loaded machine, which reads as a product failure when it is only queue.
  beforeAll(async () => {
    [wired, bare] = await Promise.all([compose(wiring(ran)), compose()]);
  }, 180_000);

  it("adds the wiring's tools to the one registry, and nothing else", async () => {
    // Both directions in one equation: every wired tool is there ONCE however
    // many slots bind it, and a composition given no wiring is untouched (the
    // absolute default set is pinned by default-composition.test.ts).
    expect(await names(wired)).toEqual([...(await names(bare)), ...WIRED_TOOLS].sort());
  });

  it("grades a wiring tool through the deployment's own guard", async () => {
    const read = await wired.guardedTools.execute(call("account_summary_accounts"), ctx);
    const write = await wired.guardedTools.execute(call("transfer_panel_send"), ctx);

    expect(read).toEqual({ status: "ok", output: { ok: true } });
    // Refused BEFORE the host function ran — the proof there is no second,
    // unguarded execution path around the registry.
    expect(write.status).toBe("blocked");
    expect(ran).not.toContain("transfer_panel_send");
  });

  it("audits a wiring tool's call like any other tool's", async () => {
    await wired.guardedTools.execute(call("account_summary_accounts"), ctx);

    const { records } = await wired.store.records("vendo_audit").list({ refs: { subject: principal.subject } });
    expect(records.map((record) => (record.data as unknown as { tool?: string }).tool))
      .toContain("account_summary_accounts");
  });
});

/**
 * THE SEAM: `vendo sync` grades a port against the holes it just found, and the
 * deployment grades the SAME port against the catalog it composed. Two catalogs
 * meant sync blessed a port whose fork could never build — the floor refused
 * `Module '"@vendo/screen"' has no exported member` on the hole and the seed
 * landed `buildFailed`. It stayed green because the producer and the consumer
 * each supplied their own catalog and so could never disagree.
 *
 * So neither end is stubbed here. The port below is the shape the splitter
 * emits — screen dialect, one hole — and it is written with a harness's own
 * hands and committed, which IS the paint (§1.6), so the verdict comes from the
 * REAL checks floor: the real esbuild, the real type check, the real VM. The
 * only difference between the two cases is whether the composition was handed
 * the wiring.
 */
const HOLE = "MapleTrendBadge";
const PORTED_SCREEN = `import { Stack, Text, ${HOLE} } from "@vendo/screen";

export default function NetWorthCard() {
  return (
    <Stack gap={12}>
      <Text text="Net worth" variant="heading" />
      <${HOLE} />
    </Stack>
  );
}
`;

const PORT_APP_ID = "app_ported_net_worth" as AppId;

/** The floor's verdict on that port, plus what it said when it refused — the
 *  refusal reaches the console and nowhere else (render-seam.ts:196-201). */
async function paintPort(remixWiring?: CreateVendoConfig["remixWiring"]): Promise<{ painted: boolean; said: string }> {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let painted = false;
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async () => principal,
    store: await tempStore(),
    harness: defineHarness({
      name: "remix-port-probe",
      async *run(turn) {
        await turn.workspace.writeFile(`/user/apps/${PORT_APP_ID}/${SCREEN_FILE}`, PORTED_SCREEN);
        const committed = await turn.workspace.commit({ message: "the port" });
        painted = paintedIn(committed)?.includes(PORT_APP_ID) === true;
        yield { type: "text", delta: "ok" };
      },
    }) as never,
    ...(remixWiring === undefined ? {} : { remixWiring }),
  });

  await (await vendo.handler(new Request("https://host.test/api/vendo/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: `thr_${PORT_APP_ID}`,
      message: { id: "m1", role: "user", parts: [{ type: "text", text: "remix it" }] },
    }),
  }))).text();

  const said = errors.mock.calls.map((args) => args.join(" ")).join("\n");
  errors.mockRestore();
  return { painted, said };
}

describe("a ported screen's holes, across the sync/runtime seam", () => {
  it("paints when the composition was handed the wiring", async () => {
    const { painted, said } = await paintPort({ NetWorthCard: { holes: { [HOLE]: () => null } } });

    expect(said).not.toContain(HOLE);
    expect(painted).toBe(true);
  }, 180_000);

  it("is refused by the same floor when it was not — naming the hole", async () => {
    const { painted, said } = await paintPort();

    expect(painted).toBe(false);
    expect(said).toContain(HOLE);
  }, 180_000);
});
