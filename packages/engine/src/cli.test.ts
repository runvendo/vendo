import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { EngineDeps, EngineMessage } from "./types.js";

function streamOf(text: string): Readable {
  return Readable.from([Buffer.from(text, "utf8")]);
}

function scripted(...messages: EngineMessage[]): EngineDeps {
  return {
    async *query() {
      for (const m of messages) yield m;
    },
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
  };
}

const validJob = JSON.stringify({ instructions: "list files", root: "/abs/root" });

describe("runCli", () => {
  it('"run" with a valid job writes ONLY the final text to stdout, nothing on stderr\'s stdout channel', async () => {
    const { out, err, stdout, stderr } = io();
    const code = await runCli(["run"], { stdin: streamOf(validJob), stdout, stderr }, scripted({ kind: "success", text: "the final answer" }));
    expect(code).toBe(0);
    expect(out).toEqual(["the final answer"]);
    expect(err).toEqual([]);
  });

  it("defaults to run with no subcommand argument", async () => {
    const { out, stdout, stderr } = io();
    const code = await runCli([], { stdin: streamOf(validJob), stdout, stderr }, scripted({ kind: "success", text: "ok" }));
    expect(code).toBe(0);
    expect(out).toEqual(["ok"]);
  });

  it("sends progress narration to stderr, not stdout", async () => {
    const { out, err, stdout, stderr } = io();
    await runCli(
      ["run"],
      { stdin: streamOf(validJob), stdout, stderr },
      scripted({ kind: "progress", text: "Read foo.ts" }, { kind: "success", text: "done" }),
    );
    expect(out).toEqual(["done"]);
    expect(err.join("")).toContain("Read foo.ts");
  });

  it("an unknown subcommand exits non-zero with nothing on stdout", async () => {
    const { out, err, stdout, stderr } = io();
    const code = await runCli(["bogus"], { stdin: streamOf(validJob), stdout, stderr }, scripted());
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/unknown subcommand/);
  });

  it("malformed job JSON exits non-zero, error on stderr, nothing on stdout", async () => {
    const { out, err, stdout, stderr } = io();
    const code = await runCli(["run"], { stdin: streamOf("{not json"), stdout, stderr }, scripted());
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/not valid JSON/);
  });

  it("a job missing required fields exits non-zero with a clear error", async () => {
    const { out, err, stdout, stderr } = io();
    const code = await runCli(["run"], { stdin: streamOf("{}"), stdout, stderr }, scripted());
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/instructions/);
  });

  it("an engine failure result exits non-zero, error on stderr, nothing on stdout", async () => {
    const { out, err, stdout, stderr } = io();
    const code = await runCli(
      ["run"],
      { stdin: streamOf(validJob), stdout, stderr },
      scripted({ kind: "failure", errors: ["model refused"] }),
    );
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/model refused/);
  });

  it("a thrown error from the query seam is caught, not an uncaught rejection", async () => {
    const { out, err, stdout, stderr } = io();
    const deps: EngineDeps = {
      // eslint-disable-next-line require-yield
      async *query() {
        throw new Error("subprocess spawn failed");
      },
    };
    const code = await runCli(["run"], { stdin: streamOf(validJob), stdout, stderr }, deps);
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/subprocess spawn failed/);
  });

  it("a thrown non-Error value from the query seam is stringified, not swallowed", async () => {
    const { out, err, stdout, stderr } = io();
    const deps: EngineDeps = {
      // eslint-disable-next-line require-yield
      async *query() {
        throw "a bare string throw";
      },
    };
    const code = await runCli(["run"], { stdin: streamOf(validJob), stdout, stderr }, deps);
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/a bare string throw/);
  });

  it("a stream error while reading the job (not a validation error) is caught cleanly", async () => {
    const { out, err, stdout, stderr } = io();
    const broken = new Readable({
      read() {
        this.destroy(new Error("stdin pipe broke"));
      },
    });
    const code = await runCli(["run"], { stdin: broken, stdout, stderr }, scripted());
    expect(code).not.toBe(0);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/stdin pipe broke/);
  });
});
