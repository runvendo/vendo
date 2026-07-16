import { describe, expect, it } from "vitest";
import { demoBeatPlan } from "./capture.js";

describe("demoBeatPlan", () => {
  it("sequences the config beats into one continuous overlay story", () => {
    expect(demoBeatPlan([
      { key: "generate-ui", prompt: "Show me a dashboard of my data", chip: "Dashboard" },
      { key: "take-action", prompt: "Take an action with approval", chip: "Action" },
      { key: "save-app", prompt: "Save this as a reusable app", chip: "Save" },
    ])).toEqual([
      { key: "generate-ui", prompt: "Show me a dashboard of my data", overlayBeat: "BEAT 1/3 · GENERATE UI" },
      { key: "take-action", prompt: "Take an action with approval", overlayBeat: "BEAT 2/3 · TAKE ACTION" },
      { key: "save-app", prompt: "Save this as a reusable app", overlayBeat: "BEAT 3/3 · SAVE APP" },
    ]);
  });
});
