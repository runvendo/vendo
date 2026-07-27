import { describe, expect, it, vi } from "vitest";
import type { AppDocument, RecordStore, VendoRecord } from "@vendoai/core";
import { chipManifestRowId, type TryThisChip } from "./chips";
import { pregenerate } from "./chips-seed";

const CHIPS: TryThisChip[] = [
  { key: "subs", prompt: "Build me a subscriptions tracker" },
  { key: "dining", prompt: "Where did my dining budget go?" },
];

function memoryRecords(): RecordStore {
  const rows = new Map<string, VendoRecord>();
  return {
    get: async (id) => rows.get(id) ?? null,
    put: async (record) => {
      const row = { ...record, revision: "1" } as unknown as VendoRecord;
      rows.set(record.id, row);
      return row;
    },
    delete: async (id) => { rows.delete(id); },
    list: async () => ({ records: [...rows.values()] }),
  };
}

function fakeApps(created: Map<string, AppDocument> = new Map()) {
  let counter = 0;
  const create = vi.fn(async ({ prompt }: { prompt: string }) => {
    counter += 1;
    const app = { format: "vendo/app@1", id: `app_gen_${counter}`, name: prompt } as AppDocument;
    created.set(app.id, app);
    return app;
  });
  const get = vi.fn(async (appId: string) => created.get(appId) ?? null);
  return { create, get, created };
}

describe("chip pre-generation", () => {
  it("generates every chip through the pipeline and records the manifest", async () => {
    const apps = fakeApps();
    const manifests = memoryRecords();

    const entries = await pregenerate(apps, manifests, "vendo-demo", CHIPS, { cookie: "authjs.session-token=seeded" });

    expect(apps.create).toHaveBeenCalledTimes(2);
    // The minted away session rides the ctx so the pipeline's host-data
    // captures pass Maple's session wall.
    expect(apps.create).toHaveBeenCalledWith(
      { prompt: "Build me a subscriptions tracker" },
      expect.objectContaining({
        principal: { kind: "user", subject: "vendo-demo" },
        requestHeaders: { cookie: "authjs.session-token=seeded" },
      }),
    );
    expect(entries.map((entry) => entry.key)).toEqual(["subs", "dining"]);
    const row = await manifests.get(chipManifestRowId("vendo-demo"));
    expect((row?.data as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("is idempotent: existing cached apps are skipped, not regenerated", async () => {
    const apps = fakeApps();
    const manifests = memoryRecords();
    await pregenerate(apps, manifests, "vendo-demo", CHIPS);
    apps.create.mockClear();

    const entries = await pregenerate(apps, manifests, "vendo-demo", CHIPS);

    expect(apps.create).not.toHaveBeenCalled();
    expect(entries).toHaveLength(2);
  });

  it("regenerates a manifest entry whose app was erased (post-reset repair)", async () => {
    const apps = fakeApps();
    const manifests = memoryRecords();
    const first = await pregenerate(apps, manifests, "vendo-demo", CHIPS);
    apps.created.delete(first[0]!.appId); // reset erased the subject's apps
    apps.create.mockClear();

    const entries = await pregenerate(apps, manifests, "vendo-demo", CHIPS);

    expect(apps.create).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(2);
  });

  it("an edited prompt regenerates: idempotency keys on the prompt, not the chip key", async () => {
    const apps = fakeApps();
    const manifests = memoryRecords();
    const first = await pregenerate(apps, manifests, "vendo-demo", CHIPS);
    apps.create.mockClear();

    const edited = [{ key: "subs", prompt: "Track my paid subscriptions" }, CHIPS[1]!];
    const entries = await pregenerate(apps, manifests, "vendo-demo", edited);

    expect(apps.create).toHaveBeenCalledTimes(1);
    expect(apps.create).toHaveBeenCalledWith({ prompt: "Track my paid subscriptions" }, expect.anything());
    const subs = entries.find((entry) => entry.key === "subs")!;
    expect(subs.prompt).toBe("Track my paid subscriptions");
    expect(subs.appId).not.toBe(first.find((entry) => entry.key === "subs")!.appId);
    // The untouched chip keeps its cached app.
    expect(entries.find((entry) => entry.key === "dining")!.appId)
      .toBe(first.find((entry) => entry.key === "dining")!.appId);
  });

  it("concurrent runs single-flight: boot + reset overlap never double-generates", async () => {
    const apps = fakeApps();
    // Make create slow enough that the second call arrives mid-run.
    const inner = apps.create.getMockImplementation()!;
    apps.create.mockImplementation(async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return inner(input);
    });
    const manifests = memoryRecords();

    const [a, b] = await Promise.all([
      pregenerate(apps, manifests, "vendo-demo", CHIPS),
      pregenerate(apps, manifests, "vendo-demo", CHIPS),
    ]);

    expect(apps.create).toHaveBeenCalledTimes(CHIPS.length);
    expect(a).toEqual(b);
    const row = await manifests.get(chipManifestRowId("vendo-demo"));
    expect((row?.data as { entries: unknown[] }).entries).toHaveLength(CHIPS.length);
  });

  it("tolerates a failed generation: logs, skips the chip, keeps the rest", async () => {
    const apps = fakeApps();
    apps.create.mockRejectedValueOnce(new Error("model 529"));
    const manifests = memoryRecords();

    const entries = await pregenerate(apps, manifests, "vendo-demo", CHIPS);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("dining");
    const row = await manifests.get(chipManifestRowId("vendo-demo"));
    expect((row?.data as { entries: unknown[] }).entries).toHaveLength(1);
  });
});
