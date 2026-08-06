import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  KNOWLEDGE_WIRE_PATHS,
  VENDO_KNOWLEDGE_WIRE_FORMAT,
  knowledgeWireRemoveRequestSchema,
  knowledgeWireSearchRequestSchema,
  knowledgeWireUpsertRequestSchema,
  type KnowledgeAdapter,
} from "@vendoai/core";
import { memoryKnowledgeAdapter } from "@vendoai/core/conformance";
import { cloudKnowledge } from "@vendoai/knowledge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runKnowledge } from "./index.js";
import type { Output } from "../shared.js";

/**
 * ENG-363 — `vendo knowledge sync` pushes to the engine the SERVER would use.
 *
 * The seam rule (repo CLAUDE.md): a harness that mocks the counterparty proves
 * nothing. So nothing here is stubbed on either side. The producer is the real
 * CLI resolving the key from the environment and building the real
 * `cloudKnowledge` client; the transport is real HTTP over a real listening
 * socket; the consumer is core's own `vendo/knowledge-wire@1` request schemas
 * over the real `memoryKnowledgeAdapter`. Read-back goes out through the same
 * wire, so the producer and the consumer CAN disagree — which is the point.
 */

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vendo-knowledge-sync-"));
  dirs.push(dir);
  await mkdir(join(dir, "docs"), { recursive: true });
  await writeFile(join(dir, "docs", "guide.md"), "# Guide\nRefunds take five days.\n");
  await writeFile(join(dir, "docs", "faq.md"), "# FAQ\nAnswers live here.\n");
  return dir;
}

interface WireServer {
  url: string;
  /** Every wire path the CLI actually hit, in order. */
  paths: string[];
  authorizations: Array<string | null>;
  engine: KnowledgeAdapter;
}

/** A real `vendo/knowledge-wire@1` server on a real port, speaking core's
    shipped request schemas over a real adapter. The console mounts the five
    routes under `/api/v1/knowledge`, which is where cloudKnowledge sends. */
async function wireServer(): Promise<WireServer> {
  const engine = memoryKnowledgeAdapter();
  const paths: string[] = [];
  const authorizations: Array<string | null> = [];
  const ctx = { principal: { kind: "user" as const, subject: "user_wire" } };

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw === "" ? undefined : JSON.parse(raw);
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const route = Object.values(KNOWLEDGE_WIRE_PATHS).find((wire) => pathname.endsWith(wire));
      paths.push(route ?? pathname);
      authorizations.push(req.headers.authorization ?? null);

      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (route === KNOWLEDGE_WIRE_PATHS.status) {
        send(200, {
          format: VENDO_KNOWLEDGE_WIRE_FORMAT,
          posture: engine.posture,
          status: await engine.status(),
        });
        return;
      }
      if (route === KNOWLEDGE_WIRE_PATHS.upsert) {
        const parsed = knowledgeWireUpsertRequestSchema.safeParse(body);
        if (!parsed.success) return send(400, { error: { code: "validation", message: "not wire@1" } });
        await engine.upsert!(parsed.data.docs);
        return send(200, {});
      }
      if (route === KNOWLEDGE_WIRE_PATHS.remove) {
        const parsed = knowledgeWireRemoveRequestSchema.safeParse(body);
        if (!parsed.success) return send(400, { error: { code: "validation", message: "not wire@1" } });
        await engine.remove!(parsed.data.docIds);
        return send(200, {});
      }
      if (route === KNOWLEDGE_WIRE_PATHS.search) {
        const parsed = knowledgeWireSearchRequestSchema.safeParse(body);
        if (!parsed.success) return send(400, { error: { code: "validation", message: "not wire@1" } });
        return send(200, await engine.search(parsed.data.query, ctx));
      }
      send(404, { error: { code: "not-found", message: pathname } });
    })();
  });

  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, paths, authorizations, engine };
}

function capture(): { output: Output; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m) => lines.push(m), error: (m) => errors.push(m) }, lines, errors };
}

const manifestOf = (dir: string): Promise<string> =>
  readFile(join(dir, ".vendo", "knowledge-manifest.json"), "utf8");

