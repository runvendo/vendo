import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../sync.js";
import { pushHostComponents, readPushComponents } from "./host-components.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

const report = () => ({
  tools: { added: [], removed: [], changed: [] },
  breaking: [],
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 1, registered: 1 },
  components: { captured: ["Donut"], drifted: [] },
  warnings: [],
});

const hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A `.vendo/components/` corpus: two components sharing one helper module. */
async function corpus(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-push-components-"));
  roots.push(root);
  const dir = join(root, ".vendo/components");
  await mkdir(join(dir, "modules"), { recursive: true });
  const shared = hex("shared");
  const entry = hex("entry");
  for (const [ref, body] of [[shared, "shared"], [entry, "entry"]] as const) {
    await writeFile(join(dir, "modules", `${ref}.json`), JSON.stringify({ source: body }), "utf8");
  }
  for (const name of ["Donut", "Sparkline"]) {
    await writeFile(join(dir, `${name}.json`), JSON.stringify({
      name,
      hash: `sha256:${hex(name)}`,
      capturedAt: "2026-08-02T00:00:00.000Z",
      module: "src/vendo/registry.tsx",
      export: name,
      entry,
      modules: { "src/lib/format.ts": shared },
    }), "utf8");
  }
  return root;
}

/** The console store wire, as a fake: blob keys, blob bodies, and rows. */
function fakeCloud(seed: { blobs?: string[]; records?: Array<{ id: string; hash: string }> } = {}) {
  const blobs = new Set(seed.blobs ?? []);
  const records = new Map((seed.records ?? []).map((row) => [row.id, row.hash]));
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/blobs/vendo_host_components")) return json({ keys: [...blobs] });
    const blob = /\/blobs\/vendo_host_components\/([0-9a-f]{64})$/u.exec(url.pathname);
    if (blob !== null) {
      if (method === "PUT") blobs.add(blob[1]!);
      if (method === "DELETE") blobs.delete(blob[1]!);
      return json({});
    }
    if (url.pathname.endsWith("/records/vendo_host_components/list")) {
      return json({
        records: [...records].map(([id, hash]) => ({
          id,
          data: { name: id, hash, capturedAt: "2026-08-02T00:00:00.000Z", module: "src/vendo/registry.tsx" },
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        })),
      });
    }
    if (url.pathname.endsWith("/records/vendo_host_components/put")) {
      const record = (JSON.parse(String(init?.body)) as { record: { id: string; data: { hash: string } } }).record;
      records.set(record.id, record.data.hash);
      return json({ record: { ...record, createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" } });
    }
    if (url.pathname.endsWith("/records/vendo_host_components/delete")) {
      records.delete((JSON.parse(String(init?.body)) as { id: string }).id);
      return json({});
    }
    return json({ records: [] });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, blobs, records };
}

describe("host component push", () => {
  it("uploads each shared module once and only the records Cloud is missing", async () => {
    const root = await corpus();
    const cloud = fakeCloud();

    const first = await pushHostComponents({
      vendoDir: join(root, ".vendo"),
      apiKey: "vendo_key",
      baseUrl: "https://cloud.test",
      fetchImpl: cloud.fetchImpl,
    });

    expect(first.pushed).toEqual(["Donut", "Sparkline"]);
    // Two components, one entry module and one shared helper — two blobs, not four.
    expect(first.modules.uploaded).toBe(2);
    expect(first.error).toBeUndefined();
  });

  it("a second sync compares hashes over a keys-only manifest and uploads nothing", async () => {
    const root = await corpus();
    const cloud = fakeCloud({
      blobs: [hex("shared"), hex("entry")],
      records: [{ id: "Donut", hash: `sha256:${hex("Donut")}` }, { id: "Sparkline", hash: `sha256:${hex("Sparkline")}` }],
    });

    const result = await pushHostComponents({
      vendoDir: join(root, ".vendo"),
      apiKey: "vendo_key",
      baseUrl: "https://cloud.test",
      fetchImpl: cloud.fetchImpl,
    });

    expect(result).toMatchObject({ pushed: [], pruned: [], modules: { uploaded: 0, deleted: 0 }, uploadedBytes: 0 });
    // The whole round trip: list the blob KEYS, list the (source-free) index.
    // No module body is ever downloaded to decide what changed.
    expect(cloud.calls).toEqual([
      "GET /api/v1/store/blobs/vendo_host_components",
      "POST /api/v1/store/records/vendo_host_components/list",
    ]);
  });

  it("deletes a stale record and only then the module nothing references", async () => {
    const root = await corpus();
    await rm(join(root, ".vendo/components/Sparkline.json"));
    const orphan = hex("orphan");
    const cloud = fakeCloud({
      blobs: [hex("shared"), hex("entry"), orphan],
      records: [{ id: "Donut", hash: `sha256:${hex("Donut")}` }, { id: "Gone", hash: "sha256:x" }, { id: "Sparkline", hash: `sha256:${hex("Sparkline")}` }],
    });

    const result = await pushHostComponents({
      vendoDir: join(root, ".vendo"),
      apiKey: "vendo_key",
      baseUrl: "https://cloud.test",
      fetchImpl: cloud.fetchImpl,
    });

    expect(result.pruned).toEqual(["Gone", "Sparkline"]);
    expect(result.modules.deleted).toBe(1);
    // The helper Donut still imports survived its other importer's deletion.
    expect([...cloud.blobs].sort()).toEqual([hex("entry"), hex("shared")].sort());
  });
});

describe("host component push consent", () => {
  it("asks once, saves the project's answer, and is silent after", async () => {
    const root = await corpus();
    const cloud = fakeCloud();
    const confirm = vi.fn(async () => true);
    const options = {
      targetDir: root,
      apiKey: "vendo_key",
      apiUrl: "https://cloud.test",
      interactive: true,
      ai: false as const,
      output: { log() {}, error() {} },
      fetchImpl: cloud.fetchImpl,
      sync: async () => report(),
      confirm,
    };

    expect(await runSync(options)).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(await readPushComponents(join(root, ".vendo"))).toBe(true);

    confirm.mockClear();
    expect(await runSync(options)).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("--no-push-components keeps the corpus local without asking or saving", async () => {
    const root = await corpus();
    const cloud = fakeCloud();
    const confirm = vi.fn(async () => true);

    expect(await runSync({
      targetDir: root,
      apiKey: "vendo_key",
      apiUrl: "https://cloud.test",
      interactive: true,
      ai: false,
      pushComponents: false,
      output: { log() {}, error() {} },
      fetchImpl: cloud.fetchImpl,
      sync: async () => report(),
      confirm,
    })).toBe(0);

    expect(confirm).not.toHaveBeenCalled();
    expect(await readPushComponents(join(root, ".vendo"))).toBeUndefined();
    expect(cloud.calls).toEqual([]);
  });

  it("keyless makes no network call at all — the tripwire", async () => {
    const root = await corpus();
    // Any request from a keyless run fails this test loudly.
    const tripwire = vi.fn(async (input: RequestInfo | URL) => {
      throw new Error(`keyless sync must not reach the network: ${String(input)}`);
    }) as unknown as typeof fetch;
    vi.stubEnv("VENDO_API_KEY", "");

    expect(await runSync({
      targetDir: root,
      interactive: true,
      ai: false,
      // No apiKey and no VENDO_API_KEY: BYO. The saved YES must not matter.
      pushComponents: true,
      output: { log() {}, error() {} },
      fetchImpl: tripwire,
      sync: async () => report(),
      confirm: async () => true,
    })).toBe(0);

    expect(tripwire).not.toHaveBeenCalled();
  });
});
