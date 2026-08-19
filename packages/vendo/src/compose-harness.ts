/**
 * Architecture §3 — WHO THINKS, composed ONCE, and the runtime that serves
 * every turn through it: the harness itself, where its thinker dials the tool
 * door, the turn runtime, the `ready()`-latched door the host and the wire
 * share, and `vendo_delegate`'s motor.
 */
import { awayRunner } from "@vendoai/agents";
import { CONNECTOR_DISCOVERY_TOOLS, VENDO_MAKE_TOOL, type AgentRunner, type Harness } from "@vendoai/core";
import { assertHarnessComposable, vendo } from "@vendoai/harnesses";
import type { VendoComposition } from "./compose-context.js";
import { storeServesHarnessTurns } from "./compose-store.js";
import { MCP_MOUNT } from "./door-paths.js";
import { createHarnessTurns, type HarnessTurns } from "./harness-turn.js";
import { assembleSystemPrompt, discoveryRail } from "./prompt.js";
import { withAgentMenu } from "./surface-menu.js";
import { VENDO_TEXT_ME_TOOL } from "./text-me.js";
import { registerTurnSteer } from "./turn-liveness.js";

/** The tools the OPERATING PROMPT teaches by name — product knowledge, declared
 *  here so the general harness carries none of it (tool-search.ts exempts only
 *  its own capability-miss hand).
 *
 *  `vendo_text_me` is here for the OTHER reason, and it is the first honoring of
 *  a contract nothing implemented: types.ts's `loadout` doc says "Vendo's own
 *  `vendo_*` tools are always active" and no code ever made it so. Maple's away
 *  surface is 25 reads and 6 writes, so the 24-tool safest-first slice evicts
 *  EVERY write — twice in two days (2026-08-18/19) an automation armed with a
 *  live Text me grant answered "I don't have a way to send a text message". A
 *  granted power the belt hides is a lie the person who granted it cannot see.
 *  Restoring the whole contract belongs to the loadout redesign; the one tool
 *  that broke production does not wait for it.
 *
 *  A name with nothing behind it costs nothing: `computeInitialLoadout` filters
 *  the turn's OWN listings through this set (tool-search.ts), so on a deployment
 *  that never opted into texts it simply never matches — no `channels` gate. */
const PROMPT_TAUGHT_TOOLS: readonly string[] = [
  VENDO_MAKE_TOOL,
  VENDO_TEXT_ME_TOOL,
  ...CONNECTOR_DISCOVERY_TOOLS,
];

const withPromptTaughtTools = (
  toolSearch: VendoComposition["toolSearch"],
): VendoComposition["toolSearch"] => ({ ...toolSearch, alwaysActive: PROMPT_TAUGHT_TOOLS });

