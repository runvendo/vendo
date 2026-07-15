import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturedPinBaselineSchema } from "@vendoai/actions";
import { pinBaselineSchema } from "@vendoai/apps";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeCapture } from "./runtime-capture.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function hostRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-runtime-capture-unit-"));
  cleanups.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "card.tsx"), "export const Card = () => <article>card</article>;\n", "utf8");
  return root;
}

function handlerFor(root: string): ReturnType<typeof createRuntimeCapture> {
  return createRuntimeCapture({ root });
}

describe("createRuntimeCapture bundler id resolution", () => {
  it("captures a file: URL module id into a schema-valid baseline", async () => {
    const root = await hostRoot();
    const handler = handlerFor(root);
    const result = await handler!.capture({
      slot: "Card",
      source: `file://${join(root, "src", "card.tsx")}`,
      exportable: false,
    });
    expect(result).toMatchObject({ slot: "Card", status: "captured" });
    expect(result.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const baseline = JSON.parse(await readFile(join(root, ".vendo", "remixable", "Card.json"), "utf8"));
    // Lockstep with both ends of the pipeline: sync's write-side schema and the
    // apps-side schema createVendo loads baselines through at boot.
    expect(capturedPinBaselineSchema.safeParse(baseline).success).toBe(true);
    expect(pinBaselineSchema.safeParse(baseline).success).toBe(true);
    expect(baseline.source).toContain("card</article>");
  });

  it("captures a Vite /@fs/ module id", async () => {
    const root = await hostRoot();
    const result = await handlerFor(root)!.capture({
      slot: "Card",
      source: `/@fs${join(root, "src", "card.tsx")}?t=1234`,
      exportable: false,
    });
    expect(result.status).toBe("captured");
  });

  it("captures a dev-browser http module URL (import.meta.url under the Vite origin)", async () => {
    const root = await hostRoot();
    const result = await handlerFor(root)!.capture({
      slot: "Card",
      source: "http://localhost:5173/src/card.tsx?t=1234",
      exportable: false,
    });
    expect(result.status).toBe("captured");
  });

  it("captures a Vite project-root /src/ module id with a query suffix", async () => {
    const root = await hostRoot();
    const result = await handlerFor(root)!.capture({
      slot: "Card",
      source: "/src/card.tsx?import&t=1234",
      exportable: false,
    });
    expect(result.status).toBe("captured");
  });

  it("captures a root-relative module id", async () => {
    const root = await hostRoot();
    const result = await handlerFor(root)!.capture({
      slot: "Card",
      source: "src/card.tsx",
      exportable: false,
    });
    expect(result.status).toBe("captured");
  });

  it("reports unchanged when the same source is captured twice", async () => {
    const root = await hostRoot();
    const handler = handlerFor(root)!;
    const first = await handler.capture({ slot: "Card", source: "src/card.tsx", exportable: false });
    const second = await handler.capture({ slot: "Card", source: "src/card.tsx", exportable: false });
    expect(first.status).toBe("captured");
    expect(second).toEqual({ slot: "Card", hash: first.hash, status: "unchanged" });
  });

  it("refuses a slot that is not a safe baseline filename", async () => {
    const root = await hostRoot();
    await expect(handlerFor(root)!.capture({
      slot: "../escape",
      source: "src/card.tsx",
      exportable: false,
    })).rejects.toThrow(/safe baseline filename/);
  });

  it("refuses a module id that resolves outside the host root", async () => {
    const root = await hostRoot();
    const outside = await mkdtemp(join(tmpdir(), "vendo-runtime-capture-outside-"));
    cleanups.push(outside);
    await writeFile(join(outside, "escape.tsx"), "export const Escape = () => null;\n", "utf8");
    await expect(handlerFor(root)!.capture({
      slot: "Escape",
      source: join(outside, "escape.tsx"),
      exportable: false,
    })).rejects.toThrow(/inside the host root/);
  });
});
