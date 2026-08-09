/**
 * execution-v2 Wave 3–4 — the box: the server-edit primitive, the seam the
 * generation lane drives it through, the server work a plan declares, and the
 * one forwarder §9.8's served door and the fn door share.
 *
 * Lifted out of `createApps` unchanged.
 */
import {
  VendoError,
  safeErrorMessage,
  type AppDocument,
  type AppId,
  type AppPlan,
  type Json,
  type RunContext,
} from "@vendoai/core";
import { appMemoryBrief } from "./app-memory.js";
import {
  pushBoxEnv,
  readBoxManifest,
  requestAppWithBootRetry,
  runBoxEdit,
  type BoxEditResult,
} from "./box-agent.js";
import type { Finding } from "./checking/types.js";
import { rungFor, withoutId } from "./edit-journal.js";
import { boxAllowlist, normalizeEgressDomain } from "./egress-approval.js";
import type { GenerationDependencies } from "./generation/engine.js";
import { runServerLane, type BoxSeam, type ServerFunction } from "./generation/lanes.js";
import { createMachineLifecycle } from "./machine-lifecycle.js";
import { parseVendoManifest } from "./manifest.js";
import { stripServerAuthoritativeFields } from "./open.js";
import { collectSecretValues, redactSecretJson, redactSecretText } from "./redaction.js";
import type { AppsRuntimeContext } from "./runtime-context.js";
import type { AppsConfig, BoxRequest, BoxResponse, EditResult, VersionEntry } from "./types.js";

/** The skin-contract summary carried to the in-box agent as task context.
 *  Values never cross — only the env-var NAMES the box will find, the /fn
 *  convention, the vendo.json schema, and curl shapes for the store/tools
 *  callback surfaces. */
const skinContractPrompt = (app: AppDocument): string => {
  const secretNames = (app.secrets ?? []).join(", ") || "(none declared)";
  return [
    "SKIN CONTRACT (the box boundary you build against):",
    "- Listen on the PORT env var. Serve POST /fn/<name> answering {\"result\": ...} (or {\"error\":{\"code\",\"message\"}}), and GET /vendo.json returning the manifest file.",
    "- Manifest vendo.json: {\"schedules\":[{\"cron\":\"0 8 * * *\",\"fn\":\"<name>\"}], \"egress\":[\"host.example.com\"]}. Declare EVERY third-party domain you fetch; undeclared egress is blocked at the network layer.",
    "- .vendo/run holds ONE shell line that starts the app (e.g. \"node server.js\"). Write it; a supervisor runs it.",
    "- Durable rows go through the Vendo store, NOT disk: PUT \"$VENDO_STORE_URL/rows/<collection>/<id>\" with header \"authorization: Bearer $VENDO_APP_TOKEN\" and body {\"data\":{...}}; list with GET \"$VENDO_STORE_URL/rows/<collection>\".",
    "- Host tools ride POST \"$VENDO_HOST_URL/tools/<name>\" with the same bearer; approvals/audit happen host-side.",
    `- Env vars available in the box: PORT, VENDO_STORE_URL, VENDO_APP_TOKEN, VENDO_HOST_URL, VENDO_INFERENCE_URL, VENDO_INFERENCE_KEY, and these declared secrets by name: ${secretNames}.`,
  ].join("\n");
};

/** Wave 4 (layer 3) — the extra contract lines for a served-app build: the
 *  box now OWNS the app surface. Same data-only floor as everything else the
 *  box reads; the host still verifies the served root itself before any
 *  surface flip. */
