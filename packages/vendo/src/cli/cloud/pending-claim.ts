import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The pending-claim file (#479): a `vendo login` claim outlives the process
 * that opened it. Coding agents' processes often live exactly one turn — if
 * the poller dies and the human approves afterwards, the approval succeeds
 * server-side but the claim_token existed only in the dead process's memory.
 * Persisting the claim lets a fresh `vendo login` resume polling the SAME
 * claim, so the late approval still lands the key.
 */
export interface PendingClaim {
  claim_token: string;
  user_code: string;
  verification_uri_complete: string;
  /** Unix timestamp in milliseconds — computed from the ceremony's expires_in. */
  expires_at: number;
  /** Poll pacing in seconds (RFC 8628). */
  interval: number;
  /** The console the claim was opened against — resume only on a match. */
  api_url: string;
  /** Where the original run intended .env.local to land. */
  cwd: string;
}

export interface PendingClaimOptions {
  home?: string;
}

/** Claims are keyed by the project directory they were opened for. A single
    machine-global file let two concurrent `vendo login` runs clobber each
    other, and let project A resume (and receive the key for) project B's
    ceremony — found by the 0.4.1 E2E certification campaign. */
function pendingClaimPath(cwd: string, options: PendingClaimOptions = {}): string {
  const name = `${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`;
  return join(options.home ?? homedir(), ".vendo", "pending-claims", name);
}

/** The pre-0.4.2 machine-global location — read once for migration. */
function legacyPendingClaimPath(options: PendingClaimOptions = {}): string {
  return join(options.home ?? homedir(), ".vendo", "pending-claim.json");
}

function isPendingClaim(value: unknown): value is PendingClaim {
  if (typeof value !== "object" || value === null) return false;
  const claim = value as Partial<PendingClaim>;
  return typeof claim.claim_token === "string"
    && typeof claim.user_code === "string"
    && typeof claim.verification_uri_complete === "string"
    && typeof claim.expires_at === "number"
    && typeof claim.interval === "number"
    && typeof claim.api_url === "string"
    && typeof claim.cwd === "string";
}

async function readClaimFile(path: string): Promise<PendingClaim | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isPendingClaim(value) ? value : null;
  } catch {
    return null;
  }
}

/** An unreadable or malformed file reads as "no pending claim" — the caller
    discards it by opening (and persisting) a fresh ceremony. Only a claim
    opened for THIS cwd is ever returned. A pre-0.4.2 machine-global file is
    honored (and migrated) only when its recorded cwd matches; someone else's
    ceremony is never resumed. */
export async function readPendingClaim(cwd: string, options: PendingClaimOptions = {}): Promise<PendingClaim | null> {
  const scoped = await readClaimFile(pendingClaimPath(cwd, options));
  if (scoped !== null) return scoped.cwd === cwd ? scoped : null;

  const legacy = await readClaimFile(legacyPendingClaimPath(options));
  if (legacy === null || legacy.cwd !== cwd) return null;
  await writePendingClaim(legacy, options);
  await rm(legacyPendingClaimPath(options), { force: true });
  return legacy;
}

export async function writePendingClaim(claim: PendingClaim, options: PendingClaimOptions = {}): Promise<void> {
  const path = pendingClaimPath(claim.cwd, options);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deletePendingClaim(cwd: string, options: PendingClaimOptions = {}): Promise<void> {
  await rm(pendingClaimPath(cwd, options), { force: true });
}
