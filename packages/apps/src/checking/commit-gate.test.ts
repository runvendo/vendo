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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApps } from "../index.js";
import {
  guardFixture,
  memoryStore,
  scriptedLanguageModel,
  seedAppRow,
  type ScriptedModelCall,
} from "../testing/index.js";

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
 * A blocking reviewer finding shaped exactly like a real one: `where` is a
 * MACHINE locus (core `pack.ts` — a node id and a prop name), and the message
 * is the teaching sentence the rubric asks for. The locus is the thing §3's
 * voice law must keep off the person's screen.
 */
const INVENTED_DATA: Finding = {
  severity: "block",
  where: 'node "n2" prop "text" (host_listInvoices)',
  message: "the balance on the card is typed into the app rather than read from your account, so it is not your real balance.",
};

const THIN: Finding = { severity: "warn", where: 'node "n2"', message: "this app feels thin." };

/** The host's OWN rule, plugged in through a pack — a customer's check, not
 *  one of ours. */
const HOUSE_STYLE: Check = {
  name: "maple-house-style",
  kind: "fact",
  run: async () => [{
    severity: "block",
    where: 'node "n2" component "Text"',
    message: "Maple never shows a money figure without saying which account it came from.",
  }],
};

let reviewerFindings: Finding[] = [];
let wire = FIRST;

/** The reviewer is a strict tool call for `report_findings`; every other turn
 *  is the brain answering with a whole app. */
const model = () => scriptedLanguageModel((call: ScriptedModelCall) =>
  call.tools?.some(({ name }) => name === "report_findings") === true
    ? { tool: "report_findings", input: { findings: reviewerFindings } }
    : wire);

const setup = (checks?: readonly Check[]) => {
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model: model(),
    ...(checks === undefined ? {} : { checks }),
  });
  return { store, runtime };
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

beforeEach(() => {
  reviewerFindings = [];
  wire = FIRST;
});

describe("an edit that does not pass is never written", () => {
  it("leaves the stored app byte-identical and still serving", async () => {
    const { runtime, store } = setup();
    const created = await runtime.create({ prompt: "my invoices" }, ctx);
    const before = await rowOf(store, created.id);

    reviewerFindings = [INVENTED_DATA];
    wire = SECOND;
    const result = await runtime.edit(created.id, "rename it", ctx);

    expect(await rowOf(store, created.id)).toBe(before);
    expect((await runtime.get(created.id, ctx)).name).toBe("Invoices");
    expect(result.app.name).toBe("Invoices");
    expect(result.failure?.code).toBe("edit-rejected");
  });

  it("tells the person, in their own language, that nothing changed and why", async () => {
    const { runtime } = setup();
    const created = await runtime.create({ prompt: "my invoices" }, ctx);

    reviewerFindings = [INVENTED_DATA];
    wire = SECOND;
    const result = await runtime.edit(created.id, "rename it", ctx);

    // The whole paragraph, pinned: this is what a person reads (demo-bank's
    // apps page joins `issues` straight into its error banner).
    expect(result.issues).toEqual([
      "This change wasn't made, so nothing changed and your app is exactly as it was — "
      + "it didn't pass the checks that keep an app honest: "
      + "the balance on the card is typed into the app rather than read from your account, "
      + "so it is not your real balance.",
    ]);
    expectConsumerVoice((result.issues ?? []).join(" "));
  });
});

describe("a create that does not pass leaves no app behind", () => {
  it("creates no app and says why in plain language", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime } = setup();
      reviewerFindings = [INVENTED_DATA];

      const error = await runtime.create({ prompt: "my invoices" }, ctx)
        .then(() => undefined, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(VendoError);
      expect(await runtime.list(ctx)).toEqual([]);
      // The reason is what `open()` hands the embed's failed surface, so it is
      // the sentence on the screen.
      expect((error as VendoError).detail).toMatchObject({
        reason: "This app wasn't created, because it didn't pass the checks that keep an app honest: "
          + "the balance on the card is typed into the app rather than read from your account, "
          + "so it is not your real balance.",
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
      const { runtime, store } = setup();
      reviewerFindings = [INVENTED_DATA];
      await runtime.create({ prompt: "my invoices" }, ctx).catch(() => undefined);

      const rows = await store.records("vendo_apps").list({});
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
  it("persists a create whose only findings are warns", async () => {
    const { runtime } = setup();
    reviewerFindings = [THIN];

    const created = await runtime.create({ prompt: "my invoices" }, ctx);

    expect((await runtime.list(ctx)).map(({ id }) => id)).toEqual([created.id]);
  });

  it("persists an edit whose only findings are warns", async () => {
    const { runtime, store } = setup();
    const created = await runtime.create({ prompt: "my invoices" }, ctx);
    const before = await rowOf(store, created.id);

    reviewerFindings = [THIN];
    wire = SECOND;
    const result = await runtime.edit(created.id, "rename it", ctx);

    expect(result.app.name).toBe("Invoices renamed");
    expect(await rowOf(store, created.id)).not.toBe(before);
    expect((await runtime.get(created.id, ctx)).name).toBe("Invoices renamed");
  });
});

describe("the host's own rules bite", () => {
  it("stops a create on a pack check's blocking finding, in the host's own words", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime } = setup([HOUSE_STYLE]);

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

  it("stops an edit on a pack check's blocking finding, leaving the stored app untouched", async () => {
    const { runtime, store } = setup([HOUSE_STYLE]);
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

    wire = SECOND;
    const result = await runtime.edit(seeded.id, "rename it", ctx);

    expect(await rowOf(store, seeded.id)).toBe(before);
    expect(result.app.name).toBe("Invoices");
    expect((result.issues ?? []).join(" ")).toContain("which account it came from");
  });
});
