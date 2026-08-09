import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "../../../src/cli/sync.js";
import { pushHostComponents, readPushComponents } from "../../../src/cli/cloud/host-components.js";

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
  toolSchemas: { total: 0, inputs: { known: 0, unknown: [] }, outputs: { known: 0, unknown: [] } },
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

/** A stored row as Cloud really holds it — refs included, because the blob
 *  keep-set is derived from exactly these. A stub without them would let a
 *  prune bug pass. `data: null` seeds a row this CLI cannot parse. */
const remoteRow = (id: string, data?: unknown): [string, unknown] => [id, data !== undefined ? data : {
  name: id,
  hash: `sha256:${hex(id)}`,
  capturedAt: "2026-08-02T00:00:00.000Z",
  module: "src/vendo/registry.tsx",
  export: id,
  entry: hex("entry"),
  modules: { "src/lib/format.ts": hex("shared") },
}];

/** The console store wire, as a fake: blob keys, blob bodies, and rows. */
function fakeCloud(seed: { blobs?: string[]; records?: Array<[string, unknown]> } = {}) {
  const blobs = new Set(seed.blobs ?? []);
  const records = new Map<string, unknown>(seed.records ?? []);
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
        records: [...records].map(([id, data]) => ({
          id,
          data,
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
        })),
      });
    }
    if (url.pathname.endsWith("/records/vendo_host_components/put")) {
      const record = (JSON.parse(String(init?.body)) as { record: { id: string; data: unknown } }).record;
      records.set(record.id, record.data);
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

  it("counts BYTES uploaded, not UTF-16 code units — sync prints the number as KB", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-push-utf8-"));
    roots.push(root);
    const dir = join(root, ".vendo/components");
    await mkdir(join(dir, "modules"), { recursive: true });
    const entry = hex("utf8-entry");
    const body = JSON.stringify({ source: "const label = \"café — €10 ✅\";" });
    await writeFile(join(dir, "modules", `${entry}.json`), body, "utf8");
    await writeFile(join(dir, "Widget.json"), JSON.stringify({
      name: "Widget",
      hash: `sha256:${hex("Widget")}`,
      capturedAt: "2026-08-02T00:00:00.000Z",
      module: "src/vendo/registry.tsx",
      export: "Widget",
      entry,
      modules: {},
    }), "utf8");

    const result = await pushHostComponents({
      vendoDir: join(root, ".vendo"),
      apiKey: "vendo_key",
      baseUrl: "https://cloud.test",
      fetchImpl: fakeCloud().fetchImpl,
    });

    expect(result.uploadedBytes).toBe(new TextEncoder().encode(body).length);
    expect(result.uploadedBytes).toBeGreaterThan(body.length);
  });

  it("a second sync compares hashes over a keys-only manifest and uploads nothing", async () => {
    const root = await corpus();
    const cloud = fakeCloud({
      blobs: [hex("shared"), hex("entry")],
      records: [remoteRow("Donut"), remoteRow("Sparkline")],
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
      records: [remoteRow("Donut"), remoteRow("Gone", { name: "Gone", hash: "sha256:gone", capturedAt: "2026-08-02T00:00:00.000Z", module: "x.tsx", entry: hex("orphan") }), remoteRow("Sparkline")],
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

  it("a corrupt local record keeps its Cloud row AND the blobs that row points at", async () => {
    const root = await corpus();
    // A half-written capture on one machine must not gut Cloud. The row is
    // kept (presence, not parseability) — so its bytes must be kept too, or
    // the push reports "left untouched" while leaving a record pointing at a
    // 404, with no path back: the hash still matches so nothing re-pushes, and
    // the module is not readable locally so nothing re-uploads.
    await writeFile(join(root, ".vendo/components/Donut.json"), "{ truncated", "utf8");
    const cloud = fakeCloud({
      blobs: [hex("shared"), hex("entry")],
      records: [remoteRow("Donut"), remoteRow("Sparkline")],
    });

    const result = await pushHostComponents({
      vendoDir: join(root, ".vendo"),
      apiKey: "vendo_key",
      baseUrl: "https://cloud.test",
      fetchImpl: cloud.fetchImpl,
    });

    expect(result.unreadable).toEqual(["Donut"]);
    expect(result.pruned).toEqual([]);
    expect(result.modules.deleted).toBe(0);
    expect([...cloud.records.keys()].sort()).toEqual(["Donut", "Sparkline"]);
    expect([...cloud.blobs].sort()).toEqual([hex("entry"), hex("shared")].sort());
  });

  it("a missing local modules directory deletes nothing in Cloud", async () => {
    const root = await corpus();
    await rm(join(root, ".vendo/components/modules"), { recursive: true, force: true });
    const cloud = fakeCloud({
      blobs: [hex("shared"), hex("entry")],
      records: [remoteRow("Donut"), remoteRow("Sparkline")],
    });

    const result = await pushHostComponents({
      vendoDir: join(root, ".vendo"),
      apiKey: "vendo_key",
      baseUrl: "https://cloud.test",
      fetchImpl: cloud.fetchImpl,
    });

    expect(result.unreadable).toEqual(["Donut", "Sparkline"]);
    expect(result.modules.deleted).toBe(0);
    expect([...cloud.blobs].sort()).toEqual([hex("entry"), hex("shared")].sort());
  });

  it("a kept row this CLI cannot read aborts the blob prune rather than guessing its refs", async () => {
    const root = await corpus();
    const orphan = hex("orphan");
    // Both sides written by a half-broken run: the local file is unreadable
    // (so the row is KEPT, not pruned) and the remote row does not parse (so
    // its references are unknowable). Deleting on a guess here destroys live
    // bytes; the conservative answer is to prune nothing this run.
    await writeFile(join(root, ".vendo/components/Sparkline.json"), "{ truncated", "utf8");
    const cloud = fakeCloud({
      blobs: [hex("shared"), hex("entry"), orphan],
      records: [remoteRow("Donut"), remoteRow("Sparkline", { unreadable: true })],
    });

    const result = await pushHostComponents({
      vendoDir: join(root, ".vendo"),
      apiKey: "vendo_key",
      baseUrl: "https://cloud.test",
      fetchImpl: cloud.fetchImpl,
    });

    expect(result.unreadable).toEqual(["Sparkline"]);
    expect(result.pruned).toEqual([]);
    expect(result.modules.deleted).toBe(0);
    expect(cloud.blobs.has(orphan)).toBe(true);
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
