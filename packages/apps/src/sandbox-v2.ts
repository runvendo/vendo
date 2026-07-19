/**
 * Execution-v2 sandbox seam — the shrunk shape recorded in the machine-model
 * plan: create-from-template, resume, request, snapshot, stop, destroy.
 * Outside-the-box exec/files dropped out of the public seam (the in-box agent
 * replaced them).
 *
 * OWNERSHIP: Wave 1 Lane A owns this seam and its e2b implementation; this
 * file is Lane B's build-against copy of the interface locked by the
 * execution-v2 orchestrator (Lane A's `sandbox.ts` shape plus adapter-level
 * destroy-by-ref), named *V2 so it cannot collide with the v1 `SandboxAdapter`
 * during the transition. Lane A merges first; Lane B's rebase swaps these
 * aliases for Lane A's canonical types — they must not stay duplicated past
 * Wave 1.
 */
export interface SandboxAdapterV2 {
  /** Boot a fresh machine from the provider's base template with its env. */
  create(spec: {
    /** Provider base template the machine boots from; provider default when absent. */
    template?: string;
    env: Record<string, string>;
    /** Grant-style outbound-domain allowlist enforced at the provider network layer. */
    allowedDomains?: string[];
  }): Promise<SandboxMachineV2>;

  /** Resume a machine from a provider-prefixed opaque snapshot reference. */
  resume(snapshotRef: string): Promise<SandboxMachineV2>;

  /** Release a sleeping machine's snapshot and every provider resource behind it,
   * without resuming it first. */
  destroy(snapshotRef: string): Promise<void>;
}

export interface SandboxMachineV2 {
  /** The provider-assigned machine identifier. */
  id: string;

  /** Proxy an HTTP request to the app's $PORT (`port` overrides for multi-listener boxes). */
  request(req: {
    method: string;
    path: string;
    port?: number;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

  /** Snapshot the machine for the app document's machine.snapshotRef field. */
  snapshot(): Promise<string>;

  /** Stop the machine without snapshotting. */
  stop(): Promise<void>;

  /** Destroy this LIVE machine for good; previously taken snapshot refs stay valid. */
  destroy(): Promise<void>;
}
