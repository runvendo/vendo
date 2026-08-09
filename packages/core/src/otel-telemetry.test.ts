import { afterEach, describe, expect, it } from "vitest";
import { otelTelemetry } from "./otel-telemetry.js";

const original = process.env.VENDO_OTEL_TRACING;

afterEach(() => {
  if (original === undefined) delete process.env.VENDO_OTEL_TRACING;
  else process.env.VENDO_OTEL_TRACING = original;
});

describe("otelTelemetry", () => {
  it("returns {} when unset, so a call spreads to exactly today's behaviour", () => {
    delete process.env.VENDO_OTEL_TRACING;
    expect(otelTelemetry("vendo.agent.turn")).toEqual({});
  });

  it("stays off for any value that is not an explicit opt-in", () => {
    for (const value of ["0", "false", "", "yes", "on", "METRICS"]) {
      process.env.VENDO_OTEL_TRACING = value;
      expect(otelTelemetry("vendo.agent.turn")).toEqual({});
    }
  });

  it("emits settings named for the lane, with payloads, on =1", () => {
    process.env.VENDO_OTEL_TRACING = "1";
    expect(otelTelemetry("vendo.apps.generate")).toEqual({
      experimental_telemetry: {
        isEnabled: true,
        functionId: "vendo.apps.generate",
        recordInputs: true,
        recordOutputs: true,
      },
    });
  });

  it("accepts 'true' as well as '1'", () => {
    process.env.VENDO_OTEL_TRACING = "true";
    expect(otelTelemetry("vendo.agent.turn")).toHaveProperty("experimental_telemetry.isEnabled", true);
  });

  it("=metrics traces WITHOUT shipping prompts or tool results", () => {
    process.env.VENDO_OTEL_TRACING = "metrics";
    expect(otelTelemetry("vendo.agent.turn")).toEqual({
      experimental_telemetry: {
        isEnabled: true,
        functionId: "vendo.agent.turn",
        recordInputs: false,
        recordOutputs: false,
      },
    });
  });

  it("lets an explicit option override the env in either direction", () => {
    process.env.VENDO_OTEL_TRACING = "metrics";
    expect(otelTelemetry("vendo.agent.turn", { recordInputs: true }))
      .toHaveProperty("experimental_telemetry.recordInputs", true);

    process.env.VENDO_OTEL_TRACING = "1";
    expect(otelTelemetry("vendo.agent.turn", { recordOutputs: false }))
      .toHaveProperty("experimental_telemetry.recordOutputs", false);
  });

  it("carries host metadata through when given, and omits the key when not", () => {
    process.env.VENDO_OTEL_TRACING = "1";
    expect(otelTelemetry("vendo.agent.turn", { metadata: { tenant: "acme" } }))
      .toHaveProperty("experimental_telemetry.metadata", { tenant: "acme" });
    expect(otelTelemetry("vendo.agent.turn").experimental_telemetry).not.toHaveProperty("metadata");
  });

  it("is read per call, so a host can flip it without a restart", () => {
    delete process.env.VENDO_OTEL_TRACING;
    expect(otelTelemetry("vendo.apps.check")).toEqual({});
    process.env.VENDO_OTEL_TRACING = "1";
    expect(otelTelemetry("vendo.apps.check")).not.toEqual({});
  });
});