/** The thinker, the door it may dial, and the boot gate between them. */
const resolveHarnessDoor = (composition: VendoComposition): Pick<VendoComposition,
  "harness" | "mcpOptions" | "internalDoorOnly" | "doorBase"> => {
  const { config, composed, sandbox, configuredBaseUrl, toolSearch } = composition;
  // Architecture §3 — WHO THINKS, composed ONCE.
  //
  // This used to be two constructions: a throwaway `vendo()` here for the boot
  // gate, and a second configured `vendo()` inside harness-turn.ts as the
  // fallback that actually ran. The gate was therefore asserting a value that
  // was never served. One value now, resolved here and passed down, so the
  // harness the gate checks IS the harness the turn runs.
  //
  // `assertHarnessComposable` is the BOOT gate: a harness that needs a machine to
  // live on and has none is a wiring mistake the host hears about here, not a turn
  // that dies in front of a user. Checked against the resolved harness because a
  // default is still a choice that has to hold.
  // A composed agent IS a harness choice (its brain, with its knobs already
  // bound and its sandbox already injected), so it takes the same slot.
  //
  // The loop's context knobs (`maxSteps`, `historyWindow`, `maxOutputTokens`,
  // `contextTokenBudget`) belong to whoever thinks, so they are set where the
  // thinker is named — `harness: vendo({ maxSteps: 40 })`. They used to be
  // createVendo's own `agent:` knobs, which meant a host configured the thinker
  // through a key the thinker never saw.
  // The default brain gets its tool-search strategy at construction: the same
  // registry search and loadout knobs the old runtime rail read, now the
  // brain's own hand (a host-constructed `vendo()` receives them through the
  // composed adapter slot instead — harness-turn.ts).
  const harness = (composed?.harness ?? config.harness
    ?? vendo({ toolSearch: withPromptTaughtTools(toolSearch) })) as Harness;
  assertHarnessComposable(harness, sandbox.adapter === undefined ? {} : { sandbox: sandbox.adapter });
  // The harness runtime, wired to everything a turn needs: the store handle (its
  // transcript and its workspace), the ONE guard-bound registry, the merged pack
  // skills projected into `/host/skills`, and the resolved model seats. The
  // per-turn halves it cannot know (thread, workspace, ctx-shaped prompt and
  // descriptor catalog) are resolved in harness-turn.ts.
  // Hoisted above the harness runtime: a harness whose thinker runs on a
  // MACHINE needs to know whether a door exists at all before it can be told
  // where to reach it. `mcp: true` and `mcp: {…}` both open the door; the
  // object form carries door options.
  const mcpOptions = typeof config.mcp === "object" && config.mcp !== null
    ? config.mcp
    : config.mcp === true
      ? {}
      : undefined;
  /**
   * THE COMPOSITION RULE — the two decisions are decoupled.
 *
   * `mcp` is the host saying "my users may connect third-party agents to my
   * product", and it opens the whole door. A harness that thinks outside this
   * process reaches `turn.tools` over the same door (10-mcp §3b) and needs one
   * whether or not the host ever said that — so declaring `requires.toolDoor`
   * mounts the INTERNAL half by itself, with no config value to write and
   * nothing exposed. `mcp` set wins: the full door already serves both spaces.
   */
  const internalDoorOnly = mcpOptions === undefined && harness.requires?.toolDoor === true;
  /**
   * `composition.learnedLoopbackOrigin` is the one origin a machine-less thinker
   * may dial when the operator named
   * none — learned from the wire, and kept separate from the base route
   * bindings resolve against because the two answer different questions.
 *
   * A request origin is the Host header, which the caller controls. Both
   * learners are therefore fenced to LOOPBACK, and each is fixed by the first
   * request that qualifies: a spoofed `Host: attacker.evil` is never a
   * candidate, and a second loopback Host cannot displace the first. Loopback
   * is exactly where a machine-less thinker's subprocess lives, so zero-config
   * development loses nothing.
 *
   * This one gates whether a turn credential may be MINTED against an origin;
   * `baseUrlTrusted` below gates whether the CALLER's cookie and bearer may
   * ride one. Both were poisonable before they were fenced.
   */
  /**
   * Where the harness's thinker dials the door.
 *
   * The operator-set public origin is the only one a MACHINE may ever be given:
   * a box holding a live turn credential must never be pointed anywhere a
   * request header could name, and loopback is not reachable from a box in any
   * case. A harness that needs NO machine thinks inside this host's own
   * process, so it may fall back to the learned loopback origin — which is what
   * lets `claudeCode({ machine: "local" })` run with nothing configured at all.
 *
   * This rule is about the HARNESS's door target, so it applies identically to
   * an `mcp: true` composition and to an internal-only one.
   */
  const doorBase = (): string | undefined => mcpOptions?.baseUrl
    ?? configuredBaseUrl
    ?? (harness.requires?.sandbox === true ? undefined : composition.learnedLoopbackOrigin);
  return { harness, mcpOptions, internalDoorOnly, doorBase };
};

/** The per-turn seams that reach this process's own doors: the live-turn
 *  publication and where an outside thinker dials. */
const harnessTurnDoorSeams = (
  composition: VendoComposition,
): Partial<Parameters<typeof createHarnessTurns>[0]> => {
  const { mcpOptions, internalDoorOnly, doorBase } = composition;
  return {
    // Every turn, published for the door's turn credential. Publishing is not a
    // grant: without a credential minted from inside the turn there is nothing
    // to resolve, and the credential's authority window IS this publication.
    // The steer sink rides the same publication for the same reason: both are
    // "reach the turn in flight from this process's own doors", and both die with
    // the turn.
    liveTurn: ({ threadId, ctx, tools, steer }) => {
      const unpublish = composition.turnCredentials.publish(threadId, { ctx, tools });
      const unregister = registerTurnSteer({ threadId, subject: ctx.principal.subject, steer });
      return () => {
        unregister();
        unpublish();
      };
    },
    // The other half, for a harness whose thinker is not in this process: where
    // the door is, and how to mint one conversation's credential for it. `url`
    // is undefined when nothing this harness may dial exists — a machine cannot
    // reach a door nobody can name, and the harness says so in the operator's
    // voice rather than opening a session that would 401 on its first tool call.
    // Read per turn, not captured: with no operator base the origin is learned
    // from the wire's first validated request, which is the one that arrives.
    ...(mcpOptions !== undefined || internalDoorOnly ? {
      toolDoor: {
        get url(): string | undefined {
          const base = doorBase();
          return base === undefined ? undefined : new URL(MCP_MOUNT, base).toString();
        },
        // Which of the two mounts this is, stated rather than inferred. With no
        // origin the harness has to tell a host whose `mcp` cannot be reached
        // (refuse — they asked for a door) from a host who never asked at all
        // (run workspace-only — nothing is misconfigured). `internalDoorOnly`
        // is exactly that fact and it is only known HERE.
        autoMounted: internalDoorOnly,
        mint: (threadId: string) => composition.turnCredentials.mint(threadId),
        revoke: (token: string) => composition.turnCredentials.revoke(token),
      },
    } : {}),
  };
};

