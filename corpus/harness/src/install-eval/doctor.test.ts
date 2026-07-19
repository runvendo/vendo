import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { doctorOutcomeFromReport, parseDoctorJson, runFixtureDoctor } from "./doctor.js";
import type { InstallEvalFixture } from "./fixtures.js";

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

const fixture: InstallEvalFixture = {
  name: "unit",
  sourcePath: "unit",
  devServer: { command: "true", readinessUrl: "http://127.0.0.1:3999" },
  doctorUrl: "http://127.0.0.1:3999/api/vendo",
};

describe("runFixtureDoctor guards", () => {
  it("fails distinctly when the fixture has no vendo CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-doctor-"));
    const outcome = await runFixtureDoctor({
      fixture,
      fixtureDir: dir,
      logsDir: path.join(dir, "logs"),
      checkPortOccupied: async () => {
        throw new Error("must not reach the port guard without a CLI");
      },
    });
    expect(outcome).toMatchObject({ ran: false, green: false, failingCodes: ["vendo-cli-missing"] });
  });

  it("refuses to boot when something already answers on the fixture port", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "install-eval-doctor-port-"));
    await mkdir(path.join(dir, "node_modules", "@vendoai", "vendo", "bin"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "@vendoai", "vendo", "bin", "vendo.mjs"), "// stub");
    const outcome = await runFixtureDoctor({
      fixture,
      fixtureDir: dir,
      logsDir: path.join(dir, "logs"),
      checkPortOccupied: async () => true,
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.green).toBe(false);
    expect(outcome.failingCodes).toEqual(["port-already-occupied"]);
    expect(outcome.detail).toContain("fake a green");
  });
});
