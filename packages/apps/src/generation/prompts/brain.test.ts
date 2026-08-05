/**
 * The away-work ladder the brain is OFFERED.
 *
 * The brain picks the rung, so the rungs it is told about are the routing. An
 * agentic automation was being refused with "This host has no sandbox
 * configured" for exactly this reason: the only two escapes this prompt named
 * were `steps` and the box, so a request that needs a judgment call every
 * firing had nowhere to go but the box — and the box is the one rung a machine
 * is required for.
 */
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { laneGates } from "../lanes.js";
import { brainPrompt } from "./brain.js";

const deps = (hostCannot?: string[]) => ({
  model: {} as LanguageModel,
  catalog: [],
  tools: [{ name: "host_listInvoices", description: "Every invoice.", risk: "read" as const }],
  ...(hostCannot === undefined ? {} : { hostCannot }),
});

describe("the away-work ladder the brain is offered", () => {
  it("names all three rungs, box last", () => {
    const prompt = brainPrompt(deps());

    expect(prompt).toContain('kind="steps"');
    expect(prompt).toContain('kind="agentic"');
    expect(prompt).toContain('kind="box"');
    // The ladder's order IS the instruction: stop at the first rung that fits,
    // and the box is the last resort.
    expect(prompt.indexOf('kind="steps"')).toBeLessThan(prompt.indexOf('kind="agentic"'));
    expect(prompt.indexOf('kind="agentic"')).toBeLessThan(prompt.lastIndexOf('kind="box"'));
  });

  it("says an app holds SEVERAL automations, so another one is a plan and not a text edit", () => {
    // The other mechanical way "add a second schedule alongside" comes back with
    // one trigger: the brain reads an app that already has an automation as an
    // app whose away work is done, answers with <Edit> blocks over the view, and
    // nothing ever reaches the automation lane. Rule 3 offers text edits for
    // "small" changes and a plan for "structural" ones, and an automation is
    // neither on its face — so the ladder says it outright.
    const prompt = brainPrompt(deps());

    expect(prompt).toMatch(/several automations/i);
    expect(prompt).toMatch(/another one/i);
  });

  it("says the two automation rungs need no machine, so a sandbox-less host still has them", () => {
    const prompt = brainPrompt(deps(laneGates({}).cannot));

    // Both halves have to be in front of the brain at once: the fact that this
    // host cannot provision a machine, and the fact that the automation rungs
    // never needed one.
    expect(prompt).toContain("no sandbox configured");
    expect(prompt).toMatch(/no machine/);
    expect(prompt).toContain('kind="agentic"');
  });
});
