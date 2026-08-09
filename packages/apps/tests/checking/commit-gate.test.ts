/**
 * The checks floor STOPS a bad app at the commit path (design §7).
 *
 * Until this file, the floor ran, reported, and the app shipped anyway: create
 * `console.info`'d its findings and `edit()` persisted first and filtered
 * afterwards into an advisory `issues: string[]`. A blocking finding now stops
 * the write itself.
 *
 * No version model is needed for that, and none is added. On an EDIT the
 * previous app is simply never overwritten — its row keeps serving, for free.
 * On a CREATE nothing app-shaped is written at all; only the terminal
 * build-failed tombstone the embed already reads.
 *
 * `warn` never blocks. Ever.
 *
 * WHERE THE GATE LIVES NOW. There is one engine, and it commits through the
 * paint seam — so the floor is `AppsRuntime.floor(ctx)`, handed to whoever writes
 * `app.vendo` (`checking/floor.ts`; the seam's own refusal is proven end to end in
 * the render-seam-floor suite beside this one). This file pins the two halves
 * this block still owns: the floor's own verdict (what blocks, what only warns,
 * and that a HOST's rule is enforceable through it), and what create and edit do
 * when a commit is refused — nothing written, and the reason said in the person's
 * own language. The AI reviewer is deliberately not part of the floor (it spends a
 * model call, and this runs on every commit); judgement is `validate`'s, and
 * `validate-door.test.ts` owns it.
 */
import {
  VENDO_APP_FORMAT,
  VendoError,
  compileWire,
  type AppDocument,
  type Check,
  type Finding,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps, type AppsRuntime } from "../../src/index.js";
import { scriptedAssembler, type AssemblerAnswer } from "../../src/testing/authoring-assembler.js";
import { guardFixture } from "../../src/testing/guard-fixture.js";
import { memoryStore } from "../../src/testing/memory-store.js";
import { basicLanguageModel } from "../../src/testing/scripted-model.js";
import { seedAppRow } from "../../src/testing/seed-app-row.js";
import { blocks } from "../../src/checking/floor.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const appWire = (name: string): string =>
  `<App name="${name}"><Text text="${name}"/><Disclaimer reason="Scripted fixture app."/></App>`;

const FIRST = appWire("Invoices");
const SECOND = appWire("Invoices renamed");

/**
 * A blocking finding shaped exactly like a real one: `where` is a MACHINE locus
 * (core `pack.ts` — a node id and a prop name), and the message is the teaching
 * sentence the rubric asks for. The locus is the thing §3's voice law must keep
 * off the person's screen; the message is what reaches them.
 */
const INVENTED_DATA: Finding = {
  severity: "block",
  where: 'node "n2" prop "text" (host_listInvoices)',
  message: "the balance on the card is typed into the app rather than read from your account, so it is not your real balance.",
};

/** The host's OWN rule, plugged in through a pack — a customer's check, not one
 *  of ours, and only a `warn`. */
const THIN: Check = {
  name: "maple-thin",
  kind: "fact",
  run: async () => [{ severity: "warn", where: 'node "n2"', message: "this app feels thin." }],
};

/** The host's OWN rule, plugged in through a pack, and this one BLOCKS. */
const HOUSE_STYLE: Check = {
  name: "maple-house-style",
  kind: "fact",
  run: async () => [{
    severity: "block",
    where: 'node "n2" component "Text"',
    message: "Maple never shows a money figure without saying which account it came from.",
  }],
};

/**
 * The runtime under test.
 *
 * `answer` is what the ONE engine does with each ask: the wire it saves (through
 * the REAL `authored` write path), or the refusal it comes back with when its own
 * commit did not pass the floor. `null` for `current` is a create.
 */
const setup = (
  answer: (request: string, current: AppDocument | null) => AssemblerAnswer,
  checks?: readonly Check[],
) => {
  const store = memoryStore();
  let runtime: AppsRuntime;
  runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model: basicLanguageModel(),
    screen: scriptedAssembler(() => runtime, ({ request }, current) => answer(request, current)),
    ...(checks === undefined ? {} : { checks }),
  });
  return { store, runtime };
};

