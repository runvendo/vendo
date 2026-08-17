/**
 * The named runner map: agents stay CODE and are never stored, so a record names
 * one by NAME and the map is what turns that name back into a brain.
 *
 * Two invariants, and both are about failing where somebody is looking:
 *  - registration is BOOT time, and a duplicate name THROWS there. Two agents
 *    answering to one name is an ambiguity nothing downstream can resolve, and
 *    discovering it at 2am means the wrong brain already ran.
 *  - lookup is FIRE time, and a miss is the caller's to report LOUDLY. There is
 *    deliberately no fallback brain: silently running someone's automation
 *    through a different agent than the one they named is worse than not
 *    running it, because nobody would ever find out.
 */
import { VendoError, type AgentRunner, type AgentRunners } from "@vendoai/core";

export const createRunnerMap = (): AgentRunners => {
  const runners = new Map<string, AgentRunner>();
  return {
    register(name, runner) {
      if (runners.has(name)) {
        throw new VendoError("conflict", `two agents are registered as "${name}" — agent names must be unique`);
      }
      runners.set(name, runner);
    },
    get: (name) => runners.get(name),
  };
};
