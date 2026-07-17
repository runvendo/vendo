import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createStore, grantStore, threadStore } from "./index.js";

// ENG-351 — the field failure under `next dev`: a second process opens PGlite
// on a data dir a live writer already holds (Turbopack evaluates the host's
// server graph in transient workers too). PGlite has no cross-process lock, so
// before the fix the second instance's startup writes tore the writer's WAL —
// the dir reopened with `Aborted()` and the last turns were gone. With the
// store's single-writer lock the second opener WAITS, and only proceeds once
// the holder is dead — at which point every awaited write must still be there.

const waitForMarker = (child: ChildProcess): Promise<void> => new Promise((resolve, reject) => {
  let output = "";
  const timeout = setTimeout(() => reject(new Error(`timed out waiting for writer marker: ${output}`)), 20_000);
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("WRITES-DURABLE")) {
      clearTimeout(timeout);
      resolve();
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.once("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once("exit", (code, signal) => {
    if (!output.includes("WRITES-DURABLE")) {
      clearTimeout(timeout);
      reject(new Error(`writer exited before marker (code=${code}, signal=${signal}): ${output}`));
    }
  });
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("pglite", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}.lock`, { force: true });
    }
  });

  it("a second opener waits for a live writer, then recovers its writes after SIGKILL", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-split-brain-"));
    dirs.push(dataDir);
    const fixture = new URL("./__fixtures__/drill-writer.mjs", import.meta.url);
    const writer = spawn(process.execPath, [fixture.pathname, dataDir], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForMarker(writer);

    // Second opener (this process) on the same dir: it must NOT start a second
    // wasm postgres while the writer lives — that is the corruption.
    const store = createStore({ dataDir });
    try {
      const opening = store.ensureSchema();
      const raced = await Promise.race([
        opening.then(() => "opened", () => "opened"),
        wait(1_500).then(() => "waiting"),
      ]);
      expect(raced).toBe("waiting");

      // Kill the writer the way a dev-server kill does; the waiter takes over.
      const exited = new Promise<void>((resolve) => writer.once("exit", () => resolve()));
      expect(writer.kill("SIGKILL")).toBe(true);
      await exited;
      await opening;

      // The dir is openable (not `Aborted()`) and the writer's awaited writes survived.
      expect((await store.records("durability_records").get("durable_record"))?.data).toEqual({ durable: true });
      expect(await grantStore(store).get("grt_durable")).toMatchObject({ subject: "durable_user" });
      expect(await threadStore(store).get(
        { kind: "user", subject: "durable_user" },
        "thr_durable",
      )).toMatchObject({ messages: [{ role: "user", text: "persist me" }] });
    } finally {
      await store.close();
    }
  }, 40_000);
});
