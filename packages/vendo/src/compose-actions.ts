/**
 * 04-actions — the ONE tool registry, and the two wrappers every call rides
 * through it: the pre-guard connect gate and the guard binding itself.
 *
 * The base-URL posture sits here too, because it is what decides whether a
 * present-mode host tool call may forward the caller's credentials at all.
 */
import {
  createActions,
  createConnectGate,
  overridesFileSchema,
  type ActionsRunContext,
  type Connector,
  type OverridesFile,
} from "@vendoai/actions";
import {
  descriptorHash,
  type PermissionGrant,
  type RunContext,
  type ToolOutcome,
} from "@vendoai/core";
import { createByoApprovals } from "./byo-approvals.js";
import type { CloudConfigResult } from "./cloud-config.js";
import type { VendoActionsConfig, VendoComposition } from "./compose-context.js";
import { selectConnectors } from "./compose-selection.js";
import { selectHostTools } from "./dot-vendo.js";
import { withUniqueToolTitles } from "./duplicate-titles.js";
import {
  DOCTOR_ACT_AS_APP_ID,
  DOCTOR_ACT_AS_PRINCIPAL,
  doctorActAsTool,
  doctorPresentTool,
} from "./wire/doctor.js";
import { environment } from "./wire/shared.js";
import { resolveVendoUrls } from "./urls.js";

interface BaseUrlPosture {
  configuredBaseUrl: string | undefined;
  urls: ReturnType<typeof resolveVendoUrls>;
  isDevelopmentEnv: boolean;
  /** Arms BOTH the boot warning and the per-call fail-closed policy. */
  baseUrlMissingInProduction: boolean;
}

/** Where this deployment says it lives, and what that means for credentials. */
const baseUrlPosture = (): BaseUrlPosture => {
  // createActions reads baseUrl from this object at execution time. An explicit
  // VENDO_BASE_URL is a trusted, operator-set origin (credentials forward to it).
  // When unset, the handler learns the wire's own origin from a validated
  // request so route bindings execute same-origin with zero configuration — but
  // that learned origin is UNTRUSTED (baseUrlTrusted:false), so a spoofed Host
  // can never turn it into a credential-exfiltration target (04 §4).
  const configuredBaseUrl = environment("VENDO_BASE_URL");
  // The deployment's two URLs, resolved ONCE (spec 2026-08-06 §B1): the public
  // URL keeps its whole path prefix, and the host API may sit on another origin.
  // Undefined = zero-config dev, where the wire learns its own origin from a
  // validated request instead.
  const urls = resolveVendoUrls(typeof process === "undefined" ? {} : process.env);
  // 09-vendo §2 (install-dx wave 1.1 — design decision 5): a literal
  // NODE_ENV check, deliberately independent of the broader `development`
  // flag below (which also honors an explicit config.development escape
  // hatch for source capture — unrelated to credential trust).
  const nodeEnv = environment("NODE_ENV");
  const isDevelopmentEnv = nodeEnv === "development";
  const isProductionEnv = nodeEnv === "production";
  // One condition arms BOTH the boot warning and the per-call fail-closed
  // policy below, so the console.error tests pin exactly what arms refusal.
  const baseUrlMissingInProduction = configuredBaseUrl === undefined && isProductionEnv;
  if (baseUrlMissingInProduction) {
    // Loud, once, at composition — never throws (a host that never makes a
    // present-mode host tool call must keep booting). The actual refusal
    // happens per-call below via untrustedOriginPolicy: "fail".
    console.error(
      "[vendo] VENDO_BASE_URL is not set in production. Present-mode host tool "
        + "calls that need to forward the caller's credentials will fail instead "
        + "of running unauthenticated. Set VENDO_BASE_URL to this deployment's "
        + "FULL public URL (path prefix included) — and VENDO_HOST_API_URL when "
        + "the host API answers on another origin — then restart the server.",
    );
  }
  return { configuredBaseUrl, urls, isDevelopmentEnv, baseUrlMissingInProduction };
};

  // #557 — cloud overrides.json feeds the actions registry's tool ENABLEMENT
  // (disabled/audience), not only app-generation semantics. The registry
  // resolves `config.overrides` ONCE through its memoized `loadHost`, and every
  // tool-serving path (descriptors/execute/search/surfaceMenu) awaits loadHost
  // before it exposes anything — so a cloud-disabled tool is NEVER live before
  // the override resolves. The provider below reads AUTHORITATIVELY via
  // configCloud.fetch() (awaited), NOT the cold stale-while-revalidate
  // snapshot: the whole point of the async design is that enablement resolves
  // before the first serve, so a cloud disable can never leak on a cold boot.
  // Precedence mirrors selectConfigSurface (file → cloud): a local
  // .vendo/overrides.json wins and is read by the registry itself (provider
  // returns undefined); only a cloud-OWNED surface triggers the fetch. This is
  // now safe at compose because `missSurface` below is deferred — nothing calls
  // actions.descriptors()/loadHost at module init, so no console fetch happens
  // in Workers global scope (portability-gate).
