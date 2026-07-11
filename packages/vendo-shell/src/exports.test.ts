import { describe, it, expect } from "vitest";
import * as shell from "./index";

describe("public API", () => {
  it("exports elements, core, primitives, hooks, and seams", () => {
    const names = [
      "VendoPage", "VendoOverlay", "VendoSlot", "VendoThread",
      "VendoShellProvider", "useShell", "useVendoThread", "toThreadItems",
      "MessageList", "Composer", "ApprovalCard", "UINodeView", "Landing",
      "SuggestionChips", "ConnectDock", "ConnectTray", "IntegrationsPicker",
      "ConnectCard", "StreamingText", "ToolCall", "VoiceButton",
      "themeToStyle", "createLocalIntegrations",
      "VoiceStage", "VoiceBlob", "useVoiceSession", "createScriptedVoiceDriver",
      "voiceSessionMessages", "reduceVoice",
    ];
    for (const name of names) expect(shell).toHaveProperty(name);
    for (const removed of [
      "createLocalStore",
      "createWebStorage",
      "createLocalRemixes",
      "createWebRemixes",
      "reopenVendo",
      "originatingPrompt",
    ]) {
      expect(shell).not.toHaveProperty(removed);
    }
  });
});
