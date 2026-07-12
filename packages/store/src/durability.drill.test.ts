import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backends } from "./backends.test-util.js";
import { createStore, grantStore, threadStore } from "./index.js";

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

for (const backend of backends()) {
  describe(backend.name, () => {
    if (backend.name === "postgres") {
      console.info("postgres durability leg skipped — durability there is the server's own");
      it.skip("kill-the-server durability is owned by PostgreSQL", () => undefined);
      return;
    }

    const dirs: string[] = [];
    afterAll(async () => {
      for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    });

    it("recovers fully awaited writes after an ungraceful SIGKILL", async () => {
      const dataDir = await mkdtemp(join(tmpdir(), "vendo-store-drill-"));
      dirs.push(dataDir);
      const fixture = new URL("./__fixtures__/drill-writer.mjs", import.meta.url);
      const child = spawn(process.execPath, [fixture.pathname, dataDir], { stdio: ["ignore", "pipe", "pipe"] });
      await waitForMarker(child);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect(child.kill("SIGKILL")).toBe(true);
      await exited;

      const store = createStore({ dataDir });
      try {
        await store.ensureSchema();
        expect((await store.records("durability_records").get("durable_record"))?.data).toEqual({ durable: true });
        expect(await grantStore(store).get("grt_durable")).toMatchObject({ subject: "durable_user" });
        expect(await threadStore(store).get(
          { kind: "user", subject: "durable_user" },
          "thr_durable",
        )).toMatchObject({ messages: [{ role: "user", text: "persist me" }] });
      } finally {
        await store.close();
      }
    }, 30_000);
  });
}
