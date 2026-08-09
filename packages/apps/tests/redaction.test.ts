import type { AppDocument, RunContext, SecretsProvider, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createMachineLane } from "../src/box-lane.js";
import { createApps, type AppsConfig } from "../src/index.js";
import { collectSecretValues, redactSecretJson, redactSecretText } from "../src/redaction.js";
import {
  fakeStatefulSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "../src/testing/index.js";

const STRIPE_VALUE = "vendo_fixture_4eC39HqLyjWDarjtT1zdp7dc";

const secrets: SecretsProvider = {
  async get(name) {
    if (name === "STRIPE_KEY") return STRIPE_VALUE;
    if (name === "TINY") return "1";
    if (name === "BROKEN") throw new Error("vault offline");
    return undefined;
  },
};

describe("redaction primitives", () => {
  it("collects declared secret values, skipping short values and provider failures", async () => {
    const values = await collectSecretValues(["STRIPE_KEY", "TINY", "BROKEN", "MISSING"], secrets);
    expect([...values.entries()]).toEqual([["STRIPE_KEY", STRIPE_VALUE]]);
    expect((await collectSecretValues(["STRIPE_KEY"], undefined)).size).toBe(0);
  });

  it("replaces every occurrence of a value, naming the secret", () => {
    const values = new Map([["STRIPE_KEY", STRIPE_VALUE]]);
    expect(redactSecretText(`a=${STRIPE_VALUE} b=${STRIPE_VALUE}`, values))
      .toBe("a=[redacted:STRIPE_KEY] b=[redacted:STRIPE_KEY]");
    expect(redactSecretText("clean", values)).toBe("clean");
  });

  it("deep-scrubs JSON leaves and keys", () => {
    const values = new Map([["STRIPE_KEY", STRIPE_VALUE]]);
    expect(redactSecretJson({
      rows: [{ [STRIPE_VALUE]: `token ${STRIPE_VALUE}` }],
      count: 2,
      ok: true,
    }, values)).toEqual({
      rows: [{ "[redacted:STRIPE_KEY]": "token [redacted:STRIPE_KEY]" }],
      count: 2,
      ok: true,
    });
  });
});

describe("the box door scrubs responses (integration)", () => {
  const tools: ToolRegistry = {
    async descriptors() {
      return [];
    },
    async execute() {
      return { status: "error", error: { code: "not-found", message: "no fixture tools" } };
    },
  };

  const ada: RunContext = {
    principal: { kind: "user", subject: "user_ada" },
    venue: "app",
    presence: "present",
    sessionId: "session_user_ada",
  };

  const setup = async () => {
    const store = memoryStore();
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_redaction",
      name: "Redaction fixture",
      secrets: ["STRIPE_KEY"],
    };
    await seedAppRow(store, doc, "user_ada");
    const config: AppsConfig = {
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      secrets,
      machine: { sandbox: fakeStatefulSandbox(), buildEnv: () => ({ PORT: "8080" }) },
    };
    const runtime = createApps(config);
    // Graduation's own provision (box-lane.ts) over the SAME deployment config
    // `createApps` composes its lifecycle from — the ref lands on the app row,
    // so the box door below wakes the machine through the runtime itself.
    await createMachineLane(config).lifecycle.provision(doc);
    return { runtime, doc };
  };

  it("an fn response echoing a secret value comes back redacted", async () => {
    const { runtime, doc } = await setup();
    // The stateful fake box stores what it is told and echoes it back — the exact
    // leak shape: a box putting its own env into a response.
    await runtime.box.request(doc.id, {
      method: "POST",
      path: "/state/leak",
      body: `key=${STRIPE_VALUE}`,
    }, ada);
    const answer = await runtime.box.request(doc.id, { method: "GET", path: "/state/leak" }, ada);
    expect(new TextDecoder().decode(answer.body)).toBe("key=[redacted:STRIPE_KEY]");
  });

  it("a clean response passes through byte-identical", async () => {
    const { runtime, doc } = await setup();
    await runtime.box.request(doc.id, { method: "POST", path: "/state/ok", body: "plain" }, ada);
    const answer = await runtime.box.request(doc.id, { method: "GET", path: "/state/ok" }, ada);
    expect(new TextDecoder().decode(answer.body)).toBe("plain");
  });

  it("box.redact scrubs a JSON payload for the wire surface", async () => {
    const { runtime, doc } = await setup();
    const scrubbed = await runtime.box.redact(doc.id, {
      data: { note: `paid with ${STRIPE_VALUE}` },
    });
    expect(scrubbed).toEqual({ data: { note: "paid with [redacted:STRIPE_KEY]" } });
  });
});

