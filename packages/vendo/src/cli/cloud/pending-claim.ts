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

function pendingClaimPath(options: PendingClaimOptions = {}): string {
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

/** An unreadable or malformed file reads as "no pending claim" — the caller
    discards it by opening (and persisting) a fresh ceremony. */
export async function readPendingClaim(options: PendingClaimOptions = {}): Promise<PendingClaim | null> {
  try {
    const value: unknown = JSON.parse(await readFile(pendingClaimPath(options), "utf8"));
    return isPendingClaim(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writePendingClaim(claim: PendingClaim, options: PendingClaimOptions = {}): Promise<void> {
  const path = pendingClaimPath(options);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deletePendingClaim(options: PendingClaimOptions = {}): Promise<void> {
  await rm(pendingClaimPath(options), { force: true });
}
