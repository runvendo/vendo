/**
 * D5 — `vendo_delegate`'s motor, carried between the composition that builds it
 * and the two BYO shims that hand it to the tool pack.
 *
 * Internal wiring, not a host surface: a delegated run is the deployment's own
 * brain doing a whole task, and there is nothing for a host to swap or inspect —
 * so it stays off `Vendo` and rides a WeakMap keyed on the composition, the same
 * way `@vendoai/agents` carries what `agent()` composed.
 */
import { VendoError, type AgentRunner } from "@vendoai/core";
import type { Vendo } from "./server.js";

const runners = new WeakMap<Vendo, AgentRunner>();

export function setDelegateRunner(vendo: Vendo, runner: AgentRunner): void {
  runners.set(vendo, runner);
}

export function delegateRunner(vendo: Vendo): AgentRunner {
  const runner = runners.get(vendo);
  if (runner === undefined) {
    throw new VendoError(
      "validation",
      "the Vendo tool pack needs the composition `createVendo()` returned — `vendo_delegate` runs on the "
      + "brain that composition wired, and an object built by hand has none.",
    );
  }
  return runner;
}