/** Everything a turn needs that this composition already holds. */
const harnessTurnConfig = (
  composition: VendoComposition,
): Parameters<typeof createHarnessTurns>[0] => {
  const { harness, sandbox, store, files, guard, boundTools, capability, catalog } = composition;
  const { inference, system, toolSearch, capabilityMiss } = composition;
  const { serviceCatalog, toolOutputCap, connectGate, membershipsSeam } = composition;
  // The host's `surfaces.agent` menu, bound at the harness door's registry
  // handle so it curates EVERY brain's `turn.tools.list()` — see withAgentMenu.
  // `agentMenu` is composed after this phase (compose-discovery.ts) and only
  // read inside a request, hence the lazy property read.
  const menuBoundTools = withAgentMenu(boundTools, () => composition.agentMenu());
  return {
    harness: harness as Harness<never>,
    // The composed sandbox adapter, threaded through so a spawned harness's
    // machine slot is filled by the SAME adapter the boot gate approved.
    // Without this line, `createVendo({ sandbox, harness: claudeCode() })`
    // boots green and then refuses every turn (wave-2 lane E blocker B2).
    ...(sandbox.adapter === undefined ? {} : { sandbox: sandbox.adapter }),
    store,
    // The SAME adapter the erase cascade deletes through (selectStore) — the
    // whole point of resolving it once.
    files,
    guard,
    tools: menuBoundTools,
    skills: capability.skills,
    // The SAME normalized catalog the prompt summary is built from, so the
    // reference files on the mount and the components the model is told about
    // can never name different sets.
    catalog,
    models: inference.seats,
    // The CONVERSATIONAL prompt, and only that. The host's theme and design
    // rules used to be appended here too, on the belief that `claudeCode()` was
    // the builder; it is the HARNESS that runs a box, and the two rungs that
    // really write apps read the briefing pack (compose-surfaces.ts). A thinker
    // that talks to the person is told what the product is and what its screens
    // look like by `assembleSystemPrompt` itself — appending the pack on top
    // would repeat the brief and the catalog it already carries.
    system: async (ctx, opts) => await assembleSystemPrompt(
      guard,
      ctx,
      system,
      // The miss reporter is a runtime rail and `find_tools` is vendo()'s own
      // hand, so the prompt may promise them — and must, or the model is handed
      // either with no instructions. WHICH discovery section rides is the
      // turn's to say (a prompt-only signal now, keyed on `toolSurface.curated`
      // in harness-turn.ts): an uncurated surface has no `find_tools`, so
      // teaching it would name a tool that is not there.
      true,
      opts?.discovery ?? "find-tools",
    ),
    // vendo()'s tool-search strategy (for the composed adapter slot) and the
    // honest-refusal rail, defined once (compose-prompt.ts). Same product
    // exemptions as the boot-time construction above — one declaration.
    toolSearch: withPromptTaughtTools(toolSearch),
    capabilityMiss,
    // The SAME condition the catalog pair is gated on above. The section teaches
    // `find_service_tools` and `use_service_tool` by name, so it rides only where
    // they are projected — a deployment with `list_connections` alone (the
    // zero-key Cloud default) is taught nothing rather than two tools that are
    // not on its listing.
    connectorDiscovery: serviceCatalog,
    bridge: () => ({ toolOutputCap, preflight: (call, ctx) => connectGate.check(call, ctx) }),
    // §7.1's floor and — contract §3.2 — the app's SOURCE half beside it, on the
    // SAME interception point. Without the floor nothing checks a harness's own
    // writes and nothing paints: the gauntlet's own `ok` is what upserts the row
    // that makes a written file an app. Without `commitSource` the app's CODE has
    // no home but the sandbox snapshot behind `machine.snapshotRef` — lose the
    // snapshot and the customer's app is gone, because the store never had it.
    render: (ctx) => ({
      commitSource: (input) => composition.apps.commitSource(input, ctx),
      floor: composition.apps.floor(ctx),
    }),
    // Build contract §9.1/§9.7 — the same host org query the wire resolves per
    // request, so a harness turn's façade mounts the team's files too.
    ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
    ...(composition.limiter === undefined ? {} : { limiter: composition.limiter }),
    ...harnessTurnDoorSeams(composition),
  };
};

