/**
 * The harness path, through the REAL composition.
 *
 * Every test here drives `createVendo(...)` — real store, real guard, real
 * registry, real HTTP `Request` into `vendo.handler` — because this wave's worst
 * bug was ~700 lines of correct primitives with zero production callers. A unit
 * test of a helper cannot tell you a composition wired it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connector } from "@vendoai/actions";
import type { FilesAdapter, Principal, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import { vendo as vendoHarness } from "@vendoai/harnesses";
import { defineHarness } from "@vendoai/harnesses";
import type { LanguageModel, UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { apps, definePack } from "./packs/index.js";
import { createVendo, type Vendo } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_harness" };

async function tempStore(prefix: string): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/**
 * A store the way a HOST supplies one: the whole public `VendoStore` surface,
 * delegating to a real store so records and blobs genuinely work — but not the
 * handle `@vendoai/store` minted, so it is absent from the package's internals
 * WeakMap (`dbFor`) and has no SQL handle. That is the same shape the Cloud
 * hosted store presents to `storeServesHarnessTurns`, without needing the Cloud.
 */
function nonSqlStore(backing: VendoStore): VendoStore {
  return {
    records: (collection) => backing.records(collection),
    blobs: (namespace) => backing.blobs(namespace),
    ensureSchema: () => backing.ensureSchema(),
    close: () => backing.close(),
    raw: () => backing.raw(),
  };
}

const request = (path: string, body: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const userMessage = (id: string, text: string): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

/** A host tool with an observable side effect, so "the guard ran it" is a fact. */
function hostTools(): { tools: ToolRegistry; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const descriptor: ToolDescriptor = {
    name: "maple_invoices_list",
    title: "List invoices",
    description: "List the signed-in customer's invoices",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    risk: "read",
  };
  return {
    calls,
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        calls.push((call.args ?? {}) as Record<string, unknown>);
        return { status: "ok", output: { invoices: [{ id: "inv_1" }] } };
      },
    },
  };
}

/** The whole point of the `harness:` slot: a host's own thinker, driven by the
 *  runtime, reading only the frozen `Turn`. */
function scriptedHarness(script: (turn: Parameters<Parameters<typeof defineHarness>[0]["run"]>[0]) => AsyncGenerator<
  { type: "text"; delta: string },
  void,
  void
>) {
  return defineHarness({ name: "scripted", run: script });
}

interface Composed {
  vendo: Vendo;
  store: VendoStore;
  host: ReturnType<typeof hostTools>;
}

async function compose(
  overrides: Partial<Parameters<typeof createVendo>[0]> = {},
): Promise<Composed> {
  const store = await tempStore("vendo-harness-");
  const host = hostTools();
  const vendo = createVendo({
    // Never reached: every harness in this file is scripted. A model would make
    // these tests measure a provider instead of the composition. Omitted when the
    // case sets `models`, because naming one seat twice is a boot error.
    ...(overrides.models === undefined ? { model: {} as LanguageModel } : {}),
    principal: async () => principal,
    store,
    ...overrides,
  } as Parameters<typeof createVendo>[0]);
  // Host tools arrive on the ONE registry through the shipped door, exactly as
  // `actions.add(packs.tools)` does in composition — so what the harness sees is
  // guard-bound and connect-gated like anything else.
  vendo.actions.add(host.tools);
  return { vendo, store, host };
}

