import { describe, expect, it } from "vitest";
import { handleFadeProposalRoute } from "./fade-proposal";
import {
  createFadeTracker,
  createInMemoryGrantStore,
  InMemoryAuditLog,
  type ToolDescriptor,
} from "@vendoai/runtime";

const scope = { tenantId: "vendo-embedded", subject: "vendo-default-user" };
const now = () => "2026-07-04T00:00:00Z";

function req(body: unknown): Request {
  return new Request("http://localhost:3000/api/vendo/fade-proposal", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3000" },
  });
}

function makeDeps() {
  const grants = createInMemoryGrantStore({ now });
  const audit = new InMemoryAuditLog();
  const fadeTracker = createFadeTracker();
  return {
    fadeTracker, grants, audit,
    resolveDescriptor: (name: string): ToolDescriptor | undefined =>
      name === "GMAIL_SEND_EMAIL"
        // Explicit readOnlyHint: false marks this descriptor VERIFIED — an
        // all-{} annotations object is "unverified" per policy/tier.ts's
        // `isUnverified`, which would make it fade-ineligible (same fixture
        // rationale as packages/vendo-runtime/src/consent.test.ts).
        ? { name, source: "composio", annotations: { readOnlyHint: false }, hasExecute: true, kind: "function" }
        : undefined,
    principal: scope,
  };
}

describe("handleFadeProposalRoute", () => {
  it("400s a malformed body", async () => {
    const res = await handleFadeProposalRoute(req({ nonsense: true }), makeDeps());
    expect(res.status).toBe(400);
  });

  it("accepts a real fade offer -> 200 {ok:true}", async () => {
    const deps = makeDeps();
    for (const to of ["a@acme.co", "b@acme.co", "c@acme.co"]) {
      deps.fadeTracker.record(scope, "GMAIL_SEND_EMAIL", { to }, "yes");
    }
    const offer = deps.fadeTracker.propose(scope, "GMAIL_SEND_EMAIL", { to: "d@acme.co" })!;
    const res = await handleFadeProposalRoute(req({ proposalId: offer.proposalId, accept: true }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(await deps.grants.findForTool(scope, "GMAIL_SEND_EMAIL")).toHaveLength(1);
  });

  it("propagates the ineligible-proposal status", async () => {
    const deps = makeDeps();
    const res = await handleFadeProposalRoute(req({ proposalId: "not-real", accept: true }), deps);
    expect(res.status).toBe(403);
  });
});
