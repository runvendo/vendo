import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudError } from "./client.js";
import { runPinShip, runPublish, runShare } from "./services.js";

const VALID_KEY = `vnd_${"a".repeat(40)}`;

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vendo-cloud-services-"));
  cleanup.push(path);
  return path;
}

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message: string) => logs.push(message), error: (message: string) => errors.push(message) } };
}

describe("cloud services", () => {
  it.each([
    ["share", (fetcher: ReturnType<typeof vi.fn>) => runShare(["missing.json", "--key", "vnd_test"], { output: output().sink, fetcher })],
    ["publish", (fetcher: ReturnType<typeof vi.fn>) => runPublish(["missing.json", "--key", "vnd_test"], { output: output().sink, fetcher })],
    ["pin-ship", (fetcher: ReturnType<typeof vi.fn>) => runPinShip([
      "--app", "app_1", "--slot", "main", "--base", "hash", "--diff", "missing.diff", "--key", "vnd_test",
    ], { output: output().sink, fetcher })],
  ])("rejects a malformed key before the %s request", async (_command, run) => {
    const fetcher = vi.fn();
    expect(await run(fetcher)).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("prints the exact malformed key error", async () => {
    const messages = output();
    expect(await runShare(["missing.json", "--key", "vnd_test"], { output: messages.sink, fetcher: vi.fn() })).toBe(1);
    expect(messages.errors).toEqual(["Invalid API key format (expected vnd_ followed by 40 hex characters)"]);
  });

  it("maps an envelope-less 401 to a friendly invalid-key message", async () => {
    const root = await home();
    const file = join(root, "app.json");
    await writeFile(file, JSON.stringify({ id: "accounting", root: "card" }));
    const messages = output();
    expect(await runShare([file, "--key", VALID_KEY], {
      output: messages.sink,
      fetcher: vi.fn().mockRejectedValue(new CloudError("http-401", "Vendo Cloud request failed (401)", 401)),
    })).toBe(1);
    expect(messages.errors).toEqual(["Invalid or revoked API key (401)"]);
  });

  it("wraps a shared app document with its id", async () => {
    const root = await home();
    const file = join(root, "app.json");
    const doc = { id: "accounting", root: "card" };
    await writeFile(file, JSON.stringify(doc));
    const fetcher = vi.fn().mockResolvedValue({ id: "shr_1", doc });

    expect(await runShare([file, `--key=${VALID_KEY}`], { output: output().sink, fetcher, env: {} })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/apps/share", expect.objectContaining({
      body: { appId: "accounting", doc },
    }));
  });

  it("allows --app to override the published document id", async () => {
    const root = await home();
    const file = join(root, "app.json");
    const doc = { id: "file-id", root: "card" };
    await writeFile(file, JSON.stringify(doc));
    const fetcher = vi.fn().mockResolvedValue({ id: "pub_1", appId: "override-id" });

    expect(await runPublish([
      file, "--app", "override-id", `--key=${VALID_KEY}`,
    ], { output: output().sink, fetcher, env: {} })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/apps/publish", expect.objectContaining({
      body: { appId: "override-id", doc },
    }));
  });

  it("reads a textual diff for pin shipping", async () => {
    const root = await home();
    const file = join(root, "change.diff");
    await writeFile(file, "@@ -1 +1 @@\n-old\n+new\n");
    const fetcher = vi.fn().mockResolvedValue({ id: "pin_1", status: "pending" });

    expect(await runPinShip([
      "--app", "app_1", "--slot", "main", "--base", "hash", "--diff", file, "--key", VALID_KEY,
    ], { output: output().sink, fetcher })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/pins/ship", expect.objectContaining({
      body: { appId: "app_1", slot: "main", baseHash: "hash", diff: "@@ -1 +1 @@\n-old\n+new\n" },
    }));
  });

  it("prints a friendly cloud-required error", async () => {
    const root = await home();
    const file = join(root, "app.json");
    await writeFile(file, JSON.stringify({ id: "accounting", root: "card" }));
    const messages = output();
    const fetcher = vi.fn().mockRejectedValue(new CloudError("cloud-required", "Upgrade", 402));
    expect(await runShare([file, "--key", VALID_KEY], { output: messages.sink, fetcher })).toBe(1);
    expect(messages.errors).toEqual(["This key's org needs a Cloud plan (cloud-required)."]);
  });
});
