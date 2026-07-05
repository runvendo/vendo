import { describe, expect, it } from "vitest";
import { handleDemoFadeProposal } from "./fade-proposal-handler";
import { demoStore, CADENCE_SCOPE } from "./store";

function req(body: unknown): Request {
  return new Request("http://localhost/api/flowlet/fade-proposal", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost" },
  });
}

describe("handleDemoFadeProposal", () => {
  it("400s a malformed body", async () => {
    const res = await handleDemoFadeProposal(req({ nonsense: true }));
    expect(res.status).toBe(400);
  });

  it("accepts a real fade offer for a verified act-tier host tool -> 200 {ok:true}", async () => {
    for (const id of ["c1", "c2", "c3"]) {
      demoStore.fadeTracker.record(CADENCE_SCOPE, "sendClientMessage", { id }, "yes");
    }
    const offer = demoStore.fadeTracker.propose(CADENCE_SCOPE, "sendClientMessage", { id: "c4" })!;
    expect(offer).toBeTruthy();
    const res = await handleDemoFadeProposal(req({ proposalId: offer.proposalId, accept: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(await demoStore.grants.findForTool(CADENCE_SCOPE, "sendClientMessage")).toHaveLength(1);
  });

  it("403s an unknown/ineligible proposalId", async () => {
    const res = await handleDemoFadeProposal(req({ proposalId: "not-real", accept: true }));
    expect(res.status).toBe(403);
  });

  it("refuses to mint for a critical tool even if somehow offered", async () => {
    for (const id of ["d1", "d2", "d3"]) {
      demoStore.fadeTracker.record(CADENCE_SCOPE, "setDocumentStatus", { id }, "yes");
    }
    const offer = demoStore.fadeTracker.propose(CADENCE_SCOPE, "setDocumentStatus", { id: "d4" })!;
    expect(offer).toBeTruthy();
    const res = await handleDemoFadeProposal(req({ proposalId: offer.proposalId, accept: true }));
    expect(res.status).toBe(403);
  });

  it("guards against non-local requests like consent-handler.ts does", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      const res = await handleDemoFadeProposal(
        new Request("https://deployed.example.com/api/flowlet/fade-proposal", {
          method: "POST", body: JSON.stringify({ proposalId: "x", accept: true }),
          headers: { "content-type": "application/json", host: "deployed.example.com" },
        }),
      );
      expect(res.status).toBe(403);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = "test";
      delete process.env.FLOWLET_DEMO_PUBLIC;
    }
  });
});
