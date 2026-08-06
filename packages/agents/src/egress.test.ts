import { describe, expect, it } from "vitest";
import { resolveEgress, withEgress } from "./egress.js";

interface CreateSpec {
  template?: string;
  env: Record<string, string>;
  allowedDomains?: string[];
}

const recordingSandbox = () => {
  const created: CreateSpec[] = [];
  return {
    created,
    async create(spec: CreateSpec) {
      created.push(spec);
      return { id: "box_1" };
    },
  };
};

describe("resolveEgress", () => {
  it("normalizes to bare lowercase hostnames and dedupes", () => {
    expect(resolveEgress(["https://API.Stripe.com/v1", "api.stripe.com"])).toEqual(["api.stripe.com"]);
  });

  it("rejects an entry with no hostname", () => {
    expect(() => resolveEgress(["https://"])).toThrow(/not a hostname/);
  });

  it("passes 'all' and unset through", () => {
    expect(resolveEgress("all")).toBe("all");
    expect(resolveEgress(undefined)).toBeUndefined();
  });
});

describe("withEgress", () => {
  it("unset leaves the harness's minimum alone", async () => {
    const sandbox = recordingSandbox();
    const wrapped = withEgress(sandbox, undefined, () => {});
    await wrapped.create({ env: {}, allowedDomains: ["api.anthropic.com"] });
    expect(sandbox.created[0]?.allowedDomains).toEqual(["api.anthropic.com"]);
  });

  it("a list ADDS to the minimum, never replaces it", async () => {
    const sandbox = recordingSandbox();
    const wrapped = withEgress(sandbox, ["api.stripe.com"], () => {});
    await wrapped.create({ env: {}, allowedDomains: ["api.anthropic.com"] });
    expect(sandbox.created[0]?.allowedDomains).toEqual(["api.anthropic.com", "api.stripe.com"]);
  });

  it("'all' lifts the restriction entirely (undefined = unrestricted)", async () => {
    const sandbox = recordingSandbox();
    const wrapped = withEgress(sandbox, "all", () => {});
    await wrapped.create({ env: {}, allowedDomains: ["api.anthropic.com"] });
    expect(sandbox.created[0]).not.toHaveProperty("allowedDomains");
  });

  it("reports the effective skin at every box boot, before the box exists", async () => {
    const sandbox = recordingSandbox();
    const boots: Array<string[] | "all"> = [];
    const wrapped = withEgress(sandbox, ["api.stripe.com"], (domains) => {
      boots.push(domains);
      expect(sandbox.created).toHaveLength(0);
    });
    await wrapped.create({ env: {}, allowedDomains: ["api.anthropic.com"] });
    expect(boots).toEqual([["api.anthropic.com", "api.stripe.com"]]);
  });
});
