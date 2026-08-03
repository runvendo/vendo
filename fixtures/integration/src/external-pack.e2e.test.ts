/**
 * E5 — a pack authored OUTSIDE this repo's `packages/` tree installs with one
 * config line and works: its tool arrives in the one guarded registry under the
 * name it authored, its fact check fires on a generated app, its judgment rule
 * joins the reviewer's rubric instead of being run, its component is really in
 * the catalog, and its skill loads on demand from the host skills mount.
 *
 * Two packs claiming one tool name fail at boot naming both.
 *
 * The pack under test (`./external-pack/index.ts`) imports `@vendoai/vendo`
 * only — no `@vendoai/core`, no deep path — so if this suite passes, the public
 * interface really is enough to author a pack from outside.
 */
import {
  createTurnSkills,
  hostSkillFiles,
  type PackSkill,
  type SkillsFs,
} from "@vendoai/core";
import { apps, mergePacks, type PackContext } from "@vendoai/vendo/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  generationTurn,
  resetFixture,
  type Stack,
  type StackOptions,
} from "./harness.js";
import { RETENTION_RULE, UNMASKED_ACCOUNT, complianceReports } from "./external-pack/index.js";

/** A workspace opened with a `/host` projection, read-only exactly like the real
 *  mount: just-bash's `IFileSystem` slice the skills store uses (build contract
 *  §3.2), over the projection the merged packs produced. */
const openedWith = (projection: Record<string, string>): SkillsFs => {
  const files = new Map(Object.entries(projection));
  return {
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    getAllPaths() { return [...files.keys()]; },
  };
};

/** A tiny-ask create: the brain writes the whole app on the spot. The account
 *  number is the point — the pack's fact check is what must object to it. */
const CLEAN_APP = '<App name="Retention"><Text text="Report 2026 is clean"/><Disclaimer reason="Fixture app."/></App>';
/** The small-change answer: quote the app's own printed text, say what replaces
 *  it. The replacement carries an unmasked account number — the pack's check is
 *  what must object. */
const LEAK_EDIT = '<Edit><Old>Report 2026 is clean</Old><New>Account 4012888888881881 is clean</New></Edit>';
/** A no-op-ish reword: the app stays clean, so `issues` being empty is a real
 *  assertion about the checks rather than about a missing response field. */
const CLEAN_EDIT = '<Edit><Old>Report 2026 is clean</Old><New>Report 2026 looks clean</New></Edit>';
/** Edits the PACK's component in beside the text. */
const BADGE_EDIT = '<Edit><Old>Report 2026 is clean</Old><New>Report 2026 is clean<RetentionBadge years={7}/></New></Edit>';
const REVIEW_SILENT = "Nothing to report.";

interface CreatedApp { id?: string; issues?: string[] }
interface EditedApp { app?: { id: string }; issues?: string[] }

let stack: Stack | undefined;
afterEach(async () => {
  const open = stack;
  stack = undefined;
  await open?.close();
});

const running = (): Stack => {
  if (stack === undefined) throw new Error("no stack for this test");
  return stack;
};

const create = async (prompt: string): Promise<CreatedApp> =>
  (await (await running().wireFetch("/apps", { method: "POST", body: JSON.stringify({ prompt }) }, ADA)).json()) as CreatedApp;

const edit = async (appId: string, instruction: string): Promise<EditedApp> =>
  (await (await running().wireFetch(`/apps/${appId}/edit`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  }, ADA)).json()) as EditedApp;

