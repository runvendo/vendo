import { describe, expect, it } from "vitest";
import { isSafeAppPath } from "./navigate";

describe("isSafeAppPath (remix navigation receiver)", () => {
  it("accepts same-app absolute paths", () => {
    expect(isSafeAppPath("/clients/cl_rivera")).toBe(true);
    expect(isSafeAppPath("/")).toBe(true);
    expect(isSafeAppPath("/calendar?view=week")).toBe(true);
  });

  it("rejects external, protocol-relative, scheme, relative, and empty hrefs", () => {
    expect(isSafeAppPath("https://evil.example")).toBe(false);
    expect(isSafeAppPath("//evil.example")).toBe(false);
    expect(isSafeAppPath("javascript:alert(1)")).toBe(false);
    expect(isSafeAppPath("mailto:x@y.z")).toBe(false);
    expect(isSafeAppPath("clients/cl_rivera")).toBe(false); // relative, not app-absolute
    expect(isSafeAppPath("")).toBe(false);
    expect(isSafeAppPath(undefined)).toBe(false);
    expect(isSafeAppPath({ href: "/x" })).toBe(false);
  });
});