describe("vendo knowledge sync — engine selection mirrors the server's seam", () => {
  it("with a Cloud key: docs arrive over the real wire and read back through it", async () => {
    const wire = await wireServer();
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });

    vi.stubEnv("VENDO_API_KEY", "vnd_live_key");
    vi.stubEnv("VENDO_CLOUD_URL", wire.url);

    expect(await runKnowledge(["sync", dir], { output: cap.output })).toBe(0);

    // The docs went out over /upsert, carrying the key as a Bearer token.
    expect(wire.paths).toContain(KNOWLEDGE_WIRE_PATHS.upsert);
    expect(wire.authorizations).toContain("Bearer vnd_live_key");

    // READ BACK through the same wire — the producer and consumer are
    // independent, so this is the assertion that a mocked pair could not make.
    const reader = cloudKnowledge({ apiKey: "vnd_live_key", baseUrl: wire.url });
    const found = await reader.search(
      { text: "Refunds take five days", intent: "chat" },
      { principal: { kind: "user", subject: "u1" } },
    );
    expect(found.hits.map((hit) => hit.ref.docId)).toContain("docs#docs/guide.md");

    // The manifest is written only after the engine confirmed.
    expect(JSON.parse(await manifestOf(dir)).docs).toHaveProperty("docs#docs/guide.md");
  });

  it("says Vendo Cloud is the target, in the plan line and the synced line", async () => {
    const wire = await wireServer();
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    vi.stubEnv("VENDO_API_KEY", "vnd_live_key");
    vi.stubEnv("VENDO_CLOUD_URL", wire.url);

    expect(await runKnowledge(["sync", dir], { output: cap.output })).toBe(0);
    const printed = cap.lines.join("\n");
    expect(printed).toMatch(/Plan: .* → Vendo Cloud \(127\.0\.0\.1:\d+\)\./);
    expect(printed).toMatch(/Synced: 2 upserted, 0 removed, 0 unchanged → Vendo Cloud \(127\.0\.0\.1:\d+\)\./);
  });

  it("a dry run names the target it WOULD push to, and pushes nothing", async () => {
    const wire = await wireServer();
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    vi.stubEnv("VENDO_API_KEY", "vnd_live_key");
    vi.stubEnv("VENDO_CLOUD_URL", wire.url);

    expect(await runKnowledge(["sync", dir, "--dry-run"], { output: cap.output })).toBe(0);
    expect(cap.lines.join("\n")).toContain("→ Vendo Cloud (");
    expect(wire.paths).toEqual([]);
    await expect(manifestOf(dir)).rejects.toThrow();
  });

  it("no key: the local store serves, and the output says so", async () => {
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    vi.stubEnv("VENDO_API_KEY", "");
    vi.stubEnv("VENDO_CLOUD_URL", "");

    expect(await runKnowledge(["sync", dir], { output: cap.output })).toBe(0);
    expect(cap.lines.join("\n")).toContain("→ local store (.vendo/data).");
    expect(JSON.parse(await manifestOf(dir)).docs).toHaveProperty("docs#docs/guide.md");
  });

  it("an injected adapter still wins over a Cloud key", async () => {
    const wire = await wireServer();
    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    vi.stubEnv("VENDO_API_KEY", "vnd_live_key");
    vi.stubEnv("VENDO_CLOUD_URL", wire.url);

    const injected = memoryKnowledgeAdapter();
    expect(await runKnowledge(["sync", dir], { output: cap.output, adapter: injected })).toBe(0);
    // Nothing crossed the wire: the explicit adapter is the engine.
    expect(wire.paths).toEqual([]);
    const seen = await injected.search(
      { text: "Refunds take five days", intent: "chat" },
      { principal: { kind: "user", subject: "u1" } },
    );
    expect(seen.hits).toHaveLength(1);
  });

  it("key set but the console is down: fails loudly and leaves the manifest unwritten", async () => {
    // Bind a real port, then close it: the connection refusal is a real one,
    // and the port is guaranteed to be free rather than guessed.
    const dead = await wireServer();
    const port = new URL(dead.url).port;
    const index = servers.findIndex((server) => (server.address() as AddressInfo | null)?.port === Number(port));
    const [closing] = servers.splice(index, 1);
    await new Promise<void>((resolve) => closing!.close(() => resolve()));

    const dir = await tempProject();
    const cap = capture();
    await runKnowledge(["add", "docs/**/*.md", dir], { output: cap.output });
    vi.stubEnv("VENDO_API_KEY", "vnd_live_key");
    vi.stubEnv("VENDO_CLOUD_URL", `http://127.0.0.1:${port}`);

    expect(await runKnowledge(["sync", dir], { output: cap.output })).toBe(1);
    expect(cap.errors.join("\n")).toContain("unreachable");
    await expect(manifestOf(dir)).rejects.toThrow();
  });
});