describe("E5: an external pack installs with one config line", () => {
  it("puts the pack's tool in the ONE guarded registry under the name it authored, and runs it", async () => {
    await resetFixture();
    stack = await createStack({ packs: [apps(), complianceReports] });

    const descriptors = await stack.vendo.actions.descriptors();
    const declared = descriptors.find(({ name }) => name === "check_report");

    // The authored name, not "compliance_reports_check_report": nothing is
    // auto-prefixed, because a skill body naming the tool is copied verbatim.
    expect(declared).toMatchObject({ name: "check_report", title: "Check a report", risk: "read" });
    // The app tools still arrived — apps() is a pack now, and adding one does
    // not displace another.
    expect(descriptors.map(({ name }) => name)).toContain("vendo_apps_create");

    // Executed through the SAME guard-bound registry chat and the MCP door use.
    const outcome = await stack.vendo.guard.bind(stack.vendo.actions).execute(
      { id: "call_pack_1", tool: "check_report", args: { reportId: "rep_9" } },
      { principal: ADA, venue: "chat", presence: "present", sessionId: "session_pack_1" },
    );

    expect(outcome).toMatchObject({ status: "ok", output: { reportId: "rep_9", status: "clean" } });
    // Guarded means audited: the call left the same trail every tool call does.
    expect(await stack.sql(
      "SELECT tool FROM vendo_audit WHERE subject = $1 AND kind = 'tool-call' AND tool = $2",
      [ADA.subject, "check_report"],
    )).toHaveLength(1);
  });

  it("fires the pack's fact check on a generated app and reports what it found", async () => {
    await resetFixture();
    stack = await createStack({
      packs: [apps(), complianceReports],
      turns: [
        // Create a clean app, then edit an account number into it: the edit path
        // is the one that hands blocking findings back to the caller.
        generationTurn(CLEAN_APP),
        generationTurn(REVIEW_SILENT, "review_1"),
        generationTurn(LEAK_EDIT, "gen_2"),
        // Two fix rounds: the brain declines to edit, so the finding survives.
        generationTurn(REVIEW_SILENT, "review_2"),
        generationTurn("No change.", "fix_1"),
        generationTurn(REVIEW_SILENT, "review_3"),
        generationTurn("No change.", "fix_2"),
        generationTurn(REVIEW_SILENT, "review_4"),
      ],
    });

    const created = await create("Show me the retention report");
    const leaky = await edit(created.id as string, "Put the full account number in the heading");

    // The host never wired a check; the PACK did, and the floor ran it anyway.
    expect(leaky.issues?.join(" ") ?? "").toContain(UNMASKED_ACCOUNT);
  });

  it("says nothing about an app the pack's check is happy with", async () => {
    await resetFixture();
    stack = await createStack({
      packs: [apps(), complianceReports],
      turns: [
        generationTurn(CLEAN_APP),
        generationTurn(REVIEW_SILENT, "review_1"),
        // Edit to a still-clean app: the edit path is the one that RETURNS
        // issues, so an empty list here is a real assertion rather than a
        // vacuous one over a field the create response never carries.
        generationTurn(CLEAN_EDIT, "gen_2"),
        generationTurn(REVIEW_SILENT, "review_2"),
      ],
    });

    const created = await create("Show me the retention report");
    const edited = await edit(created.id as string, "Reword the heading");

    expect(edited.app?.id).toBe(created.id);
    expect(edited.issues ?? []).toEqual([]);
  });

  /** Create, then edit the pack's component in. The edit path is the one that
   *  RETURNS blocking findings, and "references host component X absent from the
   *  catalog" is one — so this reports whether the catalog really carries it. */
  const editInTheBadge = async (packs: NonNullable<StackOptions["packs"]>): Promise<EditedApp> => {
    await resetFixture();
    stack = await createStack({
      packs,
      turns: [
        generationTurn(CLEAN_APP),
        generationTurn(REVIEW_SILENT, "review_1"),
        generationTurn(BADGE_EDIT, "gen_2"),
        generationTurn(REVIEW_SILENT, "review_2"),
        generationTurn("No change.", "fix_1"),
        generationTurn(REVIEW_SILENT, "review_3"),
        generationTurn("No change.", "fix_2"),
        generationTurn(REVIEW_SILENT, "review_4"),
      ],
    });
    const created = await create("Show me the retention report");
    return edit(created.id as string, "Add the retention badge");
  };

  it("registers the pack's component in the catalog the engine builds against", async () => {
    const edited = await editInTheBadge([apps(), complianceReports]);

    expect(edited.issues ?? []).toEqual([]);
  });

  it("and the SAME edit is rejected when the pack is not configured", async () => {
    // The contrast is what makes the assertion above mean something: without the
    // pack, the identical markup names a component nothing registered, and the
    // floor blocks it.
    const edited = await editInTheBadge([apps()]);

    const reported = edited.issues?.join(" ") ?? "";
    expect(reported).toContain("references unknown component");
    expect(reported).toContain("RetentionBadge");
  });
});