const servedAppContractPrompt = (): string => [
  "THIS TASK BUILDS THE APP SURFACE ITSELF (layer 3):",
  "- START WARM: the universal app template is pre-baked at /opt/vendo-box/template — Vite + React 19 with @vendoai/ui (the whole Kit, at @vendoai/ui/kit) already installed, the /fn envelopes and vendo.json serving already wired, and the .vendo/run entry already written. Your FIRST action: run exactly `cp -a /opt/vendo-box/template/. /app/` (one command; it copies .vendo/run and the node_modules link too — no ls, no second cp), then go straight to editing src/App.tsx and fns.js. Only if that cp fails (older box) build from scratch.",
  "- Write real TypeScript and React — the full language, no restricted subset. `npm run typecheck` (tsc), `npm run build` (vite) and the dev server's own errors are your code validators, and all three run here in the box. Import components from \"@vendoai/ui/kit\", never from a CDN.",
  "- src/App.tsx is the app. src/main.tsx is the wiring (brand, provider, frame protocol) and you should not need to touch it. fns.js holds your POST /fn/<name> handlers; the page reaches them with `callFn` from src/fn.ts.",
  "- Serve a REAL web app on the non-/fn paths of $PORT. GET / is the entry page and must answer 200 with text/html; `node server.js` already does that from the Vite build. Keep it self-contained — the box's egress is deny-by-default, so a CDN reference is a guaranteed failed fetch.",
  "- The host's brand is applied for you (the `vendoTheme` query param and the provisioned .vendo/host/theme.json both flow through src/provision.ts onto the --vendo-* CSS variables the Kit reads). Style with those variables, never with hardcoded brand colors.",
  "- Before you report done: run `npm run validate`. Exit 0 means shippable; any other exit prints its findings on stdout and you fix them first. Then curl GET / until it answers 200 with the real content and report servesUi: true.",
].join("\n");

/** The version an inline lane write lands under — this build's own ask, verbatim. */
const landVersion = (document: AppDocument, request: string): VersionEntry => ({
  at: new Date().toISOString(),
  intent: request,
  rung: rungFor(document),
});

/** execution-v2 — the machine lifecycle (provision/wake/sleep/destroy) and the
 *  two box-edit timings the host may tune beside it. */
export const createMachineLane = (config: AppsConfig) => {
  // execution-v2 — the machine lifecycle (provision/wake/sleep/destroy);
  // the v1 MachineSessions cache is deleted.
  const {
    implicitDomains,
    buildEnv: hostBuildEnv,
    boxEditPollMs,
    boxEditTimeoutMs,
    ...machineConfig
  } = config.machine ?? {};
  const implicitEgress = (implicitDomains ?? [])
    .map(normalizeEgressDomain)
    .filter((domain) => domain !== "");
  const lifecycle = createMachineLifecycle({
    store: config.store,
    ...machineConfig,
    // Secrets enter the box as opaque aliases and are substituted at the egress
    // proxy (06-apps §4.3), so the host's buildEnv assembles the boundary env
    // from the document alone — nothing resolves a real value into it.
    ...(hostBuildEnv === undefined ? {} : { buildEnv: hostBuildEnv }),
    // Lane E — the egress policy EVERY provision and wake consults (including
    // ctx-less paths like an idle resume or a schedule fire): approved
    // declaration + implicit skin domains, or a loud refusal naming the
    // unapproved domains. See boxAllowlist for the assembly rules.
    allowedDomains: (doc) => boxAllowlist(doc, implicitEgress),
  });

  return { lifecycle, boxEditPollMs, boxEditTimeoutMs };
};

