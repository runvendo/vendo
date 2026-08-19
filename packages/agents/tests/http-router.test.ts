import { VendoError, vendoErrorCodeSchema } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  dispatchRoutes,
  errorResponse,
  isJsonRequest,
  prefixRoute,
  relativePath,
  requestJson,
  route,
  routeSegments,
  type RouteContext,
} from "../src/http/router.js";

const wire = (method: string, path: string): RouteContext => ({
  request: new Request(`https://app.example.com${path}`, { method }),
  path,
  get segments() {
    return routeSegments(path);
  },
  params: {},
});

/** What every handler in these tests answers, so a 200 means "this entry ran". */
const ok = async () => new Response("ok");

describe("route", () => {
  it("matches an exact path and its method", async () => {
    const table = [route("GET", "/threads", ok)];

    expect(await dispatchRoutes(table, wire("GET", "/threads"))).toBeInstanceOf(Response);
    expect(await dispatchRoutes(table, wire("POST", "/threads"))).toBeUndefined();
    expect(await dispatchRoutes(table, wire("GET", "/threads/a"))).toBeUndefined();
  });

  it("captures :param segments, decoded", async () => {
    const context = wire("GET", "/apps/my%20app/fn/run");
    const seen: Record<string, string>[] = [];
    const table = [route("GET", "/apps/:appId/fn/:name", async ({ params }) => {
      seen.push(params);
      return new Response("ok");
    })];

    await dispatchRoutes(table, context);

    expect(seen).toEqual([{ appId: "my app", name: "run" }]);
  });

  it("lets a trailing /* match zero or more extra segments, but not fewer", async () => {
    const table = [route("GET", "/runs/:runId/*", ok)];

    expect(await dispatchRoutes(table, wire("GET", "/runs/r1"))).toBeInstanceOf(Response);
    expect(await dispatchRoutes(table, wire("GET", "/runs/r1/events/2"))).toBeInstanceOf(Response);
    expect(await dispatchRoutes(table, wire("GET", "/runs"))).toBeUndefined();
  });

  it("serves any method on \"*\", so a grouped handler dispatches methods itself", async () => {
    const table = [route("*", "/connections/:id", ok)];

    expect(await dispatchRoutes(table, wire("DELETE", "/connections/c1"))).toBeInstanceOf(Response);
    expect(await dispatchRoutes(table, wire("PATCH", "/connections/c1"))).toBeInstanceOf(Response);
  });
});

describe("prefixRoute", () => {
  it("matches the RAW path and never decodes it", async () => {
    const table = [prefixRoute("GET", "/proxy/", ok)];

    // The reason prefix entries exist: a percent-encoding a decoder would
    // reject still reaches the proxy verbatim.
    expect(await dispatchRoutes(table, wire("GET", "/proxy/%zz"))).toBeInstanceOf(Response);
    expect(await dispatchRoutes(table, wire("GET", "/proxied/x"))).toBeUndefined();
  });
});

describe("dispatchRoutes", () => {
  it("scans in order, falls through a handler that answers undefined, and answers undefined on no match", async () => {
    const ran: string[] = [];
    const table = [
      route("GET", "/x", async () => {
        ran.push("first");
        return undefined;
      }),
      route("GET", "/x", async () => {
        ran.push("second");
        return new Response("second");
      }),
      route("GET", "/x", async () => {
        ran.push("third");
        return new Response("third");
      }),
    ];

    const response = await dispatchRoutes(table, wire("GET", "/x"));

    expect(await response?.text()).toBe("second");
    expect(ran).toEqual(["first", "second"]);
    expect(await dispatchRoutes(table, wire("GET", "/y"))).toBeUndefined();
  });
});

describe("errorResponse", () => {
  // Every code core defines, so a new one added there without a status here
  // fails HERE rather than at a caller's first refusal (an unmapped code makes
  // Response.json throw on an undefined status).
  const STATUSES: Record<(typeof vendoErrorCodeSchema.options)[number], number> = {
    validation: 400,
    "cloud-required": 402,
    blocked: 403,
    forbidden: 403,
    "not-found": 404,
    conflict: 409,
    "schema-proposal": 409,
    "not-implemented": 501,
    "sandbox-unavailable": 501,
    unavailable: 503,
  };

  it.each(vendoErrorCodeSchema.options)("maps %s to its status", (code) => {
    expect(errorResponse(new VendoError(code, "nope")).status).toBe(STATUSES[code]);
  });

  it("carries the code and message in the envelope", async () => {
    const response = errorResponse(new VendoError("not-found", "unknown Vendo route"));

    expect(await response.json()).toEqual({ error: { code: "not-found", message: "unknown Vendo route" } });
  });
});

describe("requestJson", () => {
  const body = (raw: string) => new Request("https://app.example.com/x", { method: "POST", body: raw });

  it("returns an object body", async () => {
    expect(await requestJson(body(`{"a":1}`))).toEqual({ a: 1 });
  });

  it.each([["an array", "[1]"], ["a scalar", `"hi"`], ["null", "null"], ["unparseable", "{"]])(
    "refuses %s as validation",
    async (_label, raw) => {
      await expect(requestJson(body(raw))).rejects.toMatchObject({ code: "validation" });
    },
  );
});

describe("routeSegments", () => {
  it("throws validation on a bad percent-encoding", () => {
    expect(() => routeSegments("/threads/%zz")).toThrow(/invalid URL encoding/);
  });
});

describe("relativePath", () => {
  const at = (pathname: string) => relativePath("/api/vendo", new URL(`https://app.example.com${pathname}`));

  it("strips the mount, and answers / for the mount itself", () => {
    expect(at("/api/vendo")).toBe("/");
    expect(at("/api/vendo/threads")).toBe("/threads");
  });

  it("answers null outside the mount, including a prefix that only looks like it", () => {
    expect(at("/other")).toBeNull();
    expect(at("/api/vendoxyz")).toBeNull();
  });
});

describe("isJsonRequest", () => {
  const withType = (value: string) =>
    isJsonRequest(new Request("https://app.example.com/x", { method: "POST", headers: { "content-type": value } }));

  it("ignores parameters and casing", () => {
    expect(withType("Application/JSON; charset=utf-8")).toBe(true);
    expect(withType("text/plain")).toBe(false);
  });

  it("is false with no content-type at all", () => {
    expect(isJsonRequest(new Request("https://app.example.com/x", { method: "POST" }))).toBe(false);
  });
});
