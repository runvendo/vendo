import { describe, expect, it } from "vitest";
import {
  joinPath,
  joinUrl,
  mountMismatchMessage,
  publicBase,
  stripPathPrefix,
  withPathPrefix,
} from "./url.js";

describe("withPathPrefix", () => {
  it("prefixes exactly once", () => {
    expect(withPathPrefix("/maple", "/api/vendo")).toBe("/maple/api/vendo");
  });

  /** The #914 class: a path that already carries the prefix must be left
   *  alone, or every join doubles it. */
  it("leaves an already-prefixed path alone", () => {
    expect(withPathPrefix("/maple", "/maple/api/vendo")).toBe("/maple/api/vendo");
  });

  it("does not treat a look-alike segment as prefixed", () => {
    expect(withPathPrefix("/maple", "/maplesyrup/api")).toBe("/maple/maplesyrup/api");
  });
});

describe("stripPathPrefix", () => {
  it.each([
    ["/maple", "/maple/api", "/api"],
    ["/maple", "/maple", "/"],
    ["/maple", "/other", "/other"],
    ["", "/api", "/api"],
  ])("prefix %j off %j → %j", (prefix, path, expected) => {
    expect(stripPathPrefix(prefix, path)).toBe(expected);
  });
});

describe("publicBase", () => {
  it("keeps the whole path, never strips it", () => {
    expect(publicBase("https://site.com/maple")).toEqual({ origin: "https://site.com", path: "/maple" });
  });

  it("normalizes a bare origin and a trailing slash to no path", () => {
    expect(publicBase("https://site.com")).toEqual({ origin: "https://site.com", path: "" });
    expect(publicBase("https://site.com/")).toEqual({ origin: "https://site.com", path: "" });
    expect(publicBase("https://site.com/maple/")).toEqual({ origin: "https://site.com", path: "/maple" });
  });

  it.each([
    ["not a url", "nope"],
    ["a non-http scheme", "ftp://site.com"],
    ["embedded credentials", "https://user:pw@site.com"],
  ])("refuses %s", (_label, value) => {
    expect(() => publicBase(value)).toThrow(TypeError);
  });
});

describe("joinUrl", () => {
  it("keeps the base's whole path and appends once", () => {
    expect(joinUrl("https://site.com/maple", "/api/transfers").href)
      .toBe("https://site.com/maple/api/transfers");
  });

  /** THE regression this whole slice exists for. */
  it("refuses to double a prefix the path already carries", () => {
    expect(joinUrl("https://site.com/maple", "/maple/api/transfers").href)
      .toBe("https://site.com/maple/api/transfers");
  });

  it("passes an absolute pathOrUrl through untouched (login on another domain)", () => {
    expect(joinUrl("https://site.com/maple", "https://auth.other.com/login").href)
      .toBe("https://auth.other.com/login");
  });

  it("keeps the query string", () => {
    expect(joinUrl("https://site.com/maple", "/login?returnTo=%2Fmaple%2Fx").href)
      .toBe("https://site.com/maple/login?returnTo=%2Fmaple%2Fx");
  });

  it("tolerates a trailing slash on the base and a missing leading slash on the path", () => {
    expect(joinUrl("https://site.com/maple/", "api/x").href).toBe("https://site.com/maple/api/x");
  });

  it("returns the base's own public path for an empty path", () => {
    expect(joinUrl("https://site.com/maple", "").href).toBe("https://site.com/maple");
    expect(joinUrl("https://site.com", "").href).toBe("https://site.com/");
  });

  /** A pure joiner: a basic-auth host API base (VENDO_HOST_API_URL) is
   *  legitimate server-side, so userinfo survives the join. The
   *  no-credentials rule is publicBase's alone. */
  it("carries a base's credentials through untouched", () => {
    expect(joinUrl("https://svc:pw@api.site.com/maple", "/api/x").href)
      .toBe("https://svc:pw@api.site.com/maple/api/x");
  });
});

describe("joinPath", () => {
  it("keeps a relative base relative (same-origin browser fetch)", () => {
    expect(joinPath("/maple/api/vendo", "/threads")).toBe("/maple/api/vendo/threads");
  });

  it("keeps an absolute base absolute", () => {
    expect(joinPath("http://127.0.0.1:5173/api/vendo", "/threads"))
      .toBe("http://127.0.0.1:5173/api/vendo/threads");
  });

  it("never doubles the base", () => {
    expect(joinPath("/api/vendo", "/api/vendo/threads")).toBe("/api/vendo/threads");
  });

  it("keeps the query string", () => {
    expect(joinPath("/api/vendo", "/apps?slots=a%2Cb")).toBe("/api/vendo/apps?slots=a%2Cb");
  });
});

describe("mountMismatchMessage", () => {
  it("names both sides and the fix", () => {
    const message = mountMismatchMessage({
      clientBaseUrl: "/api/vendo",
      requested: "/api/vendo/threads",
      pageMount: "/maple",
    });
    expect(message).toContain("/api/vendo");
    expect(message).toContain("/maple");
    expect(message).toContain("VendoProvider");
    expect(message).toContain("VENDO_BASE_URL");
  });
});
