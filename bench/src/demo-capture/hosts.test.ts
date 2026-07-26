import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configDemoHost, demoHostCommandArgs } from "./hosts.js";

describe("demoHostCommandArgs", () => {
  it("forwards Next options without a literal pnpm separator", () => {
    expect(demoHostCommandArgs("demo-bank", 3100)).toEqual([
      "--filter", "demo-bank", "dev",
      "--hostname", "127.0.0.1",
      "--port", "3100",
    ]);
  });
});

describe("configDemoHost", () => {
  const sampleConfig = {
    id: "acme-widgets",
    prospect: "Acme Widgets",
    ctaUrl: "https://cal.com/yousefhelal",
    beats: [
      { key: "generate-ui", prompt: "Show me a dashboard", chip: "Dashboard" },
      { key: "take-action", prompt: "Archive the oldest item", chip: "Archive" },
    ],
    caps: { maxTurns: 20, maxSpendUsd: 5 },
    expiresAt: "2099-01-01T00:00:00Z",
  };

  async function writeAppFixture(options?: {
    config?: unknown;
    packageJson?: unknown;
  }): Promise<string> {
    const appDir = await mkdtemp(path.join(tmpdir(), "vendo-demo-app-"));
    await writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify(options?.packageJson ?? { name: "acme-widgets-demo", private: true }),
    );
    await writeFile(
      path.join(appDir, "demo.config.json"),
      JSON.stringify(options?.config ?? sampleConfig),
    );
    return appDir;
  }

  it("builds the host definition from the app directory conventions", async () => {
    const appDir = await writeAppFixture();
    const { host, config } = await configDemoHost(appDir);
    expect(host).toEqual({
      id: "acme-widgets",
      label: "ACME WIDGETS",
      packageName: "acme-widgets-demo",
      route: "/vendo",
      threadId: "thr_acme_widgets_demo",
    });
    expect(config.beats.map((beat) => beat.key)).toEqual(["generate-ui", "take-action"]);
  });

  it("surfaces the app schema's own message for an invalid demo.config", async () => {
    const appDir = await writeAppFixture({
      config: { ...sampleConfig, prospect: "", beats: [] },
    });
    await expect(configDemoHost(appDir)).rejects.toThrow(/invalid demo config .*prospect: must be non-empty.*beats: must be a non-empty array/);
  });

  it("fails loudly when the app's package.json has no usable name", async () => {
    const appDir = await writeAppFixture({ packageJson: { private: true } });
    await expect(configDemoHost(appDir)).rejects.toThrow(`no "name" in "${path.join(appDir, "package.json")}"`);
  });
});
