import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { JOB_MAX_BYTES, JobValidationError, parseJob, readJobFromStream } from "./job.js";

function streamOf(text: string): Readable {
  return Readable.from([Buffer.from(text, "utf8")]);
}

describe("readJobFromStream", () => {
  it("reads a small stream to a utf8 string", async () => {
    await expect(readJobFromStream(streamOf('{"a":1}'))).resolves.toBe('{"a":1}');
  });

  it("rejects input over JOB_MAX_BYTES without buffering it all", async () => {
    const big = "x".repeat(JOB_MAX_BYTES + 1);
    await expect(readJobFromStream(streamOf(big))).rejects.toThrow(JobValidationError);
  });

  it("accepts input exactly at JOB_MAX_BYTES", async () => {
    const exact = "a".repeat(JOB_MAX_BYTES);
    await expect(readJobFromStream(streamOf(exact))).resolves.toHaveLength(JOB_MAX_BYTES);
  });

  it("accepts a stream that yields string chunks, not just Buffers", async () => {
    const stream = Readable.from(["hello ", "world"], { objectMode: true });
    await expect(readJobFromStream(stream)).resolves.toBe("hello world");
  });
});

describe("parseJob", () => {
  const valid = { instructions: "list files", root: "/abs/root" };

  it("round-trips a valid job", () => {
    expect(parseJob(JSON.stringify(valid))).toEqual(valid);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseJob("{not json")).toThrow(JobValidationError);
    expect(() => parseJob("{not json")).toThrow(/not valid JSON/);
  });

  it("rejects a non-object JSON value", () => {
    expect(() => parseJob("42")).toThrow(/must be a JSON object/);
    expect(() => parseJob("null")).toThrow(/must be a JSON object/);
    expect(() => parseJob("[1,2]")).toThrow(/must be a JSON object/);
  });

  it("rejects a missing or empty instructions field", () => {
    expect(() => parseJob(JSON.stringify({ ...valid, instructions: "" }))).toThrow(/instructions/);
    expect(() => parseJob(JSON.stringify({ root: valid.root }))).toThrow(/instructions/);
    expect(() => parseJob(JSON.stringify({ ...valid, instructions: 7 }))).toThrow(/instructions/);
  });

  it("rejects a missing or empty root field", () => {
    expect(() => parseJob(JSON.stringify({ ...valid, root: "" }))).toThrow(/root/);
    expect(() => parseJob(JSON.stringify({ instructions: valid.instructions }))).toThrow(/root/);
  });

  it("rejects a relative root", () => {
    expect(() => parseJob(JSON.stringify({ ...valid, root: "relative/path" }))).toThrow(/absolute path/);
  });
});