describe("issue #566 — injected secret values redact without a refetch", () => {
  const tools: ToolRegistry = {
    async descriptors() {
      return [];
    },
    async execute() {
      return { status: "error", error: { code: "not-found", message: "no fixture tools" } };
    },
  };

  const ada: RunContext = {
    principal: { kind: "user", subject: "user_ada" },
    venue: "app",
    presence: "present",
    sessionId: "session_user_ada",
  };

  /** A provider that resolves STRIPE_KEY until `break()` is called, then throws
   *  on every read — the "network blip" the redaction refetch hits. */
  const mutableSecrets = () => {
    let broken = false;
    const provider: SecretsProvider = {
      async get(name) {
        if (broken) throw new Error("vault offline");
        return name === "STRIPE_KEY" ? STRIPE_VALUE : undefined;
      },
    };
    return { provider, break: () => { broken = true; } };
  };

  /** buildEnv that actually injects the granted secret's real value into the
   *  box env keyed by its own name — the real box-env shape, so the lifecycle
   *  can capture what entered the box. `inject` decides whether STRIPE_KEY was
   *  granted (declared ∩ granted). */
  const injectingEnv = (inject: boolean) => (doc: AppDocument): Record<string, string> => {
    const env: Record<string, string> = { PORT: "8080" };
    if (inject && (doc.secrets ?? []).includes("STRIPE_KEY")) env["STRIPE_KEY"] = STRIPE_VALUE;
    return env;
  };

  const configWith = (
    store: ReturnType<typeof memoryStore>,
    secretsProvider: SecretsProvider,
    inject: boolean,
  ): AppsConfig => ({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    secrets: secretsProvider,
    machine: { sandbox: fakeStatefulSandbox(), buildEnv: injectingEnv(inject) },
  });

  /** Graduation's own provision (box-lane.ts), then the host's grant-flip
   *  marker. The injected-value cache belongs to whichever lifecycle assembled
   *  the env, and in production that is the serving process — so the marker
   *  makes the RUNTIME's own next wake rebuild the boundary env (Wave 7) and
   *  cache what entered the box, exactly as its own provision would have. */
  const provisionStale = async (config: AppsConfig, doc: AppDocument): Promise<void> => {
    const provisioned = await createMachineLane(config).lifecycle.provision(doc);
    await seedAppRow(config.store, {
      ...provisioned,
      machine: { ...provisioned.machine!, envStaleAt: new Date().toISOString() },
    }, "user_ada");
  };

  const seed = async (store: ReturnType<typeof memoryStore>, id: string) => {
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id,
      name: "Redaction fixture",
      secrets: ["STRIPE_KEY"],
    };
    await seedAppRow(store, doc, "user_ada");
    return doc;
  };

  it("an injected value stays redacted even when the redaction refetch throws", async () => {
    const store = memoryStore();
    const { provider, break: breakRefetch } = mutableSecrets();
    const config = configWith(store, provider, true);
    const runtime = createApps(config);
    const doc = await seed(store, "app_injected");
    // The env assembly injects the value; the runtime's lifecycle caches it for
    // the box (the wake below rebuilds it through that lifecycle).
    await provisionStale(config, doc);
    // Now the vault goes offline — the pre-fix refetch in collectSecretValues fails.
    breakRefetch();

    await runtime.box.request(doc.id, { method: "POST", path: "/state/leak", body: `key=${STRIPE_VALUE}` }, ada);
    const answer = await runtime.box.request(doc.id, { method: "GET", path: "/state/leak" }, ada);
    expect(new TextDecoder().decode(answer.body)).toBe("key=[redacted:STRIPE_KEY]");

    // box.redact rides the same cache.
    const scrubbed = await runtime.box.redact(doc.id, { note: `paid with ${STRIPE_VALUE}` });
    expect(scrubbed).toEqual({ note: "paid with [redacted:STRIPE_KEY]" });
  });

  it("a non-injected declared secret is not redacted from a cache when the refetch fails (best-effort miss preserved)", async () => {
    const store = memoryStore();
    const { provider, break: breakRefetch } = mutableSecrets();
    // inject=false: STRIPE_KEY is declared but NOT granted, so nothing enters the box.
    const config = configWith(store, provider, false);
    const runtime = createApps(config);
    const doc = await seed(store, "app_not_injected");
    await provisionStale(config, doc);
    breakRefetch();

    await runtime.box.request(doc.id, { method: "POST", path: "/state/leak", body: `key=${STRIPE_VALUE}` }, ada);
    const answer = await runtime.box.request(doc.id, { method: "GET", path: "/state/leak" }, ada);
    // No cached value, refetch fails: best-effort armor leaves it alone (no 500).
    expect(new TextDecoder().decode(answer.body)).toBe(`key=${STRIPE_VALUE}`);
  });

  it("the cache never crosses box boundaries — one box's injected value cannot redact another's output", async () => {
    const store = memoryStore();
    const { provider, break: breakRefetch } = mutableSecrets();
    // App A injects the value; App B declares the same name but never gets it granted.
    const configA = configWith(store, provider, true);
    const configB = configWith(store, provider, false);
    const runtimeA = createApps(configA);
    const runtimeB = createApps(configB);
    const docA = await seed(store, "app_box_a");
    const docB = await seed(store, "app_box_b");
    await provisionStale(configA, docA);
    await provisionStale(configB, docB);
    breakRefetch();

    // A's box redacts from its own cache.
    await runtimeA.box.request(docA.id, { method: "POST", path: "/state/leak", body: `key=${STRIPE_VALUE}` }, ada);
    const answerA = await runtimeA.box.request(docA.id, { method: "GET", path: "/state/leak" }, ada);
    expect(new TextDecoder().decode(answerA.body)).toBe("key=[redacted:STRIPE_KEY]");

    // B's box has no cached value (and its own runtime's cache is separate), so
    // A's cache cannot bleed across — the value passes through unredacted.
    await runtimeB.box.request(docB.id, { method: "POST", path: "/state/leak", body: `key=${STRIPE_VALUE}` }, ada);
    const answerB = await runtimeB.box.request(docB.id, { method: "GET", path: "/state/leak" }, ada);
    expect(new TextDecoder().decode(answerB.body)).toBe(`key=${STRIPE_VALUE}`);
  });
});
