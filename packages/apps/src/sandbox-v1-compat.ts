/**
 * TEMPORARY execution-v2 transition surface — DELETE WITH THE LAST v1 PATH.
 *
 * Ownership (locked by the execution-v2 orchestrator at Wave 1 Lane A merge):
 * - Lane B deletes the machine.ts / runtime.ts / interchange.ts v1 usages.
 * - Lane C (Wave 5 for cloudSandbox) deletes the packages/vendo usages.
 * - Whichever of Lanes B/C merges LAST also deletes this file.
 *
 * These are the archived v1 seam shapes (docs/archive/contracts/06-apps.md
 * §3-4) kept only so the dying v1 code paths keep compiling and behaving
 * until their owning lanes replace them. Nothing new may import this module.
 */
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";

/** @deprecated v1 seam — see the header; new code uses the v2 create spec. */
export interface V1SandboxCreateSpec {
  env: Record<string, string>;
  /** @deprecated v1 initial-files seeding; the in-box agent replaced it. */
  files?: Record<string, Uint8Array | string>;
  /** @deprecated v1 name for the v2 create spec's allowedDomains. */
  egress?: string[];
}

/** @deprecated v1 seam — see the header; new code uses the v2 SandboxMachine. */
export interface V1SandboxMachine {
  id: string;
  request(req: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  exec(
    cmd: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array | string): Promise<void>;
    list(dir: string): Promise<string[]>;
  };
  snapshot(): Promise<string>;
  screenshot?(): Promise<Uint8Array>;
  url?(port: number): Promise<string>;
  /** v1 stop meant teardown; the bridge maps it to v2 destroy(). */
  stop(): Promise<void>;
}

/** @deprecated v1 seam — see the header; new code uses the v2 SandboxAdapter. */
export interface V1SandboxAdapter {
  create(spec: V1SandboxCreateSpec): Promise<V1SandboxMachine>;
  resume(snapshotRef: string): Promise<V1SandboxMachine>;
}

const isV2Machine = (machine: V1SandboxMachine | SandboxMachine): machine is SandboxMachine =>
  typeof (machine as Partial<SandboxMachine>).destroy === "function";

const wrapV1Machine = (machine: V1SandboxMachine | SandboxMachine): V1SandboxMachine => {
  if (!isV2Machine(machine)) return machine;
  // A pass-through Proxy so the dying v1 call sites (and their tests) keep
  // seeing the adapter's real machine — its fields, methods, and prototype —
  // with ONE override: v1 callers say stop() when they mean "this machine is
  // gone" (evict, post-snapshot teardown). v2 stop() is a snapshot-preserving
  // sleep, so passing it through would strand paused provider machines nobody
  // resumes. The adapter-private exec/files the in-repo adapters still carry
  // are reached through the same pass-through.
  return new Proxy(machine, {
    get(target, property, receiver) {
      if (property === "stop") return () => target.destroy();
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as V1SandboxMachine;
};

/**
 * @deprecated Bridge for the dying v1 call sites: presents any adapter —
 * v2-native (fake, e2b) or v1-native (cloudSandbox until Wave 5) — through
 * the archived v1 seam. The in-repo v2 adapters accept the v1 create spec's
 * files/egress as adapter-private compat, so v1 specs pass through unchanged.
 */
export const toV1SandboxAdapter = (
  adapter: SandboxAdapter | V1SandboxAdapter,
): V1SandboxAdapter => ({
  create: async (spec) =>
    wrapV1Machine(await (adapter as V1SandboxAdapter).create(spec)),
  resume: async (snapshotRef) => wrapV1Machine(await adapter.resume(snapshotRef)),
});
