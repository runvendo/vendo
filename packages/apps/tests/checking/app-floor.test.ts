/**
 * `createAppFloor` — the checks floor as the PAINT SEAM calls it (blueprint §7.1).
 *
 * The hole this closes is worth restating, because it is what these tests are
 * for: the seam used to read the hot-path file itself and decide what to paint,
 * so a harness's own writes faced a different gate than the conductor's — a lying
 * read painted, and nothing at the seam ever RAN the screen. The floor was live
 * for the conductor and structurally dead for every other author, and every test
 * passed the whole time, because nothing ever asked the floor to render anything.
 *
 * One method now: `component`. So these drive it through its real entry point, on
 * real `app.tsx`, and assert what a structurally-dead floor cannot do — execute a
 * screen's query, refuse a read the tool's response does not carry, fire the
 * host's own checks over what was rendered, and hand the row half both halves of
 * its answer.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  SCREEN_FILE,
  warmScreenEngine,
  type Check,
  type NormalizedCatalog,
} from "../../src/contract/index.js";
import type { FloorDependencies, HostToolInfo } from "../../src/server/checking/deps.js";
import { blocks, createAppFloor } from "../../src/server/checking/floor.js";

const tools: HostToolInfo[] = [{
  name: "host_listInvoices",
  description: "Open invoices",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    required: ["data"],
    additionalProperties: false,
  },
}];

const catalog: NormalizedCatalog = [];

const floorDeps = (): FloorDependencies => ({ catalog, tools });

const ROWS = { data: [{ id: "inv_1" }] };

const screen = (body: string): string => `import { Stack, Text, useQuery } from "@vendo/screen";

export default function Invoices() {
  const invoices = useQuery("host_listInvoices");
  return (
    <Stack gap={12}>
      ${body}
    </Stack>
  );
}
`;

/** Reads a field the tool's declared response really carries. */
const GOOD = screen(`<Text text={"invoices: " + invoices.data.length} />`);
/** Reads one it does not. */
const BAD_READ = screen(`<Text text={"invoices: " + invoices.nope.length} />`);

const floor = (options: Partial<Parameters<typeof createAppFloor>[0]> = {}) => createAppFloor({
  deps: async () => floorDeps(),
  runQuery: async () => ROWS,
  ...options,
});

beforeAll(async () => {
  await warmScreenEngine();
});

describe("component runs the ONE gauntlet, and it is the paint gate", () => {
  it("executes the screen's query and hands back everything a paint needs", async () => {
    const ran: string[] = [];

    const painted = await floor({ runQuery: async (_appId, tool) => { ran.push(tool); return ROWS; } })
      .component({ appId: "app_floor", source: GOOD });

    expect(painted.ok).toBe(true);
    // The query ran for real, under the app the seam named.
    expect(ran).toEqual(["host_listInvoices"]);
    if (!painted.ok) throw new Error("unreachable");
    expect(painted.root).toBe("root");
    expect(JSON.stringify(painted.nodes)).toContain("invoices: 1");
    // …and what the renderer re-boots the screen from rides along.
    expect(painted.interactive.compiledSource).toContain("require(");
    expect(painted.interactive.queries).toEqual({ host_listInvoices: ROWS });
    expect(painted.interactive.queryPlan).toEqual([{ tool: "host_listInvoices" }]);
  }, 60_000);

  it("refuses a read the tool's response does not carry, in the gauntlet's own words", async () => {
    const painted = await floor().component({ appId: "app_floor", source: BAD_READ });

    expect(painted.ok).toBe(false);
    if (painted.ok) throw new Error("unreachable");
    // Verbatim: these sentences are written to be read by whatever repairs the
    // screen, so a caller that rewrote them would lose the part that teaches.
    expect(painted.blocking.join("\n")).toContain('reads field "nope"');
    expect(painted.blocking.join("\n")).toContain("the real fields are: data");
  }, 60_000);

  it("refuses rather than answering 'fine' when no query runner was composed", async () => {
    // A gate that could not execute the screen has checked nothing about it.
    const painted = await createAppFloor({ deps: async () => floorDeps() })
      .component({ appId: "app_floor", source: GOOD });

    expect(painted.ok).toBe(false);
    if (painted.ok) throw new Error("unreachable");
    expect(painted.blocking.join("\n")).toContain("composed no query runner");
  });
});