describe("createVendo({ harness }) — a turn served through the composed runtime", () => {
  it("routes POST /threads through the harness and persists the reply", async () => {
    const { vendo, store } = await compose({
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "Two invoices are open." };
      }),
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_served",
      message: userMessage("m1", "How many invoices?"),
    }));
    expect(turn.status).toBe(200);
    // The effective thread id comes back on every turn, like `createAgent`'s —
    // the wire needs it to register turn liveness.
    expect(turn.headers.get("x-vendo-thread-id")).toBe("thr_served");
    expect(await turn.text()).toContain("Two invoices are open.");

    // Persisted through the SAME table `createAgent` writes, so the shipped read
    // door sees a harness turn.
    const fetched = await vendo.handler(new Request("https://host.test/api/vendo/threads/thr_served"));
    const thread = await fetched.json() as { messages: Array<{ role: string }> };
    expect(thread.messages.map((message) => message.role)).toEqual(["user", "assistant"]);

    const rows = await store.records("vendo_threads").list({ refs: { subject: principal.subject } });
    expect(rows.records.map((record) => record.id)).toEqual(["thr_served"]);
  });

  it("hands the harness the guard-bound registry, schemas and all, and runs a real call", async () => {
    let listed: Array<{ name: string; inputSchema?: unknown }> = [];
    const { vendo, host } = await compose({
      harness: scriptedHarness(async function* (turn) {
        listed = await turn.tools.list();
        const result = await turn.tools.call("maple_invoices_list", {});
        yield { type: "text", delta: `status=${result.status}` };
      }),
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_tools",
      message: userMessage("m1", "list them"),
    }));
    expect(await turn.text()).toContain("status=ok");
    // The host tool really executed — not a mirror, not a stub.
    expect(host.calls).toHaveLength(1);
    // The listing carries every tool composition added, host and pack alike.
    expect(listed.map((entry) => entry.name)).toContain("maple_invoices_list");
    expect(listed.find((entry) => entry.name === "maple_invoices_list")?.inputSchema)
      .toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("gives the harness the real workspace, and a write survives to the next turn", async () => {
    const seen: string[] = [];
    const { vendo } = await compose({
      harness: scriptedHarness(async function* (turn) {
        const path = "/user/memory/notes.md";
        if (await turn.workspace.exists(path)) seen.push(await turn.workspace.readFile(path));
        await turn.workspace.writeFile(path, "the user prefers tables\n");
        yield { type: "text", delta: "noted" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_ws", message: userMessage("m1", "remember that"),
    }))).text();
    await (await vendo.handler(request("/threads", {
      threadId: "thr_ws", message: userMessage("m2", "what did I say?"),
    }))).text();

    // Turn two read what turn one committed — the workspace is the store, not
    // per-turn scratch.
    expect(seen).toEqual(["the user prefers tables\n"]);
  });

  it("mounts pack skills at /host/skills so TurnSkills serves them", async () => {
    const listing: Array<{ name: string; description: string }> = [];
    let body = "";
    const housePack = definePack({
      name: "house",
      skills: [{
        name: "house-style",
        description: "How this product talks to its customers.",
        body: "Say the amount and the recipient. Never say 'a payment'.\n",
      }],
    });

    const { vendo } = await compose({
      packs: [apps(), housePack],
      harness: scriptedHarness(async function* (turn) {
        listing.push(...await turn.skills.list());
        body = await turn.skills.load("house-style");
        yield { type: "text", delta: "read the skill" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_skills", message: userMessage("m1", "how do I talk?"),
    }))).text();

    expect(listing).toEqual(expect.arrayContaining([
      { name: "house-style", description: "How this product talks to its customers." },
      // The apps pack's own skill rides the same mount — nothing registers
      // anywhere, the mount IS the source of truth.
      expect.objectContaining({ name: "building-apps" }),
    ]));
    expect(body).toBe("Say the amount and the recipient. Never say 'a payment'.\n");
  });

  it("fills every model seat, borrowing `default` for the ones nobody set", async () => {
    const model = { id: "the-default" } as unknown as LanguageModel;
    const reviewer = { id: "the-reviewer" } as unknown as LanguageModel;
    let seats: Record<string, unknown> = {};
    const { vendo } = await compose({
      models: { default: model, reviewer },
      harness: scriptedHarness(async function* (turn) {
        seats = turn.models as unknown as Record<string, unknown>;
        yield { type: "text", delta: "seated" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_seats", message: userMessage("m1", "hi"),
    }))).text();

    expect(seats["default"]).toBe(model);
    expect(seats["reviewer"]).toBe(reviewer);
    // Unset seats borrow `default` — contract §4's own fallback, so no seat is
    // ever undefined for a harness that reads one.
    expect(seats["judge"]).toBe(model);
    expect(seats["fill"]).toBe(model);
    expect(seats["verifier"]).toBe(model);
  });

  it("boot-errors when a harness needs a sandbox and none is wired", () => {
    expect(() => createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      harness: { name: "boxed", requires: { sandbox: true }, run: async function* () {} },
    } as Parameters<typeof createVendo>[0])).toThrow(/boxed needs a sandbox adapter/);
  });

  /**
   * THE FLIP (wave 2). `POST /threads` goes through the harness runtime for every
   * host, named harness or not — the wave-1 ruling that kept the default on
   * `agent.stream` is spent, because both paths now carry the same four discovery
   * rails and the same assembled prompt.
   *
   * The discriminator is the audit plane, not the prose: only the harness runtime
   * writes a `run` row naming the harness that ran (`reportRun`). A turn that
   * quietly fell back to `agent.stream` produces no such row, so this cannot pass
   * by accident.
   */
  it("routes POST /threads through the harness runtime when NO harness is named", async () => {
    const { vendo, store } = await compose();
    // The default harness exists and is reachable directly…
    expect(vendo.harness).toBeDefined();
    // …and the wire route now runs it. The model double is empty, so `vendo()`
    // fails honestly — which is itself the failure the audit row records.
    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_default", message: userMessage("m1", "hello"),
    }));
    expect(turn.status).toBe(200);
    await turn.text();

    const { records } = await store.records("vendo_audit").list({ refs: { subject: principal.subject } });
    const runs = records
      .map((record) => (record.data as { kind?: string; detail?: { harness?: string } }))
      .filter((row) => row.kind === "run");
    expect(runs.map((row) => row.detail?.harness)).toContain("vendo");
  });

  it("still prefers the harness the host DID name", async () => {
    const { vendo, store } = await compose({
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "the named one ran" };
      }),
    });
    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_named", message: userMessage("m1", "hello"),
    }));
    expect(await turn.text()).toContain("the named one ran");
    const { records } = await store.records("vendo_audit").list({ refs: { subject: principal.subject } });
    const harnesses = records
      .map((record) => (record.data as { kind?: string; detail?: { harness?: string } }))
      .filter((row) => row.kind === "run")
      .map((row) => row.detail?.harness);
    expect(harnesses).not.toContain("vendo");
  });

  /**
   * THE FLIP'S ONE EXCEPTION, exercised. A store with no SQL handle — the Cloud
   * hosted store, or a host's own adapter behind the public `VendoStore` surface —
   * cannot serve the transcript and workspace TABLES a harness turn needs, so it
   * keeps `agent.stream`. Untested, that branch is exactly the kind of fallback
   * that rots into "every chat turn is a boot-shaped error" for the deployments
   * least able to notice.
   *
   * Two-sided, so it cannot pass by accident:
   *  - the harness path is provably IMPOSSIBLE on this store (driving the door
   *    directly raises the not-implemented refusal), and yet
   *  - the route answers 200 and writes NO `run` row, the audit row only the
   *    harness runtime writes — and the marker text of the harness that WAS
   *    named is absent from the body, which the named-harness case above proves
   *    would otherwise be there.
   */
  it("keeps POST /threads on agent.stream when the store has no SQL handle", async () => {
    const backing = await tempStore("vendo-harness-nonsql-");
    const { vendo } = await compose({
      store: nonSqlStore(backing),
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "HARNESS-RAN" };
      }),
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_nonsql", message: userMessage("m1", "hello"),
    }));
    expect(turn.status).toBe(200);
    expect(await turn.text()).not.toContain("HARNESS-RAN");

    const { records } = await backing.records("vendo_audit").list({ refs: { subject: principal.subject } });
    const runs = records
      .map((record) => (record.data as { kind?: string }))
      .filter((row) => row.kind === "run");
    expect(runs).toEqual([]);

    // The other side of the oracle: the harness door is composed and reachable,
    // and it is the STORE that cannot serve it. So the 200 above is a routing
    // fact, not a harness that happened to stay silent.
    await expect(vendo.harness.stream({
      threadId: "thr_nonsql" as never,
      message: userMessage("m2", "hello"),
      ctx: { principal } as never,
    })).rejects.toThrow(/needs a SQL-backed store/);
  });
});

