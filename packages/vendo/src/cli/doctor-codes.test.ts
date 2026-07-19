import { describe, expect, it } from "vitest";
import { DOCTOR_ERROR_CODES, VERIFY_URL, doctorErrorCodes, doctorFixRef } from "./doctor-codes.js";
import { CLI_VERSION } from "./shared.js";

describe("doctor error-code registry", () => {
  it("exports a complete, well-formed list a CI check can enumerate", () => {
    expect(doctorErrorCodes.length).toBeGreaterThan(0);
    expect(doctorErrorCodes).toEqual(Object.keys(DOCTOR_ERROR_CODES));
    for (const code of doctorErrorCodes) {
      // Short, grep-able, stable: E-<AREA>-<NNN>.
      expect(code).toMatch(/^E-[A-Z]+-\d{3}$/);
      expect(DOCTOR_ERROR_CODES[code].length).toBeGreaterThan(0);
    }
  });

  it("builds a URL-valid fix_ref with the version param before the fragment", () => {
    const ref = doctorFixRef("E-AUTH-001", "1.2.3");
    expect(ref).toBe("https://vendo.run/agents/verify?v=1.2.3#E-AUTH-001");
    const url = new URL(ref);
    expect(url.searchParams.get("v")).toBe("1.2.3");
    expect(url.hash).toBe("#E-AUTH-001");
    expect(`${url.origin}${url.pathname}`).toBe(VERIFY_URL);
  });

  it("defaults the version param to the installed CLI version", () => {
    expect(new URL(doctorFixRef("E-WIRE-001")).searchParams.get("v")).toBe(CLI_VERSION);
  });
});
