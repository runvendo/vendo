import type { RunContext, ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps, type AppsRuntime } from "../index.js";
import type { SandboxAdapter } from "../sandbox.js";
import { guardFixture } from "./guard-fixture.js";
import { memoryStore } from "./memory-store.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "./scripted-model.js";

/**
 * ENG-290 live lanes (apps-block design, locked decision 6): drive rungs 2→3→4
 * through the REAL public runtime (createApps → edit/call/open) against a REAL
 * provider adapter. The model is scripted — the venue behavior under test is
 * the machine lifecycle (write → serve → snapshot → resume → serve), not
 * generation. Gated per provider on its env keys, exactly like the adapter
 * conformance suite; each lane deletes its app so provider machines are
 * stopped even on assertion failure.
 */

const LANE_TIMEOUT_MS = 300_000;

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const ctx = (subject: string): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  sessionId: `session_${subject}`,
});

/** A REAL Node HTTP server (rung 2): POST /fn/total sums its args. */
const rung2ServerSource = `
const http = require("node:http");
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    let args;
    try { args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").args; } catch { args = undefined; }
    if (request.method === "POST" && request.url === "/fn/total") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ result: { total: Number(args?.a ?? 0) + Number(args?.b ?? 0) } }));
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not-found", message: "no such fn" } }));
  });
}).listen(Number(process.env.PORT || 8080));
`;

/** A REAL Node HTTP server (rung 3): POST /fn/dashboard answers a ui envelope. */
const rung3ServerSource = `
const http = require("node:http");
const tree = {
  formatVersion: "vendo-genui/v2",
  root: "root",
  nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: "Server-computed (live)" } }],
};
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (request.method === "POST" && request.url === "/fn/dashboard") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ ui: tree }));
    }
    if (request.method === "POST" && request.url === "/fn/total") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({ result: { total: -1 } }));
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "not-found", message: "no such fn" } }));
  });
}).listen(Number(process.env.PORT || 8080));
`;

const promptText = (call: ScriptedModelCall): string =>
  call.prompt
    .map((message) => typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.text ?? "").join(""))
    .join("\n");

const instructionOf = (text: string): string => /INSTRUCTION:\s*(.*)/.exec(text)?.[1] ?? "";

/** Scripted create → rung-2 → rung-3 → rung-4 ladder with REAL server code. */
const laneModel = () => scriptedLanguageModel((call) => {
  const text = promptText(call);
  if (text.includes("TASK: CREATE_APP")) {
    return JSON.stringify({
      name: "Live ladder app",
      description: "climbs the ladder on a real venue",
      tree: {
        formatVersion: "vendo-genui/v2",
        root: "root",
        nodes: [{ id: "root", component: "Text", source: "prewired", props: { text: "Rung 1 (live)" } }],
      },
    });
  }
  const instruction = instructionOf(text);
  if (instruction.includes("full web app")) {
    // CJS on purpose: a real `node --check` treats bare .js as CommonJS.
    return JSON.stringify({ rung: 4, files: [{ path: "/app/custom.js", content: "exports.custom = 1;" }] });
  }
  if (instruction.includes("computed")) {
    return JSON.stringify({ rung: 3, files: [{ path: "/app/server.js", content: rung3ServerSource }] });
  }
  return JSON.stringify({ rung: 2, files: [{ path: "/app/server.js", content: rung2ServerSource }] });
});

const openUntilHttp = async (
  runtime: AppsRuntime,
  appId: string,
  ada: RunContext,
): Promise<string> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const surface = await runtime.open(appId, ada);
    if (surface.kind === "http") return surface.url;
    expect(surface.kind).toBe("resuming"); // last state, never a broken surface
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("rung-4 machine never started serving through open()");
};

export interface LadderLiveLaneOptions {
  /** The provider's opaque snapshot-ref shape, e.g. /^e2b:v1:/. */
  serverRefPattern: RegExp;
}

