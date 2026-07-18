import { describe, expect, it } from "vitest";
import { scenarios } from "./scenarios.js";

/** The states the install-dx §8 plan requires the playground to show. */
const REQUIRED = [
  "overlay-launcher",
  "overlay-open",
  "overlay-streaming",
  "thread-streaming",
  "thread-view",
  "thread-connect",
  "approval-flow",
  "activities",
  "activities-empty",
  "slot-empty",
  "slot-filled",
  "slot-broken",
  "page",
  "mobile",
];

describe("playground scenario registry", () => {
  it("covers every required surface state with unique linkable ids", () => {
    const ids = scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of REQUIRED) expect(ids).toContain(required);
  });

  it("every scenario is renderable metadata: title, description, mount", () => {
    for (const scenario of scenarios) {
      expect(scenario.title.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.description.length, scenario.id).toBeGreaterThan(0);
      expect(typeof scenario.render, scenario.id).toBe("function");
    }
  });

  it("director scripts are well-formed multi-or-single turn cue lists", () => {
    for (const scenario of scenarios) {
      if (!scenario.script) continue;
      const turns = scenario.script.turns ?? [{ cues: scenario.script.cues ?? [] }];
      expect(turns.length, scenario.id).toBeGreaterThan(0);
      for (const turn of turns) {
        expect(turn.cues.length, scenario.id).toBeGreaterThan(0);
        for (const cue of turn.cues) {
          expect(typeof cue.delay, scenario.id).toBe("number");
          expect(typeof (cue.chunk as { type?: unknown }).type, scenario.id).toBe("string");
        }
      }
      // A scripted conversation must end its final turn cleanly.
      const last = turns.at(-1)!.cues.at(-1)!.chunk as { type: string };
      expect(last.type, scenario.id).toBe("finish");
    }
  });

  it("auto-played scenarios carry the prompt their script answers", () => {
    // These stay interactive: the launcher waits for a click, the page waits
    // for a typed turn, and mobile embeds another scenario in an iframe.
    const interactive = new Set(["overlay-launcher", "page", "mobile"]);
    for (const scenario of scenarios) {
      if (scenario.script && !interactive.has(scenario.id)) {
        expect(scenario.autoSend, `${scenario.id} plays a script and needs an opening user turn`).toBeTruthy();
      }
    }
  });

  it("the approval flow parks on an approval request and resumes on a second turn", () => {
    const approval = scenarios.find((scenario) => scenario.id === "approval-flow")!;
    const turns = approval.script!.turns!;
    expect(turns.length).toBeGreaterThanOrEqual(2);
    const types = turns[0]!.cues.map((cue) => (cue.chunk as { type: string }).type);
    expect(types).toContain("tool-approval-request");
    expect(types).toContain("data-vendo-approval");
  });

  it("activities shows a populated queue+feed; activities-empty overrides both to empty", () => {
    const populated = scenarios.find((scenario) => scenario.id === "activities")!;
    const populatedFixtures = populated.fixtures?.();
    expect(populatedFixtures, "activities uses the default populated fixtures").toBeUndefined();

    const empty = scenarios.find((scenario) => scenario.id === "activities-empty")!;
    const emptyFixtures = empty.fixtures!();
    expect(emptyFixtures.approvals).toEqual([]);
    expect(emptyFixtures.activity).toEqual([]);
  });

  it("the connect scenario ends with a connect-required tool outcome", () => {
    const connect = scenarios.find((scenario) => scenario.id === "thread-connect")!;
    const cues = (connect.script!.turns ?? [{ cues: connect.script!.cues ?? [] }]).flatMap((turn) => turn.cues);
    const outputs = cues
      .map((cue) => cue.chunk as { type: string; output?: { status?: string } })
      .filter((chunk) => chunk.type === "tool-output-available");
    expect(outputs.some((chunk) => chunk.output?.status === "connect-required")).toBe(true);
  });
});
