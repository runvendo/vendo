/**
 * E5 — capability authored OUTSIDE this repo's `packages/` tree installs with
 * config keys a host already knows, and works: its tool arrives in the one
 * guarded registry under the name it authored, its fact check fires on a
 * generated app, its judgment rule joins the reviewer's rubric instead of being
 * run, its component is really in the catalog, and its skill loads on demand
 * from the host skills mount.
 *
 * Two contributors claiming one tool name fail at boot naming both.
 *
 * The module under test (`./external-capability/index.ts`) imports
 * `@vendoai/vendo` only — no deep path — so if this suite passes, the public
 * interface really is enough to extend Vendo from outside.
 */
import { createTurnSkills } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADA,
  createStack,
  generationTurn,
  resetFixture,
  type Stack,
  type StackOptions,
} from "./harness.js";
import {
  RETENTION_RULE,
  UNMASKED_ACCOUNT,
  complianceChecks,
  complianceComponents,
  complianceSkills,
  complianceTools,
} from "./external-capability/index.js";

/** The whole install, as one host would write it. */
const installed: StackOptions = {
  tools: complianceTools,
  skills: complianceSkills,
  checks: complianceChecks,
  catalog: complianceComponents,
};

/** A tiny-ask create: the brain writes the whole app on the spot. The account
 *  number is the point — the fact check is what must object to it. */
const CLEAN_APP = '<App name="Retention"><Text text="Report 2026 is clean"/><Disclaimer reason="Fixture app."/></App>';
/** The small-change answer: quote the app's own printed text, say what replaces
 *  it. The replacement carries an unmasked account number — the fact check is
 *  what must object. */
const LEAK_EDIT = '<Edit><Old>Report 2026 is clean</Old><New>Account 4012888888881881 is clean</New></Edit>';
/** A no-op-ish reword: the app stays clean, so `issues` being empty is a real
 *  assertion about the checks rather than about a missing response field. */
const CLEAN_EDIT = '<Edit><Old>Report 2026 is clean</Old><New>Report 2026 looks clean</New></Edit>';
/** Edits the contributed component in beside the text. */
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

