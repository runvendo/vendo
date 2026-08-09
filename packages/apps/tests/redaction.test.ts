import type { AppDocument, RunContext, SecretsProvider, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createMachineLane } from "../src/box-lane.js";
import { createApps, type AppsConfig } from "../src/index.js";
import { collectSecretValues, redactSecretJson, redactSecretText } from "../src/redaction.js";
import { fakeBoxSandbox, type FakeBoxAgent } from "../src/testing/fake-box.js";
import { fakeStatefulSandbox } from "../src/testing/fake-sandbox-stateful.js";
import { guardFixture } from "../src/testing/guard-fixture.js";
import { memoryStore } from "../src/testing/memory-store.js";
import { basicLanguageModel } from "../src/testing/scripted-model.js";
import { seedAppRow } from "../src/testing/seed-app-row.js";

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

  /** The in-box agent, as the escalation ladder's box arm meets it: it installs
   *  the leaky fn — a POST /fn/<name> handler that puts the secret value into
   *  its own response, which is the exact shape the box door's redaction guard
   *  exists for. */
  const leakyAgent: FakeBoxAgent = ({ box }) => {
    box.fns.set("leak", () => `key=${STRIPE_VALUE}`);
    return { ok: true, summary: "installed the leaky fn", filesChanged: ["/app/fns.js"], testsRun: 0, fns: ["leak"] };
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
    // Nothing here generates a screen: the assembler escalates, and the box is
    // what builds. The model is present because a runtime without one refuses
    // to edit at all.
    model: basicLanguageModel(),
    screen: { assemble: async () => ({ kind: "escalate", why: "this needs real code" }) },
    machine: { sandbox: fakeBoxSandbox({ agent: leakyAgent }), buildEnv: injectingEnv(inject), boxEditPollMs: 1 },
  });

  /** Graduation, through the door a person actually takes: the assembler
   *  escalates, the box arm provisions the machine on the RUNTIME's own
   *  lifecycle and then re-injects the boundary env before the in-box agent
   *  runs. Both of those assemble the env through this deployment's `buildEnv`,
   *  and both cache what entered the box — which is the cache the box door
   *  below reads. */
  const graduate = async (runtime: ReturnType<typeof createApps>, appId: string): Promise<void> => {
    const result = await runtime.edit(appId, "Reconcile my invoices with custom matching logic", ada);
    expect(result.failure).toBeUndefined();
    expect(result.app.machine).toBeDefined();
  };

  /** One leaky fn call, as the box door serves it. */
  const callLeak = async (runtime: ReturnType<typeof createApps>, appId: string): Promise<string> => {
    const answer = await runtime.box.request(appId, {
      method: "POST",
      path: "/fn/leak",
      body: JSON.stringify({ args: {} }),
    }, ada);
    return new TextDecoder().decode(answer.body);
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
    // The env assembly injects the value; the runtime's own lifecycle caches it
    // for this box on the way in.
    await graduate(runtime, doc.id);
    // Now the vault goes offline — the pre-fix refetch in collectSecretValues fails.
    breakRefetch();

    expect(await callLeak(runtime, doc.id)).toContain("[redacted:STRIPE_KEY]");
    expect(await callLeak(runtime, doc.id)).not.toContain(STRIPE_VALUE);

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
    await graduate(runtime, doc.id);
    breakRefetch();

    // No cached value, refetch fails: best-effort armor leaves it alone (no 500).
    expect(await callLeak(runtime, doc.id)).toContain(STRIPE_VALUE);
  });

  it("the cache never crosses box boundaries — one box's injected value cannot redact another's output", async () => {
    const store = memoryStore();
    const { provider, break: breakRefetch } = mutableSecrets();
    // App A injects the value; App B declares the same name but never gets it granted.
    const runtimeA = createApps(configWith(store, provider, true));
    const runtimeB = createApps(configWith(store, provider, false));
    const docA = await seed(store, "app_box_a");
    const docB = await seed(store, "app_box_b");
    await graduate(runtimeA, docA.id);
    await graduate(runtimeB, docB.id);
    breakRefetch();

    // A's box redacts from its own cache.
    expect(await callLeak(runtimeA, docA.id)).toContain("[redacted:STRIPE_KEY]");

    // B's box has no cached value (and its own runtime's cache is separate), so
    // A's cache cannot bleed across — the value passes through unredacted.
    expect(await callLeak(runtimeB, docB.id)).toContain(STRIPE_VALUE);
  });
});
