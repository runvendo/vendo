/**
 * The served-app machine's egress policy must FAIL CLOSED.
 *
 * Sibling of the conversational box's hole (`claude-code/box.ts`): the sandbox
 * seam reads `allowedDomains: undefined` as UNRESTRICTED internet, so any path
 * that can reach `adapter.create` without naming a policy asks for an unfiltered
 * box. This file pins every such path shut.
 *
 * Scope: these assert WHAT WE SEND the provider. How strongly the provider then
 * enforces it is a separate question with a measured gap —
 * `docs/verification/box-egress/README.md`.
 */
import type { AppDocument } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { createMachineLifecycle } from "./machine-lifecycle.js";
import type { SandboxAdapter } from "./sandbox.js";
import { fakeStatefulSandbox, guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

type CreateSpec = { template?: string; env: Record<string, string>; allowedDomains?: string[] };

/** The real fake sandbox, with every create SPEC recorded — the network policy
 *  is a create-time argument and nothing inside the box reflects it. */
const watched = (): SandboxAdapter & { specs: CreateSpec[] } => {
  const inner = fakeStatefulSandbox();
  const specs: CreateSpec[] = [];
  return {
    ...inner,
    specs,
    async create(spec: CreateSpec) {
      specs.push(spec);
      return inner.create(spec);
    },
  } as SandboxAdapter & { specs: CreateSpec[] };
};

const ada = {
  principal: { kind: "user" as const, subject: "user_ada" },
  venue: "app" as const,
  presence: "present" as const,
  sessionId: "session_egress_failopen",
};

const doc = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_egress_failopen",
  name: "Egress fail-closed fixture",
});

describe("the served-app machine's egress policy fails CLOSED", () => {
  it("provisions with a defined allowlist even when the deployment names no implicit domains", async () => {
    const store = memoryStore();
    const sandbox = watched();
    await seedAppRow(store, doc(), ada.principal.subject);
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: { async descriptors() { return []; }, async execute() { return { status: "error", error: { code: "not-found", message: "none" } }; } },
      catalog: [],
      // No implicitDomains, no declared egress: the emptiest possible deployment.
      machine: { sandbox, buildEnv: () => ({ PORT: "8080" }) },
    });

    await runtime.machine.provision(doc().id, ada);

    expect(sandbox.specs).toHaveLength(1);
    // `[]` asks for everything to be filtered; `undefined` would ask for nothing to be.
    expect(sandbox.specs[0]?.allowedDomains).toEqual([]);
  });

  it("cannot be constructed without a policy — an omitted allowlist is not a way to say 'unrestricted'", async () => {
    const store = memoryStore();
    const sandbox = watched();
    await seedAppRow(store, doc(), ada.principal.subject);
    // @ts-expect-error the seam REQUIRES a policy: omitting it used to mean
    // unrestricted egress, which is the fail-open this whole file exists for.
    const lifecycle = createMachineLifecycle({ store, sandbox });

    await lifecycle.provision(doc());

    expect(sandbox.specs[0]?.allowedDomains).toBeDefined();
  });

  it("a policy that resolves to nothing sends an EMPTY list — it never degrades to unrestricted", async () => {
    const store = memoryStore();
    const sandbox = watched();
    await seedAppRow(store, doc(), ada.principal.subject);
    const lifecycle = createMachineLifecycle({
      store,
      sandbox,
      // A host whose policy function answers with nothing at all.
      allowedDomains: () => undefined as unknown as string[],
    });

    await lifecycle.provision(doc());

    expect(sandbox.specs[0]?.allowedDomains).toEqual([]);
  });
});
