import { describe, expect, it } from "vitest";
import {
  createApps,
  publishRecordSchema,
  shareSnapshotSchema,
} from "./index.js";
import { guardFixture, memoryStore } from "./testing/index.js";

const ctx = {
  principal: { kind: "user" as const, subject: "user_ada" },
  venue: "app" as const,
  presence: "present" as const,
  sessionId: "session_ada",
};

const runtime = () => createApps({
  store: memoryStore(),
  guard: guardFixture(),
  tools: {
    async descriptors() { return []; },
    async execute() { return { status: "error" as const, error: { code: "not-found", message: "missing" } }; },
  },
  catalog: [],
});

describe.sequential("cloud interchange stubs", () => {
  it("exports the share and publish schemas", () => {
    const doc = { format: "vendo/app@1" as const, id: "app_cloud", name: "Cloud app" };
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
    const previous = globalThis.process.env.VENDO_API_KEY;
    delete globalThis.process.env.VENDO_API_KEY;
    try {
      const apps = runtime();
      await expect(apps.share("app_cloud", ctx)).rejects.toMatchObject({ code: "cloud-required" });
      await expect(apps.publish("app_cloud", ctx)).rejects.toMatchObject({ code: "cloud-required" });
    } finally {
      if (previous === undefined) delete globalThis.process.env.VENDO_API_KEY;
      else globalThis.process.env.VENDO_API_KEY = previous;
    }
  });

  it("reports the separately shipped client when an API key is present", async () => {
    const previous = globalThis.process.env.VENDO_API_KEY;
    globalThis.process.env.VENDO_API_KEY = "test-key";
    try {
      const apps = runtime();
      await expect(apps.share("app_cloud", ctx)).rejects.toMatchObject({
        code: "not-implemented",
        message: "Vendo Cloud client ships separately in v0",
      });
      await expect(apps.publish("app_cloud", ctx)).rejects.toMatchObject({
        code: "not-implemented",
        message: "Vendo Cloud client ships separately in v0",
      });
    } finally {
      if (previous === undefined) delete globalThis.process.env.VENDO_API_KEY;
      else globalThis.process.env.VENDO_API_KEY = previous;
    }
  });
});
