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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADA,
  createStack,
  resetFixture,
  screenAgentCreateTurns,
  type Stack,
  type StackOptions,
} from "../src/harness.js";
import {
  RETENTION_RULE,
  UNMASKED_ACCOUNT,
  complianceChecks,
  complianceComponents,
  complianceSkills,
  complianceTools,
} from "../src/external-capability/index.js";

/** The whole install, as one host would write it. */
const installed: StackOptions = {
  tools: complianceTools,
  skills: complianceSkills,
  checks: complianceChecks,
  catalog: complianceComponents,
};

/** A tiny-ask create: the screen agent saves the whole `app.tsx` with its own
 *  hands. Clean, so it lands. The default export's name is the app's title. */
const screen = (body: string, imports = "Disclaimer, Stack, Text"): string =>
  `import { ${imports} } from "@vendo/screen";

export default function Retention() {
  return (
    <Stack gap={12}>
${body}
      <Disclaimer reason="Fixture app." />
    </Stack>
  );
}
`;

const CLEAN_APP = screen('      <Text text="Report 2026 is clean" variant="heading" />');
/** The edit answer — the whole screen again, this time carrying an unmasked
 *  account number. The contributed fact check is what must object to it. */
const LEAK_APP = screen('      <Text text="Account 4012888888881881 is clean" variant="heading" />');
/** A no-op-ish reword: the app stays clean, so `issues` being empty is a real
 *  assertion about the checks rather than about a missing response field. */
const REWORDED_APP = screen('      <Text text="Report 2026 looks clean" variant="heading" />');
/** The same app with the contributed component saved in beside the text. */
const BADGE_APP = screen(
  '      <Text text="Report 2026 is clean" variant="heading" />\n      <RetentionBadge years={7} />',
  "Disclaimer, RetentionBadge, Stack, Text",
);

/** The digits the fact check objects to, spelled once. */
const ACCOUNT_NUMBER = "4012888888881881";

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

/** The app as the composed store holds it, read back over the wire. */
const stored = async (appId: string): Promise<string> =>
  JSON.stringify(await (await running().wireFetch(`/apps/${appId}`, {}, ADA)).json());

/**
 * Everything the composed server told the OPERATOR while `body` ran.
 *
 * A `block` at the paint seam is deliberately NOT a user-facing channel: the
 * seam emits nothing, no row lands, and the last good view stays on the person's
 * screen. So the reason the floor refused a save reaches exactly one place, and
 * this is it (`render-seam.ts`: "Loud for the operator, silent for the user").
 */