const overridesEnablement = (
  composition: VendoComposition,
): (() => Promise<OverridesFile | undefined>) => {
  const { readSurfaceFile, configCloud } = composition;
  const overridesEnablementProvider = async (): Promise<OverridesFile | undefined> => {
    // File-owned: let the registry read the local .vendo/overrides.json (which
    // also handles v1/legacy migration). No cloud fetch decides enablement.
    if (readSurfaceFile("overrides.json") !== undefined) return undefined;
    // Cloud-owned: AWAIT the authoritative read so enablement is resolved before
    // any tool is served (boot-once on the first request).
    let result: CloudConfigResult;
    try {
      result = await configCloud!.fetch();
    } catch (error) {
      // A flaky/unreachable console must not permanently brick the registry
      // (loadHost memoizes its result). Degrade to no cloud overrides this boot,
      // the same fail-open posture as the guard policy fallback; key/meter
      // problems still surface on the first real service call.
      console.warn(
        "[vendo] hosted overrides.json fetch failed; tool enablement falls back to the local file / none "
        + `this boot: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    const body = result.config?.["overrides.json"];
    if (body === undefined) return undefined;
    try {
      return overridesFileSchema.parse(JSON.parse(body));
    } catch (error) {
      console.error(
        "[vendo] hosted overrides.json is malformed; ignoring it for tool enablement this boot: "
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
  return overridesEnablementProvider;
};

/** The registry's config object, assembled once and then MUTATED twice — see
 *  VendoActionsConfig for why those two fields are read at execution time. */
const actionsConfigFor = (
  composition: VendoComposition,
  posture: BaseUrlPosture,
  resolvedConnectors: Connector[],
  overridesProvider: () => Promise<OverridesFile | undefined>,
): VendoActionsConfig => {
  const { config, actAsSeam, configCloud, warnPresentCredentialsNotForwarded } = composition;
  const { urls, baseUrlMissingInProduction } = posture;
  return {
    dir: config.profileDir ?? ".",
    // Task 15a — the in-memory actions pieces ride the registry's own config
    // inputs (tools/capabilities existed; overrides is the parallel input
    // added with this seam). Inside the registry each wins over its dir-read
    // file, so per-piece precedence needs no second path here.
    ...(selectHostTools(config) === undefined ? {} : { tools: selectHostTools(config) }),
    // Overrides seam (#557 + Task 15a): an explicitly-passed in-memory
    // profile.overrides wins (adapter rule); otherwise a cloud-configured host
    // gets the enablement provider. Both flow through the registry's single
    // `overrides` seam to the same disabled/audience enablement resolution.
    ...(config.profile?.overrides !== undefined
      ? { overrides: config.profile.overrides }
      : configCloud === undefined
        ? {}
        : { overrides: overridesProvider }),
    ...(resolvedConnectors.length === 0 ? {} : { connectors: resolvedConnectors }),
    ...(actAsSeam === undefined ? {} : { actAs: actAsSeam }),
    ...(config.serverActions === undefined ? {} : { serverActions: config.serverActions }),
    // Try-surface seam: an explicitly passed fetch always wins (adapter rule).
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(urls === undefined
      ? {}
      : { baseUrl: urls.hostApiUrl.href, baseUrlTrusted: true }),
    onPresentCredentialsNotForwarded: warnPresentCredentialsNotForwarded,
    // 09-vendo §2 install-dx wave 1.1: production refuses a present-mode call
    // it can't authenticate rather than quietly dropping the caller's
    // credentials. Dev/test keep today's warn-and-continue (dev never reaches
    // "untrusted-host-origin" at all — see onRequestOrigin below).
    ...(baseUrlMissingInProduction ? { untrustedOriginPolicy: "fail" as const } : {}),
  };
};

/** The two /doctor probes, each on a registry carrying ONLY its probe tool. */
const doctorProbes = (actionsConfig: VendoActionsConfig): VendoComposition["doctor"] => ({
    present(ctx: RunContext): Promise<ToolOutcome> {
      // The probe registries carry ONLY the probe tool — dir: undefined
      // stripped the file reads before Task 15a; the in-memory profile pieces
      // are stripped the same way so a profile override/compound can never
      // leak into a doctor probe.
      const probes = createActions({ ...actionsConfig, dir: undefined, overrides: undefined, tools: [doctorPresentTool] });
      return probes.execute({ id: "call_vendo_doctor_present", tool: doctorPresentTool.name, args: {} }, ctx);
    },
    actAs(): Promise<ToolOutcome> {
      const grant: PermissionGrant = {
        id: "grt_vendo_doctor_act_as",
        subject: DOCTOR_ACT_AS_PRINCIPAL.subject,
        tool: doctorActAsTool.name,
        descriptorHash: descriptorHash(doctorActAsTool),
        scope: { kind: "tool" },
        duration: "standing",
        appId: DOCTOR_ACT_AS_APP_ID,
        source: "automation",
        grantedAt: new Date().toISOString(),
      };
      const ctx: ActionsRunContext = {
        principal: DOCTOR_ACT_AS_PRINCIPAL,
        venue: "automation",
        presence: "away",
        sessionId: "session_vendo_doctor_act_as",
        appId: DOCTOR_ACT_AS_APP_ID,
        grant,
      };
      // Same probe isolation as doctor.present above.
      const probes = createActions({ ...actionsConfig, dir: undefined, overrides: undefined, tools: [doctorActAsTool] });
      return probes.execute({ id: "call_vendo_doctor_act_as", tool: doctorActAsTool.name, args: {} }, ctx);
    },
});

/** 04-actions §1 — the registry, the gate, and the guard binding. */
export const composeActions = (composition: VendoComposition): Pick<VendoComposition,
  "configuredBaseUrl" | "urls" | "isDevelopmentEnv" | "connectorToolkits" | "resolvedConnectors"
  | "actionsConfig" | "actions" | "doctor" | "connectGate" | "boundTools" | "byoApprovals"
  | "parkedCallTtlMs"> => {
  const { config, guard, store } = composition;
  const posture = baseUrlPosture();
  // Connectors seam (adapter rule): explicit array wins, VENDO_API_KEY
  // defaults the Cloud tools connector for a wholly unset slot.
  // One list, two spellings: strings are Cloud toolkits, objects are providers.
  const connectorToolkits = (config.connectors ?? []).filter((entry): entry is string => typeof entry === "string");
  const resolvedConnectors = selectConnectors(config.connectors, connectorToolkits);
  const actionsConfig = actionsConfigFor(
    composition,
    posture,
    resolvedConnectors,
    overridesEnablement(composition),
  );
  const actions = createActions(actionsConfig);
  const doctor = doctorProbes(actionsConfig);
  // Discovery-discipline 2026-07-25: the connect check wraps OUTSIDE
  // guard.bind, so a call to an unconnected brokered tool returns the
  // connect-required flow BEFORE any guard decision — no approval minted on
  // any door (chat, MCP, automations, compound steps, BYO resume).
  // `connections` and the toolkit cache are declared below this composition;
  // execution only happens after createVendo returns, so the closure
  // references are safe (same pattern as the connections loadout seed).
  const connectGate = createConnectGate({
    toolkitOf: (tool) => actions.connectorToolkit(tool),
    isConnected: (toolkit, ctx) => composition.subjectHasToolkit(toolkit, ctx),
    // A gated call never reaches guard.bind's audit — the gate reports the
    // same tool-call event (with connectorAccount enrichment) itself.
    report: (event) => guard.report(event),
  });
  // Design §12: a deployment where two tools share a `title` cannot render an
  // honest consent card, so it must not serve. Composition installs the check
  // here — the one place the deployment's whole registry is assembled — and it
  // fires the instant the descriptor set first resolves, which is the earliest
  // this is knowable (createVendo is synchronous; descriptors are not).
  const boundTools = withUniqueToolTitles(connectGate.bind(guard.bind(actions)));
  // 04 §6: compound steps route through the guard binding — grants, approvals,
  // breakers, and audit see every real call; there is no second
  // execution path. createActions reads invokeTool at execution time (same
  // pattern as baseUrl above), so assigning after guard.bind is sound.
  actionsConfig.invokeTool = (call, ctx) => boundTools.execute(call, ctx);
  // Existing-agents Lane B — parked guarded calls with no Vendo thread: the
  // parking registry the BYO tool pack executes through (guardedTools below),
  // the resume-on-decide subscriber (same onApprovalDecision seam apps and
  // automations ride), the wire's per-approval read, and the TTL sweep leg.
  const byoApprovals = createByoApprovals({ guard, tools: boundTools, store });
  // The guard owns its approval lifecycle: whether the rules arrived as a spec
  // this composition completed or as a built instance, the number is read off
  // the guard, so a host that brings its own never loses the knob.
  const parkedCallTtlMs = guard.approvals.parkedCallTtlMs;
  return {
    configuredBaseUrl: posture.configuredBaseUrl,
    urls: posture.urls,
    isDevelopmentEnv: posture.isDevelopmentEnv,
    connectorToolkits,
    resolvedConnectors,
    actionsConfig,
    actions,
    doctor,
    connectGate,
    boundTools,
    byoApprovals,
    parkedCallTtlMs,
  };
};