/** Env-gated rung-3/4 live lanes shared by the E2B and Modal providers. */
export const ladderLiveLanes = (
  name: string,
  makeAdapter: () => SandboxAdapter | Promise<SandboxAdapter>,
  options: LadderLiveLaneOptions,
): void => {
  describe(`${name} ladder rungs 2–4 through the real runtime`, () => {
    it("climbs rung 2 → 3: fn: calls served by machines resumed from real snapshots", async () => {
      const runtime = createApps({
        store: memoryStore(),
        guard: guardFixture(),
        tools,
        sandbox: await makeAdapter(),
        catalog: [],
        model: laneModel(),
      });
      const ada = ctx("user_live_ladder");
      const created = await runtime.create({ prompt: "Show a greeting" }, ada);
      try {
        expect(created.ui).toBe("tree");
        expect(created.server).toBeUndefined();

        // Rung 2 — the edit must leave a snapshot of a SERVING machine behind.
        const rung2 = await runtime.edit(created.id, "Add a server backend to persist data", ada);
        expect(rung2.issues, rung2.issues?.join("; ")).toBeUndefined();
        expect(rung2.version.rung).toBe(2);
        expect(rung2.app.server).toMatch(options.serverRefPattern);

        // The fn: call resumes that snapshot on the provider and gets a real
        // HTTP answer from the app's own server code.
        await expect(runtime.call(created.id, "fn:total", { a: 2, b: 3 }, ada))
          .resolves.toEqual({ status: "ok", output: { total: 5 } });

        // Rung 3 — the edit forks the serving snapshot; the NEW server code
        // must take effect (the old rung-2 process cannot keep the port).
        const rung3 = await runtime.edit(created.id, "Return a server-computed dashboard tree", ada);
        expect(rung3.issues, rung3.issues?.join("; ")).toBeUndefined();
        expect(rung3.version.rung).toBe(3);
        expect(rung3.app.server).toMatch(options.serverRefPattern);
        expect(rung3.app.server).not.toBe(rung2.app.server);

        const dashboard = await runtime.call(created.id, "fn:dashboard", {}, ada);
        expect(dashboard).toMatchObject({
          status: "ok",
          output: { ui: { formatVersion: "vendo-genui/v2" } },
        });

        // Invisible graduation: open() still answers from the kept tree.
        await expect(runtime.open(created.id, ada)).resolves.toMatchObject({ kind: "tree" });

        // Every transition recorded, newest first.
        await expect(runtime.history(created.id).list())
          .resolves.toMatchObject([{ rung: 3 }, { rung: 2 }]);
      } finally {
        // Stops the cached live machine and clears provider state.
        await runtime.delete(created.id, ada).catch(() => undefined);
      }
    }, LANE_TIMEOUT_MS);

    it("graduates rung 3 → 4: the served scaffold renders the identical kept tree over real HTTP", async () => {
      const runtime = createApps({
        store: memoryStore(),
        guard: guardFixture(),
        tools,
        sandbox: await makeAdapter(),
        catalog: [],
        model: laneModel(),
      });
      const ada = ctx("user_live_graduation");
      const created = await runtime.create({ prompt: "Show a greeting" }, ada);
      try {
        // Climb through a serving rung first so graduation forks a machine
        // whose old server must yield $PORT to the scaffold.
        const rung3 = await runtime.edit(created.id, "Return a server-computed dashboard tree", ada);
        expect(rung3.issues, rung3.issues?.join("; ")).toBeUndefined();

        const graduated = await runtime.edit(created.id, "Turn this into a full web app", ada);
        expect(graduated.issues, graduated.issues?.join("; ")).toBeUndefined();
        expect(graduated.version.rung).toBe(4);
        expect(graduated.app.ui).toBe("http");
        expect(graduated.app.tree).toEqual(created.tree); // kept byte for byte
        expect(graduated.app.server).toMatch(options.serverRefPattern);

        // open() resolves to the machine's real URL once the resume is awake.
        const url = await openUntilHttp(runtime, created.id, ada);
        const served = await fetch(`${url}/tree.json`);
        expect(served.status).toBe(200);
        expect(await served.json()).toEqual(created.tree);
        const page = await fetch(url);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("vendo-served-tree");
      } finally {
        await runtime.delete(created.id, ada).catch(() => undefined);
      }
    }, LANE_TIMEOUT_MS);
  });
};