describe("THE CONSTRAINT — TurnRunInput.messages is store-sourced", () => {
  /**
   * A transcript carrying an UNANSWERED approval — the state that made a
   * client-sourced `TurnRunInput.messages` throw forever.
   *
   * Seeded through the real store door rather than produced by a first turn,
   * because `approval-requested` is a `createAgent`-authored part: the harness
   * runtime mirrors a refused call as `tool-output-denied`. So this fixture IS
   * the harness-swap case — a thread whose earlier turn ran on the shipped agent,
   * resumed by a harness turn.
   */
  const pendingApprovalPart = {
    type: "tool-maple_invoices_list",
    toolCallId: "call_pending",
    state: "approval-requested",
    input: {},
    // The ai-SDK's own handle, which a real `createAgent`-authored part carries.
    approval: { id: "aiapr_pending" },
  };
  const assistantWithPendingApproval = {
    id: "m_assistant_pending",
    role: "assistant",
    parts: [pendingApprovalPart],
  };

  const seeded = async (threadId: string): Promise<Composed> => {
    const composed = await compose({
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "carried on" };
      }),
    });
    await composed.store.ensureSchema();
    const { threadStore } = await import("@vendoai/store");
    await threadStore(composed.store).put(principal, {
      id: threadId as never,
      messages: [userMessage("m0", "list invoices"), assistantWithPendingApproval] as never,
    });
    return composed;
  };

  const partStates = async (vendo: Vendo, threadId: string): Promise<string[]> => {
    const fetched = await vendo.handler(new Request(`https://host.test/api/vendo/threads/${threadId}`));
    const thread = await fetched.json() as { messages: Array<{ parts: Array<{ state?: string }> }> };
    return thread.messages.flatMap((message) => message.parts.map((part) => part.state ?? ""));
  };

  it("a client re-posting a stale pre-flip transcript cannot break the thread", async () => {
    const threadId = "thr_stale";
    const { vendo } = await seeded(threadId);

    // Pre-flip: the store really does hold an unresolved approval.
    expect(await partStates(vendo, threadId)).toContain("approval-requested");

    // Two consecutive turns, each re-posting the client's PRE-FLIP copy of
    // history alongside a fresh message. The second one is where the bug showed:
    // turn one flips the part and persists the flip, so a client still sending
    // the old assistant message is, by `validateUpsert`'s rules, forging history —
    // and it would throw on that turn and on every turn after it, permanently.
    for (const [id, text] of [["m1", "any luck?"], ["m2", "still there?"]] as const) {
      const later = await vendo.handler(request("/threads", {
        threadId,
        message: userMessage(id, text),
        // A client posting a whole transcript, ai-SDK style. The wire reads
        // `message` and nothing else, and the composition reads history from the
        // STORE — so this array is inert by construction.
        messages: [assistantWithPendingApproval, userMessage(id, text)],
      }));
      expect(later.status).toBe(200);
      expect(await later.text()).toContain("carried on");
    }

    // Post-flip: the runtime resolved the abandoned approval, and the client's
    // stale copy never reinstated it.
    const after = await partStates(vendo, threadId);
    expect(after).not.toContain("approval-requested");
  });

  it("still refuses a client that rewrites an existing user message", async () => {
    // The store-sourced transcript is not a licence to accept anything: the
    // shipped `validateUpsert` rule still decides what a client may change.
    const { vendo } = await compose({
      harness: scriptedHarness(async function* () {
        yield { type: "text", delta: "ok" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_forge", message: userMessage("m1", "the original words"),
    }))).text();

    const forged = await vendo.handler(request("/threads", {
      threadId: "thr_forge", message: userMessage("m1", "words I never said"),
    }));
    expect(forged.status).toBe(400);
    expect(await forged.text()).toMatch(/cannot be rewritten/);
  });
});