/** The gate itself, as the paint seam calls it: compile in the production dialect,
 *  then run the checks over what compiled. */
const floorVerdict = async (runtime: AppsRuntime, wire: string): Promise<Finding[]> => {
  const floor = runtime.floor(ctx);
  const compiled = await floor.compile(wire);
  return await floor.check({ appId: "app_floor", compiled });
};

const rowOf = async (store: ReturnType<typeof memoryStore>, appId: string): Promise<string> =>
  JSON.stringify((await store.records("vendo_apps").get(appId))?.data);

/** Everything the person could read about why it did not ship. */
const userText = (error: unknown): string => {
  const detail = (error as VendoError).detail as { issues?: string[]; reason?: string };
  return [(error as Error).message, detail?.reason, ...(detail?.issues ?? [])].join(" ");
};

/**
 * §3's voice law, as an assertion: no tool or component identifier, no machine
 * locus, no file path, no severity word. "Friendly is not vague" is the other
 * half — the caller asserts the real reason is still in there.
 */
const expectConsumerVoice = (text: string): void => {
  expect(text).not.toMatch(/host_|vendo_apps|maple-house-style|report_findings/);
  expect(text).not.toMatch(/node "|prop "|component "/);
  expect(text).not.toMatch(/packages\/|\.ts\b|\.tsx\b/);
  expect(text.toLowerCase()).not.toMatch(/\bblock\b|\bblocking\b|\bseverity\b|\bwarn\b|\bfinding\b/);
};

describe("an edit that does not pass is never written", () => {
  /** Creates cleanly, then refuses the change: the app under edit is a real one. */
  const refusingEdit = (why: string) =>
    setup((_request, current) => (current === null ? FIRST : { kind: "unavailable", why }));

  it("leaves the stored app byte-identical and still serving", async () => {
    const { runtime, store } = refusingEdit(INVENTED_DATA.message);
    const created = await runtime.create({ prompt: "my invoices" }, ctx);
    const before = await rowOf(store, created.id);

    const result = await runtime.edit(created.id, "rename it", ctx);

    expect(await rowOf(store, created.id)).toBe(before);
    expect((await runtime.get(created.id, ctx))!.name).toBe("Invoices");
    expect(result.app.name).toBe("Invoices");
    expect(result.failure?.code).toBe("edit-rejected");
  });

  it("tells the person, in their own language, that nothing changed and why", async () => {
    const { runtime } = refusingEdit(INVENTED_DATA.message);
    const created = await runtime.create({ prompt: "my invoices" }, ctx);

    const result = await runtime.edit(created.id, "rename it", ctx);

    // Verbatim, and nothing else: this is what a person reads (demo-bank's apps
    // page joins `issues` straight into its error banner), so a generic apology
    // wrapped around it would be one more sentence with nothing to act on.
    expect(result.issues).toEqual([INVENTED_DATA.message]);
    expectConsumerVoice((result.issues ?? []).join(" "));
    // The retry instruction is the MODEL's half and stays off the person's screen.
    expect(result.failure?.retryable).toBe(true);
  });
});

describe("a create that does not pass leaves no app behind", () => {
  const refusingCreate = () =>
    setup(() => ({ kind: "unavailable", why: INVENTED_DATA.message }));

  it("creates no app and says why in plain language", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime } = refusingCreate();

      const error = await runtime.create({ prompt: "my invoices" }, ctx)
        .then(() => undefined, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(VendoError);
      expect(await runtime.list(ctx)).toEqual([]);
      // The reason is what `open()` hands the embed's failed surface, so it is
      // the sentence on the screen.
      expect((error as VendoError).detail).toMatchObject({
        reason: INVENTED_DATA.message,
        retryable: true,
      });
      expectConsumerVoice(userText(error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("puts nothing app-shaped in the store — the only row is the terminal tombstone", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime, store } = refusingCreate();
      await runtime.create({ prompt: "my invoices" }, ctx).catch(() => undefined);

      const rows = await store.records("vendo_apps").list({});
      expect(rows.records.length).toBeGreaterThan(0);
      for (const record of rows.records) {
        const doc = (record.data as { doc?: { tree?: unknown; buildFailed?: unknown } }).doc;
        expect(doc?.tree).toBeUndefined();
        expect(doc?.buildFailed).toBeDefined();
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("warn never blocks", () => {
  const saving = (checks?: readonly Check[]) =>
    setup((_request, current) => (current === null ? FIRST : SECOND), checks);

  it("keeps a warn out of the gate's verdict", async () => {
    const { runtime } = saving([THIN]);

    const findings = await floorVerdict(runtime, FIRST);

    // Reported — a warn rides along on an app that ships…
    expect(findings.map(({ message }) => message)).toContain("this app feels thin.");
    // …and stops nothing.
    expect(blocks(findings)).toEqual([]);
  });

  it("persists a create whose only findings are warns", async () => {
    const { runtime } = saving([THIN]);

    const created = await runtime.create({ prompt: "my invoices" }, ctx);

    expect((await runtime.list(ctx)).map(({ id }) => id)).toEqual([created.id]);
  });

  it("persists an edit whose only findings are warns", async () => {
    const { runtime, store } = saving([THIN]);
    const created = await runtime.create({ prompt: "my invoices" }, ctx);
    const before = await rowOf(store, created.id);

    const result = await runtime.edit(created.id, "rename it", ctx);

    expect(result.app.name).toBe("Invoices renamed");
    expect(await rowOf(store, created.id)).not.toBe(before);
    expect((await runtime.get(created.id, ctx))!.name).toBe("Invoices renamed");
  });
});

describe("the host's own rules bite", () => {
  it("blocks at the gate on a pack check's finding, in the host's own words", async () => {
    // The host plugged one sentence in and it is now the reason a commit cannot
    // land — no code of ours knows this rule, and the floor enforces it anyway.
    const { runtime } = setup(() => FIRST, [HOUSE_STYLE]);

    const blocking = blocks(await floorVerdict(runtime, FIRST));

    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.message).toContain("which account it came from");
    // Its LOCUS is machine-facing and stays off the person's screen; the sentence
    // is the half that reaches them.
    expect(blocking[0]?.where).toContain("node");
    expectConsumerVoice(blocking[0]?.message ?? "");
  });

  it("stops a create on that finding: no app, and the host's sentence is the reason", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const rule = "Maple never shows a money figure without saying which account it came from.";
      const { runtime } = setup(() => ({ kind: "unavailable", why: rule }), [HOUSE_STYLE]);

      const error = await runtime.create({ prompt: "my invoices" }, ctx)
        .then(() => undefined, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(VendoError);
      expect(await runtime.list(ctx)).toEqual([]);
      const text = userText(error);
      expect(text).toContain("which account it came from");
      expectConsumerVoice(text);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("stops an edit on that finding, leaving the stored app untouched", async () => {
    const rule = "Maple never shows a money figure without saying which account it came from.";
    const { runtime, store } = setup(() => ({ kind: "unavailable", why: rule }), [HOUSE_STYLE]);
    // The host's rule stops the create too, so the app under edit is seeded
    // straight into the store rather than generated.
    const compiled = compileWire(FIRST, {});
    const seeded = {
      format: VENDO_APP_FORMAT,
      id: "app_seeded",
      name: "Invoices",
      ui: "tree",
      tree: compiled.tree,
    } as unknown as AppDocument;
    await seedAppRow(store, seeded, ctx.principal.subject);
    const before = await rowOf(store, seeded.id);

    const result = await runtime.edit(seeded.id, "rename it", ctx);

    expect(await rowOf(store, seeded.id)).toBe(before);
    expect(result.app.name).toBe("Invoices");
    expect((result.issues ?? []).join(" ")).toContain("which account it came from");
  });
});