/**
 * THE harness door — one object, served two ways.
 *
 * `vendo.harness` (the host's/proofs' direct handle) and the wire's chat route
 * are the SAME value. They used to be two: the returned door wrapped the
 * `ready()` latch around `harnessTurns`, and `createWireHandler` was handed the
 * raw one. That was harmless while the wire path was opt-in and the wire
 * awaited `ready()` itself, but the wave-2 flip makes this the path every host
 * takes, and two objects means "what a host can drive" and "what a request
 * actually runs" can drift. `ready()` is an idempotent latch, so latching twice
 * on the wire path costs a resolved promise.
 */
const harnessDoorFor = (composition: VendoComposition): HarnessTurns => {
  const { ready, harnessTurns } = composition;
  return {
    stream: async (input) => {
      await ready();
      return harnessTurns.stream(input);
    },
    warm: async (input) => {
      await ready();
      return harnessTurns.warm(input);
    },
    workspace: async (principal, opts) => {
      await ready();
      return harnessTurns.workspace(principal, opts);
    },
    putUserFile: async (input) => {
      await ready();
      return harnessTurns.putUserFile(input);
    },
    threads: {
      get: async (id, ctx) => {
        await ready();
        return harnessTurns.threads.get(id, ctx);
      },
      list: async (ctx) => {
        await ready();
        return harnessTurns.threads.list(ctx);
      },
      delete: async (id, ctx) => {
        await ready();
        await harnessTurns.threads.delete(id, ctx);
      },
    },
    evictSubject: (subject) => harnessTurns.evictSubject(subject),
  };
};

/**
 * D5 — `vendo_delegate`'s motor: one non-interactive run of THIS deployment's
 * brain, on the same runtime, the same guard-bound choke point and the same
 * durable workspace a chat turn gets. It replaced `createAgent`'s mini-loop,
 * which was a second engine with its own prompt and its own persistence
 * (none — the delegated run left no thread behind).
 *
 * `liveTurn` rides along, unlike the automations firing above: a delegation
 * happens INSIDE a chat request, in this process, so a harness whose thinker
 * lives on a machine must be able to reach the door for the delegated turn too.
 *
 * Gated on `storeServesHarnessTurns`: a delegated run IS a harness turn, so a
 * store that cannot serve one cannot serve this either. Ungated, `awayRunner`
 * throws on its first line — which the tool pack turns into "the delegated run
 * could not be completed", a sentence that sends the host looking for a bug in
 * their task. It says the real reason instead.
 */
const delegateRunnerFor = (composition: VendoComposition): AgentRunner => {
  const { store, harness, files, guard, capability, inference, system, serviceCatalog } = composition;
  return storeServesHarnessTurns(store)
    ? awayRunner({
      harness,
      store,
      files,
      guard,
      skills: capability.skills,
      models: inference.seats,
      // The SAME brief a chat turn thinks on, assembled for the delegated ctx —
      // discovery section included. A delegated run is this deployment's own
      // brain on the same runtime, so it carries the same `find_tools` hand a
      // chat turn does; the hardcoded `false` here told it otherwise, the same
      // way the away run's did (compose-automations.ts).
      system: (ctx) => assembleSystemPrompt(guard, ctx, system, true, discoveryRail(harness, serviceCatalog)),
      liveTurn: ({ threadId, ctx, tools, steer }) => {
        const unpublish = composition.turnCredentials.publish(threadId, { ctx, tools });
        const unregister = registerTurnSteer({ threadId, subject: ctx.principal.subject, steer });
        return () => {
          unregister();
          unpublish();
        };
      },
    })
    : async () => ({
      status: "error",
      summary: "This deployment's store cannot serve a harness turn, so there is no brain to delegate to. "
        + "vendo_delegate needs a store with Vendo's own tables or one that speaks the store operation "
        + "contract.",
      toolCalls: [],
    });
};

/** Architecture §3 — the thinker, its runtime, and the two doors onto it. */
export const composeHarness = (composition: VendoComposition): Pick<VendoComposition,
  "harness" | "mcpOptions" | "internalDoorOnly" | "doorBase" | "harnessTurns"
  | "harnessTurnsForScreens" | "harnessDoor" | "delegateRunner"> => {
  const door = resolveHarnessDoor(composition);
  Object.assign(composition, door);
  const harnessTurns = createHarnessTurns(harnessTurnConfig(composition));
  // The screen agent's workspace door is now real (see compose-apps.ts).
  Object.assign(composition, { harnessTurns, harnessTurnsForScreens: harnessTurns });
  const harnessDoor = harnessDoorFor(composition);
  return {
    ...door,
    harnessTurns,
    harnessTurnsForScreens: harnessTurns,
    harnessDoor,
    delegateRunner: delegateRunnerFor(composition),
  };
};
