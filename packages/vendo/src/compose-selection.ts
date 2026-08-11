/**
 * The ADAPTER RULE seams, and the env knobs they read.
 *
 * One home for every "which implementation composes here" decision the
 * umbrella makes, moved out of server.ts with the composition that calls them.
 * The adapters themselves never read the environment; these do.
 */
import type { Connector } from "@vendoai/actions";
import {
  VendoError,
  type KnowledgeAdapter,
  type SecretsProvider,
  type StoreAdapter,
} from "@vendoai/core";
import { bindKnowledgeStore, cloudKnowledge } from "@vendoai/knowledge";
import { envSecrets } from "@vendoai/store";
import { chainSecrets, cloudSecrets } from "./cloud-secrets.js";
import { cloudTools } from "./cloud-tools.js";
import {
  byoConnections,
  cloudConnections,
  hasConnections,
  unconfiguredConnections,
  type ConnectionsService,
} from "./connections.js";
import { environment } from "./wire/shared.js";

/** Operator-tuned env knobs must be positive integer milliseconds. A typo
    like "8m" fails loudly here (validateSessionsConfig's posture) instead of
    flowing as NaN into the machine config, where NaN defeats runBoxEdit's
    `??` defaults — every box edit would time out instantly and hot-poll the
    box control port. */
