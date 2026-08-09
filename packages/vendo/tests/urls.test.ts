import { describe, expect, it } from "vitest";
import { resolveVendoUrls } from "../src/urls.js";

describe("resolveVendoUrls", () => {
  it("is undefined with no base (zero-config dev)", () => {
    expect(resolveVendoUrls({})).toBeUndefined();
  });

  it("keeps the base URL's whole path on both URLs", () => {
    const urls = resolveVendoUrls({ VENDO_BASE_URL: "https://site.com/maple" })!;
    expect(urls.publicUrl.href).toBe("https://site.com/maple");
    expect(urls.hostApiUrl.href).toBe("https://site.com/maple");
  });

  it("lets VENDO_HOST_API_URL move the API to another origin", () => {
    const urls = resolveVendoUrls({
      VENDO_BASE_URL: "https://site.com/maple",
      VENDO_HOST_API_URL: "https://api.site.com",
    })!;
    expect(urls.hostApiUrl.href).toBe("https://api.site.com/");
  });

  it("treats a blank env value as unset", () => {
    expect(resolveVendoUrls({ VENDO_BASE_URL: "" })).toBeUndefined();
  });

  it("fails loud on a malformed base", () => {
    expect(() => resolveVendoUrls({ VENDO_BASE_URL: "not-a-url" })).toThrow(TypeError);
  });
});
