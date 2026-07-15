import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveGenerationIfRequested,
  calculateGalleryP95,
  captureGalleryRepo,
  convertVideoToGif,
  createGalleryTimings,
  discoverConfiguredGalleryRepoNames,
  galleryNavigationOptions,
  loadGalleryConfig,
  parseGalleryConfig,
  writeGalleryHtml,
  type GalleryCaptureDriver,
} from "./gallery.js";
import type { E2ePage } from "./layers/e2e.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-gallery-"));
  tempRoots.push(root);
  return root;
}

describe("gallery config", () => {
  it("uses a DOM-ready navigation policy with a bounded live-host timeout", () => {
    expect(galleryNavigationOptions(240_000)).toEqual({
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    expect(galleryNavigationOptions(25_000)).toEqual({
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
  });

  it("discovers defaults only from checked-in gallery configs", async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, "umami"), { recursive: true });
    await mkdir(path.join(root, "express-host"), { recursive: true });
    await mkdir(path.join(root, "teable"), { recursive: true });
    await writeFile(path.join(root, "umami/gallery.json"), "{}");
    await writeFile(path.join(root, "express-host/gallery.json"), "{}");
    await writeFile(path.join(root, "teable/conversations.json"), "{}");

    await expect(discoverConfiguredGalleryRepoNames(root)).resolves.toEqual(["express-host", "umami"]);
  });

  it("parses native screens and UI-generating prompts strictly", () => {
    expect(parseGalleryConfig({
      version: 1,
      nativeScreens: [
        { id: "tasks", label: "Native tasks", path: "/tasks", waitFor: ".task-row" },
      ],
      prompts: [
        { id: "priority-dashboard", label: "Priority dashboard", prompt: "Build and open a priority dashboard.", timeoutMs: 120_000 },
      ],
    })).toMatchObject({
      nativeScreens: [{ id: "tasks", path: "/tasks" }],
      prompts: [{ id: "priority-dashboard", timeoutMs: 120_000 }],
    });

    expect(() => parseGalleryConfig({
      version: 1,
      nativeScreens: [{ id: "external", label: "External", path: "https://example.com" }],
      prompts: [{ id: "view", label: "View", prompt: "Build a view." }],
    })).toThrow(/path/i);
  });

  it("loads every checked-in gallery config with three or more prompts", async () => {
    const expectationsRoot = path.resolve(fileURLToPath(new URL("../../expectations", import.meta.url)));
    const names = await discoverConfiguredGalleryRepoNames(expectationsRoot);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const config = await loadGalleryConfig(expectationsRoot, name);
      expect(config.nativeScreens.length).toBeGreaterThanOrEqual(1);
      expect(config.prompts.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("captureGalleryRepo", () => {
  it("automatically approves a generated-app write card so capture can reach first paint", async () => {
    let visible = false;
    let clicks = 0;
    const locator = {
      async count() { return visible ? 1 : 0; },
      async click() { clicks += 1; },
      first() { return this; },
    };
    const page = {
      locator(selector: string) {
        expect(selector).toContain("vendo_apps_create");
        return locator;
      },
    } as unknown as E2ePage;

    await expect(approveGenerationIfRequested(page, {
      timeoutMs: 1_000,
      sleep: async () => { visible = true; },
    })).resolves.toBe(true);
    expect(clicks).toBe(1);
  });

  it("captures host-native screens first, then generated prompts with automatic timing artifacts", async () => {
    const root = await makeTempRoot();
    const expectationsRoot = path.join(root, "expectations");
    const runRoot = path.join(root, ".repos/.gallery/run-1");
    const configDir = path.join(expectationsRoot, "relay");
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "gallery.json"), JSON.stringify({
      version: 1,
      nativeScreens: [
        { id: "tasks", label: "Relay tasks", path: "/", waitFor: ".task-row" },
      ],
      prompts: [
        { id: "priority", label: "Priority view", prompt: "Build and open a priority dashboard." },
        { id: "workload", label: "Workload view", prompt: "Build and open a workload summary." },
      ],
    }));

    const events: string[] = [];
    const driver: GalleryCaptureDriver = {
      async captureNativeScreen(input) {
        events.push(`native:${input.screen.id}`);
        await writeFile(input.outputPath, Buffer.from(`native-${input.screen.id}`));
      },
      async capturePrompt(input) {
        events.push(`prompt:${input.prompt.id}`);
        await mkdir(input.artifactDir, { recursive: true });
        const firstPaintPath = path.join(input.artifactDir, "first-paint.png");
        const settledPath = path.join(input.artifactDir, "settled.png");
        const animationPath = path.join(input.artifactDir, "generation.gif");
        await writeFile(firstPaintPath, Buffer.from("first"));
        await writeFile(settledPath, Buffer.from("settled"));
        await writeFile(animationPath, Buffer.from("gif"));
        return {
          firstPaintPath,
          settledPath,
          animationPath,
          animationFormat: "gif",
          animationNote: "converted with ffmpeg",
          timings: createGalleryTimings(600, 840, 8_400),
        };
      },
      async close() {
        events.push("close");
      },
    };

    const result = await captureGalleryRepo({
      repoName: "relay",
      readinessUrl: "http://127.0.0.1:3210",
      expectationsRoot,
      runRoot,
      driver,
    });

    expect(events).toEqual(["native:tasks", "prompt:priority", "prompt:workload", "close"]);
    expect(result.nativeScreens).toHaveLength(1);
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0]?.timings.bars).toEqual({ firstPaintUnder1s: true, usableUnder10s: true });
    const timings = JSON.parse(await readFile(path.join(runRoot, "relay/prompts/priority/timings.json"), "utf8")) as unknown;
    expect(timings).toMatchObject({
      marksMs: { promptSubmitted: 0, generationToolCalled: 600, firstGeneratedPixel: 840, settledUsable: 8_400 },
      durationsMs: {
        promptToFirstPaint: 840,
        promptToUsable: 8_400,
        generationToFirstPaint: 240,
        generationToUsable: 7_800,
      },
      animation: { format: "gif", note: "converted with ffmpeg" },
    });
  });
});

describe("writeGalleryHtml", () => {
  it("calculates nearest-rank p95 latency bars across successful prompt captures", () => {
    const prompts = Array.from({ length: 20 }, (_, index) => {
      const sample = index + 1;
      return {
        id: `prompt-${sample}`,
        label: `Prompt ${sample}`,
        prompt: `Build view ${sample}`,
        firstPaintPath: "/tmp/first.png",
        settledPath: "/tmp/settled.png",
        animationPath: "/tmp/generation.gif",
        animationFormat: "gif" as const,
        animationNote: "converted with ffmpeg",
        timings: createGalleryTimings(sample * 50, sample * 100, sample * 500),
      };
    });

    expect(calculateGalleryP95([{
      repoName: "relay",
      nativeScreens: [],
      prompts,
    }])).toEqual({
      sampleCount: 20,
      promptToFirstPaintMs: 1_900,
      promptToUsableMs: 9_500,
      generationToFirstPaintMs: 950,
      generationToUsableMs: 8_550,
      firstPaintUnder1s: true,
      usableUnder10s: true,
    });
  });

  it("inlines every screenshot and animation into one standalone report", async () => {
    const root = await makeTempRoot();
    const runRoot = path.join(root, "run-1");
    const repoRoot = path.join(runRoot, "relay");
    await mkdir(repoRoot, { recursive: true });
    const nativePath = path.join(repoRoot, "native.png");
    const firstPaintPath = path.join(repoRoot, "first.png");
    const settledPath = path.join(repoRoot, "settled.png");
    const animationPath = path.join(repoRoot, "generation.gif");
    await writeFile(nativePath, Buffer.from("native"));
    await writeFile(firstPaintPath, Buffer.from("first"));
    await writeFile(settledPath, Buffer.from("settled"));
    await writeFile(animationPath, Buffer.from("gif"));

    const galleryPath = await writeGalleryHtml({
      runId: "run-1",
      runRoot,
      generatedAt: "2026-07-14T12:00:00.000Z",
      repos: [{
        repoName: "relay",
        nativeScreens: [{ id: "tasks", label: "Native tasks", path: nativePath }],
        prompts: [{
          id: "priority",
          label: "Priority dashboard",
          prompt: "Build and open a priority dashboard.",
          firstPaintPath,
          settledPath,
          animationPath,
          animationFormat: "gif",
          animationNote: "converted with ffmpeg",
          timings: createGalleryTimings(600, 840, 8_400),
        }],
      }],
    });

    const html = await readFile(galleryPath, "utf8");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("data:image/gif;base64,");
    expect(html).toContain("840 ms");
    expect(html).toContain("8.40 s");
    expect(html).toContain("p95 generation tool call → first generated pixel · 240 ms");
    expect(html).toContain("p95 generation tool call → settled/usable · 7.80 s");
    expect(html).toContain("End-to-end prompt submit → first generated pixel (includes approval wait)");
    expect(html).toContain("End-to-end prompt submit → settled/usable (includes approval wait)");
    expect(html).toContain("Generation tool call → first generated pixel");
    expect(html).toContain("Generation tool call → settled/usable");
    expect(html).not.toMatch(/(?:src|href)=["'](?:\.\/|relay\/|\/Users\/)/);
  });
});

describe("convertVideoToGif", () => {
  it("keeps WebM and records the fallback when ffmpeg is unavailable", async () => {
    const root = await makeTempRoot();
    const webmPath = path.join(root, "generation.webm");
    const gifPath = path.join(root, "generation.gif");
    await writeFile(webmPath, Buffer.from("webm"));

    const result = await convertVideoToGif(webmPath, gifPath, async () => {
      throw Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });
    });

    expect(result).toEqual({
      animationPath: webmPath,
      animationFormat: "webm",
      animationNote: "ffmpeg unavailable; retained Playwright WebM",
    });
    await expect(readFile(webmPath)).resolves.toEqual(Buffer.from("webm"));
  });
});