describe("ONE files adapter (build contract §3.4)", () => {
  /** Records which adapter instance the deployment actually used. */
  function recordingFiles(): FilesAdapter & { puts: string[]; deletes: string[] } {
    const blobs = new Map<string, Uint8Array>();
    return {
      puts: [],
      deletes: [],
      async put(key, bytes) {
        (this as unknown as { puts: string[] }).puts.push(key);
        blobs.set(key, bytes);
      },
      async get(key) {
        const bytes = blobs.get(key);
        return bytes === undefined ? undefined : { bytes };
      },
      async delete(key) {
        (this as unknown as { deletes: string[] }).deletes.push(key);
        blobs.delete(key);
      },
    } as FilesAdapter & { puts: string[]; deletes: string[] };
  }

  it("writes workspace blobs through `files:` and erases them through the SAME instance", async () => {
    const files = recordingFiles();
    // Past WORKSPACE_INLINE_MAX_BYTES (65536), so the content goes to the blob
    // seam instead of an inline row — which is what makes the adapter observable.
    const big = "x".repeat(70_000);
    const { vendo, store } = await compose({
      files,
      harness: scriptedHarness(async function* (turn) {
        await turn.workspace.writeFile("/user/files/report.txt", big);
        await turn.workspace.commit();
        yield { type: "text", delta: "wrote it" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_files", message: userMessage("m1", "save the report"),
    }))).text();

    // The workspace used the CONFIGURED adapter, not the store's blobs.
    expect(files.puts).toHaveLength(1);
    const key = files.puts[0] as string;

    // Now the other end: the erase cascade must delete the same object. If erase
    // resolved its own adapter, the row would go and the object would leak —
    // the class lane B spent three rounds killing.
    const { eraseStore } = await import("@vendoai/store");
    await eraseStore(store, { files }).bySubject(principal.subject);
    expect(files.deletes).toContain(key);
  });

  it("caps the no-adapter path and names `files:` as the fix", async () => {
    let message = "";
    const { vendo } = await compose({
      harness: scriptedHarness(async function* (turn) {
        try {
          // Past FILES_STORE_MAX_BYTES (5 MiB) with no `files:` wired. The façade
          // STAGES writes, so the blob only reaches the adapter at commit — which
          // is where the honest refusal has to surface.
          await turn.workspace.writeFile("/user/files/huge.bin", "x".repeat(6 * 1024 * 1024));
          await turn.workspace.commit();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        yield { type: "text", delta: "tried" };
      }),
    });

    await (await vendo.handler(request("/threads", {
      threadId: "thr_cap", message: userMessage("m1", "save something huge"),
    }))).text();

    expect(message).toMatch(/files:/);
    expect(message).toMatch(/s3\(/);
  });
});

describe("the default harness is `vendo()`", () => {
  it("composes without a `harness:` and exposes a reachable harness door", async () => {
    const { vendo } = await compose();
    // `vendo()` is what composition resolved; the door exists either way, so a
    // host (and the live proofs) can drive a harness turn without config.
    expect(typeof vendo.harness.stream).toBe("function");
    expect(typeof vendo.harness.workspace).toBe("function");
    expect(vendoHarness().name).toBe("vendo");
  });
});

/**
 * The four shipped rails, on the harness path — the reason `POST /threads` could
 * not be pointed at a harness by default. Each one is proven through a real
 * `Request` into `vendo.handler`, because a unit test of `createDiscoveryRails`
 * cannot tell you the composition wired it.
 */
describe("rail parity: find_tools, the loadout, the menu, capability miss", () => {
  /** A brokered connector whose toolkit the subject has NOT connected. */
  function gmailConnector(executed: string[]): Connector {
    const descriptor: ToolDescriptor = {
      name: "gmail_GMAIL_SEND_EMAIL",
      title: "Send an email",
      description: "Send an email through the connected Gmail account",
      inputSchema: { type: "object", properties: { to: { type: "string" } } },
      risk: "write",
      // Core `tools.ts`: `toolkit` is present on connector tools whose usefulness
      // is gated by a per-user connected account. It is what the search
      // annotation and the connect card are both keyed on.
      toolkit: "gmail",
    };
    return {
      name: "composio",
      descriptors: async () => [descriptor],
      execute: async (call) => {
        executed.push(call.tool);
        return { status: "ok", output: { sent: true } };
      },
      toolkitOf: (tool) => (tool.startsWith("gmail_") ? "gmail" : undefined),
    };
  }

  it("equips a searched-in tool and makes it CALLABLE in the same turn", async () => {
    // The rail in one test: the curated loadout hides the long tail, `find_tools`
    // equips a match, and the SAME turn's next `list()` offers it — which is how a
    // harness discovers, since `list()` is the one discovery surface.
    const before: string[][] = [];
    const after: string[][] = [];
    let searched: unknown;
    let called: string | undefined;
    const { vendo, host } = await compose({
      // A curated menu of exactly ONE tool: the long tail is off the initial
      // loadout, so `list()` must not offer `maple_invoices_list` until it is
      // searched in. This is the host's `surfaces.agent` menu in effect.
      agent: { loadout: ["maple_reports_read"] },
      harness: scriptedHarness(async function* (turn) {
        before.push((await turn.tools.list()).map((entry) => entry.name));
        const search = await turn.tools.call("find_tools", { query: "invoices" });
        searched = search.status === "ok" ? search.output : search;
        after.push((await turn.tools.list()).map((entry) => entry.name));
        const result = await turn.tools.call("maple_invoices_list", {});
        called = result.status;
        yield { type: "text", delta: `called=${called}` };
      }),
    });
    // A second host tool so the curated loadout has something to exclude.
    vendo.actions.add({
      async descriptors() {
        return [{
          name: "maple_reports_read",
          title: "Read reports",
          description: "Read the customer's reports",
          inputSchema: { type: "object", properties: {} },
          risk: "read" as const,
        }];
      },
      async execute() {
        return { status: "ok" as const, output: {} };
      },
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_find", message: userMessage("m1", "how many invoices are open?"),
    }));
    expect(await turn.text()).toContain("called=ok");

    // The loadout really was curated: the tool was NOT on offer to start with...
    expect(before[0]).toContain("find_tools");
    expect(before[0]).not.toContain("maple_invoices_list");
    // ...`find_tools` equipped it, reporting what it loaded...
    expect(JSON.stringify(searched)).toContain("maple_invoices_list");
    // ...the very next `list()` offers it, with its schema...
    expect(after[0]).toContain("maple_invoices_list");
    // ...and it really executed, through the guard, in the same turn.
    expect(called).toBe("ok");
    expect(host.calls).toHaveLength(1);
  });

  it("annotates an UNCONNECTED connector's tool and answers a call with the connect card", async () => {
    const executed: string[] = [];
    let searched = "";
    let denied: unknown;
    const { vendo } = await compose({
      connectors: [gmailConnector(executed)],
      harness: scriptedHarness(async function* (turn) {
        const search = await turn.tools.call("find_tools", { query: "send an email" });
        searched = JSON.stringify(search.status === "ok" ? search.output : search);
        denied = await turn.tools.call("gmail_GMAIL_SEND_EMAIL", { to: "a@b.test" });
        yield { type: "text", delta: "tried" };
      }),
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_connect", message: userMessage("m1", "email the invoice"),
    }));
    expect(await turn.text()).toContain("tried");

    // The search told the model it cannot run this yet — the annotation the tool
    // description and the system prompt both promise, and what stops the model
    // burning a turn reading a refusal as a failure.
    expect(searched).toContain("gmail_GMAIL_SEND_EMAIL");
    expect(searched).toContain("connectRequired");
    // And the call itself is the connect card, not an execution: `DeniedNeeds`
    // carries the toolkit so the harness can offer connecting.
    expect(denied).toMatchObject({ status: "denied", needs: { kind: "connect", toolkit: "gmail" } });
    expect(executed).toEqual([]);
  });

  it("takes the honest capability-miss path on an impossible ask (evaluation E1)", async () => {
    // E1's fifth ask: an impossible request must get an honest refusal, not an
    // invention. The reporter tool is what makes "I cannot" a recorded, reviewable
    // event instead of the model quietly making something up.
    let reported: unknown;
    let offered: string[] = [];
    const { vendo } = await compose({
      harness: scriptedHarness(async function* (turn) {
        offered = (await turn.tools.list()).map((entry) => entry.name);
        // No tool can launch a rocket. The model says so through the door.
        const outcome = await turn.tools.call("vendo_report_capability_miss", {
          kind: "no-matching-tool",
          toolsConsidered: ["maple_invoices_list"],
        });
        reported = outcome.status === "ok" ? outcome.output : outcome;
        yield { type: "text", delta: "I can't do that — nothing here reaches it." };
      }),
    });

    const turn = await vendo.handler(request("/threads", {
      threadId: "thr_miss", message: userMessage("m1", "launch a rocket to Mars"),
    }));
    expect(await turn.text()).toContain("I can't do that");

    // The reporter is on the offered surface, so a model can reach it at all —
    // this is the half that was simply absent from the harness path.
    expect(offered).toContain("vendo_report_capability_miss");
    // `reported: true` is only returned once the detector has actually fired its
    // report (it latches, so a second call answers false). The event's own
    // journey to the sink is the shipped, separately-tested half, and both
    // thinkers are handed the SAME `capabilityMiss` config value by composition.
    expect(reported).toEqual({ reported: true });
  });
});
