import { describe, expect, it } from "vitest";
import { VendoError, type KnowledgeContext, type KnowledgeDoc } from "@vendoai/core";
import { knowledgeAdapterConformance, memoryKnowledgeAdapter, runConformance } from "@vendoai/core/conformance";
import { fakeKnowledgeServer } from "../src/cloud.test-util.js";
import { httpKnowledge } from "../src/http.js";

const ctx: KnowledgeContext = { principal: { kind: "user", subject: "user_http_test" } };

const SEED: { public: KnowledgeDoc; internal: KnowledgeDoc } = {
  public: {
    id: "doc_conformance_public",
    kind: "docs",
    visibility: "public",
    title: "Conformance refund policy",
    text: "Conformance refunds are processed within 5 business days.",
    source: "conformance/refunds.md",
  },
  internal: {
    id: "doc_conformance_internal",
    kind: "glossary",
    visibility: "internal",
    title: "Conformance chargeback runbook",
    text: "Conformance internal chargeback escalation contacts.",
    source: "conformance/chargebacks.md",
  },
};

describe("httpKnowledge — conformance", () => {
  it("passes posture-adapted against a search-only endpoint (the BYO default)", async () => {
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => {
        // Read-only endpoints come pre-seeded: the host owns that corpus.
        const server = fakeKnowledgeServer({
          adapter: memoryKnowledgeAdapter({ docs: [SEED.public] }),
          posture: { fetch: false, write: false, visibility: "public-only" },
        });
        return { adapter: httpKnowledge({ url: "https://byo.example/knowledge", fetch: server.fetch }) };
      },
      posture: { fetch: false, write: false, visibility: "public-only" },
      seedDocs: SEED,
    }));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("passes with a declared full posture against a full endpoint (override is first-class)", async () => {
    const posture = { fetch: true, write: true, visibility: "enforced" } as const;
    const report = await runConformance(knowledgeAdapterConformance({
      makeAdapter: async () => {
        const server = fakeKnowledgeServer({ posture });
        return { adapter: httpKnowledge({ url: "https://byo.example/knowledge", fetch: server.fetch, posture }) };
      },
      posture,
    }));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("httpKnowledge — posture-shaped surface", () => {
  it("keeps read-more gracefully absent without fetch posture, and write members absent when read-only", () => {
    const searchOnly = httpKnowledge({ url: "https://byo.example" });
    expect(searchOnly.posture).toEqual({ fetch: false, write: false, visibility: "public-only" });
    expect(searchOnly.fetch).toBeUndefined();
    expect(searchOnly.upsert).toBeUndefined();
    expect(searchOnly.remove).toBeUndefined();
  });

  it("sends Bearer auth only when configured, straight at the endpoint's own paths", async () => {
    const server = fakeKnowledgeServer({ adapter: memoryKnowledgeAdapter({ docs: [SEED.public] }) });
    const authed = httpKnowledge({ url: "https://byo.example/kb/", auth: { bearer: "host-token" }, fetch: server.fetch });
    await authed.search({ text: "refunds" }, ctx);
    expect(server.requests[0]).toMatchObject({ path: "/search", authorization: "Bearer host-token" });

    const anonymous = httpKnowledge({ url: "https://byo.example/kb", fetch: server.fetch });
    await anonymous.status();
    expect(server.requests[1]).toMatchObject({ path: "/status", authorization: null });
  });

  it("answers a posture-gated 501 from the endpoint as a not-implemented VendoError", async () => {
    const server = fakeKnowledgeServer({ posture: { fetch: false, write: false, visibility: "public-only" } });
    // A client that (wrongly) declares write against a read-only endpoint
    // gets the endpoint's honest 501 envelope, not a silent no-op.
    const overclaiming = httpKnowledge({
      url: "https://byo.example",
      fetch: server.fetch,
      posture: { write: true },
    });
    const thrown = await overclaiming.upsert!([SEED.public]).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(VendoError);
    expect((thrown as VendoError).code).toBe("not-implemented");
  });

  it("names the route when the endpoint answers 200 with a body that is not the wire", async () => {
    // The BYO implementor's most likely mistake: a live endpoint that answers
    // successfully in its own shape. It must be told which route disagreed and
    // which contract it failed, not handed a generic parse error.
    const ownShape: typeof fetch = async () =>
      new Response(JSON.stringify({ status: "ok", results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const adapter = httpKnowledge({ url: "https://byo.example/kb", fetch: ownShape });
    const thrown = await adapter.status().catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(VendoError);
    expect((thrown as VendoError).code).toBe("not-implemented");
    expect((thrown as Error).message).toContain("https://byo.example/kb/status");
    expect((thrown as Error).message).toContain("vendo/knowledge-wire@1");
  });

  it("names the endpoint when it is unreachable", async () => {
    const down: typeof fetch = async () => { throw new TypeError("fetch failed"); };
    const adapter = httpKnowledge({ url: "https://byo.example/kb", fetch: down });
    await expect(adapter.status()).rejects.toThrow(/byo\.example\/kb is unreachable/);
  });
});
