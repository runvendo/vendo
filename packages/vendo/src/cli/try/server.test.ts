import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import type { RefineProposals } from "../../refine.js";
import { runDeterministicPass } from "./extract.js";
import { VENDO_FIXTURES_FORMAT, VENDO_USECASES_FORMAT, type TryProfile } from "./profile.js";
import {
  composeTryVendo,
  createTryEventBus,
  startTryServer,
  type TryEvent,
  type TryServer,
} from "./server.js";

const cleanupDirs: string[] = [];
const cleanupServers: TryServer[] = [];

afterEach(async () => {
  await Promise.all(cleanupServers.splice(0).map((server) => server.close().catch(() => undefined)));
  await Promise.all(cleanupDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, source, "utf8");
}

/** Same minimal Next-ish host as extract.test.ts: one shadcn-token stylesheet,
 *  one app-router API route (`host_invoices_list`, GET /api/invoices). */
async function nextFixture(): Promise<string> {
  const root = await tempDir("vendo-try-server-fixture-");
  await write(root, "package.json", `${JSON.stringify({
    name: "host",
    dependencies: { next: "16.0.0", "@vendoai/vendo": "0.4.0" },
  }, null, 2)}\n`);
  await write(root, "app/layout.tsx", [
    'import "./globals.css";',
    "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
    "",
  ].join("\n"));
  await write(root, "app/globals.css", [
    ":root {",
    "  --background: #fffdf8;",
    "  --foreground: #1c1917;",
    "  --primary: #7c3aed;",
    "  --radius: 10px;",
    "}",
    "",
  ].join("\n"));
  await write(root, "app/api/invoices/route.ts",
    "export async function GET() { return Response.json([]); }\n");
  return root;
}

/** Full recursive inventory of a tree (extract.test.ts's zero-commit unit). */
async function inventory(root: string, at = root): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name);
    const relative = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      entries[`${relative}/`] = "dir";
      Object.assign(entries, await inventory(root, path));
    } else {
      entries[relative] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return entries;
}

async function extractedProfile(): Promise<{ repoRoot: string; profileRoot: string }> {
  const repoRoot = await nextFixture();
  const profileRoot = await tempDir("vendo-try-server-profile-");
  await runDeterministicPass({ repoRoot, profileRoot });
  return { repoRoot, profileRoot };
}

async function serve(options: Parameters<typeof startTryServer>[0]): Promise<TryServer> {
  const server = await startTryServer(options);
  cleanupServers.push(server);
  return server;
}

async function fetchProfile(server: TryServer): Promise<TryProfile> {
  const response = await fetch(`${server.url}/profile.json`);
  expect(response.status).toBe(200);
  return await response.json() as TryProfile;
}

/** A model the tests never invoke: liveChat is a capability FLAG, not a call. */
function stubModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "stub",
    modelId: "stub",
    supportedUrls: {},
    doGenerate: async () => { throw new Error("the try server must never call the model on its own"); },
    doStream: async () => { throw new Error("the try server must never call the model on its own"); },
  } as unknown as LanguageModel;
}

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** refine.test.ts's mock BYO model: ONE scripted generateObject answer, with
 *  the prompts captured so tests can assert the panel message rode in as the
 *  interview. `onCall` is the concurrency test's gate seam. */
