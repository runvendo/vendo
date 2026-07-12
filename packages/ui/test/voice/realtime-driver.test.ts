// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { mapRealtimeServerEvent, realtimeVoiceDriver } from "../../src/voice/index.js";

describe("realtime voice driver pure seams", () => {
  it("maps recorded state and transcript events", () => {
    expect(mapRealtimeServerEvent({ type: "input_audio_buffer.speech_started" })).toEqual([
      { type: "state", state: "listening" },
    ]);
    expect(mapRealtimeServerEvent({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "turn-1",
      delta: "Hello",
    })).toEqual([
      { type: "transcript-delta", id: "user:turn-1", role: "user", delta: "Hello" },
    ]);
    expect(mapRealtimeServerEvent({
      type: "response.audio_transcript.done",
      response_id: "response-1",
      transcript: "Hi there",
    })).toEqual([
      { type: "transcript-final", id: "assistant:response-1", role: "assistant", text: "Hi there" },
    ]);
    expect(mapRealtimeServerEvent({ type: "future.event", payload: true })).toEqual([]);
  });

  it("surfaces missing browser capabilities as an error event without throwing", async () => {
    const events: unknown[] = [];
    const driver = realtimeVoiceDriver({
      getSession: async () => ({ clientSecret: "ephemeral" }),
    });

    expect(() => driver.start({ onEvent: (event) => events.push(event) })).not.toThrow();
    await Promise.resolve();

    expect(events).toContainEqual({ type: "state", state: "connecting" });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error" }),
    ]));
  });
});
