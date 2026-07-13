import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudError } from "./client.js";
import { runPinShip, runShare, runValidate } from "./services.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

describe("cloud services", () => {
  it("validates a machine key", async () => {
    const fetcher = vi.fn().mockResolvedValue({ valid: true, entitlements: ["sharing"] });
    expect(await runValidate(["--key", "vnd_test"], { output: output().sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/keys/validate", expect.objectContaining({
      auth: "key",
      apiKey: "vnd_test",
      method: "POST",
    }));
  });

  it("reads and posts an app document", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-cloud-services-"));
    cleanup.push(root);
    const file = join(root, "app.json");
    const app = { appId: "accounting", doc: { root: "card" } };
    await writeFile(file, JSON.stringify(app));
    const fetcher = vi.fn().mockResolvedValue({ id: "shr_1", doc: app.doc });

    expect(await runShare([file, "--key=vnd_test"], { output: output().sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/apps/share", expect.objectContaining({ body: app }));
  });

  it("reads a textual diff for pin shipping", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-cloud-pin-"));
    cleanup.push(root);
    const file = join(root, "change.diff");
    await writeFile(file, "@@ -1 +1 @@\n-old\n+new\n");
    const fetcher = vi.fn().mockResolvedValue({ id: "pin_1", status: "pending" });

    expect(await runPinShip([
      "--app", "app_1", "--slot", "main", "--base", "hash", "--diff", file, "--key", "vnd_test",
    ], { output: output().sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/pins/ship", expect.objectContaining({
      body: { appId: "app_1", slot: "main", baseHash: "hash", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    }));
  });

  it("prints a friendly cloud-required error", async () => {
    const messages = output();
    const fetcher = vi.fn().mockRejectedValue(new CloudError("cloud-required", "Upgrade", 402));
    expect(await runValidate(["--key", "vnd_test"], { output: messages.sink, fetcher })).toBe(1);
    expect(messages.errors).toEqual(["This key's org needs a Cloud plan (cloud-required)."]);
  });
});
