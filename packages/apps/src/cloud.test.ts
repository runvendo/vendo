import type { AppDocument } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApps,
  publishRecordSchema,
  shareSnapshotSchema,
} from "./index.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

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

const runtime = async () => {
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
  });
};

const previousKey = globalThis.process.env.VENDO_API_KEY;
const previousUrl = globalThis.process.env.VENDO_CLOUD_URL;

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousKey === undefined) delete globalThis.process.env.VENDO_API_KEY;
  else globalThis.process.env.VENDO_API_KEY = previousKey;
  if (previousUrl === undefined) delete globalThis.process.env.VENDO_CLOUD_URL;
  else globalThis.process.env.VENDO_CLOUD_URL = previousUrl;
});

describe.sequential("cloud interchange", () => {
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

  it("requires Vendo Cloud when no API key is configured", async () => {
    delete globalThis.process.env.VENDO_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const apps = await runtime();

    await expect(apps.share("app_cloud", ctx)).rejects.toMatchObject({ code: "cloud-required" });
    await expect(apps.publish("app_cloud", ctx)).rejects.toMatchObject({ code: "cloud-required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the owned app document and validates share and publish responses", async () => {
    globalThis.process.env.VENDO_API_KEY = "test-key";
    globalThis.process.env.VENDO_CLOUD_URL = "https://cloud.example/";
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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(snapshot))
      .mockResolvedValueOnce(Response.json(record));
    vi.stubGlobal("fetch", fetchMock);
    const apps = await runtime();

    await expect(apps.share(doc.id, ctx)).resolves.toEqual(snapshot);
    await expect(apps.publish(doc.id, ctx)).resolves.toEqual(record);
    for (const [index, path] of ["share", "publish"].entries()) {
      expect(fetchMock).toHaveBeenNthCalledWith(
        index + 1,
        `https://cloud.example/api/v1/apps/${path}`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ appId: doc.id, doc }),
        },
      );
    }
  });

  it("maps HTTP 402 envelopes to cloud-required", async () => {
    globalThis.process.env.VENDO_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: { code: "billing-required", message: "Upgrade your Vendo Cloud plan" },
    }, { status: 402 })));
    const apps = await runtime();

    await expect(apps.share(doc.id, ctx)).rejects.toMatchObject({
      code: "cloud-required",
      message: "Upgrade your Vendo Cloud plan",
    });
    await expect(apps.publish(doc.id, ctx)).rejects.toMatchObject({
      code: "cloud-required",
      message: "Upgrade your Vendo Cloud plan",
    });
  });

  it("does not call Cloud for an app the principal does not own", async () => {
    globalThis.process.env.VENDO_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const apps = await runtime();

    await expect(apps.share(doc.id, {
      ...ctx,
      principal: { kind: "user", subject: "user_grace" },
    })).rejects.toMatchObject({ code: "not-found" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
