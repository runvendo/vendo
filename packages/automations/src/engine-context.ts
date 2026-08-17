/**
 * The primitives `createAutomationsEngine`'s closure holds, and the wiring that
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
import { engineOverAdapter, type AgentRunners } from "@vendoai/core";
import { createAutomationRows, type AutomationRowsAccess } from "./automation-rows.js";
import { createConsent, type ConsentAccess } from "./consent.js";
import { createCreateSurface, type CreateSurfaceAccess } from "./create-surface.js";
import { createGrants, type GrantsAccess } from "./grants.js";
import { createRunExecution, type RunExecutionAccess } from "./run-execution.js";
import { createRunnerMap } from "./runner-map.js";
import type { EngineOps } from "./rows.js";
import { createRunRows, type RunRowsAccess } from "./run-rows.js";
import { createSponsorshipGate, type SponsorshipGateAccess } from "./sponsorship-gate.js";
import type { AutomationsConfig } from "./index.js";

/** The closure primitives every module reads. */
export interface EngineBase {
  config: AutomationsConfig;
  /** Vendo's OWN drawers, through the named `engine` family — the allowlist gate
   *  sits on every verb, so nothing outside it can be reached from here. Host and
   *  generated-app data is not this door's business. */
  engine: EngineOps;
  /** The clock, through the testability seam. */
  now(): Date;
  /** The same clock, as the ISO string every row and event is stamped with. */
  iso(): string;
  /** Run ids `runs.stop` has claimed, so an in-flight copy lands as stopped. */
  stopped: Set<string>;
  /** Run ids currently executing in THIS process. */
  active: Set<string>;
  /** The goal runs `runs.stop` can still cancel in this process. */
  abortControllers: Map<string, AbortController>;
}

/** The engine's modules, by name — what every surface is handed a slice of. */
export interface EngineModules {
  base: EngineBase;
  automations: AutomationRowsAccess;
  grants: GrantsAccess;
  runRows: RunRowsAccess;
  sponsorship: SponsorshipGateAccess;
  consent: ConsentAccess;
  execution: RunExecutionAccess;
  writes: CreateSurfaceAccess;
  runners: AgentRunners;
}

/** 07 §1 — `createAutomationsEngine`'s closure, wired in dependency order. */
export const createEngineModules = (config: AutomationsConfig): EngineModules => {
  const now = (): Date => config.now?.() ?? new Date();
  const iso = (): string => now().toISOString();

  // The composition's own 42-op surface when it resolved one; otherwise the same
  // seven verbs over the adapter the host handed us. An unset slot is a route,
  // not a downgrade.
  const engine = config.ops?.engine ?? engineOverAdapter(config.store);

  const base: EngineBase = {
    config,
    engine,
    now,
    iso,
    stopped: new Set(),
    active: new Set(),
    abortControllers: new Map(),
  };
  const runners = createRunnerMap();
  const automations = createAutomationRows({ base });
  const grants = createGrants({ base });
  const runRows = createRunRows({ base });
  const sponsorship = createSponsorshipGate({ base });
  const consent = createConsent({ base, automations, grants, runRows });
  const execution = createRunExecution({ base, grants, runRows, sponsorship, consent, runners });
  const writes = createCreateSurface({ base, automations });
  return { base, automations, grants, runRows, sponsorship, consent, execution, writes, runners };
};
