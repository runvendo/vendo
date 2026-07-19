import type { AppDocument } from "@vendoai/core";
import { VENDO_APP_FORMAT, VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createMachineLifecycle, type LifecycleClock } from "./machine-lifecycle.js";
import { documentFromRecord } from "./persistence.js";
import { fakeSandboxV2, memoryStore, seedAppRow } from "./testing/index.js";

const app = (id = "app_machine_test"): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id,
  name: "Machine lifecycle fixture",
});

const provisioned = (id = "app_machine_test"): AppDocument => ({
  ...app(id),
  machine: { snapshotRef: "fake-v2:seeded", provisionedAt: "2026-07-19T00:00:00.000Z" },
});

/** Deterministic injectable clock: timers fire only when the test advances. */
const fakeClock = () => {
  const timers = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  let nextId = 1;
  const clock: LifecycleClock = {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  };
  const advance = async (ms: number): Promise<void> => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
    // Auto-sleep runs async work after the timer fires; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { clock, advance, pending: () => timers.size };
};

const setup = async (options: {
  doc?: AppDocument;
  env?: Record<string, string>;
  template?: string;
  idleMs?: number;
  withAdapter?: boolean;
  allowedDomains?: (doc: AppDocument) => Promise<string[] | undefined> | string[] | undefined;
} = {}) => {
  const store = memoryStore();
  const sandbox = fakeSandboxV2();
  const timers = fakeClock();
  const doc = options.doc ?? app();
  await seedAppRow(store, doc, "owner");
  const lifecycle = createMachineLifecycle({
    store,
    sandbox: options.withAdapter === false ? undefined : sandbox,
    buildEnv: () => options.env ?? { PORT: "8080" },
    allowedDomains: options.allowedDomains,
    template: options.template,
    idleMs: options.idleMs,
    clock: timers.clock,
  });
  const stored = async (): Promise<AppDocument> => {
    const record = await store.records("vendo_apps").get(doc.id);
    if (record === null) throw new Error(`app row ${doc.id} is gone`);
    return documentFromRecord(record);
  };
  return { store, sandbox, timers, lifecycle, doc, stored };
};

const bodyText = (body: Uint8Array): string => new TextDecoder().decode(body);

describe("machine lifecycle: provision", () => {
  it("creates from the base template with the assembled env, snapshots, and stores the ref", async () => {
    const { sandbox, lifecycle, doc, stored } = await setup({
      env: { PORT: "8080", VENDO_STORE_URL: "http://host/store" },
      template: "vendo-base-v2",
    });

    const updated = await lifecycle.provision(doc);

    expect(updated.machine?.snapshotRef).toMatch(/^fake-v2:/);
    expect(updated.machine?.provisionedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await stored()).toEqual(updated);
    expect(sandbox.creates).toBe(1);
    const machine = sandbox.machines[0];
    expect(machine?.template).toBe("vendo-base-v2");
    expect(machine?.env).toEqual({ PORT: "8080", VENDO_STORE_URL: "http://host/store" });
    // Provision leaves a sleeping snapshot, not a running machine — and the
    // source machine is destroyed at the provider (snapshot leaves it running).
    expect(machine?.destroyedSelf).toBe(true);
    expect(lifecycle.peek(doc.id)).toBeUndefined();
  });

  it("is idempotent: an app that already has a machine is returned unchanged", async () => {
    const { sandbox, lifecycle, doc } = await setup({ doc: provisioned() });
    const result = await lifecycle.provision(doc);
    expect(result.machine?.snapshotRef).toBe("fake-v2:seeded");
    expect(sandbox.creates).toBe(0);
  });

  it("coalesces concurrent provisions into one machine", async () => {
    const { sandbox, lifecycle, doc } = await setup();
    const [first, second] = await Promise.all([
      lifecycle.provision(doc),
      lifecycle.provision(doc),
    ]);
    expect(sandbox.creates).toBe(1);
    expect(first.machine?.snapshotRef).toBe(second.machine?.snapshotRef);
  });

  it("fails with not-found when the app row does not exist", async () => {
    const { lifecycle } = await setup();
    await expect(lifecycle.provision(app("app_missing"))).rejects.toMatchObject({
      name: "VendoError",
      code: "not-found",
    });
  });
});