describe("E5: the pack's judgment rule reaches the live reviewer", () => {
  it("puts the rule on the reviewer's rubric in the composed server, not just in merged.checks", async () => {
    await resetFixture();
    // A reviewer that applies whatever rule its rubric carried: it blocks only
    // if the pack's rule text is in the prompt it was given. Same app either
    // way, so a finding proves the rule travelled from `Pack.checks` through the
    // floor into the reviewer's prompt in the REAL composed umbrella.
    stack = await createStack({
      packs: [apps(), complianceReports],
      turns: [generationTurn(CLEAN_APP), generationTurn(REVIEW_SILENT, "review_1")],
    });

    await create("Show me the retention report");

    // Every prompt the composed server sent this turn. The reviewer's is the one
    // that must carry the rule — it is the only thing that can apply it.
    const sent = JSON.stringify(stack.model.prompts);
    expect(sent).toContain(RETENTION_RULE);
  });

  it("does not put the rule in a prompt when the pack is not configured", async () => {
    await resetFixture();
    stack = await createStack({
      packs: [apps()],
      turns: [generationTurn(CLEAN_APP), generationTurn(REVIEW_SILENT, "review_1")],
    });

    await create("Show me the retention report");

    expect(JSON.stringify(stack.model.prompts)).not.toContain(RETENTION_RULE);
  });
});

describe("E5: a pack reaches only what its handle names", () => {
  it("hands the pack the tool registry and nothing else off the apps runtime", async () => {
    // The `Pick<AppsRuntime, "agentTools">` type is only a promise unless the
    // object really is that narrow: delete, publish and exportApp are on the
    // runtime, and "no reaching into other packs" cannot be enforced by a type
    // the pack author is free to cast away.
    await resetFixture();
    let handleKeys: string[] = [];
    stack = await createStack({
      packs: [
        apps(),
        // The handle is only resolvable once the runtime exists — inside a tool
        // call — which is exactly where a pack would reach for something it
        // should not have.
        (context) => ({
          name: "probe",
          tools: [{
            name: "probe_handle",
            description: "Reports what the pack can reach.",
            inputSchema: { type: "object", properties: {} },
            risk: "read" as const,
            execute: async () => {
              handleKeys = Object.keys(context.apps()).sort();
              return { keys: handleKeys };
            },
          }],
        }),
      ],
    });

    await stack.vendo.guard.bind(stack.vendo.actions).execute(
      { id: "call_probe_1", tool: "probe_handle", args: {} },
      { principal: ADA, venue: "chat", presence: "present", sessionId: "session_probe_1" },
    );

    expect(handleKeys).toEqual(["agentTools"]);
  });

  it("still lets the apps pack's tools run through that handle", async () => {
    await resetFixture();
    stack = await createStack({ packs: [apps()] });

    // A real guarded call through the narrowed handle. `agentTools` has to stay
    // BOUND to the runtime — a detached method would fail with a TypeError about
    // reading a property of undefined, which is what this rules out. The app id
    // is bogus on purpose: the runtime's own honest answer is the proof, not a
    // successful open.
    const outcome = await stack.vendo.guard.bind(stack.vendo.actions).execute(
      { id: "call_apps_1", tool: "vendo_apps_open", args: { appId: "app_does_not_exist" } },
      { principal: ADA, venue: "chat", presence: "present", sessionId: "session_apps_1" },
    );

    const message = outcome.status === "error" ? outcome.error.message : "";
    expect(message).not.toMatch(/Cannot read propert|is not a function|undefined/);
  });
});