function proposalModel(
  proposals: RefineProposals,
  onCall?: () => Promise<void>,
): LanguageModel & { prompts: string[] } {
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (request) => {
      const last = request.prompt[request.prompt.length - 1];
      const content = last !== undefined && Array.isArray(last.content) ? last.content : [];
      prompts.push(content
        .filter((part): part is { type: "text"; text: string } => (part as { type: string }).type === "text")
        .map((part) => part.text)
        .join(""));
      await onCall?.();
      return {
        content: [{ type: "text", text: JSON.stringify(proposals) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
  }) as LanguageModel & { prompts: string[] };
  (model as { prompts: string[] }).prompts = prompts;
  return model;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Read SSE frames off a fetch body until `count` data frames (and
 *  `minComments` comment frames) arrived. */
async function readDataFrames(
  body: ReadableStream<Uint8Array>,
  count: number,
  minComments = 0,
): Promise<{ data: TryEvent[]; comments: string[] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const data: TryEvent[] = [];
  const comments: string[] = [];
  try {
    while (data.length < count || comments.length < minComments) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let boundary = buffered.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (frame.startsWith("data: ")) data.push(JSON.parse(frame.slice("data: ".length)) as TryEvent);
        else if (frame.startsWith(":")) comments.push(frame);
        boundary = buffered.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { data, comments };
}

describe("startTryServer profile endpoint", () => {
  it("serves the profile from CURRENT disk state and re-reflects artifacts landing between requests", async () => {
    const { repoRoot, profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, repoRoot, env: {} });

    const first = await fetchProfile(server);
    expect(first.venue).toBe("local");
    expect(first.tools.list.map((tool) => tool.name)).toContain("host_invoices_list");
    expect(first.usecases).toEqual([]);
    // env {} → the model ladder resolves unavailable → liveChat honestly false;
    // refine defaults false until Task 11 turns it on.
    expect(first.capabilities).toEqual({ liveChat: false, refine: false });

    // Deepening lands usecases.json between requests — no restart, no cache.
    await write(profileRoot, ".vendo/data/extract/usecases.json", JSON.stringify({
      format: VENDO_USECASES_FORMAT,
      usecases: [{ label: "Overdue invoices", prompt: "Show my overdue invoices" }],
    }));
    const second = await fetchProfile(server);
    expect(second.usecases).toEqual([{ label: "Overdue invoices", prompt: "Show my overdue invoices" }]);
    expect(second.depth.stages["usecases"]).toBe("done");
  });

  it("reports liveChat true when the caller supplies a model, and threads venue/brand options", async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({
      profileRoot,
      model: stubModel(),
      brand: { name: "Maple" },
      env: {},
    });

    const profile = await fetchProfile(server);
    expect(profile.capabilities.liveChat).toBe(true);
    expect(profile.brand.name).toBe("Maple");
  });
});

describe("startTryServer shell", () => {
  it("injects window.__VENDO_TRY__ into / and serves the playground bundle", async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, env: {} });

    const home = await fetch(server.url);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain(
      'window.__VENDO_TRY__ = {"profileUrl":"/profile.json","eventsUrl":"/events","apiBase":"/api/vendo"}',
    );
    expect(html).toContain('src="/playground.js');

    const bundle = await fetch(`${server.url}/playground.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");

    expect((await fetch(`${server.url}/favicon.ico`)).status).toBe(204);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  });
});

describe("startTryServer events (SSE)", () => {
  it("streams bus emissions to a connected client, with heartbeats, and closes cleanly", async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, env: {}, heartbeatIntervalMs: 20 });

    const stream = await fetch(`${server.url}/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    server.events.emit({ type: "stage", stage: "usecases", status: "done" });
    // The injectable heartbeat interval is tiny here, so keep reading until a
    // heartbeat comment frame arrives alongside the data frame.
    const { data, comments } = await readDataFrames(stream.body!, 1, 1);
    expect(data[0]).toEqual({ type: "stage", stage: "usecases", status: "done" });
    expect(comments[0]).toBe(": heartbeat");

    await server.close();
  });

  it("flushes SSE headers immediately: an idle stream (no events, distant heartbeat) still answers", async () => {
    const { profileRoot } = await extractedProfile();
    // Nothing ever emitted and the first heartbeat is a minute away — without
    // an explicit header flush, Node would hold the response head until the
    // first body write and this fetch would hang past the timeout.
    const server = await serve({ profileRoot, env: {}, heartbeatIntervalMs: 60_000 });

    const stream = await fetch(`${server.url}/events`, { signal: AbortSignal.timeout(2_000) });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();

    await server.close();
  });

  it("replays latest-known state to a late subscriber and overrides profile stage statuses", async () => {
    const { profileRoot } = await extractedProfile();
    const bus = createTryEventBus();
    const server = await serve({ profileRoot, env: {}, events: bus });

    // Emitted BEFORE any client connects — and superseded once for the same stage.
    bus.emit({ type: "stage", stage: "usecases", status: "pending" });
    bus.emit({ type: "stage", stage: "usecases", status: "failed" });
    bus.emit({ type: "stage", stage: "fixtures", status: "skipped" });

    const late = await fetch(`${server.url}/events`);
    const { data } = await readDataFrames(late.body!, 2);
    expect(data).toEqual([
      { type: "stage", stage: "usecases", status: "failed" },
      { type: "stage", stage: "fixtures", status: "skipped" },
    ]);

    // The bus's latest-known statuses win over the disk-derived defaults.
    const profile = await fetchProfile(server);
    expect(profile.depth.stages["usecases"]).toBe("failed");
    expect(profile.depth.stages["fixtures"]).toBe("skipped");
    expect(profile.depth.stages["tools"]).toBe("done");

    await server.close();
  });
});

