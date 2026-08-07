import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostOAuthAdapter } from "@vendoai/mcp";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type CreateVendoConfig, type Vendo } from "../server.js";
import { runDoctor } from "./doctor.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
}, 180_000);

async function write(root: string, relative: string, body: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}

describe("vendo doctor MCP discovery live", () => {
  it("validates server.json against a real composed door", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-doctor-live-host-"));
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-doctor-live-store-"));
    const store = createStore({ dataDir });
    const oauth: HostOAuthAdapter = {
      async authorize() { return { subject: "doctor-user" }; },
      async principal(subject) { return { kind: "user", subject }; },
    };
    let vendo: Vendo | undefined;
    const server = createServer((request, response) => {
      if (vendo === undefined) {
        response.statusCode = 503;
        response.end("Vendo is starting");
        return;
      }
      const host = request.headers.host ?? "127.0.0.1";
      void vendo.handler(new Request(`http://${host}${request.url ?? "/"}`, {
        method: request.method,
        headers: request.headers as Record<string, string>,
      })).then(async (result) => {
        response.statusCode = result.status;
        result.headers.forEach((value, name) => response.setHeader(name, value));
        response.end(Buffer.from(await result.arrayBuffer()));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    // createVendo reads VENDO_BASE_URL at composition time; the doctor present
    // probe only passes when the fixture origin is the trusted host origin.
    vi.stubEnv("VENDO_BASE_URL", origin);
    const minted = new Map<string, string>();
    vendo = createVendo({
      model: {} as unknown as CreateVendoConfig["model"],
      principal: async (request) => ({
        kind: "user",
        subject: minted.get(request.headers.get("authorization") ?? "") ?? "doctor-user",
      }),
      actAs: async (principal) => {
        const token = `Bearer doctor-${principal.subject}`;
        minted.set(token, principal.subject);
        return { headers: { authorization: token } };
      },
      store,
      mcp: true,
      oauth,
      // Light the execution venue deterministically (independent of local
      // E2B/Modal env keys) so doctor reports no venue warning here.
      sandbox: {
        create: async () => { throw new Error("not used by doctor"); },
        resume: async () => { throw new Error("not used by doctor"); },
      },
    });
    cleanup.push(async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await store.close();
      await rm(root, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    });

    await write(root, "package.json", JSON.stringify({
      dependencies: { "@vendoai/vendo": "0.3.0", next: "16" },
    }));
    await write(root, "app/layout.tsx", "export default ({children}) => <VendoRoot>{children}<VendoOverlay /></VendoRoot>;");
    await write(root, "app/api/vendo/[...vendo]/route.ts", "export const GET = () => {};\n");
    for (const file of ["tools.json", "overrides.json", "policy.json", "brief.md", "theme.json"]) {
      await write(root, `.vendo/${file}`, "{}\n");
    }
    await write(root, ".vendo/data/.gitignore", "*\n");
    await write(root, "server.json", JSON.stringify({
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      name: "1.0.0.127/fixture",
      description: "Live doctor fixture",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: `${origin}/api/vendo/mcp` }],
    }));

    const logs: string[] = [];
    const errors: string[] = [];
    expect(await runDoctor({
      targetDir: root,
      url: `${origin}/api/vendo`,
      output: { log: (message) => logs.push(message), error: (message) => errors.push(message) },
      telemetry: { env: { VENDO_TELEMETRY_DISABLED: "1" } },
      // This test proves MCP discovery, not the model turn (the fixture uses a
      // stub model). Stub doctor v2's live surface so the discovery checks stay
      // the subject.
      interactive: false,
      liveTurn: async () => ({ attempted: true, ok: true, rung: "env-key", credential: "stub", reply: "ok", elapsedMs: 1 }),
      cloudProbe: async () => ({ present: false, ok: false, unlocks: ["x"] }),
    })).toBe(0);
    expect(errors).toEqual([]);
    expect(logs).toContain("ok: server.json remote agrees with the live MCP door");
  }, 180_000);
});