describe("machine lifecycle: wake and sleep", () => {
  it("wakes from the stored snapshot and preserves box state across a sleep/wake cycle", async () => {
    const { lifecycle, doc, stored } = await setup();
    const withMachine = await lifecycle.provision(doc);

    const first = await lifecycle.wake(withMachine);
    await first.request({ method: "POST", path: "/state/greeting", body: "hello from the box" });

    const slept = await lifecycle.sleep(withMachine);
    expect(slept.machine?.snapshotRef).not.toBe(withMachine.machine?.snapshotRef);
    // Sleep re-snapshots; provisionedAt records provisioning, not the last sleep.
    expect(slept.machine?.provisionedAt).toBe(withMachine.machine?.provisionedAt);
    expect(await stored()).toEqual(slept);
    expect(lifecycle.peek(doc.id)).toBeUndefined();

    const second = await lifecycle.wake(slept);
    const read = await second.request({ method: "GET", path: "/state/greeting" });
    expect(read.status).toBe(200);
    expect(bodyText(read.body)).toBe("hello from the box");
  });

  it("coalesces concurrent wakes of the same app into one machine", async () => {
    const { sandbox, lifecycle, doc } = await setup();
    const withMachine = await lifecycle.provision(doc);

    const [first, second, third] = await Promise.all([
      lifecycle.wake(withMachine),
      lifecycle.wake(withMachine),
      lifecycle.wake(withMachine),
    ]);

    expect(sandbox.resumes).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("returns the already-live machine on a repeat wake", async () => {
    const { sandbox, lifecycle, doc } = await setup();
    const withMachine = await lifecycle.provision(doc);
    const first = await lifecycle.wake(withMachine);
    const second = await lifecycle.wake(withMachine);
    expect(second).toBe(first);
    expect(sandbox.resumes).toBe(1);
  });

  it("rejects waking a layer-1 app with no machine", async () => {
    const { lifecycle, doc } = await setup();
    await expect(lifecycle.wake(doc)).rejects.toMatchObject({
      name: "VendoError",
      code: "validation",
    });
  });

  it("treats sleep of an app with no live machine as a no-op", async () => {
    const { sandbox, lifecycle, doc } = await setup({ doc: provisioned() });
    const result = await lifecycle.sleep(doc);
    expect(result.machine?.snapshotRef).toBe("fake-v2:seeded");
    expect(sandbox.destroyed).toEqual([]);
  });
});

describe("machine lifecycle: idle auto-sleep", () => {
  it("sleeps a woken machine after the idle timeout", async () => {
    const { sandbox, lifecycle, timers, doc, stored } = await setup({ idleMs: 5 * 60_000 });
    const withMachine = await lifecycle.provision(doc);
    const machine = await lifecycle.wake(withMachine);
    await machine.request({ method: "POST", path: "/state/note", body: "keep me" });

    await timers.advance(5 * 60_000);

    expect(lifecycle.peek(doc.id)).toBeUndefined();
    const slept = await stored();
    expect(slept.machine?.snapshotRef).not.toBe(withMachine.machine?.snapshotRef);
    const again = await lifecycle.wake(slept);
    const read = await again.request({ method: "GET", path: "/state/note" });
    expect(bodyText(read.body)).toBe("keep me");
    expect(sandbox.resumes).toBe(2);
  });

  it("resets the idle timer on every request", async () => {
    const { lifecycle, timers, doc } = await setup({ idleMs: 5 * 60_000 });
    const withMachine = await lifecycle.provision(doc);
    const machine = await lifecycle.wake(withMachine);

    await timers.advance(4 * 60_000);
    await machine.request({ method: "GET", path: "/" });
    await timers.advance(4 * 60_000);
    expect(lifecycle.peek(doc.id)).toBeDefined();

    await timers.advance(60_000 + 1);
    expect(lifecycle.peek(doc.id)).toBeUndefined();
  });

  it("resets the idle timer on a repeat wake", async () => {
    const { lifecycle, timers, doc } = await setup({ idleMs: 5 * 60_000 });
    const withMachine = await lifecycle.provision(doc);
    await lifecycle.wake(withMachine);

    await timers.advance(4 * 60_000);
    await lifecycle.wake(withMachine);
    await timers.advance(4 * 60_000);
    expect(lifecycle.peek(doc.id)).toBeDefined();
  });

  it("stops arming timers once the machine is destroyed", async () => {
    const { lifecycle, timers, doc } = await setup({ idleMs: 5 * 60_000 });
    const withMachine = await lifecycle.provision(doc);
    await lifecycle.wake(withMachine);
    await lifecycle.destroyMachine(withMachine);
    expect(timers.pending()).toBe(0);
  });
});

describe("machine lifecycle: provider snapshot hygiene", () => {
  it("sleep releases the superseded provider snapshot after the new ref is stored", async () => {
    const { sandbox, lifecycle, doc } = await setup();
    const withMachine = await lifecycle.provision(doc);
    await lifecycle.wake(withMachine);

    const slept = await lifecycle.sleep(withMachine);

    expect(sandbox.destroyed).toEqual([withMachine.machine?.snapshotRef]);
    expect(sandbox.snapshots.has(slept.machine?.snapshotRef ?? "")).toBe(true);
    // The live source machine is destroyed after checkpoint, never left paused.
    expect(sandbox.machines.at(-1)?.destroyedSelf).toBe(true);
  });

  it("a provision that loses a cross-process race keeps the winner's ref and releases its own", async () => {
    const store = memoryStore();
    const sandbox = fakeSandboxV2();
    const timers = fakeClock();
    const doc = app();
    await seedAppRow(store, doc, "owner");
    const winner = { snapshotRef: "fake-v2:winner", provisionedAt: "2026-07-19T01:00:00.000Z" };
    const lifecycle = createMachineLifecycle({
      store,
      sandbox,
      // Another app server wins the provision race while this one assembles env:
      // the store row already carries a machine by the time our CAS write runs.
      buildEnv: async () => {
        await store.records("vendo_apps").put({
          id: doc.id,
          data: { subject: "owner", enabled: false, doc: { ...doc, machine: winner } },
          refs: { subject: "owner" },
        });
        return { PORT: "8080" };
      },
      clock: timers.clock,
    });

    const result = await lifecycle.provision(doc);

    expect(result.machine).toEqual(winner);
    // The loser's freshly taken snapshot is released, not leaked.
    expect(sandbox.destroyed).toHaveLength(1);
    expect(sandbox.destroyed[0]).toMatch(/^fake-v2:snap_/);
    expect(sandbox.destroyed[0]).not.toBe(winner.snapshotRef);
  });

  it("destroyMachine destroys a live machine at the provider, not just stops it", async () => {
    const { sandbox, lifecycle, doc } = await setup();
    const withMachine = await lifecycle.provision(doc);
    await lifecycle.wake(withMachine);

    await lifecycle.destroyMachine(withMachine);

    const liveMachine = sandbox.machines.at(-1);
    expect(liveMachine?.destroyedSelf).toBe(true);
  });
});

describe("machine lifecycle: in-flight requests defer auto-sleep", () => {
  it("does not sleep a machine while a request is in flight", async () => {
    const store = memoryStore();
    const timers = fakeClock();
    const doc = app();
    await seedAppRow(
      store,
      { ...doc, machine: { snapshotRef: "slow:snap", provisionedAt: "2026-07-19T00:00:00.000Z" } },
      "owner",
    );
    let releaseRequest = (): void => undefined;
    let snapshots = 0;
    const slowMachine = {
      id: "slow-machine",
      request: () =>
        new Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>(
          (resolve) => {
            releaseRequest = () => resolve({ status: 200, headers: {}, body: new Uint8Array() });
          },
        ),
      snapshot: async () => {
        snapshots += 1;
        return `slow:snap_${snapshots}`;
      },
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    const lifecycle = createMachineLifecycle({
      store,
      sandbox: {
        create: async () => slowMachine,
        resume: async () => slowMachine,
        destroy: async () => undefined,
      },
      idleMs: 5 * 60_000,
      clock: timers.clock,
    });

    const machine = await lifecycle.wake(doc);
    const pending = machine.request({ method: "GET", path: "/" });

    // The idle timer fires mid-request: the machine must stay awake, unsnapshotted.
    await timers.advance(5 * 60_000);
    expect(lifecycle.peek(doc.id)).toBeDefined();
    expect(snapshots).toBe(0);

    releaseRequest();
    await pending;
    // Once the request completes, the re-armed timer sleeps it normally.
    await timers.advance(5 * 60_000);
    expect(lifecycle.peek(doc.id)).toBeUndefined();
    expect(snapshots).toBe(1);
  });
});

describe("machine lifecycle: destroy", () => {
  it("destroys the sandbox and clears the machine field", async () => {
    const { sandbox, lifecycle, doc, stored } = await setup();
    const withMachine = await lifecycle.provision(doc);

    const cleared = await lifecycle.destroyMachine(withMachine);

    expect(cleared.machine).toBeUndefined();
    expect(await stored()).toEqual(cleared);
    expect(sandbox.destroyed).toEqual([withMachine.machine?.snapshotRef]);
  });

  it("stops a live machine before destroying its snapshot", async () => {
    const { sandbox, lifecycle, doc } = await setup();
    const withMachine = await lifecycle.provision(doc);
    await lifecycle.wake(withMachine);

    await lifecycle.destroyMachine(withMachine);

    expect(lifecycle.peek(doc.id)).toBeUndefined();
    expect(sandbox.machines.every((machine) => machine.stopped)).toBe(true);
    expect(sandbox.destroyed).toEqual([withMachine.machine?.snapshotRef]);
  });

  it("treats a layer-1 app as a no-op even without an adapter", async () => {
    const { lifecycle, doc } = await setup({ withAdapter: false });
    const result = await lifecycle.destroyMachine(doc);
    expect(result.machine).toBeUndefined();
  });
});

describe("machine lifecycle: sandbox-unavailable", () => {
  it("fails layer-2 operations with the existing VendoError shape when no adapter is configured", async () => {
    const bare = await setup({ withAdapter: false });
    const seeded = await setup({ doc: provisioned(), withAdapter: false });
    for (const operation of [
      () => bare.lifecycle.provision(bare.doc),
      () => seeded.lifecycle.wake(seeded.doc),
      () => seeded.lifecycle.destroyMachine(seeded.doc),
    ]) {
      const failure = await operation().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(VendoError);
      expect((failure as VendoError).code).toBe("sandbox-unavailable");
    }
    expect(bare.lifecycle.available()).toBe(false);
  });

  it("provision of an already-provisioned app stays idempotent without an adapter", async () => {
    // The machine field is already there; nothing needs the provider, so a
    // layer-2 document read stays available on an adapterless host.
    const { lifecycle, doc } = await setup({ doc: provisioned(), withAdapter: false });
    const result = await lifecycle.provision(doc);
    expect(result.machine?.snapshotRef).toBe("fake-v2:seeded");
  });
});

describe("machine lifecycle: egress allowlist policy (Lane E)", () => {
  it("provision passes the resolved allowlist to create", async () => {
    const { sandbox, lifecycle, doc } = await setup({
      allowedDomains: () => ["api.example.com", "host.vendo.test"],
    });
    await lifecycle.provision(doc);
    expect(sandbox.machines[0]?.allowedDomains).toEqual(["api.example.com", "host.vendo.test"]);
  });

  it("provision without a policy callback creates unrestricted (pre-Lane-E behavior)", async () => {
    const { sandbox, lifecycle, doc } = await setup();
    await lifecycle.provision(doc);
    expect(sandbox.machines[0]?.allowedDomains).toBeUndefined();
  });

  it("wake applies the CURRENT policy over the snapshot-time allowlist", async () => {
    let domains: string[] = ["api.example.com"];
    const { sandbox, lifecycle, doc } = await setup({ allowedDomains: () => [...domains] });
    await lifecycle.provision(doc);
    // A grant decided while the machine slept widens the policy…
    domains = ["api.example.com", "hooks.stripe.com"];
    const woken = await lifecycle.wake(doc);
    const raw = sandbox.machines.find((machine) => machine.id === woken.id);
    // …and the wake enforces it even though the snapshot carried the old list.
    expect(raw?.allowedDomains).toEqual(["api.example.com", "hooks.stripe.com"]);
  });

  it("a policy refusal blocks provision before any provider call", async () => {
    const { sandbox, lifecycle, doc } = await setup({
      allowedDomains: () => {
        throw new VendoError("blocked", "machine egress is not approved for: hooks.stripe.com");
      },
    });
    await expect(lifecycle.provision(doc)).rejects.toMatchObject({
      code: "blocked",
      message: expect.stringContaining("hooks.stripe.com"),
    });
    expect(sandbox.creates).toBe(0);
  });

  it("a policy refusal blocks wake before any provider call", async () => {
    let approved = true;
    const { sandbox, lifecycle, doc } = await setup({
      allowedDomains: () => {
        if (!approved) throw new VendoError("blocked", "machine egress is not approved for: api.example.com");
        return ["api.example.com"];
      },
    });
    await lifecycle.provision(doc);
    approved = false;
    await expect(lifecycle.wake(doc)).rejects.toMatchObject({ code: "blocked" });
    expect(sandbox.resumes).toBe(0);
  });
});