describe("startTryServer /api/vendo mount", () => {
  it("answers the wire's cheapest endpoint (GET /status) through a real composition", { timeout: 60_000 }, async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, env: {} });

    const response = await fetch(`${server.url}/api/vendo/status`);
    expect(response.status).toBe(200);
    const body = await response.json() as { posture: string; blocks: Record<string, unknown> };
    expect(body.blocks["store"]).toBe(true);
    expect(body.blocks["agent"]).toBe(true);
  });

  it("reports a configured guard posture (never \"unconfigured\") once the deterministic pass has run — the demo policy.json it always leaves behind silences the \"running without a policy\" banner", { timeout: 60_000 }, async () => {
    // extractedProfile() runs the SAME runDeterministicPass a real `npx vendo
    // try` does; this host fixture carries no .vendo/policy.json of its own,
    // so the temp profile gets the honest permissive demo policy.
    const { profileRoot } = await extractedProfile();

    const vendo = await composeTryVendo({ profileRoot });
    try {
      expect(vendo.guard.status().posture).not.toBe("unconfigured");
      expect(vendo.guard.status().posture).toBe("rules");
    } finally {
      await vendo.store.close();
    }
  });

  it("honors the HOST's own carried-over policy.json — a real rule change, not just a cosmetic posture flip", { timeout: 60_000 }, async () => {
    const { repoRoot, profileRoot } = await extractedProfile();
    // A rule this fixture's default posture would never produce on its own
    // (blocking this exact tool outright) — proof the guard is reading the
    // CARRIED file's rules, not falling back to its own default.
    await write(repoRoot, ".vendo/policy.json", JSON.stringify({
      format: "vendo/policy@1",
      rules: [{ match: { tool: "host_invoices_list" }, action: "block", note: "host lockdown" }],
    }));
    // Re-run the pass into the SAME profileRoot the way `vendo try` would on
    // a fresh boot — the carry-over reads repoRoot, not a stale profileRoot.
    await runDeterministicPass({ repoRoot, profileRoot });

    const vendo = await composeTryVendo({ profileRoot });
    try {
      expect(vendo.guard.status().posture).toBe("rules");
      // A validated wire request teaches the same-origin baseUrl default the
      // route-binding executor joins paths against (server.ts onRequestOrigin) —
      // same priming the synthetic-fetch test above uses before calling
      // vendo.actions.execute directly.
      await vendo.handler(new Request("http://127.0.0.1/api/vendo/status"));
      // guardedTools (not the raw `actions` registry) is the guard-bound
      // execution path chat/apps/automations actually ride — see Vendo's own
      // guardedTools doc comment.
      const outcome = await vendo.guardedTools.execute(
        { id: "call_policy_check", tool: "host_invoices_list", args: {} },
        { principal: { kind: "user", subject: "try_user" }, venue: "chat", presence: "present", sessionId: "session_try" },
      );
      expect(outcome).toMatchObject({ status: "blocked", reason: "host lockdown" });
    } finally {
      await vendo.store.close();
    }
  });

  it("executes host route tools through the synthetic fetch (composition-level: the wire's only no-inference tool paths are bearer/model-gated)", { timeout: 60_000 }, async () => {
    const { profileRoot } = await extractedProfile();
    await write(profileRoot, ".vendo/data/extract/fixtures.json", JSON.stringify({
      format: VENDO_FIXTURES_FORMAT,
      fixtures: { host_invoices_list: [{ id: "inv_1", total: 4200 }] },
    }));

    const vendo = await composeTryVendo({ profileRoot });
    try {
      // A validated wire request teaches the same-origin baseUrl default the
      // route-binding executor joins paths against (server.ts onRequestOrigin).
      const status = await vendo.handler(new Request("http://127.0.0.1/api/vendo/status"));
      expect(status.status).toBe(200);

      const outcome = await vendo.actions.execute(
        { id: "call_try_synthetic", tool: "host_invoices_list", args: {} },
        { principal: { kind: "user", subject: "try_user" }, venue: "chat", presence: "present", sessionId: "session_try" },
      );
      expect(outcome.status).toBe("ok");
      // The fixture rows came back: the host request was answered by the
      // synthetic fetch, not the (not-running) host API.
      expect(outcome.output).toEqual([{ id: "inv_1", total: 4200 }]);
    } finally {
      await vendo.store.close();
    }
  });

  it("resolves a GENERATED APP's query bindings through the synthetic fetch (the same fixture rows the chat tool path gets)", { timeout: 60_000 }, async () => {
    const { simulateReadableStream } = await import("ai/test");
    const { profileRoot } = await extractedProfile();
    await write(profileRoot, ".vendo/data/extract/fixtures.json", JSON.stringify({
      format: VENDO_FIXTURES_FORMAT,
      fixtures: { host_invoices_list: [{ id: "inv_1", total: 4200 }] },
    }));
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    // One-shot valid wire: a Query bound to the real extracted tool, and a
    // Table whose `rows` prop binds the WHOLE query result (Law 1 — a real
    // $path binding, never a literal).
    const wire = '<App name="Invoices board"><Query id="invoices" tool="host_invoices_list"/>'
      + '<Table rows={invoices}/></App>';
    const model = {
      specificationVersion: "v2" as const,
      provider: "vendo-scripted",
      modelId: "vendo-scripted-v1",
      supportedUrls: {},
      async doStream() {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: wire },
              { type: "text-end" as const, id: "t1" },
              { type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: undefined } },
            ],
          }),
        };
      },
    } as unknown as LanguageModel;

    const vendo = await composeTryVendo({ profileRoot, model });
    try {
      // THROUGH THE WIRE, like the real try surface: POST /apps to create,
      // GET /apps/:id/open to read the rendered tree — never the runtime
      // methods called directly (that bypasses onRequestOrigin's baseUrl
      // learning entirely, which is not what a browser client does).
      const createResponse = await vendo.handler(new Request("http://127.0.0.1/api/vendo/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Build an invoices board" }),
      }));
      expect(createResponse.status).toBe(200);
      const created = await createResponse.json() as { id: string };
      // The SAME anon principal must carry into the open() poll — an app is
      // owner-scoped, and the anon session rides the Set-Cookie the create
      // response minted.
      const anonCookie = createResponse.headers.getSetCookie()[0];

      const openResponse = await vendo.handler(new Request(`http://127.0.0.1/api/vendo/apps/${created.id}/open`, {
        headers: anonCookie === undefined ? {} : { cookie: anonCookie.split(";")[0]! },
      }));
      expect(openResponse.status).toBe(200);
      const opened = await openResponse.json() as { kind: string; payload?: { data?: { invoices?: unknown } } };
      expect(opened.kind).toBe("tree");
      // The app's own data binding resolved through the SAME synthetic
      // fixture rows the chat tool-call path gets in the test above — one
      // mechanism, no special-case data for the app-data path.
      expect(opened.payload?.data?.invoices).toEqual([{ id: "inv_1", total: 4200 }]);
    } finally {
      await vendo.store.close();
    }
  });

  it("rebuilds the mount when compose-time artifacts change: the next turn sees NEW fixture rows and the landed brief", { timeout: 60_000 }, async () => {
    const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
    const usage = {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    };
    // Each POST /threads turn is two model calls: a host tool call, then the
    // closing text — scripted, so the server never needs a real key.
    let calls = 0;
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        calls += 1;
        prompts.push(structuredClone(prompt));
        const chunks = calls % 2 === 1
          ? [
              { type: "tool-call" as const, toolCallId: `call_${calls}`, toolName: "host_invoices_list", input: "{}" },
              { type: "finish" as const, usage, finishReason: { unified: "tool-calls" as const, raw: undefined } },
            ]
          : [
              { type: "text-start" as const, id: `t${calls}` },
              { type: "text-delta" as const, id: `t${calls}`, delta: "Done." },
              { type: "text-end" as const, id: `t${calls}` },
              { type: "finish" as const, usage, finishReason: { unified: "stop" as const, raw: undefined } },
            ];
        return { stream: simulateReadableStream({ chunks }) };
      },
    });

    const { profileRoot } = await extractedProfile();
    await write(profileRoot, ".vendo/data/extract/fixtures.json", JSON.stringify({
      format: VENDO_FIXTURES_FORMAT,
      fixtures: { host_invoices_list: [{ id: "inv_first" }] },
    }));
    const server = await serve({ profileRoot, env: {}, model: model as unknown as LanguageModel });
    const turn = async (threadId: string): Promise<string> => {
      const response = await fetch(`${server.url}/api/vendo/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          message: { id: `msg_${threadId}`, role: "user", parts: [{ type: "text", text: "List invoices" }] },
        }),
      });
      expect(response.status).toBe(200);
      return await response.text();
    };

    // First composition: the tool result streamed back carries the v1 rows.
    expect(await turn("thr_rebuild_1")).toContain("inv_first");

    // Deepening lands NEW fixtures and the brief between requests.
    await write(profileRoot, ".vendo/data/extract/fixtures.json", JSON.stringify({
      format: VENDO_FIXTURES_FORMAT,
      fixtures: { host_invoices_list: [{ id: "inv_second" }] },
    }));
    await write(profileRoot, ".vendo/brief.md", "Maple is a neobank for freelancers.\n");

    const second = await turn("thr_rebuild_2");
    expect(second).toContain("inv_second");
    expect(second).not.toContain("inv_first");
    // The rebuilt composition also re-read brief.md into the system prompt —
    // the whole compose-time read set refreshes, not just fixtures.
    expect(JSON.stringify(prompts[2])).toContain("Maple is a neobank for freelancers.");
  });

  it("recovers /api/vendo after the profile is repaired: a failed composition is retried, never terminal", { timeout: 60_000 }, async () => {
    const profileRoot = await tempDir("vendo-try-server-repair-");
    await write(profileRoot, ".vendo/try-store", "not a directory\n");
    const server = await serve({ profileRoot, env: {}, heartbeatIntervalMs: 20 });

    expect((await fetch(`${server.url}/api/vendo/status`)).status).toBe(503);

    // Repair: the blocking file goes away (state OUTSIDE the keyed artifact
    // set — recovery must not depend on a keyed file ever changing).
    await rm(join(profileRoot, ".vendo", "try-store"));
    expect((await fetch(`${server.url}/api/vendo/status`)).status).toBe(200);
  });

  it("degrades to 503 JSON naming the composition error while /, /profile.json, /events still paint", { timeout: 60_000 }, async () => {
    const profileRoot = await tempDir("vendo-try-server-corrupt-");
    // A FILE where the try store's PGlite data directory must go: composing
    // the vendo instance over this profile root fails, nothing else does.
    await write(profileRoot, ".vendo/try-store", "not a directory\n");
    // A short heartbeat so cancelling the /events probe below doesn't sit out
    // a full default heartbeat interval (undici resolves cancel on the next
    // server write).
    const server = await serve({ profileRoot, env: {}, heartbeatIntervalMs: 20 });

    const api = await fetch(`${server.url}/api/vendo/status`);
    expect(api.status).toBe(503);
    const body = await api.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("composition-failed");
    expect(body.error.message).toMatch(/try-store/);

    expect((await fetch(server.url)).status).toBe(200);
    expect((await fetchProfile(server)).depth.level).toBe("shallow");
    const events = await fetch(`${server.url}/events`);
    expect(events.status).toBe(200);
    await events.body?.cancel();
  });
});

describe("startTryServer refine endpoints", () => {
  it("turns a correction into projected review changes, applies approved ones to the TEMP profile, and the next profile reflects them", { timeout: 60_000 }, async () => {
    const { repoRoot, profileRoot } = await extractedProfile();
    const before = await inventory(repoRoot);
    const model = proposalModel({
      compounds: [{
        name: "host_invoice_digest",
        description: "Summarize recent invoices",
        inputSchema: { type: "object" },
        steps: [{ id: "list", tool: "host_invoices_list" }],
      }],
      curation: [{ tool: "host_invoices_list", disabled: true, reason: "too risky for the demo" }],
    });
    const server = await serve({ profileRoot, repoRoot, model, env: {} });

    // Task 11 flips the capability on: model resolved AND tools.json present.
    expect((await fetchProfile(server)).capabilities).toEqual({ liveChat: true, refine: true });

    const run = await postJson(`${server.url}/api/refine`, { message: "that invoices tool is riskier than it looks — disable it" });
    expect(run.status).toBe(200);
    const result = run.body as {
      runId: string;
      changes: Array<{ id: number; file: string; summary: string; diff: string; warnings: string[] }>;
      dropped: unknown[];
      probes: Array<{ tool: string; status: string }>;
    };
    // v3 profile (post-#568): the compound AND the correction fold into the
    // ONE authored file, overrides.json — a single reviewable change.
    expect(result.changes.map((change) => ({ id: change.id, file: change.file }))).toEqual([
      { id: 0, file: ".vendo/overrides.json" },
    ]);
    expect(result.changes[0]!.summary).not.toBe("");
    expect(result.changes[0]!.diff).toContain("+++ b/.vendo/overrides.json");
    expect(result.changes[0]!.diff).toContain('"disabled": true');
    expect(result.changes[0]!.diff).toContain("host_invoice_digest");
    // The panel message rode into the engine as the interview leg.
    expect(model.prompts[0]).toContain("riskier than it looks");
    // No url → the probe NEVER fabricates a live check: static-only, with
    // every check honestly reporting static validation.
    expect(result.probes).toHaveLength(1);
    expect(result.probes[0]!.tool).toBe("host_invoice_digest");
    expect(result.probes[0]!.status).toBe("static-only");
    for (const check of (result.probes[0] as { checks: Array<{ ok: boolean; detail: string }> }).checks) {
      expect(check.ok).toBe(true);
      expect(check.detail).toContain("validated statically");
    }

    // Approve the folded overrides change; it lands in the TEMP profile only.
    const apply = await postJson(`${server.url}/api/refine/apply`, { runId: result.runId, changeIds: [0] });
    expect(apply.status).toBe(200);
    expect(apply.body).toEqual({ applied: [{ id: 0, file: ".vendo/overrides.json" }] });

    const profile = await fetchProfile(server);
    expect(profile.tools.list.find((tool) => tool.name === "host_invoices_list")?.disabled).toBe(true);
    expect(profile.tools.counts.enabled).toBe(profile.tools.counts.total - 1);
    const written = JSON.parse(await readFile(join(profileRoot, ".vendo", "overrides.json"), "utf8")) as {
      tools: Record<string, { disabled?: boolean }>;
      compounds?: Array<{ name: string }>;
    };
    expect(written.tools["host_invoices_list"]?.disabled).toBe(true);
    // The compound rode the same v3 file — capabilities.json is never written.
    expect(written.compounds?.map((compound) => compound.name)).toEqual(["host_invoice_digest"]);
    await expect(readFile(join(profileRoot, ".vendo", "capabilities.json"), "utf8")).rejects.toThrow();

    // The zero-commit guarantee holds across the whole refine round trip.
    expect(await inventory(repoRoot)).toEqual(before);
  });

  it("answers 409 to a second concurrent run: one refine at a time", { timeout: 60_000 }, async () => {
    let releaseRun!: () => void;
    const gate = new Promise<void>((resolveGate) => { releaseRun = resolveGate; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
    const model = proposalModel({}, async () => {
      signalStarted();
      await gate;
    });
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, model, env: {} });

    const first = postJson(`${server.url}/api/refine`, { message: "first correction" });
    await started;
    const second = await postJson(`${server.url}/api/refine`, { message: "second correction" });
    expect(second.status).toBe(409);
    releaseRun();
    expect((await first).status).toBe(200);
  });

  it("stays honest keyless: capabilities.refine false and POST /api/refine answers 503, never a fake run", { timeout: 60_000 }, async () => {
    const { profileRoot } = await extractedProfile();
    const server = await serve({ profileRoot, env: {} });

    expect((await fetchProfile(server)).capabilities).toEqual({ liveChat: false, refine: false });
    const response = await postJson(`${server.url}/api/refine`, { message: "disable the delete tools" });
    expect(response.status).toBe(503);
  });

  it("reports refine false without tools.json even when a model resolved (runRefine's hard input)", async () => {
    const profileRoot = await tempDir("vendo-try-server-notools-");
    const server = await serve({ profileRoot, model: stubModel(), env: {} });
    expect((await fetchProfile(server)).capabilities).toEqual({ liveChat: true, refine: false });
  });

  it("guards the lanes: blank message 400, apply with no run 404, stale run 404, unknown change id 400", { timeout: 60_000 }, async () => {
    const { profileRoot } = await extractedProfile();
    const model = proposalModel({ curation: [{ tool: "host_invoices_list", disabled: true }] });
    const server = await serve({ profileRoot, model, env: {} });

    expect((await postJson(`${server.url}/api/refine`, { message: "   " })).status).toBe(400);
    expect((await postJson(`${server.url}/api/refine/apply`, { changeIds: [0] })).status).toBe(404);

    const run = await postJson(`${server.url}/api/refine`, { message: "disable the invoices tool" });
    expect(run.status).toBe(200);
    const runId = (run.body as { runId: string }).runId;
    expect((await postJson(`${server.url}/api/refine/apply`, { runId: "run_999", changeIds: [0] })).status).toBe(404);
    expect((await postJson(`${server.url}/api/refine/apply`, { runId, changeIds: [7] })).status).toBe(400);
    expect((await postJson(`${server.url}/api/refine/apply`, { runId, changeIds: "0" })).status).toBe(400);
  });
});

describe("startTryServer zero-commit contract", () => {
  it("never writes a byte under repoRoot across serving, SSE, and the vendo mount", { timeout: 60_000 }, async () => {
    const repoRoot = await nextFixture();
    const profileRoot = await tempDir("vendo-try-server-profile-");
    await runDeterministicPass({ repoRoot, profileRoot });
    const before = await inventory(repoRoot);

    const server = await serve({ profileRoot, repoRoot, env: {} });
    await fetch(server.url);
    await fetchProfile(server);
    server.events.emit({ type: "stage", stage: "brief", status: "pending" });
    const events = await fetch(`${server.url}/events`);
    await readDataFrames(events.body!, 1);
    // The mount composes a real store — its PGlite data dir must land under
    // profileRoot, never the repo (and never the cwd).
    expect((await fetch(`${server.url}/api/vendo/status`)).status).toBe(200);
    await server.close();

    expect(await inventory(repoRoot)).toEqual(before);
  });
});