const createBoxEditor = (
  deps: Pick<AppsRuntimeContext,
    "lifecycle" | "manifestTriggers" | "updateAppDocument" | "boxEditPollMs" | "boxEditTimeoutMs">,
) => {
  const { lifecycle, manifestTriggers, updateAppDocument, boxEditPollMs, boxEditTimeoutMs } = deps;
  /**
   * The box server-edit primitive: wake the (already-provisioned) machine,
   * re-inject the current boundary env (grant-flip restart loop), send the
   * instruction to the in-box agent, and on success sync schedules + the
   * egress declaration and snapshot the new state. On failure the box is
   * DISCARDED — the app rolls back to its pre-edit snapshot. Returns the box's
   * (data-only) result and the synced document.
   */
  const editServerViaBox = async (
    app: AppDocument,
    instruction: string,
    ctx: RunContext,
    options: { served?: boolean } = {},
  ): Promise<{ ok: true; result: BoxEditResult; doc: AppDocument; servedOk: boolean } | { ok: false; result: BoxEditResult }> => {
    const machine = await lifecycle.wake(app);
    await pushBoxEnv(machine, await lifecycle.buildAppEnv(app)).catch(() => undefined);
    // The builder in the box reads the app's memory before its own contract, for
    // the same reason the brain does: the code on that disk cannot say which of
    // its shapes were asked for and which are incidental.
    const contract = options.served === true
      ? `${skinContractPrompt(app)}\n${servedAppContractPrompt()}`
      : skinContractPrompt(app);
    const memory = appMemoryBrief(app.memory);
    const result = await runBoxEdit(machine, {
      prompt: instruction,
      context: memory === undefined ? contract : `${memory}\n\n${contract}`,
      ...(boxEditPollMs === undefined ? {} : { pollIntervalMs: boxEditPollMs }),
      ...(boxEditTimeoutMs === undefined ? {} : { timeoutMs: boxEditTimeoutMs }),
    });
    if (!result.ok) {
      // Rollback: drop the live machine without snapshotting — the doc keeps
      // its pre-edit ref (no new fork machinery, just "don't keep this").
      await lifecycle.discard(app).catch(() => undefined);
      return { ok: false, result };
    }
    // Wave 4 (layer 3) — the box's servesUi is DATA; the HOST verifies the
    // served root while the machine is still awake. A surface flip downstream
    // requires this check, never the claim alone.
    let servedOk = false;
    if (result.servesUi === true) {
      const root = await requestAppWithBootRetry(machine, { method: "GET", path: "/" }).catch(() => undefined);
      // Header keys are matched case-insensitively: fetch normalizes to
      // lowercase, but a provider adapter is not obliged to.
      const contentType = root === undefined
        ? ""
        : Object.entries(root.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
      servedOk = root !== undefined
        && root.status >= 200 && root.status < 300
        && contentType.includes("text/html")
        && root.body.length > 0;
    }
    // Fold the manifest's schedules into doc triggers while the box is awake and
    // its egress declaration is not yet on the doc (so this wake's allowlist
    // still passes). Best-effort — a manifest the converter cannot honor must
    // not roll back an edit that already succeeded inside the box — but never
    // SILENT: the reason is the only thing that says why nothing is scheduled.
    await manifestTriggers.sync(app, ctx).catch((error: unknown) => {
      console.warn(`[vendo] vendo.json schedules for ${app.id} were not folded into triggers: ${safeErrorMessage(error)}`);
    });
    // Sync the egress DECLARATION (mirrors vendo.json) onto the doc; the
    // owner-approval grant is a separate, guard-gated step (Lane E).
    let egressDecl: string[] = [];
    const manifestSource = await readBoxManifest(machine).catch(() => undefined);
    if (manifestSource !== undefined) {
      try {
        egressDecl = (parseVendoManifest(manifestSource).egress ?? []).map(normalizeEgressDomain).filter((d) => d !== "");
      } catch {
        // An invalid manifest declares nothing; the box just cannot egress.
      }
    }
    const synced = await updateAppDocument(app.id, (doc) => {
      const next = { ...doc };
      if (egressDecl.length === 0) delete next.egress;
      else next.egress = [...new Set(egressDecl)];
      return next;
    });
    // Snapshot the new code + state (sleep does not consult the allowlist).
    // Sleep advances machine.snapshotRef via CAS, so the post-sleep document —
    // not the pre-sleep `synced` — is the current stored row a later persist
    // must build on.
    const slept = await lifecycle.sleep(synced);
    return { ok: true, result, doc: slept, servedOk };
  };

  return editServerViaBox;
};

const createBoxSeams = (
  deps: Pick<AppsRuntimeContext,
    "lifecycle" | "fnCaller" | "requireOwned" | "ensureEgressApproved" | "reportLifecycle" | "editServerViaBox">,
) => {
  const { lifecycle, fnCaller, requireOwned, ensureEgressApproved, reportLifecycle, editServerViaBox } = deps;
  /**
   * The box, as the server lane needs it. `available()` is checked BEFORE
   * anything is provisioned; `instruct()` wakes the machine, hands the in-box
   * agent the plan's reason, and — on failure — discards the live machine
   * WITHOUT snapshotting, so a failed box leaves nothing to inherit.
   *
   * Every function the box reports is SAMPLED here by actually calling it: the
   * sample is the only real shape in existence for it, because nothing declared
   * these functions up front. That is the same call the graduation path made,
   * and the same call a query-bound fn makes the moment the app opens.
   */
  const boxSeamFor = (appId: AppId, ctx: RunContext, wantsServed: boolean): BoxSeam => ({
    available: () => lifecycle.available(),
    provision: async () => {
      const app = await requireOwned(appId, ctx);
      if (app.machine !== undefined) return;
      await ensureEgressApproved(app, ctx);
      await lifecycle.provision(app);
      await reportLifecycle("machine-provision", appId, ctx);
    },
    instruct: async (instruction) => {
      const app = await requireOwned(appId, ctx);
      const box = await editServerViaBox(app, instruction, ctx, { served: wantsServed });
      if (!box.ok) return { ok: false, summary: box.result.summary };
      const current = await requireOwned(appId, ctx);
      const functions: ServerFunction[] = [];
      // A served app's PAGES are its interface: there is no tree left to bind a
      // function into, and sampling would wake the box straight back up after
      // the snapshot. Graduation ends asleep.
      for (const name of wantsServed ? [] : box.result.fns ?? []) {
        const outcome = await fnCaller.callFn(current, name, {}, ctx).catch(() => undefined);
        functions.push({
          name,
          ...(outcome !== undefined && outcome.status === "ok"
            ? { sampleOutput: outcome.output as Json }
            : {}),
        });
      }
      return {
        ok: true,
        summary: box.result.summary,
        functions,
        ...(box.result.servesUi === undefined ? {} : { servesUi: box.result.servesUi }),
        servedOk: box.servedOk,
      };
    },
  });

  return boxSeamFor;
};

/**
 * The 2→3 surface flip, on the two independent signals `runServerWork` gathers:
 * the PLAN asked to be served, and the host itself fetched `GET /` and got a
 * real page. Its own function only so the runner stays one readable screenful.
 */
const createSurfaceFlip = (deps: Pick<AppsRuntimeContext, "requireOwned" | "persistEdit">) => {
  const { requireOwned, persistEdit } = deps;
  return async (input: {
    lane: Awaited<ReturnType<typeof runServerLane>>;
    document: AppDocument;
    appId: AppId;
    ctx: RunContext;
    wantsServed: boolean;
    request: string;
  }): Promise<{ document: AppDocument; issues: string[] }> => {
    const { lane, appId, ctx, wantsServed } = input;
    let document = input.document;
    const issues: string[] = [];
    if (lane.server !== undefined && (wantsServed || lane.server.servesUi === true)) {
      if (!wantsServed) {
        issues.push("the box declared a served web app, but this app's plan never asked for one — the surface flip was refused and the tree keeps serving");
      } else if (lane.server.servesUi === true && lane.server.servedOk === true) {
        const base = await requireOwned(appId, ctx);
        const flipped = structuredClone(base);
        delete flipped.tree;
        delete flipped.components;
        delete flipped.componentTools;
        delete flipped.pins;
        flipped.ui = "http";
        document = await persistEdit(base, flipped, landVersion(flipped, input.request), ctx.principal.subject, undefined, {});
      } else {
        issues.push("the box did not produce a verified served web app (GET / must answer 200 text/html) — the surface was not flipped; retry the edit");
      }
    }
    return { document, issues };
  };
};

/**
 * Run the server work a plan declared, on an app that is already STORED — the
 * lane lands through the ordinary edit persist, and arming a trigger whose row
 * does not exist yet would enable an automation nobody has. steps/agentic
 * author an automation on the existing engine in seconds; box provisions a
 * machine and lets the in-box agent write real code against the plan itself.
 */
const createServerWorkRunner = (
  deps: Pick<AppsRuntimeContext, "config" | "requireOwned" | "persistEdit" | "assembleEdit" | "reportGuard">
    & { boxSeamFor: ReturnType<typeof createBoxSeams>; applySurfaceFlip: ReturnType<typeof createSurfaceFlip> },
) => {
  const { config, requireOwned, persistEdit, assembleEdit, reportGuard, boxSeamFor, applySurfaceFlip } = deps;
  const runServerWork = async (
    input: {
      plan: AppPlan;
      /** The escalated `plan.vendo` verbatim — the box's brief (lanes.ts). */
      planText?: string;
      document: AppDocument;
      request: string;
    },
    ctx: RunContext,
    deps: GenerationDependencies,
  ): Promise<{
    document: AppDocument;
    findings: Finding[];
    automation?: EditResult["automation"];
    /** The box wrote real server code for this app (layer 2 or 3). */
    graduated?: boolean;
    /** Sentences for the caller's `issues` — a refused flip is never silent. */
    issues?: string[];
    /** The server work the plan REQUIRED could not be built, so the edit did not
     *  happen at all: a served app that never got its surface has nothing to
     *  stand on, unlike a layer-2 box whose tree still works. */
    failed?: string[];
  }> => {
    const appId = input.document.id;
    const wantsServed = input.plan.server?.served === true;
    const lane = await runServerLane(input.plan, withoutId(input.document), {
      ...deps,
      appId,
      ctx,
      // The words that started this. The automation planner decides whether the
      // ask is one MORE automation or a new version of one the app already has,
      // and the plan's `why` alone cannot tell those apart.
      request: input.request,
      ...(input.planText === undefined ? {} : { planText: input.planText }),
      box: boxSeamFor(appId, ctx, wantsServed),
      ...(config.armAutomation === undefined ? {} : { armAutomation: config.armAutomation }),
      land: async (document, options) => {
        const previous = await requireOwned(appId, ctx);
        const next: AppDocument = { ...document, id: appId };
        if (next.tree !== undefined) stripServerAuthoritativeFields(next.tree);
        await persistEdit(previous, next, landVersion(next, input.request), ctx.principal.subject, undefined, options);
      },
      // The board that shows an automation's results is a SCREEN, so the thing
      // that writes every other screen writes this one: one assembler turn over
      // the app as it stands. The row it saves is what the lane re-stamps the
      // trigger onto, so the automation can never be lost to its own rewire.
      rebind: async (instruction) => {
        const rebound = await assembleEdit(appId, instruction, ctx);
        if (rebound.kind === "assembled") return { document: withoutId(rebound.app), issues: [] };
        return {
          issues: rebound.kind === "escalate"
            ? ["the assembler asked for a build rather than rewiring the board"]
            : rebound.issues,
        };
      },
    });
    let document: AppDocument = { ...lane.document, id: appId };
    const findings = [...lane.findings];
    if (lane.automation !== undefined || lane.server !== undefined) {
      // Either lane already wrote the row itself — the automation lane landed
      // its own persist, and provisioning the box wrote `machine` — so re-read:
      // the pre-write copy would report an app without what the lane just gave
      // it.
      document = await requireOwned(appId, ctx);
    }
    // ── The 2→3 surface flip ────────────────────────────────────────────────
    // The tree kept serving through the whole box build. Only NOW, with the box
    // green, does the surface change — and only on TWO independent signals: the
    // PLAN asked to be served, and the host itself fetched `GET /` and got a real
    // page. A box that self-declares a served surface on a layer-2 plan is
    // refused loudly: it must never replace a tree the person did not ask to lose.
    const issues: string[] = [];
    if (wantsServed && lane.server === undefined) {
      return { document, findings, failed: findings.map(({ message }) => message) };
    }
    const flip = await applySurfaceFlip({ lane, document, appId, ctx, wantsServed, request: input.request });
    document = flip.document;
    issues.push(...flip.issues);
    // Wave 9 — an edit that rode the ladder to an automation is an audit event
    // in its own right (the row main has carried since the ladder shipped): the
    // trigger now fires unattended, so the trail must say when it was authored.
    if (lane.automation !== undefined) {
      await reportGuard(ctx.principal.subject, appId, ctx, {
        operation: "automation-created",
        mode: lane.automation.mode,
        triggerKind: lane.automation.trigger.on.kind,
      });
    }
    // Arming's own sentences are the CALLER's, not just the log's: a trigger
    // left disarmed is the person's to fix, and the sentence names the surface
    // that fixes it. The rest of the lane's findings stay operator-side.
    const armingIssues = lane.armingIssues ?? [];
    return {
      document,
      findings,
      ...(lane.automation === undefined ? {} : { automation: lane.automation }),
      ...(lane.server === undefined ? {} : { graduated: true }),
      ...(issues.length === 0 && armingIssues.length === 0
        ? {}
        : { issues: [...issues, ...armingIssues] }),
    };
  };

  return runServerWork;
};

const createBoxForwarder = (
  deps: Pick<AppsRuntimeContext, "config" | "lifecycle" | "ensureEgressApproved">,
) => {
  const { config, lifecycle, ensureEgressApproved } = deps;
  /**
   * Forward ONE already-authorized request into the app's machine. Extracted
   * because §9.8's served door and the fn door differ ONLY in the level they
   * require (`viewer` vs `editor`) — the wake, the egress pre-flight and the
   * redaction guard are identical, and a second copy of them is exactly how the
   * two would drift apart.
   */
  const forwardToBox = async (
    app: AppDocument,
    request: BoxRequest,
    ctx: RunContext,
  ): Promise<BoxResponse> => {
    // Lane E — the fn door wakes the machine, so it carries the same
    // egress pre-flight (and re-prompt on a grown declaration) as wake.
    await ensureEgressApproved(app, ctx);
    const machine = await lifecycle.wake(app);
    // Lane E redaction guard — a box may echo its own env (fn responses
    // are host-side artifacts that reach clients and logs): scrub every
    // known secret value out of the response, and out of any error
    // message crossing this seam. issue #566 — prefer the values already
    // injected into THIS box (the lifecycle's per-box cache) so a value
    // that entered the box is always redactable without a refetch that
    // could fail; only names NOT injected fall back to a best-effort read.
    const secretValues = await collectSecretValues(
      app.secrets,
      config.secrets,
      lifecycle.injectedSecretValues(app.id),
    );
    try {
      const answer = await machine.request(request);
      if (secretValues.size === 0) return answer;
      const text = new TextDecoder().decode(answer.body);
      const scrubbed = redactSecretText(text, secretValues);
      return {
        status: answer.status,
        headers: Object.fromEntries(Object.entries(answer.headers)
          .map(([header, value]) => [header, redactSecretText(value, secretValues)])),
        // Untouched bodies pass through byte-identical (binary safety).
        body: scrubbed === text ? answer.body : new TextEncoder().encode(scrubbed),
      };
    } catch (error) {
      if (error instanceof Error) {
        // Mutate in place so the error keeps its type, stack, and code.
        error.message = redactSecretText(error.message, secretValues);
      }
      if (error instanceof VendoError && error.detail !== undefined) {
        error.detail = redactSecretJson(error.detail, secretValues);
      }
      throw error;
    }
  };

  return forwardToBox;
};

/** The box slice of `createApps`' closure. */
export const createBoxLane = (
  deps: Pick<AppsRuntimeContext,
    "config" | "lifecycle" | "manifestTriggers" | "updateAppDocument" | "boxEditPollMs" | "boxEditTimeoutMs"
    | "fnCaller" | "requireOwned" | "ensureEgressApproved" | "reportLifecycle" | "reportGuard"
    | "persistEdit" | "assembleEdit">,
) => {
  const editServerViaBox = createBoxEditor(deps);
  const boxSeamFor = createBoxSeams({ ...deps, editServerViaBox });
  const applySurfaceFlip = createSurfaceFlip(deps);
  const runServerWork = createServerWorkRunner({ ...deps, boxSeamFor, applySurfaceFlip });
  const forwardToBox = createBoxForwarder(deps);
  return { editServerViaBox, runServerWork, forwardToBox };
};
