import type { AppDocument, RunContext, SecretsProvider, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { collectSecretValues, redactSecretJson, redactSecretText } from "./redaction.js";
import {
  fakeSandboxV2,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

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
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools,
      catalog: [],
      secrets,
      experimentalMachines: true,
      machine: { sandbox: fakeSandboxV2(), buildEnv: () => ({ PORT: "8080" }) },
    });
    await runtime.machine.provision(doc.id, ada);
    return { runtime, doc };
  };

  it("an fn response echoing a secret value comes back redacted", async () => {
    const { runtime, doc } = await setup();
    // The fake v2 box stores what it is told and echoes it back — the exact
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
