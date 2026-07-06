import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInit } from "./init.js";
import { runRefresh } from "./refresh.js";
import { textModel } from "./test-helpers.js";

const ROUTE_REPLY = JSON.stringify([{
  name: "list_things", description: "List things.", method: "get", path: "/api/things",
  inputSchema: { type: "object", properties: {} },
}]);
const COMPONENT_REPLY = JSON.stringify({
  include: true, reason: "primitive", name: "Badge", description: "A badge.",
  imports: ["Badge"], props: [{ name: "text", type: "string", optional: false, description: "Text." }],
  jsx: "<Badge>{p.text}</Badge>",
});

/** A wireable Next.js App Router fixture (mirrors init.test.ts's helper). */
async function nextAppFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "refresh-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "host-app", dependencies: { next: "15.0.0" } }),
  );
  await writeFile(path.join(dir, "tsconfig.json"), "{}");
  await mkdir(path.join(dir, "app/api/things"), { recursive: true });
  await mkdir(path.join(dir, "components/ui"), { recursive: true });
  await writeFile(
    path.join(dir, "app/layout.tsx"),
    "export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
  );
  await writeFile(path.join(dir, "app/globals.css"), ":root { --color-bg: #ffffff; --color-ink: #111111; }");
  await writeFile(path.join(dir, "app/api/things/route.ts"), "export async function GET() { return Response.json([]); }\n");
  await writeFile(path.join(dir, "components/ui/badge.tsx"), "export const Badge = () => null");
  return dir;
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await fn();
    return { result, out: log.mock.calls.flat().join("\n"), err: err.mock.calls.flat().join("\n") };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("vendo refresh (catch-up mode)", () => {
  it("suppresses the first-run onboarding block on a wired app", async () => {
    const dir = await nextAppFixture();

    // Set the app up first (this wires it and prints the onboarding block).
    const first = await capture(() =>
      runInit({ targetDir: dir, skipLlm: true, force: false }),
    );
    expect(first.result).toBe(0);
    expect(first.out).toContain("Next steps:"); // first run onboards

    // Now refresh: additive run, but no first-run onboarding noise.
    const refreshed = await capture(() =>
      runRefresh({ targetDir: dir, skipLlm: true, force: false }),
    );
    expect(refreshed.result).toBe(0);
    expect(refreshed.out).not.toContain("Next steps:");
    // A genuine manual follow-up (the sandbox-asset copy this fixture always
    // yields) is still surfaced, but the idempotent "already exists" skips are
    // dropped — wiring is verified, not re-explained.
    expect(refreshed.out).toContain("TODO (manual):");
    // No wiring skip lines (format: "  skip   <step>: <reason>"). Matches the
    // renderer output specifically, not the report's "kept (already exists…)".
    expect(refreshed.out).not.toMatch(/^ {2}skip {3}/m);
  });

  it("suppresses onboarding via the mode disjunct on a FRESH (unwired) app", async () => {
    // No prior init here, so `state.wired.wired` is false — only `mode:
    // "refresh"` can drive catch-up. Isolates the mode disjunct so it can't
    // silently break (removing it would let this run print the onboarding block).
    const dir = await nextAppFixture();
    const refreshed = await capture(() =>
      runRefresh({ targetDir: dir, skipLlm: true, force: false }),
    );
    expect(refreshed.result).toBe(0);
    expect(refreshed.out).not.toContain("Next steps:");
  });

  it("gap-fills only-new candidates and keeps existing artifacts byte-for-byte", async () => {
    const dir = await nextAppFixture();

    // First run with no key: theme extracted (real), deterministic route
    // tools written, no components. This also wires the app.
    const first = await capture(() =>
      runInit({ targetDir: dir, skipLlm: false, force: false, model: null }),
    );
    expect(first.result).toBe(0);
    const deterministicTools = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(deterministicTools).toMatchObject({
      version: 1,
      events: [],
      tools: [{
        name: "getThings",
        description: "GET /api/things",
        inputSchema: { type: "object", properties: {} },
        annotations: { mutating: false, dangerous: false },
        binding: { type: "http", method: "GET", path: "/api/things" },
      }],
    });

    // Hand-edit the extracted theme to prove refresh preserves it.
    const themePath = path.join(dir, ".vendo/theme.json");
    const editedTheme = (await readFile(themePath, "utf8")).replace(/#ffffff/i, "#123456");
    await writeFile(themePath, editedTheme);

    // Refresh with a key: keeps existing deterministic tools as real content,
    // fills the only-new component, and keeps the theme.
    const refreshed = await capture(() =>
      runRefresh({
        targetDir: dir,
        skipLlm: false,
        force: false,
        model: textModel([ROUTE_REPLY, COMPONENT_REPLY]),
      }),
    );
    expect(refreshed.result).toBe(0);
    expect(refreshed.out).toContain("theme.json: kept");
    expect(refreshed.out).toContain("tools.json: kept");
    expect(refreshed.out).not.toContain("Next steps:");
    expect(await readFile(themePath, "utf8")).toBe(editedTheme);
    const tools = JSON.parse(await readFile(path.join(dir, ".vendo/tools.json"), "utf8"));
    expect(tools).toEqual(deterministicTools);
    await readFile(path.join(dir, ".vendo/components/Badge/impl.tsx"), "utf8");
  });

  it("succeeds without a key (never fails) and coaches, still no onboarding", async () => {
    const dir = await nextAppFixture();
    await capture(() => runInit({ targetDir: dir, skipLlm: true, force: false }));

    const refreshed = await capture(() =>
      runRefresh({ targetDir: dir, skipLlm: false, force: false, model: null }),
    );
    expect(refreshed.result).toBe(0);
    expect(refreshed.out).not.toContain("Next steps:");
    // The no-key coaching line stays relevant in catch-up mode.
    expect(refreshed.out).toContain("only fills gaps");
    // ...but the verbose first-run remix hint is suppressed on catch-up runs.
    expect(refreshed.out).not.toContain("Remix anchors let your users");
  });
});
