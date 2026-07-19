import { describe, expect, it } from "vitest";
import { doctorOutcomeFromReport, parseDoctorJson } from "./doctor.js";

const doctorStdout = `starting…
{
  "vendo": "doctor",
  "wired": false,
  "exit": 1,
  "checks": [
    { "id": "wiring/layout", "status": "broken", "error_code": "E-WIRE-004" },
    { "id": "config/files", "status": "ok" },
    { "id": "cloud/key", "status": "warning", "error_code": "E-CLOUD-001" }
  ]
}`;

describe("parseDoctorJson", () => {
  it("tolerates human noise before the JSON object", () => {
    expect(parseDoctorJson(doctorStdout)?.wired).toBe(false);
  });

  it("returns null for garbage", () => {
    expect(parseDoctorJson("no json here")).toBeNull();
  });
});

describe("doctorOutcomeFromReport", () => {
  it("collects only broken error codes (warnings stay green-compatible)", () => {
    const outcome = doctorOutcomeFromReport(parseDoctorJson(doctorStdout), 1, doctorStdout);
    expect(outcome.green).toBe(false);
    expect(outcome.failingCodes).toEqual(["E-WIRE-004"]);
  });

  it("is green only on exit 0 + wired", () => {
    const report = { wired: true, checks: [] };
    expect(doctorOutcomeFromReport(report, 0, "").green).toBe(true);
    expect(doctorOutcomeFromReport(report, 1, "").green).toBe(false);
  });

  it("marks unparseable output distinctly", () => {
    const outcome = doctorOutcomeFromReport(null, 0, "garbage");
    expect(outcome.failingCodes).toEqual(["doctor-json-unparseable"]);
  });
});