describe("the host's own plugged checks fire over a harness's write", () => {
  it("blocks the paint, stamped with its provenance", async () => {
    // The floor does not care who wrote the screen — that is the whole point of
    // lifting it out of the generation pipeline.
    const hostCheck: Check = {
      name: "house-style",
      kind: "fact",
      run: async () => [{ severity: "block", where: "document", message: "no invoices on a Friday" }],
    };

    const painted = await floor({ checks: [hostCheck] }).component({ appId: "app_floor", source: GOOD });

    expect(painted.ok).toBe(false);
    if (painted.ok) throw new Error("unreachable");
    // Its name rides the refusal, so a host-check failure is distinguishable from
    // the gauntlet's own at a waive point and in the operator's log.
    expect(painted.blocking).toEqual(["[house-style] document no invoices on a Friday"]);
  }, 60_000);

  it("lets a warn through — a warning never blocks a commit", async () => {
    const advisory: Check = {
      name: "house-style",
      kind: "fact",
      run: async () => [{ severity: "warn", where: "document", message: "this screen feels thin" }],
    };

    expect((await floor({ checks: [advisory] }).component({ appId: "app_floor", source: GOOD })).ok).toBe(true);
  }, 60_000);

  it("hands them the screen and the tree it just painted, under the id the seam knows", async () => {
    let seen: { id?: string; name?: string; source?: string; nodes?: number; request?: string } = {};
    const spy: Check = {
      name: "spy",
      kind: "fact",
      run: async ({ document, request }) => {
        seen = {
          id: document.id,
          name: document.name,
          source: document.source?.[SCREEN_FILE]?.text,
          nodes: (document.tree as unknown as { nodes: unknown[] } | undefined)?.nodes.length,
          request,
        };
        return [];
      },
    };

    await floor({ checks: [spy] }).component({ appId: "app_seam", source: GOOD });

    expect(seen.id).toBe("app_seam");
    // The app's name is read off the default export, exactly as the row spells it.
    expect(seen.name).toBe("Invoices");
    // The screen's own bytes — so a check reading the source reads what it would
    // read off the store.
    expect(seen.source).toBe(GOOD);
    // …and the tree the person is about to SEE, which is the only thing a check
    // about what is on screen has to read.
    expect(seen.nodes).toBeGreaterThan(0);
    // A file write carries no user text; absence means "no carve-out", which is
    // the conservative direction.
    expect(seen.request).toBe("");
  }, 60_000);

  it("degrades a check that throws to a warn, so it never takes the screen down", async () => {
    const flaky: Check = { name: "flaky", kind: "fact", run: async () => { throw new Error("boom"); } };

    expect((await floor({ checks: [flaky] }).component({ appId: "app_floor", source: GOOD })).ok).toBe(true);
  }, 60_000);
});

describe("the row half of the paint", () => {
  it("stores the screen ONLY when the gauntlet admitted it", async () => {
    const delivered: Array<{ appId: string; name: string; source: string }> = [];
    const refused: Array<{ appId: string; blocking: readonly string[] }> = [];
    const withRow = (source: string) => floor({
      delivered: async (input, text) => { delivered.push({ ...input, source: text }); },
      refused: async (input) => { refused.push(input); },
    }).component({ appId: "app_row", source });

    await withRow(GOOD);
    expect(delivered).toEqual([{ appId: "app_row", name: "Invoices", source: GOOD }]);
    expect(refused).toEqual([]);

    await withRow(BAD_READ);
    // A generic workspace diff lands the file whether or not the screen was
    // refused, which is how a screen the floor would not render became the app's
    // stored screen. Nothing new was delivered; the refusal was recorded instead.
    expect(delivered).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.blocking.join("\n")).toContain('reads field "nope"');
  }, 60_000);

  it("is still a refusal when the recorder itself breaks", async () => {
    // Swallowing the refusal because the recorder broke would paint the screen
    // the floor just turned down.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const painted = await floor({
        refused: async () => { throw new Error("the journal is gone"); },
      }).component({ appId: "app_row", source: BAD_READ });

      expect(painted.ok).toBe(false);
      expect(logged.mock.calls.map(String).join("\n")).toContain("could not be recorded");
    } finally {
      logged.mockRestore();
    }
  }, 60_000);
});

describe("the host surface is resolved LAZILY and exactly once", () => {
  it("does not probe the host until the floor is actually used", () => {
    const deps = vi.fn(async () => floorDeps());

    createAppFloor({ deps, runQuery: async () => ROWS });

    // A floor is constructed per turn and called per commit; building it probes
    // the host's read tools for their declared response shapes.
    expect(deps).not.toHaveBeenCalled();
  });

  it("resolves once across many paints, so a turn cannot change its mind", async () => {
    const deps = vi.fn(async () => floorDeps());
    const once = createAppFloor({ deps, runQuery: async () => ROWS });

    await once.component({ appId: "app_once", source: GOOD });
    await once.component({ appId: "app_once", source: BAD_READ });

    expect(deps).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe("blocks — the findings that mean 'this must not reach a screen'", () => {
  it("keeps blocks and drops warns", () => {
    const findings = [
      { severity: "block" as const, message: "stops the app" },
      { severity: "warn" as const, message: "rides along" },
      { severity: "block" as const, message: "also stops it" },
    ];

    expect(blocks(findings).map(({ message }) => message)).toEqual(["stops the app", "also stops it"]);
  });

  it("answers empty for an all-warn set, so a warning never blocks a commit", () => {
    expect(blocks([{ severity: "warn", message: "rides along" }])).toEqual([]);
  });
});
