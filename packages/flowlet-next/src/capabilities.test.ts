import { describe, expect, it } from "vitest";
import { detectCapabilities } from "./capabilities";

describe("detectCapabilities", () => {
  it("is chat-only with just an Anthropic key (the one-key minimum)", () => {
    expect(detectCapabilities({ ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({
      chat: true,
      integrations: false,
      voice: false,
    });
  });

  it("adds integrations with a Composio key and voice with an OpenAI key", () => {
    expect(
      detectCapabilities({
        ANTHROPIC_API_KEY: "sk-ant-x",
        COMPOSIO_API_KEY: "ck_x",
        OPENAI_API_KEY: "sk-x",
      }),
    ).toEqual({ chat: true, integrations: true, voice: true });
  });

  it("treats empty/whitespace values as absent", () => {
    expect(
      detectCapabilities({ ANTHROPIC_API_KEY: "  ", COMPOSIO_API_KEY: "" }),
    ).toEqual({ chat: false, integrations: false, voice: false });
  });
});
