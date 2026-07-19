import { afterEach, describe, expect, it } from "vitest";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

const decoder = new TextDecoder();
const TEST_TIMEOUT_MS = 180_000;

/**
 * The conformance app every harness must install in the box (on $PORT):
 * - `GET /conformance/env/<NAME>` → 200, body = the box's value for env NAME
 * - `POST /fn/echo` → 200, body echoed back
 * - `GET /conformance/egress/<host>` → 200 JSON `{"allowed": boolean}` — an
 *   outbound `https://<host>` attempt (real or provider-faithfully simulated)
 */
export interface SandboxConformanceHarness {
  makeAdapter(): SandboxAdapter | Promise<SandboxAdapter>;
  /**
   * Install the conformance app in a freshly created machine through
   * provider-private means (in production the in-box agent owns the inside of
   * the box; here it is test scaffolding — e.g. adapter-private exec for a
   * live provider, an in-process handler for the fake).
   */
  bootstrap(machine: SandboxMachine): Promise<void>;
  /** True when the adapter enforces create()'s allowedDomains; enables the egress case. */
  enforcesAllowedDomains: boolean;
}

const requestEventually = async (
  machine: SandboxMachine,
  req: Parameters<SandboxMachine["request"]>[0],
): Promise<{ status: number; body: string }> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await machine.request(req);
      if (response.status >= 200 && response.status < 500) {
        expect(response.body).toBeInstanceOf(Uint8Array);
        return { status: response.status, body: decoder.decode(response.body) };
      }
      failure = new Error(`sandbox listener answered ${response.status} for ${req.path}`);
    } catch (error) {
      failure = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw failure ?? new Error(`sandbox listener did not serve ${req.path}`);
};

/** True when the machine no longer serves the given env value (asleep, dead, or wrong box). */
const noLongerServes = async (
  machine: SandboxMachine,
  req: Parameters<SandboxMachine["request"]>[0],
  value: string,
): Promise<boolean> => {
  try {
    const response = await machine.request(req);
    return response.status !== 200 || decoder.decode(response.body) !== value;
  } catch {
    return true;
  }
};

