import { describe, it, expect } from "vitest";
import * as shell from "./index";

describe("public API", () => {
  it("exports elements, core, primitives, hooks, and seams", () => {
    const names = [
      "FlowletPage", "FlowletOverlay", "FlowletSlot", "FlowletThread",
      "FlowletShellProvider", "useShell", "useFlowletThread", "toThreadItems",
      "MessageList", "Composer", "ApprovalCard", "UINodeView", "Landing",
      "SuggestionChips", "FlowGallery", "ConnectDock", "ConnectTray", "IntegrationsPicker",
      "ConnectCard", "StreamingText", "ToolCall", "VoiceButton",
      "themeToStyle", "createLocalStore", "createLocalIntegrations", "useVoiceInput",
    ];
    for (const name of names) expect(shell).toHaveProperty(name);
  });
});