export function positiveIntegerEnv(name: string): number | undefined {
  const raw = environment(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new VendoError("validation", `${name} must be a positive integer of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Default char cap on a single tool result before it reaches the model (03-agent §2).
    Generous enough for normal host responses, small enough that a runaway payload is
    truncated to a preview instead of blowing the context window. Override via config.agent. */
export const DEFAULT_TOOL_OUTPUT_CAP = 32_000;

/** The shared Cloud-default leg of the ADAPTER RULE: VENDO_API_KEY fills a
    seam the host left unset, VENDO_CLOUD_URL overrides the console base URL. */
export function cloudKeyOptions(): { apiKey: string; baseUrl?: string } | undefined {
  const apiKey = environment("VENDO_API_KEY");
  if (apiKey === undefined) return undefined;
  const baseUrl = environment("VENDO_CLOUD_URL");
  return { apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

/** ADAPTER RULE, connectors seam: which Connector[] feeds the actions registry,
    and which Cloud toolkits the composed pair is scoped to.

    ONE list carries both spellings. A Connector object is used verbatim; a
    string names a Cloud toolkit, and the strings together compose the scoped
    cloudTools connector — which is also what the connections seam below scopes
    its catalog to, so connect and use can never advertise different sets.

    An explicitly passed list always wins — including an empty one ("no
    connectors" is a choice). Only a wholly unset slot lets VENDO_API_KEY
    default the UNSCOPED Cloud tools connector. Strings with no key mount
    nothing: there is no broker to reach them through, and the connections seam
    says so by name rather than dropping them quietly. */
export function selectConnectors(
  configured: readonly (string | Connector)[] | undefined,
  toolkits: string[],
): Connector[] {
  const apiKey = environment("VENDO_API_KEY");
  const baseUrl = environment("VENDO_CLOUD_URL");
  const cloudArgs = { ...(baseUrl === undefined ? {} : { baseUrl }) };
  if (configured === undefined) {
    return apiKey === undefined ? [] : [cloudTools({ apiKey, ...cloudArgs })];
  }
  const explicit = configured.filter((entry): entry is Connector => typeof entry !== "string");
  if (toolkits.length === 0 || apiKey === undefined) return explicit;
  return [...explicit, cloudTools({ apiKey, ...cloudArgs, apps: toolkits })];
}

/** ADAPTER RULE, knowledge seam (ENG-368): which KnowledgeAdapter (if any)
    backs the `vendo_knowledge_search` tool. Precedence, top to bottom:
      1. an explicitly passed adapter always wins — including the no-key BYO
         paths (`httpKnowledge({ url })`, `vendoKnowledge()`), which is how a
         Cloud subscriber keeps its own engine by construction. A zero-config
         `vendoKnowledge()` is handed the composed store here
         (bindKnowledgeStore), so the host never plumbs one;
      2. VENDO_API_KEY makes the Cloud engine the default for the seam the host
         left unfilled (VENDO_CLOUD_URL overrides the console base URL) —
         the same rung every other Cloud-backed seam above already has;
      3. nothing configured at all: no adapter, no tool. That silence is
         intended — the agent must not advertise a knowledge base the host
         does not have — and it is the ONLY silent outcome. A key that is
         wrong or a console that is down surfaces on first use (the client
         raises `cloud-required`; the tool answers "unavailable" and warns the
         operator with the cause), per the Cloud rule that key problems appear
         on the first real service call, never at a validate endpoint.
    The adapters themselves never read the environment. */
export function selectKnowledge(
  configured: KnowledgeAdapter | undefined,
  store: StoreAdapter,
): KnowledgeAdapter | undefined {
  if (configured !== undefined) return bindKnowledgeStore(configured, store);
  const cloud = cloudKeyOptions();
  if (cloud === undefined) return undefined;
  return cloudKnowledge(cloud);
}

/** ADAPTER RULE (docs/superpowers/specs/2026-07-17-vendo-cloud-definition-design.md):
    an infrastructure-backed block defines one adapter interface; which
    implementation composes is decided HERE, at the seam where createVendo
    wires blocks together — never by a hidden key-conditional inside the block.
    Precedence, top to bottom:
      1. an explicitly passed adapter always wins;
      2. BYO — a connector's own connections capability (connections must live
         where the connector executes);
      3. VENDO_API_KEY makes the Cloud adapter the default for the seam the
         host left unfilled (VENDO_CLOUD_URL overrides the console base URL);
      4. the unconfigured fallback, which fails closed with setup guidance.
    The adapters themselves never read the environment. */
/** Wraps a connections adapter so a successful `disconnect` drops the
    subject's cached connected-toolkit list. Invalidation is a COMPOSITION
    concern — the cache lives here, not in any adapter — so every posture gets
    it without an adapter knowing the cache exists. `initiate` needs no hook:
    a cached MISS already refetches before the gate blocks anything. */
export function withDisconnectInvalidation(
  service: ConnectionsService,
  invalidate: (subject: string) => void,
): ConnectionsService {
  return {
    ...service,
    posture: service.posture,
    list: (principal) => service.list(principal),
    initiate: (principal, options) => service.initiate(principal, options),
    status: (principal, connector, connectionId) => service.status(principal, connector, connectionId),
    async disconnect(principal, connector, connectionId) {
      await service.disconnect(principal, connector, connectionId);
      invalidate(principal.subject);
    },
    catalog: () => service.catalog(),
  };
}

export function selectConnections(
  configured: ConnectionsService | undefined,
  connectors: Connector[],
  toolkits: string[],
): ConnectionsService {
  if (configured !== undefined) return configured;
  if (connectors.some(hasConnections)) return byoConnections(connectors);
  const cloud = cloudKeyOptions();
  // Named toolkits with no key: the honest unconfigured surface, but saying
  // which fix THIS config needs. Silently mounting nothing was the old
  // `connectorApps` trap and it does not survive in any form.
  if (cloud === undefined) {
    return unconfiguredConnections(
      toolkits.length === 0
        ? undefined
        : `createVendo({ connectors: [${toolkits.map((toolkit) => `"${toolkit}"`).join(", ")}] }) names Vendo Cloud `
          + "toolkits, which are brokered by the console: set VENDO_API_KEY, or pass a connector object "
          + `instead (composioConnector({ apps: [${toolkits.map((toolkit) => `"${toolkit}"`).join(", ")}] }))`,
    );
  }
  // The same scoping the composed cloudTools carries — the connect dock's
  // catalog must never advertise a toolkit the agent cannot invoke.
  return cloudConnections({
    ...cloud,
    ...(toolkits.length === 0 ? {} : { apps: toolkits }),
  });
}

/** ADAPTER RULE, secrets seam (cloned from selectConnections): generated-app
    env building and the apps block's redaction consume one SecretsProvider;
    which implementation composes is decided HERE. Precedence, top to bottom:
      1. an explicitly passed provider always wins (BYO — the host's own vault
         indirection via createVendo({ secrets }));
      2. the process environment stays first even with a key — a defined,
         non-empty env value wins (the hard BYO rule: setting a Vendo key
         never shadows a secret the operator already ships in the env) — and
         VENDO_API_KEY chains the Cloud secrets provider behind it for the
         names the environment leaves unset (VENDO_CLOUD_URL overrides the
         console base URL);
      3. keyless, the envSecrets default alone (unchanged behavior).
    The providers themselves never read VENDO_API_KEY; a Cloud lookup failure
    propagates from the chain (chainSecrets) — redaction already tolerates
    provider failures at its own layer. */
export function selectSecrets(configured: SecretsProvider | undefined): SecretsProvider {
  if (configured !== undefined) return configured;
  const cloud = cloudKeyOptions();
  if (cloud === undefined) return envSecrets();
  return chainSecrets(envSecrets(), cloudSecrets(cloud));
}