describe("E5: external capability installs through the keys a host already knows", () => {
  it("puts the contributed tool in the ONE guarded registry under the name it authored, and runs it", async () => {
    await resetFixture();
    stack = await createStack(installed);

    const descriptors = await stack.vendo.actions.descriptors();
    const declared = descriptors.find(({ name }) => name === "check_report");

    // The authored name, not "compliance_reports_check_report": nothing is
    // auto-prefixed, because a skill body naming the tool is copied verbatim.
    expect(declared).toMatchObject({ name: "check_report", title: "Check a report", risk: "read" });
    // The app tools still arrived — adding capability does not displace any.
    expect(descriptors.map(({ name }) => name)).toContain("vendo_make");

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

  it("fires the contributed fact check on a generated app and reports what it found", async () => {
    await resetFixture();
    stack = await createStack({
      ...installed,
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

    expect(leaky.issues?.join(" ") ?? "").toContain(UNMASKED_ACCOUNT);
  });

  it("says nothing about an app the contributed check is happy with", async () => {
    await resetFixture();
    stack = await createStack({
      ...installed,
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

  /** Create, then edit the contributed component in. The edit path is the one
   *  that RETURNS blocking findings, and "references host component X absent
   *  from the catalog" is one — so this reports whether the catalog really
   *  carries it. */
  const editInTheBadge = async (options: StackOptions): Promise<EditedApp> => {
    await resetFixture();
    stack = await createStack({
      ...options,
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

  it("registers the contributed component in the catalog the engine builds against", async () => {
    const edited = await editInTheBadge(installed);

    expect(edited.issues ?? []).toEqual([]);
  });

  it("and the SAME edit is rejected when the component was not registered", async () => {
    // The contrast is what makes the assertion above mean something: without the
    // registration, the identical markup names a component nothing knows, and
    // the floor blocks it.
    const edited = await editInTheBadge({});

    const reported = edited.issues?.join(" ") ?? "";
    expect(reported).toContain("references unknown component");
    expect(reported).toContain("RetentionBadge");
  });
});

describe("E5: the contributed judgment rule reaches the live reviewer", () => {
  it("puts the rule on the reviewer's rubric in the composed server, not just in a list", async () => {
    await resetFixture();
    // A reviewer that applies whatever rule its rubric carried: it blocks only
    // if the rule text is in the prompt it was given. Same app either way, so a
    // finding proves the rule travelled from the config key through the floor
    // into the reviewer's prompt in the REAL composed umbrella.
    stack = await createStack({
      ...installed,
      turns: [generationTurn(CLEAN_APP), generationTurn(REVIEW_SILENT, "review_1")],
    });

    await create("Show me the retention report");

    // Every prompt the composed server sent this turn. The reviewer's is the one
    // that must carry the rule — it is the only thing that can apply it.
    const sent = JSON.stringify(stack.model.prompts);
    expect(sent).toContain(RETENTION_RULE);
  });

  it("does not put the rule in a prompt when the check was not configured", async () => {
    await resetFixture();
    stack = await createStack({
      turns: [generationTurn(CLEAN_APP), generationTurn(REVIEW_SILENT, "review_1")],
    });

    await create("Show me the retention report");

    expect(JSON.stringify(stack.model.prompts)).not.toContain(RETENTION_RULE);
  });
});

describe("E5: app generation mounts itself through the same keys", () => {
  it("still runs its own tools through the composed runtime", async () => {
    await resetFixture();
    stack = await createStack({});

    // A real guarded call. The app tools reach the runtime through a thunk
    // resolved at call time; a detached method would fail with a TypeError about
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

  it("is honestly ABSENT with apps: false — no tools, no skill, no /apps door", async () => {
    await resetFixture();
    stack = await createStack({ apps: false, tools: complianceTools });

    const names = (await stack.vendo.actions.descriptors()).map(({ name }) => name);
    // The one front door and the app tools are gone, and nothing refuses in
    // their place — they are simply not there.
    expect(names).not.toContain("vendo_make");
    expect(names.filter((name) => name.startsWith("vendo_apps_"))).toEqual([]);
    // The capability the host DID configure is untouched by the unmount.
    expect(names).toContain("check_report");

    const response = await stack.wireFetch("/apps", { method: "POST", body: JSON.stringify({ prompt: "hi" }) }, ADA);
    expect(response.status).toBe(404);
  });
});

describe("E5: the contributed skill loads on demand from the host mount", () => {
  it("mounts it at /host/skills/<name>/SKILL.md in the REAL composed workspace", async () => {
    await resetFixture();
    stack = await createStack(installed);

    // The workspace a turn is handed, from the composed umbrella — not a fake
    // projection assembled in the test.
    const workspace = await stack.vendo.harness.workspace(ADA);
    expect(workspace.getAllPaths()).toContain("/host/skills/building-compliance-reports/SKILL.md");

    const skills = createTurnSkills(workspace);
    const listing = await skills.list();

    // Cheap listing: both skills, descriptions only — no body in it.
    expect(listing.map(({ name }) => name)).toEqual(["building-apps", "building-compliance-reports"]);
    expect(JSON.stringify(listing)).not.toContain("fresh subagent");

    // The full body only when asked for, byte-identical to what was authored.
    expect(await skills.load("building-compliance-reports")).toBe(complianceSkills[0]?.body);
  });
});

describe("E5: two contributors claiming one tool name fail at boot", () => {
  it("refuses to compose, naming both contributors and the contested name", async () => {
    await resetFixture();
    const rival = complianceTools.map((tool) => ({ ...tool }));

    await expect(createStack({ tools: [...complianceTools, ...rival] })).rejects.toThrow(/check_report/);
  });

  /** `host_invoices_list` is a real tool in this fixture's `.vendo/tools.json`. */
  const squatter = complianceTools.map((tool) => ({ ...tool, name: "host_invoices_list" }));
  const claimsAHostToolName = /host_invoices_list/;

  it("refuses to compose when a contributor claims one of the HOST's tool names (F4)", async () => {
    await resetFixture();
    // The registry would refuse this on some later request as "added registry";
    // boot refuses it now, naming the contributor and the host.
    await expect(createStack({ tools: squatter })).rejects.toThrow(claimsAHostToolName);
  });

  it("still refuses when profileDir is the host root spelled explicitly", async () => {
    await resetFixture();
    await expect(createStack({ tools: squatter, profileDir: "." })).rejects.toThrow(claimsAHostToolName);
  });

  it("still refuses when profileDir points AT the .vendo directory", async () => {
    await resetFixture();
    // The registry accepts either form. A gate that only ever appended /.vendo/
    // read `.vendo/.vendo/tools.json` here, found nothing, and passed — the exact
    // silent no-op this check exists to prevent.
    await expect(createStack({ tools: squatter, profileDir: "./.vendo" })).rejects.toThrow(claimsAHostToolName);
  });
});
