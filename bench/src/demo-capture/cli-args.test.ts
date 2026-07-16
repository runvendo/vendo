import { describe, expect, it } from "vitest";
import { parseDemoCaptureArgs } from "./cli-args.js";

describe("parseDemoCaptureArgs", () => {
  it("defaults streaming capture to both demo hosts", () => {
    expect(parseDemoCaptureArgs(["streaming-first-paint"])).toMatchObject({
      beat: "streaming-first-paint",
      host: "both",
      port: 3000,
      timeoutMs: 180_000,
      boot: true,
      headed: false,
    });
  });

  it("accepts the literal separator forwarded by pnpm scripts", () => {
    expect(parseDemoCaptureArgs(["--", "streaming-first-paint"]))
      .toMatchObject({ beat: "streaming-first-paint", host: "both" });
  });

  it("parses a parameterized remix capture", () => {
    expect(parseDemoCaptureArgs([
      "remix-edit",
      "--host", "cadence",
      "--prompt", "Build the first view",
      "--edit-prompt", "Make it denser",
      "--port", "3210",
      "--timeout-ms", "240000",
      "--run-id", "after-streaming",
      "--headed",
      "--no-boot",
    ])).toEqual({
      beat: "remix-edit",
      host: "cadence",
      prompt: "Build the first view",
      editPrompt: "Make it denser",
      port: 3210,
      timeoutMs: 240_000,
      runId: "after-streaming",
      headed: true,
      boot: false,
      url: undefined,
      outputDir: undefined,
    });
  });

  it("requires the Wave-1 run directory for a corpus montage", () => {
    expect(() => parseDemoCaptureArgs(["corpus-montage"]))
      .toThrow("--gallery-run is required");

    expect(parseDemoCaptureArgs([
      "corpus-montage",
      "--gallery-run", "corpus/.repos/.gallery/run-42",
      "--repos", "umami,skateshop,papermark,express-host,taxonomy",
      "--output", "bench/demo-capture/output/run-42/corpus-montage.gif",
    ])).toMatchObject({
      beat: "corpus-montage",
      galleryRun: "corpus/.repos/.gallery/run-42",
      repos: ["umami", "skateshop", "papermark", "express-host", "taxonomy"],
    });
  });

  it("parses a demo-beats capture against a template-derived app directory", () => {
    expect(parseDemoCaptureArgs([
      "demo-beats",
      "--host-config", "apps/demo-template",
      "--port", "3100",
      "--run-id", "task6-acceptance",
    ])).toEqual({
      beat: "demo-beats",
      hostConfig: "apps/demo-template",
      port: 3100,
      timeoutMs: 180_000,
      runId: "task6-acceptance",
      headed: false,
      boot: true,
      url: undefined,
      outputDir: undefined,
    });
  });

  it("requires --host-config for demo-beats", () => {
    expect(() => parseDemoCaptureArgs(["demo-beats"]))
      .toThrow("--host-config is required for demo-beats");
  });

  it("rejects mixing --host with --host-config, including --host both", () => {
    expect(() => parseDemoCaptureArgs([
      "demo-beats",
      "--host-config", "apps/demo-template",
      "--host", "maple",
    ])).toThrow("--host and --host-config are mutually exclusive");

    expect(() => parseDemoCaptureArgs([
      "demo-beats",
      "--host-config", "apps/demo-template",
      "--host", "both",
    ])).toThrow("--host and --host-config are mutually exclusive");
  });

  it("rejects --host-config on the concrete maple/cadence beats", () => {
    expect(() => parseDemoCaptureArgs([
      "streaming-first-paint",
      "--host-config", "apps/demo-template",
    ])).toThrow("--host-config is only supported by the demo-beats beat");
  });

  it("rejects an ambiguous no-boot capture for both hosts", () => {
    expect(() => parseDemoCaptureArgs([
      "streaming-first-paint",
      "--host", "both",
      "--no-boot",
    ])).toThrow("--no-boot can target only one host");
  });

  it("rejects unknown beats and invalid numeric arguments", () => {
    expect(() => parseDemoCaptureArgs(["unknown"])).toThrow("Unknown demo beat");
    expect(() => parseDemoCaptureArgs(["host-component", "--port", "zero"])).toThrow("--port");
  });
});
