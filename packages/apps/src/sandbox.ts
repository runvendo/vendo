/**
 * execution-v2 Wave 1 Lane A — the sandbox seam
 * (docs/superpowers/specs/2026-07-19-execution-v2-design.md).
 *
 * The whole public contract between Vendo and a sandbox provider. The coding
 * agent lives INSIDE the box (Wave 3), so outside-the-box exec/files dropped
 * out of this seam; a provider adapter may keep them adapter-private for
 * bootstrap and diagnostics. The v1 seam this replaces is archived in
 * docs/archive/contracts/06-apps.md §3-4.
 */
export interface SandboxAdapter {
  /** Create a machine, optionally from a provider template, with its boundary env. */
  create(spec: {
    /** Provider template (base snapshot) to boot from; provider default when omitted. */
    template?: string;
    env: Record<string, string>;
    /**
     * Grant-style outbound-domain allowlist enforced at the provider network
     * layer. Undefined means unrestricted egress; an empty list denies all
     * egress. Wave 2 Lane E wires the approval flow on top of this knob.
     */
    allowedDomains?: string[];
  }): Promise<SandboxMachine>;

  /** Restore a machine from a provider-prefixed opaque snapshot reference (e.g. "e2b:…"). */
  resume(snapshotRef: string): Promise<SandboxMachine>;
}

export interface SandboxMachine {
  /** The provider-assigned machine identifier. */
  id: string;

  /**
   * Proxy one HTTP request to the box — the ONLY runtime data path into it.
   * Targets the app's $PORT by default; `port` overrides for a box serving
   * more than one listener.
   */
  request(req: {
    method: string;
    path: string;
    port?: number;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

  /** Persist the machine's current state; the ref restores it via SandboxAdapter.resume. */
  snapshot(): Promise<string>;

  /** Sleep: a snapshot-preserving pause where the provider supports it. */
  stop(): Promise<void>;

  /** Gone for good. Previously taken snapshot refs stay valid. */
  destroy(): Promise<void>;
}
