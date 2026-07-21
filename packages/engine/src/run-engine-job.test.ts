import { describe, expect, it } from "vitest";
import { runEngineJob } from "./run-engine-job.js";
import type { EngineDeps, EngineMessage, EngineJob } from "./types.js";

const job: EngineJob = { instructions: "do the thing", root: "/tmp/root" };

function scripted(...messages: EngineMessage[]): EngineDeps {
  return {
    async *query() {
      for (const m of messages) yield m;
    },
  };
}

describe("runEngineJob", () => {
  it("resolves ok with the success message's text", async () => {
    const result = await runEngineJob(job, scripted({ kind: "success", text: "final answer" }));
    expect(result).toEqual({ ok: true, text: "final answer", errors: [] });
  });

  it("routes progress messages to onProgress, not into the result", async () => {
    const seen: string[] = [];
    const result = await runEngineJob(
      job,
      scripted({ kind: "progress", text: "Read foo.ts" }, { kind: "progress", text: "Glob **/*.ts" }, { kind: "success", text: "done" }),
      (line) => seen.push(line),
    );
    expect(seen).toEqual(["Read foo.ts", "Glob **/*.ts"]);
    expect(result).toEqual({ ok: true, text: "done", errors: [] });
  });

  it("resolves not-ok with the failure message's errors", async () => {
    const result = await runEngineJob(job, scripted({ kind: "failure", errors: ["boom", "again"] }));
    expect(result).toEqual({ ok: false, text: "", errors: ["boom", "again"] });
  });

  it("stops draining after a failure message (does not read further)", async () => {
    let readAfterFailure = false;
    const deps: EngineDeps = {
      async *query() {
        yield { kind: "failure", errors: ["stop here"] };
        readAfterFailure = true; // would only run if the generator is pumped again
        yield { kind: "success", text: "should never appear" };
      },
    };
    const result = await runEngineJob(job, deps);
    expect(result).toEqual({ ok: false, text: "", errors: ["stop here"] });
    expect(readAfterFailure).toBe(false);
  });

  it("treats a stream that ends without a result message as a failure", async () => {
    const result = await runEngineJob(job, scripted({ kind: "progress", text: "only progress, no terminal message" }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/ended without a result/);
  });

  it("treats an empty stream (no messages at all) as a failure", async () => {
    const result = await runEngineJob(job, scripted());
    expect(result.ok).toBe(false);
  });

  it("passes the job through to the query seam unmodified", async () => {
    let received: EngineJob | undefined;
    const deps: EngineDeps = {
      async *query(j) {
        received = j;
        yield { kind: "success", text: "ok" };
      },
    };
    await runEngineJob(job, deps);
    expect(received).toEqual(job);
  });
});
