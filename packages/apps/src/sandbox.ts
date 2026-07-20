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

  /**
   * Restore a machine from a provider-prefixed opaque snapshot reference
   * (e.g. "e2b:…"). When `policy` is present its allowlist REPLACES whatever
   * egress policy the snapshot carries — the approved grant state may have
   * changed while the machine slept (Wave 2 Lane E), and a wake must enforce
   * the current policy, not the snapshot-time one. Absent policy restores the
   * snapshot-time behavior unchanged.
   */
  resume(snapshotRef: string, policy?: SandboxResumePolicy): Promise<SandboxMachine>;

  /**
   * Destroy a SLEEPING machine by its snapshot reference without resuming it:
   * afterwards resume(snapshotRef) fails and the provider holds no state for
   * it. Idempotent — a ref whose state is already gone is a no-op; a ref from
   * another provider rejects.
   */
  destroy(snapshotRef: string): Promise<void>;
}

/**
 * Wave 2 Lane E — the egress policy a wake applies over a snapshot's stored
 * one. The key is required on purpose: passing the object at all means "the
 * caller owns the policy now", and `allowedDomains: undefined` explicitly
 * means unrestricted egress (same semantics as create()).
 */
export interface SandboxResumePolicy {
  allowedDomains: string[] | undefined;
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

  /**
   * Wave 4 (layer 3) — the machine's PUBLIC ingress URL for a port, defaulting
   * to the app's $PORT. This is the browser→box serving path: the host embeds
   * it as a served app's surface. Absolute http(s); the host shape is the
   * provider's business (e.g. e2b's per-port public hostname).
   */
  url(port?: number): Promise<string>;

  /** Persist the machine's current state; the ref restores it via SandboxAdapter.resume. */
  snapshot(): Promise<string>;

  /** Sleep: a snapshot-preserving pause where the provider supports it. */
  stop(): Promise<void>;

  /** Gone for good. Previously taken snapshot refs stay valid. */
  destroy(): Promise<void>;
}
