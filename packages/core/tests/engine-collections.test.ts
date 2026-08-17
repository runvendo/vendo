import { describe, expect, it } from "vitest";
import { VendoError } from "../src/errors.js";
import {
  ENGINE_ALLOWLIST_VERSION,
  ENGINE_COLLECTIONS,
  assertEngineCollection,
  assertIndexedField,
  collectionKind,
  engineAppHistory,
  isEngineCollection,
} from "../src/engine-collections.js";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as VendoError).code;
  }
  throw new Error("expected a throw");
}

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as VendoError).message;
  }
  throw new Error("expected a throw");
}

describe("engine allowlist", () => {
  it("holds 38 distinct static collections", () => {
    expect(ENGINE_ALLOWLIST_VERSION).toBe(5);
    expect(ENGINE_COLLECTIONS).toHaveLength(38);
    expect(new Set(ENGINE_COLLECTIONS).size).toBe(38);
  });

  it("admits one name from each group and refuses host/app data", () => {
    expect(isEngineCollection("vendo_audit")).toBe(true); // reserved
    expect(isEngineCollection("vendo_mcp_clients")).toBe(true); // dedicated table
    expect(isEngineCollection("guard:controls")).toBe(true); // generic table
    expect(isEngineCollection("users")).toBe(false);
    expect(isEngineCollection("app:app_1:notes")).toBe(false);
    expect(isEngineCollection("")).toBe(false);
  });

  // vendo_secrets has zero `.records()` call sites — it is served only by the
  // dedicated secretStore door (packages/store/src/secrets.ts), so the engine
  // family must never reach it.
  it("does not admit vendo_secrets", () => {
    expect(isEngineCollection("vendo_secrets")).toBe(false);
    expect(codeOf(() => assertEngineCollection("vendo_secrets"))).toBe("blocked");
  });

  it("composes an app-history name that passes the gate", () => {
    expect(engineAppHistory("app_x")).toBe("vendo:app-history:app_x");
    expect(isEngineCollection(engineAppHistory("app_x"))).toBe(true);
  });

  it("refuses app ids that would compose someone else's drawer", () => {
    expect(codeOf(() => engineAppHistory(""))).toBe("validation");
    expect(codeOf(() => engineAppHistory("a:b"))).toBe("validation");
    expect(codeOf(() => engineAppHistory("a".repeat(129)))).toBe("validation");
  });

  it("passes allowed names through silently", () => {
    expect(() => assertEngineCollection("vendo_grants")).not.toThrow();
    expect(() => assertEngineCollection(engineAppHistory("app_1"))).not.toThrow();
  });

  it("refuses an unknown name, naming the version and the right door", () => {
    expect(codeOf(() => assertEngineCollection("users"))).toBe("blocked");
    const message = messageOf(() => assertEngineCollection("users"));
    // Against the constant, like the conformance suite's own check
    // (conformance/store-ops.ts:241): the point is that the refusal names THIS
    // build's list, so a bump does not turn into a test edit every time.
    expect(message).toContain(`v${ENGINE_ALLOWLIST_VERSION}`);
    expect(message).toContain("appData");
    // "users" is not a typo of anything here, so it collects no guess.
    expect(message).not.toContain("did you mean");
  });

  it("suggests the nearest allowed name on a typo", () => {
    expect(messageOf(() => assertEngineCollection("vendo_audi"))).toContain("vendo_audit");
  });

  it("invents no suggestion for a name nothing is close to", () => {
    const far = "z".repeat(32);
    expect(codeOf(() => assertEngineCollection(far))).toBe("blocked");
    expect(messageOf(() => assertEngineCollection(far))).not.toContain("did you mean");
  });

  it("refuses app-history names the pattern does not accept", () => {
    expect(codeOf(() => assertEngineCollection("vendo:app-history:"))).toBe("blocked");
    expect(codeOf(() => assertEngineCollection("vendo:app-history:a/b"))).toBe("blocked");
  });
});

describe("collection kind", () => {
  it("calls the corpus knowledge and everything else storage", () => {
    expect(collectionKind("vendo_knowledge_docs")).toBe("knowledge");
    expect(collectionKind("vendo_knowledge_chunks")).toBe("knowledge");
    expect(collectionKind("vendo_audit")).toBe("storage");
    expect(collectionKind("guard:controls")).toBe("storage");
  });

  // `knowledge` is what Cloud meters as index cost, so a collection nobody
  // registered must never fall into it by default — the app-history pattern and
  // any appData collection a footprint runs across are storage.
  it("defaults an unregistered collection to storage, never knowledge", () => {
    expect(collectionKind(engineAppHistory("app_1"))).toBe("storage");
    expect(collectionKind("app:app_1:notes")).toBe("storage");
  });

  it("registers exactly two knowledge collections", () => {
    expect(ENGINE_COLLECTIONS.filter((name) => collectionKind(name) === "knowledge"))
      .toEqual(["vendo_knowledge_docs", "vendo_knowledge_chunks"]);
  });
});

describe("indexed fields", () => {
  it("accepts the one field a collection declares", () => {
    expect(() => assertIndexedField("vendo_runs", "started_at")).not.toThrow();
  });

  // A bound on an unindexed column is a full table scan wearing a filter's
  // clothes — refused, and the refusal names what IS indexed so the caller is
  // not left guessing.
  it("refuses a field the collection does not index, and says what it does", () => {
    expect(codeOf(() => assertIndexedField("vendo_runs", "finished_at"))).toBe("validation");
    expect(messageOf(() => assertIndexedField("vendo_runs", "finished_at"))).toContain("started_at");
  });

  it("refuses every field of a collection that declares none, and says so", () => {
    expect(codeOf(() => assertIndexedField("vendo_audit", "at"))).toBe("validation");
    expect(messageOf(() => assertIndexedField("vendo_audit", "at"))).toContain("declares none");
  });
});