describe("E5: the pack's skill loads on demand from the host mount", () => {
  it("projects every merged pack skill to /host/skills/<name>/SKILL.md and loads it back", async () => {
    const context = { apps: () => { throw new Error("no tool runs in this test"); } } as unknown as PackContext;
    const merged = mergePacks([apps(), complianceReports], context);

    // What the runtime hands the workspace open call as its `/host` projection.
    const projection = hostSkillFiles(merged.skills);
    expect(Object.keys(projection)).toContain("/host/skills/building-compliance-reports/SKILL.md");

    const skills = createTurnSkills(openedWith(projection));
    const listing = await skills.list();

    // Cheap listing: both skills, descriptions only.
    expect(listing.map(({ name }) => name)).toEqual(["building-apps", "building-compliance-reports"]);
    expect(JSON.stringify(listing)).not.toContain("fresh subagent");

    // The full body only when asked for, byte-identical to what the pack authored.
    const authored = merged.skills.find((skill: PackSkill) => skill.name === "building-compliance-reports");
    expect(await skills.load("building-compliance-reports")).toBe(authored?.body);
    expect(await skills.load("building-compliance-reports")).toContain("fresh subagent");
  });
});

describe("E5: judgment rules join the rubric; they are never run", () => {
  it("keeps the pack's judgment rule out of the fact runner and in the rubric as its own line", () => {
    const context = { apps: () => { throw new Error("no tool runs in this test"); } } as unknown as PackContext;
    const merged = mergePacks([complianceReports], context);

    const judgment = merged.checks.find(({ name }) => name === "totals-cite-their-report");
    expect(judgment).toEqual({ name: "totals-cite-their-report", kind: "judgment", rule: RETENTION_RULE });
    // One rule, one line — never folded into another rule's string.
    expect(merged.checks.filter(({ kind }) => kind === "judgment")).toHaveLength(1);
  });
});

describe("E5: two packs claiming one tool name fail at boot", () => {
  it("refuses to compose, naming both packs and the contested name", async () => {
    await resetFixture();
    const rival = { name: "rival-reports", tools: complianceReports.tools };

    await expect(createStack({ packs: [complianceReports, rival] })).rejects.toThrow(
      /check_report[\s\S]*compliance-reports[\s\S]*rival-reports/,
    );
  });

  /** `host_invoices_list` is a real tool in this fixture's `.vendo/tools.json`. */
  const squatter = {
    name: "squatter",
    tools: (complianceReports.tools ?? []).map((tool) => ({ ...tool, name: "host_invoices_list" })),
  };
  const claimsAHostToolName = /squatter[\s\S]*host_invoices_list|host_invoices_list[\s\S]*squatter/;

  it("refuses to compose when a pack claims one of the HOST's tool names (F4)", async () => {
    await resetFixture();
    // The registry would refuse this on some later request as "added registry";
    // boot refuses it now, naming the pack and the host.
    await expect(createStack({ packs: [apps(), squatter] })).rejects.toThrow(claimsAHostToolName);
  });

  it("still refuses when profileDir is the host root spelled explicitly", async () => {
    await resetFixture();
    await expect(createStack({ packs: [apps(), squatter], profileDir: "." }))
      .rejects.toThrow(claimsAHostToolName);
  });

  it("still refuses when profileDir points AT the .vendo directory", async () => {
    await resetFixture();
    // The registry accepts either form. A gate that only ever appended /.vendo/
    // read `.vendo/.vendo/tools.json` here, found nothing, and passed — the exact
    // silent no-op this check exists to prevent.
    await expect(createStack({ packs: [apps(), squatter], profileDir: "./.vendo" }))
      .rejects.toThrow(claimsAHostToolName);
  });

  it("warns when an explicit packs list has no apps pack (F6)", async () => {
    await resetFixture();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      stack = await createStack({ packs: [complianceReports] });
    } finally {
      console.warn = original;
    }

    const said = warnings.join("\n");
    expect(said).toContain("apps()");
    expect(said).toContain("compliance-reports");
  });
});
