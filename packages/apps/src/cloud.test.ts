import type { AppDocument } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import {
  createApps,
  publishRecordSchema,
  shareSnapshotSchema,
  type CloudAppsClient,
} from "./index.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

// ADAPTER RULE (see selectConnections in the umbrella's server.ts): the apps
// block never reads the environment. Share/publish ride an INJECTED Cloud
// client — which implementation composes is decided at the createVendo seam;
// an unfilled seam fails honestly with cloud-required.

const ctx = {
  principal: { kind: "user" as const, subject: "user_ada" },
  venue: "app" as const,
  presence: "present" as const,
  sessionId: "session_ada",
};

const doc: AppDocument = {
  format: "vendo/app@1",
  id: "app_cloud",
  name: "Cloud app",
};

const runtime = async (cloud?: CloudAppsClient) => {
  const store = memoryStore();
  await seedAppRow(store, doc, ctx.principal.subject);
  return createApps({
    store,
    guard: guardFixture(),
    tools: {
      async descriptors() { return []; },
      async execute() { return { status: "error" as const, error: { code: "not-found", message: "missing" } }; },
    },
    catalog: [],
    ...(cloud === undefined ? {} : { cloud }),
  });
};

describe("cloud interchange", () => {
  it("exports the share and publish schemas", () => {
    expect(shareSnapshotSchema.parse({
      id: "share_1",
      doc,
      createdAt: "2026-07-11T12:00:00.000Z",
    }).doc).toEqual(doc);
    expect(publishRecordSchema.parse({
      id: "publish_1",
      appId: "app_cloud",
      version: "1",
      createdAt: "2026-07-11T12:00:00.000Z",
    }).appId).toBe("app_cloud");
  });

  it("requires Vendo Cloud when no cloud client is injected", async () => {
    const apps = await runtime();

    await expect(apps.share("app_cloud", ctx)).rejects.toMatchObject({ code: "cloud-required" });
    await expect(apps.publish("app_cloud", ctx)).rejects.toMatchObject({ code: "cloud-required" });
  });

  it("delegates the owned app document to the injected client", async () => {
    const snapshot = {
      id: "share_1",
      doc,
      createdAt: "2026-07-11T12:00:00.000Z",
    };
    const record = {
      id: "publish_1",
      appId: doc.id,
      version: "1",
      createdAt: "2026-07-11T12:00:00.000Z",
    };
    const cloud: CloudAppsClient = {
      share: vi.fn(async () => snapshot),
      publish: vi.fn(async () => record),
    };
    const apps = await runtime(cloud);

    await expect(apps.share(doc.id, ctx)).resolves.toEqual(snapshot);
    await expect(apps.publish(doc.id, ctx)).resolves.toEqual(record);
    expect(cloud.share).toHaveBeenCalledWith(doc.id, doc);
    expect(cloud.publish).toHaveBeenCalledWith(doc.id, doc);
  });

  it("strips the owner's egress approval before the copy leaves (Lane E grant hygiene)", async () => {
    const approvedDoc: AppDocument = { ...doc, id: "app_egress", egressApproved: ["api.stripe.com"] };
    const store = memoryStore();
    await seedAppRow(store, approvedDoc, ctx.principal.subject);
    const shared: AppDocument[] = [];
    const apps = createApps({
      store,
      guard: guardFixture(),
      tools: {
        async descriptors() { return []; },
        async execute() { return { status: "error" as const, error: { code: "not-found", message: "missing" } }; },
      },
      catalog: [],
      cloud: {
        share: async (_appId, outbound) => {
          shared.push(outbound);
          return { id: "share_e", doc: outbound, createdAt: "2026-07-11T12:00:00.000Z" };
        },
        publish: async (appId, outbound) => {
          shared.push(outbound);
          return { id: "publish_e", appId, version: "1", createdAt: "2026-07-11T12:00:00.000Z" };
        },
      },
    });

    await apps.share("app_egress", ctx);
    await apps.publish("app_egress", ctx);
    expect(shared).toHaveLength(2);
    for (const outbound of shared) {
      expect(outbound).not.toHaveProperty("egressApproved");
    }
  });

  it("does not call Cloud for an app the principal does not own", async () => {
    const cloud: CloudAppsClient = {
      share: vi.fn(async () => { throw new Error("unreached"); }),
      publish: vi.fn(async () => { throw new Error("unreached"); }),
    };
    const apps = await runtime(cloud);

    await expect(apps.share(doc.id, {
      ...ctx,
      principal: { kind: "user", subject: "user_grace" },
    })).rejects.toMatchObject({ code: "not-found" });
    expect(cloud.share).not.toHaveBeenCalled();
    expect(cloud.publish).not.toHaveBeenCalled();
  });
});
