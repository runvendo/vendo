/** 06-apps §3 */
export interface SandboxAdapter {
  /** 06-apps §3 — Create a machine with its run environment and optional initial files. */
  create(spec: {
    env: Record<string, string>;
    files?: Record<string, Uint8Array | string>;
    /**
     * 06-apps §4.3 additive adapter flag — provider-native outbound-domain
     * allowlist. Undefined means unrestricted egress; an empty list denies all egress.
     */
    egress?: string[];
  }): Promise<SandboxMachine>;

  /** 06-apps §3 — Resume a machine from a provider-prefixed opaque snapshot reference. */
  resume(snapshotRef: string): Promise<SandboxMachine>;
}

/** 06-apps §3 */
export interface SandboxMachine {
  /** 06-apps §3 — The provider-assigned machine identifier. */
  id: string;

  /** 06-apps §3 — Proxy an HTTP request to the app's $PORT. */
  request(req: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

  /** 06-apps §3 — Execute an agent editing command inside the machine. */
  exec(
    cmd: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;

  /** 06-apps §3 — Read, write, and list files in the machine filesystem. */
  files: {
    /** 06-apps §3 — Read a file as bytes. */
    read(path: string): Promise<Uint8Array>;
    /** 06-apps §3 — Write bytes or UTF-8 text to a file. */
    write(path: string, bytes: Uint8Array | string): Promise<void>;
    /** 06-apps §3 — List files beneath a directory. */
    list(dir: string): Promise<string[]>;
  };

  /** 06-apps §3 — Snapshot the machine after edits for the app document's server field. */
  snapshot(): Promise<string>;

  /** 06-apps §3 — Capture the optional rung-4 loading cover. */
  screenshot?(): Promise<Uint8Array>;

  /** Plan decision 2 — Resolve the rung-4 serving URL; without it ui:"http" cannot be served. */
  url?(port: number): Promise<string>;

  /** 06-apps §3 — Stop the machine. */
  stop(): Promise<void>;
}
