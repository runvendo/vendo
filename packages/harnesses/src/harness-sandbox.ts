/**
 * How a boot-constructed harness reaches a COMPOSED adapter.
 *
 * `harness: claudeCode()` is written by the HOST, at boot, where no `createVendo`
 * composition exists yet — the same gap that made the documented `harness:
 * vendo()` opt-in think with a zero-character prompt (contract §1 amendment).
 * `Turn` is frozen and carries no adapter slot, and design §3's law is that
 * host-side dependencies "arrive by factory closure", so a harness that wants a
 * sandbox may simply be handed one: `claudeCode({ sandbox })`.
 *
 * This is the other half — for the host who wired `createVendo({ sandbox })` and
 * reasonably expects `requires: { sandbox: true }` to MEAN something. Composition
 * fills the slot once, keyed by the harness value itself, and the harness reads
 * it at turn time. Deployment-scoped, not per-turn: the adapter is a deployment
 * fact, so there is nothing here that could attribute one user's machine to
 * another user's thread.
 *
 * A `WeakMap` rather than an `AsyncLocalStorage` deliberately — ALS would have to
 * survive `createUIMessageStream`'s deferral of `execute`, and a slot that is
 * silently empty is exactly the failure mode this file exists to close.
 */
import type { AppId, Finding, Harness, TurnTools, WorkspaceFs } from "@vendoai/core";

/**
 * The host's own MCP door, as a harness that runs a MACHINE needs it.
 *
 * A boxed harness cannot hold the guard-bound registry — the registry is the
 * host's, and the box is deliberately credential-free. Before door-ctx it
 * reached the registry through an inverted HTTP bridge the host polled; now it
 * reaches the SAME `turn.tools` over the host's own MCP door, using a credential
 * this port mints (10-mcp §3b).
 *
 * The credential states nothing and grants nothing on its own: it is a pointer
 * at "the turn currently in flight on thread T", mintable only from inside such
 * a turn, and dead the moment that turn ends.
 */
export interface ToolDoorPort {
  /** The door's canonical absolute URL, or undefined when this deployment has no
   *  public base a machine could reach (`VENDO_BASE_URL` unset). */
  readonly url: string | undefined;
  /**
   * Did COMPOSITION mount this door on the harness's behalf, or did the HOST
   * ask for one? The two look identical from here and mean opposite things when
   * `url` is undefined:
   *
   *   host-configured (`mcp` set) + unreachable → a misconfiguration. The
   *     operator believes their product's tools are live and they are not, so
   *     the turn is refused rather than silently under-served.
   *   auto-mounted + unreachable → not a misconfiguration at all. The harness
   *     declares `requires.toolDoor`, so composition mounts the internal half
   *     with no config value in sight; a deployment that never named an origin
   *     is simply workspace-only, which is a supported shape.
   *
   * Absent counts as host-configured: this fails CLOSED, so a port built by
   * anything that has not thought about the distinction keeps the refusal.
   */
  readonly autoMounted?: boolean;
  /** Mint a credential for one conversation. `undefined` outside a live turn of
   *  that thread — the subject is READ from the turn, never named by a caller. */
  mint(threadId: string): string | undefined;
  revoke(token: string): void;
}

/**
 * The hot-path vocabulary, as a machine-backed driver needs it: which shapes to
 * watch on the machine's disk mid-turn, and which paths count as hot when the
 * collected files come home.
 *
 * Injected — this package no longer depends on `@vendoai/apps`, where the real
 * vocabulary (`HOT_PATH_WATCH`, `hotPathAppId`) lives. Composition hands the
 * driver the real one; a bare host-driven runtime without it simply has no
 * mid-turn hot sync, and the driver says so once.
 */
export interface HotPathsPort {
  /** Watch shapes for the machine's mid-turn collect (`*` = one segment). */
  watch: readonly string[];
  /** The appId a hot-path write belongs to, or undefined if this is not one. */
  appId(path: string): string | undefined;
}

/** One app document that did not pass the validate gate — a structural mirror
 *  of `AppValidationFailure` in `@vendoai/apps` (validate-gate.ts). Restated
 *  because this package no longer imports apps; the composition site assigns
 *  the real functions into {@link HarnessAdapters}, so drift between the two
 *  shapes fails to compile there, by name. */
export interface AppValidationFailureLike {
  path: string;
  appId: AppId;
  findings: readonly Finding[];
}

/** The composed adapters a harness may be handed. Mirrors `ComposedAdapters`
 *  (the boot gate's view), plus the MCP door a machine-backed harness needs. */
export interface HarnessAdapters {
  /** `SandboxAdapter` from `@vendoai/apps`; typed loosely so the root entry of
   *  this package never pulls a provider SDK into scope. */
  sandbox?: unknown;
  /** The host's MCP door, for a harness whose thinker runs on a machine. */
  toolDoor?: ToolDoorPort;
  /** vendo()'s tool-search strategy (`VendoToolSearchConfig` on the vendo
   *  subpath); typed loosely for the same reason as `sandbox` — the slot is a
   *  drawer, not a contract. */
  toolSearch?: unknown;
  /** The hot-path vocabulary (`HOT_PATH_WATCH` + `hotPathAppId` in apps). */
  hotPaths?: HotPathsPort;
  /** The builder's validate gate (`validateWrittenApps` in apps). Property
   *  style, not method style, so `strictFunctionTypes` checks the assignment
   *  at the composition site in both directions. */
  validateApps?: (input: {
    tools: Pick<TurnTools, "call">;
    workspace: Pick<WorkspaceFs, "readFile">;
    paths: readonly string[];
    review?: boolean;
  }) => Promise<readonly AppValidationFailureLike[]>;
  /** The gate's failures as one instruction (`repairInstruction` in apps). */
  repairInstruction?: (failures: readonly AppValidationFailureLike[]) => string | undefined;
}

const slots = new WeakMap<object, HarnessAdapters>();

/** Composition's call, once, at `createVendo` time. */
export function provideHarnessAdapters(harness: object, adapters: HarnessAdapters): void {
  slots.set(harness, { ...slots.get(harness), ...adapters });
}

/** The harness's call, at turn time. Empty when the host composed nothing. */
export function harnessAdapters(harness: Harness<never> | object): HarnessAdapters {
  return slots.get(harness as object) ?? {};
}
