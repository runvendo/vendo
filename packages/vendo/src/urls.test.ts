import { describe, expect, it } from "vitest";
import { resolveVendoUrls } from "./urls.js";

describe("resolveVendoUrls", () => {
  it("is undefined with no base and no request fallback (zero-config dev)", () => {
    expect(resolveVendoUrls({})).toBeUndefined();
  });

  it("keeps the base URL's whole path on all three URLs", () => {
    const urls = resolveVendoUrls({ VENDO_BASE_URL: "https://site.com/maple" })!;
    expect(urls.publicUrl.href).toBe("https://site.com/maple");
    expect(urls.hostApiUrl.href).toBe("https://site.com/maple");
    expect(urls.loginUrl.href).toBe("https://site.com/maple/login");
  });

  it("defaults login to {public}/login and lets VENDO_LOGIN_URL win", () => {
    const relative = resolveVendoUrls({
      VENDO_BASE_URL: "https://site.com/maple",
      VENDO_LOGIN_URL: "/sign-in",
    })!;
    expect(relative.loginUrl.href).toBe("https://site.com/maple/sign-in");
    const absolute = resolveVendoUrls({
      VENDO_BASE_URL: "https://site.com/maple",
      VENDO_LOGIN_URL: "https://auth.other.com/login",
    })!;
    expect(absolute.loginUrl.href).toBe("https://auth.other.com/login");
  });

  it("lets VENDO_HOST_API_URL move the API to another origin without moving login", () => {
    const urls = resolveVendoUrls({
      VENDO_BASE_URL: "https://site.com/maple",
      VENDO_HOST_API_URL: "https://api.site.com",
    })!;
    expect(urls.hostApiUrl.href).toBe("https://api.site.com/");
    expect(urls.loginUrl.href).toBe("https://site.com/maple/login");
  });

  it("falls back to the request URL's origin when no base is configured", () => {
    const urls = resolveVendoUrls({}, { requestUrl: "http://localhost:3000/api/vendo/threads" })!;
    expect(urls.publicUrl.origin).toBe("http://localhost:3000");
    expect(urls.loginUrl.href).toBe("http://localhost:3000/login");
  });

  it("treats a blank env value as unset", () => {
    expect(resolveVendoUrls({ VENDO_BASE_URL: "" })).toBeUndefined();
  });

  it("fails loud on a malformed base", () => {
    expect(() => resolveVendoUrls({ VENDO_BASE_URL: "not-a-url" })).toThrow(TypeError);
  });
});