/** execution-v2 sandbox-seam conformance suite shared by the fake and live adapters. */
export const sandboxAdapterConformance = (
  name: string,
  harness: SandboxConformanceHarness,
): void => {
  describe(`${name} SandboxAdapter conformance`, () => {
    const spawned: SandboxMachine[] = [];
    const track = <T extends SandboxMachine>(machine: T): T => {
      spawned.push(machine);
      return machine;
    };
    const mintedRefs: Array<{ adapter: SandboxAdapter; ref: string }> = [];
    const mint = async (adapter: SandboxAdapter, machine: SandboxMachine): Promise<string> => {
      const ref = await machine.snapshot();
      mintedRefs.push({ adapter, ref });
      return ref;
    };

    // The gate's own rule: destroy every sandbox we create — and every
    // snapshot we mint — even on failure.
    afterEach(async () => {
      await Promise.all(spawned.splice(0).map((machine) => machine.destroy().catch(() => undefined)));
      await Promise.all(mintedRefs.splice(0).map(({ adapter, ref }) => adapter.destroy(ref).catch(() => undefined)));
    }, TEST_TIMEOUT_MS);

    it("creates, serves on $PORT, snapshots, sleeps, resumes, and destroys", async () => {
      const adapter = await harness.makeAdapter();
      const created = track(await adapter.create({
        env: { PORT: "8080", CONFORMANCE_VALUE: "present" },
      }));
      await harness.bootstrap(created);

      const envRequest = { method: "GET", path: "/conformance/env/CONFORMANCE_VALUE" };
      await expect(requestEventually(created, envRequest))
        .resolves.toMatchObject({ status: 200, body: "present" });
      const echoed = await created.request({ method: "POST", path: "/fn/echo", body: "round-trip" });
      expect(echoed.status).toBe(200);
      expect(decoder.decode(echoed.body)).toBe("round-trip");

      const snapshotRef = await mint(adapter, created);
      // The seam requires provider-prefixed refs (e.g. "e2b:…"); the prefix
      // spelling beyond that is the provider's business.
      expect(snapshotRef).toMatch(/^[A-Za-z][A-Za-z0-9_-]*:.+/);

      await created.stop();
      await created.stop(); // sleeping twice is not an error
      expect(await noLongerServes(created, envRequest, "present")).toBe(true);

      // A fresh adapter instance restores the ref: env and app carried.
      const resumed = track(await (await harness.makeAdapter()).resume(snapshotRef));
      expect(resumed.id).not.toBe(created.id);
      await expect(requestEventually(resumed, envRequest))
        .resolves.toMatchObject({ status: 200, body: "present" });

      // destroy() works on a sleeping machine and is idempotent.
      await created.destroy();
      await created.destroy();
      await resumed.destroy();
      expect(await noLongerServes(resumed, envRequest, "present")).toBe(true);
    }, TEST_TIMEOUT_MS);

    it("resumes one snapshot into independent machines", async () => {
      const adapter = await harness.makeAdapter();
      const source = track(await adapter.create({
        env: { PORT: "8080", CONFORMANCE_VALUE: "independent" },
      }));
      await harness.bootstrap(source);
      const envRequest = { method: "GET", path: "/conformance/env/CONFORMANCE_VALUE" };
      await requestEventually(source, envRequest);
      const ref = await mint(adapter, source);

      // The source keeps serving after the snapshot...
      await expect(requestEventually(source, envRequest))
        .resolves.toMatchObject({ status: 200, body: "independent" });

      const left = track(await adapter.resume(ref));
      const right = track(await adapter.resume(ref));
      expect(new Set([source.id, left.id, right.id]).size).toBe(3);
      await requestEventually(left, envRequest);

      // ...and destroying one resume leaves its sibling alive.
      await left.destroy();
      await expect(requestEventually(right, envRequest))
        .resolves.toMatchObject({ status: 200, body: "independent" });
    }, TEST_TIMEOUT_MS);

    it("routes requests to the box $PORT by default, honoring an explicit port", async () => {
      const adapter = await harness.makeAdapter();
      const machine = track(await adapter.create({
        env: { PORT: "9090", CONFORMANCE_VALUE: "ported" },
      }));
      await harness.bootstrap(machine);
      const envPath = "/conformance/env/CONFORMANCE_VALUE";
      await expect(requestEventually(machine, { method: "GET", path: envPath }))
        .resolves.toMatchObject({ status: 200, body: "ported" });
      await expect(requestEventually(machine, { method: "GET", path: envPath, port: 9090 }))
        .resolves.toMatchObject({ status: 200, body: "ported" });
      // A port nothing listens on never reaches the app.
      expect(await noLongerServes(machine, { method: "GET", path: envPath, port: 9099 }, "ported"))
        .toBe(true);
    }, TEST_TIMEOUT_MS);

    it.skipIf(!harness.enforcesAllowedDomains)(
      "enforces the create-time allowedDomains egress allowlist",
      async () => {
        const adapter = await harness.makeAdapter();
        const machine = track(await adapter.create({
          env: { PORT: "8080" },
          allowedDomains: ["example.com"],
        }));
        await harness.bootstrap(machine);
        const attempt = async (host: string): Promise<boolean> => {
          const result = await requestEventually(machine, {
            method: "GET",
            path: `/conformance/egress/${host}`,
          });
          return (JSON.parse(result.body) as { allowed: boolean }).allowed;
        };
        expect(await attempt("example.com")).toBe(true);
        expect(await attempt("vendo.run")).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    it("rejects a snapshot ref it did not issue", async () => {
      const adapter = await harness.makeAdapter();
      await expect(adapter.resume("bogus:not-a-real-ref")).rejects.toThrow();
      await expect(adapter.destroy("bogus:not-a-real-ref")).rejects.toThrow();
    }, TEST_TIMEOUT_MS);

    it("destroys a sleeping machine by ref, without resuming it", async () => {
      const adapter = await harness.makeAdapter();
      const machine = track(await adapter.create({
        env: { PORT: "8080", CONFORMANCE_VALUE: "sleeping" },
      }));
      const ref = await mint(adapter, machine);
      await machine.stop();

      await adapter.destroy(ref);
      await adapter.destroy(ref); // destroying already-destroyed state is a no-op
      await expect(adapter.resume(ref)).rejects.toThrow();
    }, TEST_TIMEOUT_MS);
  });
};