const operatorLog = async (body: () => Promise<void>): Promise<string> => {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
};

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
        // Create a clean app, then save an account number into it. The floor the
        // pack's check rides is the PAINT SEAM's, and it runs on every commit by
        // every author — so this is the same gate a hand-written save meets.
        ...screenAgentCreateTurns(CLEAN_APP),
        ...screenAgentCreateTurns(LEAK_APP),
      ],
    });

    const created = await create("Show me the retention report");
    const appId = created.id as string;
    expect(appId).toMatch(/^app_/);
    // The clean app really landed — the contrast below is about the ACCOUNT
    // NUMBER, not about generation being broken.
    expect(await stored(appId)).toContain("Report 2026 is clean");

    const reported = await operatorLog(async () => {
      await edit(appId, "Put the full account number in the heading");
    });

    // WHAT IT FOUND, in the contributed check's own words and under the name it
    // registered itself with. Nothing else in this deployment knows that an
    // account number is worth objecting to.
    expect(reported).toContain(UNMASKED_ACCOUNT);
    expect(reported).toContain("no-unmasked-accounts");
    // …and the finding STOPPED the save: a `block` means nothing paints and no
    // row lands, so the app is still exactly what it was.
    const after = await stored(appId);
    expect(after).not.toContain(ACCOUNT_NUMBER);
    expect(after).toContain("Report 2026 is clean");
  });

  it("says nothing about an app the contributed check is happy with", async () => {
    await resetFixture();
    stack = await createStack({
      ...installed,
      turns: [
        ...screenAgentCreateTurns(CLEAN_APP),
        // Save a still-clean app: the edit path is the one that RETURNS issues,
        // so an empty list here is a real assertion rather than a vacuous one
        // over a field the create response never carries.
        ...screenAgentCreateTurns(REWORDED_APP),
      ],
    });

    const created = await create("Show me the retention report");
    const edited = await edit(created.id as string, "Reword the heading");

    expect(edited.app?.id).toBe(created.id);
    expect(edited.issues ?? []).toEqual([]);
    // The reword really LANDED. Without this, "no issues" would also be what a
    // refused save looks like from out here.
    expect(await stored(created.id as string)).toContain("Report 2026 looks clean");
  });

  /** Create, then save the contributed component in. `@vendo/screen` exports
   *  exactly the Kit plus this deployment's catalog, so a component nothing here
   *  registered does not type-check and the gauntlet refuses the screen — which
   *  makes "did the badge reach the row" a report on whether the catalog really
   *  carries it. */
  const editInTheBadge = async (options: StackOptions): Promise<{ edited: EditedApp; reported: string; after: string }> => {
    await resetFixture();
    stack = await createStack({
      ...options,
      turns: [
        ...screenAgentCreateTurns(CLEAN_APP),
        ...screenAgentCreateTurns(BADGE_APP),
      ],
    });
    const created = await create("Show me the retention report");
    const appId = created.id as string;
    let edited: EditedApp = {};
    const reported = await operatorLog(async () => {
      edited = await edit(appId, "Add the retention badge");
    });
    return { edited, reported, after: await stored(appId) };
  };

  it("registers the contributed component in the catalog the engine builds against", async () => {
    const { edited, reported, after } = await editInTheBadge(installed);

    expect(edited.issues ?? []).toEqual([]);
    // The badge reached the ROW, so the catalog the floor measures against
    // really carries it — the floor never refused this screen at all.
    expect(after).toContain("RetentionBadge");
    expect(reported).not.toContain("did not pass the checks floor");
  });

  it("and the SAME edit is rejected when the component was not registered", async () => {
    // The contrast is what makes the assertion above mean something: without the
    // registration, the identical screen names a component nothing knows, and
    // the floor blocks it.
    const { reported, after } = await editInTheBadge({});

    // A screen may only name what `@vendo/screen` exports, and that surface IS
    // the catalog — so an unregistered component is a type error, and the
    // gauntlet's type stage is where the refusal comes from.
    expect(reported).toContain("did not pass the checks floor");
    expect(reported).toContain("has no exported member 'RetentionBadge'");
    // Refused, not half-applied: nothing painted, so the app the person can
    // still open is the one they had — a screen the floor would not render must
    // never become the app's stored screen.
    expect(after).not.toContain("RetentionBadge");
    expect(after).toContain("Report 2026 is clean");
  });
});

describe("E5: the contributed judgment rule reaches the live reviewer", () => {
  /**
   * The screen agent's own review floor, scripted: save the screen, stop, and
   * face the MANDATORY reviewer pass — the one judging call every painted screen
   * gets whether or not the loop asked for it (`screen-agent.ts`). The loop
   * carries no `validate` verb of its own any more, so this pass is the only
   * route a host's judgment rule has into a live reviewer, which is exactly what
   * makes the prompt below the proof.
   *
   * The last turn is that reviewer's own verdict (`report_findings`, empty).
   */
  const saveThenReviewTurns = screenAgentCreateTurns(CLEAN_APP);

  it("puts the rule on the reviewer's rubric in the composed server, not just in a list", async () => {
    await resetFixture();
    // The reviewer applies whatever rule its rubric carried, and it can only
    // carry one that reached its prompt. So a rule found in the prompt the
    // composed umbrella really sent proves it travelled from the config key,
    // through `AppsRuntime.validate`'s floor, into the live reviewer — on the
    // path the screen agent itself takes.
    stack = await createStack({ ...installed, turns: saveThenReviewTurns });

    await create("Show me the retention report");

    // Every prompt the composed server sent this turn. The reviewer's is the one
    // that must carry the rule — it is the only thing that can apply it.
    const sent = JSON.stringify(stack.model.prompts);
    expect(sent).toContain(RETENTION_RULE);
  });

  it("does not put the rule in a prompt when the check was not configured", async () => {
    await resetFixture();
    stack = await createStack({ turns: saveThenReviewTurns });

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
