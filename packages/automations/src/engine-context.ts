/**
 * The primitives `createAutomationsEngine`' closure holds, and the wiring that
 * builds its modules over them.
 *
 * `createAutomationsEngine` is an ASSEMBLER: every door it returns, and every
 * helper those doors lean on, lives in a module beside its contract. Each module
 * declares what it offers as its OWN interface, in its own file, and is handed
 * the other modules BY NAME — so a call site says where the function it calls
 * lives. `EngineBase` below is the only thing they all share.
 *
 * Internal — not exported from the package root.
 */
import { createAppRows, type AppRowsAccess } from "./app-rows.js";
import { createArmed, type ArmedAccess } from "./armed.js";
import { createConsent, type ConsentAccess } from "./consent.js";
import { createGrants, type GrantsAccess } from "./grants.js";
import { createRunExecution, type RunExecutionAccess } from "./run-execution.js";
import { createRunRows, type RunRowsAccess } from "./run-rows.js";
import { createSponsorshipGate, type SponsorshipGateAccess } from "./sponsorship-gate.js";
import type { AutomationsConfig } from "./index.js";

/** The closure primitives every module reads. */
export interface EngineBase {
  config: AutomationsConfig;
  /** The clock, through the testability seam. */
  now(): Date;
  /** The same clock, as the ISO string every row and event is stamped with. */
  iso(): string;
  /** Run ids `runs.stop` has claimed, so an in-flight copy lands as stopped. */
  stopped: Set<string>;
  /** Run ids currently executing in THIS process. */
  active: Set<string>;
  /** The agentic runs `runs.stop` can still cancel in this process. */
  abortControllers: Map<string, AbortController>;
  /** Whether THIS engine instance fires this trigger kind itself (07 §1). */
  firesLocally(kind: "schedule" | "external"): boolean;
}

/** The engine's modules, by name — what every surface is handed a slice of. */
export interface EngineModules {
  base: EngineBase;
  appRows: AppRowsAccess;
  armed: ArmedAccess;
  grants: GrantsAccess;
  runRows: RunRowsAccess;
  sponsorship: SponsorshipGateAccess;
  consent: ConsentAccess;
  execution: RunExecutionAccess;
}

/** 07 §1 — `createAutomationsEngine`' closure, wired in dependency order. */
export const createEngineModules = (config: AutomationsConfig): EngineModules => {
  const now = (): Date => config.now?.() ?? new Date();
  const iso = (): string => now().toISOString();
  const stopped = new Set<string>();
  const active = new Set<string>();
  const abortControllers = new Map<string, AbortController>();
  // Absent localTriggerKinds → every kind fires locally (today's behavior, unchanged).
  const firesLocally = (kind: "schedule" | "external"): boolean =>
    config.localTriggerKinds === undefined || config.localTriggerKinds.has(kind);

  const base: EngineBase = { config, now, iso, stopped, active, abortControllers, firesLocally };
  const appRows = createAppRows({ base });
  const armed = createArmed({ base, appRows });
  const grants = createGrants({ base });
  const runRows = createRunRows({ base });
  const sponsorship = createSponsorshipGate({ base, appRows });
  const consent = createConsent({ base, appRows, armed, grants, runRows });
  const execution = createRunExecution({ base, grants, runRows, sponsorship, consent });
  return { base, appRows, armed, grants, runRows, sponsorship, consent, execution };
};
