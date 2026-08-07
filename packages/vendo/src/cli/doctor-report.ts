import { doctorFixRef, type DoctorErrorCode } from "./doctor-codes.js";
import type { Output } from "./shared.js";

type CheckStatus = "ok" | "broken" | "warning";
/** Agent-install DX (design 2026-07-19 §CLI-3) — every check carries a stable
 *  id; failures and warnings additionally carry the registry error_code and a
 *  full fix_ref URL. Passing checks carry neither: a pass has no failure mode
 *  to anchor, so agents filter `status !== "ok"` and follow fix_ref. */
export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  error_code?: DoctorErrorCode;
  fix_ref?: string;
}

/** The ambient facts every check section reads, plus the four reporters they
 *  write through. Sections take this and nothing else where they can, so the
 *  order the checks array is built in stays visible in `runDoctor` rather than
 *  being spread across the file. */
export interface DoctorRun {
  /** The TARGET project's root (a resolved absolute path), not the shell cwd. */
  root: string;
  env: Record<string, string | undefined>;
  json: boolean;
  /** The wire base every live probe hangs off: origin + mount path. */
  statusUrl: string;
  fetchImpl: typeof fetch;
  checks: DoctorCheck[];
  failures: number;
  warnings: number;
  note: (message: string) => void;
  pass: (id: string, message: string) => void;
  fail: (id: string, code: DoctorErrorCode, message: string) => void;
  warn: (id: string, code: DoctorErrorCode, message: string) => void;
}

export function createDoctorRun(input: {
  root: string;
  env: Record<string, string | undefined>;
  json: boolean;
  statusUrl: string;
  fetchImpl: typeof fetch;
  output: Output;
}): DoctorRun {
  const { json, output } = input;
  const run: DoctorRun = {
    root: input.root,
    env: input.env,
    json,
    statusUrl: input.statusUrl,
    fetchImpl: input.fetchImpl,
    checks: [],
    failures: 0,
    warnings: 0,
    // In --json mode nothing but the final object may reach stdout; human lines
    // are suppressed and the same information rides the checks array instead.
    note: (message: string): void => { if (!json) output.log(message); },
    // Human lines stay exactly as before (the fix_ref URL is a machine
    // affordance; --json is the agent surface, so no per-line URL noise here).
    pass: (id: string, message: string): void => { run.checks.push({ id, status: "ok", message }); if (!json) output.log(`ok: ${message}`); },
    fail: (id: string, code: DoctorErrorCode, message: string): void => { run.failures += 1; run.checks.push({ id, status: "broken", message, error_code: code, fix_ref: doctorFixRef(code) }); if (!json) output.error(`broken: ${message}`); },
    warn: (id: string, code: DoctorErrorCode, message: string): void => { run.warnings += 1; run.checks.push({ id, status: "warning", message, error_code: code, fix_ref: doctorFixRef(code) }); if (!json) output.error(`warning: ${message}`); },
  };
  return run;
}

interface DoctorProbeBody {
  ok?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export async function probeBody(response: Response): Promise<DoctorProbeBody> {
  try {
    const body = await response.json() as unknown;
    return typeof body === "object" && body !== null ? body as DoctorProbeBody : {};
  } catch {
    return {};
  }
}
