import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleCorpusMontage,
  buildMontageFfmpegArgs,
  discoverGalleryPairs,
} from "./montage.js";

const ppm = Buffer.from("P3\n2 2\n255\n255 0 0  255 0 0\n255 0 0  255 0 0\n");
const gif = Buffer.from(
  "R0lGODlhAgACAIAAAAAAAP///ywAAAAAAgACAAACA0QCBQA7",
  "base64",
);

async function writeRepoFixture(
  root: string,
  name: string,
  paint: number,
  usable: number,
  generated: "gif" | "ppm" = "gif",
) {
  const repo = path.join(root, name);
  await mkdir(path.join(repo, "prompts", "dashboard"), { recursive: true });
  await writeFile(path.join(repo, "host-home.ppm"), ppm);
  await writeFile(
    path.join(repo, "prompts", "dashboard", `generation.${generated}`),
    generated === "gif" ? gif : ppm,
  );
  await writeFile(path.join(repo, "timings.json"), JSON.stringify({ firstPaintMs: paint, usableMs: usable }));
}

describe("corpus montage", () => {
  it("discovers host/generated pairs and timing labels from a Wave-1 run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vendo-gallery-fixture-"));
    await writeRepoFixture(root, "umami", 940, 8_200);
    await writeRepoFixture(root, "skateshop", 1_120, 9_400);

    const pairs = await discoverGalleryPairs(root);
    expect(pairs.map((pair) => pair.repo)).toEqual(["skateshop", "umami"]);
    expect(pairs[1]).toMatchObject({ firstPaintMs: 940, usableMs: 8_200 });
    expect(pairs[1]?.hostImage).toMatch(/host-home\.ppm$/);
    expect(pairs[1]?.generatedMedia).toMatch(/generation\.gif$/);
  });

  it("builds one host/generated column per repo and stacks the columns side by side", () => {
    const args = buildMontageFfmpegArgs([
      { repo: "umami", hostImage: "/tmp/u.png", generatedMedia: "/tmp/u.gif", firstPaintMs: 940, usableMs: 8_200 },
      { repo: "skateshop", hostImage: "/tmp/s.png", generatedMedia: "/tmp/s.gif", firstPaintMs: 1_120, usableMs: 9_400 },
    ], "/tmp/out.gif", { fps: 10, panelWidth: 320, panelHeight: 180 });

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain("vstack=inputs=2");
    expect(filter).toContain("hstack=inputs=2");
    expect(filter).toContain("UMAMI");
    expect(filter).toContain("paint 0.94s / usable 8.20s");
  });

  it.runIf(process.platform !== "win32")("assembles fixture images into a real GIF with ffmpeg", async () => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    } catch {
      return;
    }

    const root = await mkdtemp(path.join(tmpdir(), "vendo-gallery-fixture-"));
    await writeRepoFixture(root, "umami", 940, 8_200, "ppm");
    await writeRepoFixture(root, "skateshop", 1_120, 9_400, "ppm");
    const output = path.join(root, "montage.gif");

    await assembleCorpusMontage({
      galleryRun: root,
      output,
      repos: ["umami", "skateshop"],
      durationSeconds: 1,
      fps: 2,
      panelWidth: 32,
      panelHeight: 18,
    });

    expect((await stat(output)).size).toBeGreaterThan(0);
    expect((await readFile(output)).subarray(0, 6).toString()).toMatch(/^GIF8/);
  }, 20_000);
});
