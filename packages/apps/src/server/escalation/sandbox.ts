/**
 * execution-v2 Wave 1 Lane A — the sandbox seam.
 *
 * The whole public contract between Vendo and a sandbox provider. The coding
 * agent lives INSIDE the box (Wave 3), so outside-the-box `exec` dropped out of
 * this seam; a provider adapter may keep it adapter-private for bootstrap and
 * diagnostics. `files` came BACK: a built app's source has to leave the box,
 * and every adapter had grown its own private copy of the same three
 * operations. The v1 seam this replaces is in git history.
 */
export interface SandboxAdapter {
  /** Create a machine, optionally from a provider template, with its boundary env. */
  create(spec: {
    /** Provider template (base snapshot) to boot from; provider default when omitted. */
    template?: string;
    env: Record<string, string>;
    /**
     * Grant-style outbound-domain allowlist, filtered at the provider network
     * layer. Undefined means unrestricted egress; an empty list asks for
     * everything to be filtered out. Wave 2 Lane E wires the approval flow on
     * top of this knob.
     *
     * This states what the provider is ASKED for, not what it guarantees. e2b
     * matches on the requested server name, so the filter holds against
     * ordinary clients and is bypassed by one that omits SNI. Callers should
     * treat it as defence in depth, not as containment.
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
   *
   * Wave 7 — the dead-machine signal: when the PROVIDER's machine state is
   * gone (TTL expiry, idle sweep), the adapter throws VendoError "not-found"
   * instead of relaying a gateway status. App-level responses (including the
   * app's own 4xx/5xx) always come back as `status`, never as a throw, so a
   * thrown not-found is unambiguous — the machine lifecycle keys its
   * evict-and-re-wake recovery on it.
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

  /**
   * The box's filesystem — the seam a built app's SOURCE crosses. The in-box
   * agent owns the inside of the box, but the bytes it produces have to come
   * back out: this is what §3.2's commit reads a built app's source through,
   * and what puts scaffolding in before the agent starts. Three operations,
   * identical for every provider — it used to be adapter-private, which meant
   * five private spellings (or absences) of the same thing.
   *
   * - `read` REJECTS for a path the box does not hold. It never answers empty
   *   bytes: a silently empty source file is a lost app.
   * - `write` creates or REPLACES the whole file, and creates the directories
   *   on the way to it. It never appends.
   * - `list` is ONE level and names only — the entry names directly in `dir`,
   *   a subdirectory as its own name, never a path and never recursive. It
   *   REJECTS for a directory the box does not hold, exactly as `read` does:
   *   answering `[]` there lets a mistyped source directory read as an app
   *   with no files. `"/"` is the one directory that always exists, so it
   *   answers the box's top-level names and never rejects.
   *
   * Box content is UNTRUSTED. A compromised or merely buggy in-box agent
   * controls every path and every byte crossing this seam, so `read` hands
   * bytes back UNCHANGED — no text decode, no BOM strip, no line-ending
   * normalization — and the layer above verifies them against the hash in the
   * app's row. Confining which paths may become an app's source is that layer's
   * job too (`app-source.ts`), not this one's: a box's own filesystem is not
   * partitioned, and the bootstrap legitimately writes outside the app root.
   */
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, bytes: Uint8Array | string): Promise<void>;
    list(dir: string): Promise<string[]>;
  };

  /** Persist the machine's current state; the ref restores it via SandboxAdapter.resume. */
  snapshot(): Promise<string>;

  /** Sleep: a snapshot-preserving pause where the provider supports it. */
  stop(): Promise<void>;

  /** Gone for good. Previously taken snapshot refs stay valid. */
  destroy(): Promise<void>;
}
