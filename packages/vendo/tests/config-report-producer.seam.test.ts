/**
 * The PRODUCER half of the config-report seam, under adversarial input.
 *
 * SEAM, both cases: real `.vendo` files on disk → the real composition seam →
 * the real reporter → the real batched uploader → the captured HTTP request.
 * Nothing between resolution and the wire is stubbed, and the one thing that
 * IS substituted — `fetch` — answers with the byte-exact response the console
 * door really produces (captured from apps/console's own door in the
 * vendo-web repo, not invented here).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "../src/server.js";
import type { CreateVendoConfig } from "../src/types.js";

const REPORT_URL = "https://console.producer-test/api/v1/config/report";

const identity: Pick<CreateVendoConfig, "principal"> = {
  principal: async () => ({ kind: "user", subject: "user_producer_test" }),
};

type Surfaces = Record<string, { source: string; content: string | null }>;

const cleanups: Array<() => Promise<void>> = [];
let sent: Array<{ surfaces: Surfaces }> = [];
/** What the stubbed console answers. `null` = the frozen 204 No Content. */
let answer: (() => Response) | null = null;

async function project(files: Record<string, string>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "vendo-config-report-producer-"));
  await mkdir(join(root, ".vendo"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, ".vendo", name), body);
  }
  const originalCwd = process.cwd();
  process.chdir(root);
  cleanups.push(async () => {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  });
}

beforeEach(() => {
  sent = [];
  answer = null;
  vi.stubEnv("VENDO_API_KEY", "vnd_producer_test");
  vi.stubEnv("VENDO_CLOUD_URL", "https://console.producer-test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== REPORT_URL) return Response.json({});
      sent.push(JSON.parse(String(init?.body)) as { surfaces: Surfaces });
      return answer === null ? new Response(null, { status: 204 }) : answer();
    }),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const waitForReport = async (count = 1): Promise<void> => {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(count), {
    timeout: 5_000,
    interval: 25,
  });
};

// ── the reported surface is the one the runtime resolved ────────────────────
//
// The Agent tab's whole promise is "this page shows what your deployments are
// actually running", so the report and the runtime cannot be allowed to
// disagree about which surface won. What a BLANK code value means is decided
// PER SURFACE, in compose-adapters' `codeSurface` table, exactly as each block
// decides it for itself: a blank `instructions` or `apps.designRules` falls
// through to the `.vendo/` file, a defined `profile.brief` never does. Any
// single global blank rule gets one of these two backwards.
describe("the report has to name the surface the runtime actually resolved", () => {
  it("reports brief.md as the FILE when an empty `instructions` falls through to it", async () => {
    await project({ "brief.md": "Maple is a consumer bank.\n" });
    createVendo({ ...identity, instructions: "", connectors: [] });
    await waitForReport();

    expect(sent[0]?.surfaces["brief.md"]).toEqual({
      source: "file",
      content: "Maple is a consumer bank.\n",
    });
  });

  // The mirror image, and the reason the blank rule cannot live in the shared
  // `selectConfigSurface`: it is per SURFACE. A DEFINED `profile.brief` is
  // authoritative even when blank — compose-prompt.ts:40-42 takes that branch
  // and never touches disk, so the deployment runs with NO brief. A report that
  // trimmed it to falsy would show the operator a file-backed brief this
  // deployment deliberately does not run.
  it("reports brief.md as CODE when an explicitly empty `profile.brief` means NO brief", async () => {
    await project({ "brief.md": "Maple is a consumer bank.\n" });
    createVendo({ ...identity, profile: { brief: "" }, connectors: [] });
    await waitForReport();

    expect(sent[0]?.surfaces["brief.md"]).toEqual({ source: "code", content: "" });
  });

  it("reports design-rules.md as the FILE when a blank `apps.designRules` falls through", async () => {
    await project({ "design-rules.md": "# Rules\n\nUse the host's components.\n" });
    createVendo({ ...identity, apps: { designRules: "   " }, connectors: [] });
    await waitForReport();

    expect(sent[0]?.surfaces["design-rules.md"]).toEqual({
      source: "file",
      content: "# Rules\n\nUse the host's components.\n",
    });
  });
});

// ── what a rejected report costs ────────────────────────────────────────────
//
// The console caps a surface at 512KB and refuses over-cap with the door's
// ordinary shape refusal. That is a PERMANENT verdict: the same bytes will be
// refused every time, forever, so the uploader must not spend its retry ladder
// on one. `cloudKeyFetch` carries the status onto the error it throws and
// `send()` gives up on a 4xx, rather than shipping a multi-megabyte body three
// times per boot.
//
// The second case holds the other half: the reporter's `lastHash` is set before
// the enqueue (config-report.ts:76-78), so a refused report is never
// re-enqueued until the config CHANGES. One refused report, one upload.
describe("a report the console permanently refuses", () => {
  /** The console door's real 400: door.ts's BAD_SHAPE, via lib/api/respond.ts.
   *  Byte-for-byte what apps/console/app/api/v1/config/report/route.ts answers
   *  when parseConfigReport returns null (verified against that door). */
  const OVER_CAP_REFUSAL = () =>
    new Response(
      JSON.stringify({ error: { code: "validation", message: "Invalid request body." } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );

  it("is sent ONCE — a 400 is a verdict, not a dropped packet", async () => {
    answer = OVER_CAP_REFUSAL;
    await project({ "design-rules.md": `# rules\n${"x".repeat(512 * 1024 + 1)}` });
    createVendo({ ...identity, connectors: [] });
    await waitForReport();
    // The uploader's ladder is 250ms then 1s; 1.5s covers both rungs.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(sent).toHaveLength(1);
  });

  it("never re-sends the same refused report on a later resolution cycle", async () => {
    answer = OVER_CAP_REFUSAL;
    await project({ "design-rules.md": `# rules\n${"x".repeat(512 * 1024 + 1)}` });
    const vendo = createVendo({ ...identity, connectors: [] });
    cleanups.push(async () => {
      await vendo.store.close();
    });
    await waitForReport();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const afterBoot = sent.length;

    // Drive several more resolution cycles: every lazy surface read re-hashes
    // and re-reports only on a CHANGE (compose-surfaces.ts:53-56).
    for (let i = 0; i < 5; i += 1) await vendo.actions.descriptors();
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(sent).toHaveLength(afterBoot);
  });
});
