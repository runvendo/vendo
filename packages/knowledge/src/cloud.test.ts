import { describe, expect, it } from "vitest";
import {
  VendoError,
  type KnowledgeContext,
  type VendoErrorCode,
} from "@vendoai/core";
import { knowledgeAdapterConformance, memoryKnowledgeAdapter, runConformance } from "@vendoai/core/conformance";
import { cloudKnowledge } from "./cloud.js";
import { fakeKnowledgeServer } from "./cloud.test-util.js";

const ctx: KnowledgeContext = { principal: { kind: "user", subject: "user_cloud_test" } };

const client = (server: ReturnType<typeof fakeKnowledgeServer>, apiKey = "vnd_test") =>
  cloudKnowledge({ apiKey, baseUrl: "https://console.test", fetch: server.fetch });

describe("cloudKnowledge — conformance against the fake wire server", () => {
  it("passes the KnowledgeAdapter conformance suite end-to-end over the wire", async () => {
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => ({ adapter: client(fakeKnowledgeServer()) }),
      posture: { fetch: true, write: true, visibility: "enforced" },
    }));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("cloudKnowledge — wire behavior", () => {
  it("sends Bearer auth and hits the console knowledge mount paths", async () => {
    const server = fakeKnowledgeServer();
    await client(server).status();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ path: "/status", method: "GET", authorization: "Bearer vnd_test" });
  });

  it("never puts a tenant selector on the wire — no org/namespace/tenant key in any request", async () => {
    const server = fakeKnowledgeServer();
    const adapter = client(server);
    await adapter.upsert!([{
      id: "doc_1", kind: "docs", visibility: "public", title: "T", text: "body text", source: "t.md",
    }]);
    await adapter.search({ text: "body", intent: "deep", kinds: ["docs"], limit: 3 }, { ...ctx, includeInternal: true });
    await adapter.fetch!({ docId: "doc_1" }, ctx);
    await adapter.remove!(["doc_1"]);
    await adapter.status();
    expect(server.requests.length).toBe(5);
    const keys = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
          keys.add(key);
          collect(nested);
        }
      }
    };
    for (const request of server.requests) collect(request.body);
    for (const key of keys) expect(key).not.toMatch(/org|tenant|namespace|workspace/i);
  });

  it("round-trips every VendoError code through the wire envelope", async () => {
    const codes: VendoErrorCode[] = [
      "validation", "blocked", "not-implemented", "sandbox-unavailable", "cloud-required", "not-found", "conflict",
    ];
    for (const code of codes) {
      const throwing = {
        ...memoryKnowledgeAdapter(),
        search: async () => { throw new VendoError(code, `engine says ${code}`); },
      };
      const adapter = client(fakeKnowledgeServer({ adapter: throwing }));
      const thrown = await adapter.search({ text: "boom" }, ctx).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(VendoError);
      expect((thrown as VendoError).code).toBe(code);
      expect((thrown as VendoError).message).toBe(`engine says ${code}`);
    }
  });

  it("folds any 401 into cloud-required (auth is the mount's, not the wire's)", async () => {
    const server = fakeKnowledgeServer({ bearer: "vnd_right" });
    const wrong = client(server, "vnd_wrong");
    const thrown = await wrong.status().catch((error: unknown) => error);
    expect((thrown as VendoError).code).toBe("cloud-required");
    expect((thrown as VendoError).message).toContain("vendo login");
  });

  it("translates ONLY the enveloped not-found to null on fetch — a bare 404 stays an error", async () => {
    const server = fakeKnowledgeServer();
    expect(await client(server).fetch!({ docId: "doc_absent" }, ctx)).toBeNull();

    const bare404: typeof fetch = async () => new Response("nginx: not found", { status: 404 });
    const broken = cloudKnowledge({ apiKey: "vnd_test", baseUrl: "https://console.test", fetch: bare404 });
    const thrown = await broken.fetch!({ docId: "doc_absent" }, ctx).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(VendoError);
    expect((thrown as VendoError).code).toBe("not-implemented");
  });

  it("surfaces a 2xx non-wire body as a server-shaped error, never caller blame", async () => {
    const junk: typeof fetch = async () => Response.json({ hello: "world" });
    const broken = cloudKnowledge({ apiKey: "vnd_test", baseUrl: "https://console.test", fetch: junk });
    const thrown = await broken.search({ text: "q" }, ctx).catch((error: unknown) => error);
    expect((thrown as VendoError).code).toBe("not-implemented");
  });

  it("wraps transport failures as cloud-required with the base url named", async () => {
    const down: typeof fetch = async () => { throw new TypeError("fetch failed"); };
    const broken = cloudKnowledge({ apiKey: "vnd_test", baseUrl: "https://console.test", fetch: down });
    const thrown = await broken.status().catch((error: unknown) => error);
    expect((thrown as VendoError).code).toBe("cloud-required");
    expect((thrown as VendoError).message).toContain("https://console.test");
  });

  it("fake server validates request bodies (validation envelope) and gates undeclared routes (not-implemented)", async () => {
    const server = fakeKnowledgeServer({ posture: { fetch: true, write: false, visibility: "public-only" } });
    const invalid = await server.fetch("https://console.test/api/v1/knowledge/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: { text: "" } }),
    });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("validation");

    const gated = await server.fetch("https://console.test/api/v1/knowledge/upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docs: [] }),
    });
    expect(gated.status).toBe(501);
    expect(((await gated.json()) as { error: { code: string } }).error.code).toBe("not-implemented");
  });
});
