// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapRealtimeServerEvent,
  realtimeVoiceDriver,
  type RealtimeVoiceDriverOptions,
  type VoiceDriverEvent,
} from "../../src/voice/index.js";

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
    expect(mapRealtimeServerEvent({
      type: "response.audio_transcript.delta",
      response_id: "response-2",
      delta: "Working",
    })).toEqual([
      { type: "state", state: "speaking" },
      { type: "transcript-delta", id: "assistant:response-2", role: "assistant", delta: "Working" },
    ]);
    expect(mapRealtimeServerEvent({ type: "response.done" })).toEqual([
      { type: "state", state: "listening" },
    ]);
    expect(mapRealtimeServerEvent({ type: "error", error: { message: "provider failed" } })).toEqual([
      { type: "error", message: "provider failed" },
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

  it("times out when connecting makes no progress", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser();
    const events: VoiceDriverEvent[] = [];
    const driver = realtimeVoiceDriver(optionsWithBrowser(browser, { connectTimeoutMs: 50 }));

    driver.start({ onEvent: (event) => events.push(event) });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(51);

    expect(events).toContainEqual({ type: "state", state: "connecting" });
    expect(errorMessages(events)).toEqual([expect.stringMatching(/timed out/i)]);
  });

  it("distinguishes microphone, session, and SDP setup failures", async () => {
    const microphone = fakeBrowser({
      getUserMediaError: new DOMException("Permission denied", "NotAllowedError"),
    });
    const microphoneEvents: VoiceDriverEvent[] = [];
    realtimeVoiceDriver(optionsWithBrowser(microphone)).start({
      onEvent: (event) => microphoneEvents.push(event),
    });
    await flushMicrotasks();
    expect(errorMessages(microphoneEvents)).toEqual([expect.stringMatching(/microphone permission/i)]);

    const session = fakeBrowser();
    const sessionEvents: VoiceDriverEvent[] = [];
    realtimeVoiceDriver(optionsWithBrowser(session, {
      getSession: vi.fn().mockRejectedValue(new Error("mint unavailable")),
    })).start({ onEvent: (event) => sessionEvents.push(event) });
    await flushMicrotasks();
    expect(errorMessages(sessionEvents)).toEqual([expect.stringMatching(/voice session/i)]);

    const sdp = fakeBrowser({ responseOk: false });
    const sdpEvents: VoiceDriverEvent[] = [];
    realtimeVoiceDriver(optionsWithBrowser(sdp)).start({ onEvent: (event) => sdpEvents.push(event) });
    await flushMicrotasks();
    expect(errorMessages(sdpEvents)).toEqual([expect.stringMatching(/SDP exchange/i)]);
  });

  it.each(["disconnected", "failed"] as const)(
    "reconnects a %s peer with a fresh session and returns to listening",
    async (connectionState) => {
      vi.useFakeTimers();
      const browser = fakeBrowser();
      const events: VoiceDriverEvent[] = [];
      const getSession = vi.fn().mockResolvedValue({ clientSecret: "ephemeral" });
      const driver = realtimeVoiceDriver(optionsWithBrowser(browser, { getSession }));

      const handle = driver.start({ onEvent: (event) => events.push(event) });
      await flushMicrotasks();
      browser.peers[0]?.open();
      browser.peers[0]?.changeConnectionState(connectionState);

      expect(events.at(-1)).toEqual({ type: "state", state: "reconnecting" });

      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();
      expect(browser.peers).toHaveLength(2);
      browser.peers[1]?.open();

      expect(events.at(-1)).toEqual({ type: "state", state: "listening" });
      expect(getSession).toHaveBeenCalledTimes(2);
      handle.stop();
    },
  );

  it("emits an error after all reconnect attempts are exhausted", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser();
    const getSession = vi.fn()
      .mockResolvedValueOnce({ clientSecret: "ephemeral" })
      .mockRejectedValue(new Error("mint unavailable"));
    const events: VoiceDriverEvent[] = [];
    const driver = realtimeVoiceDriver(optionsWithBrowser(browser, { getSession }));

    driver.start({ onEvent: (event) => events.push(event) });
    await flushMicrotasks();
    browser.peers[0]?.open();
    browser.peers[0]?.changeConnectionState("failed");

    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(500);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(getSession).toHaveBeenCalledTimes(4);
    expect(errorMessages(events)).toEqual([expect.stringMatching(/after 3 attempts/i)]);
  });

  it("toggles microphone tracks and reapplies mute after reconnect", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser();
    const driver = realtimeVoiceDriver(optionsWithBrowser(browser));
    const handle = driver.start({ onEvent: () => undefined });

    await flushMicrotasks();
    handle.setMuted?.(true);
    expect(browser.streams[0]?.track.enabled).toBe(false);
    browser.peers[0]?.open();
    browser.peers[0]?.changeConnectionState("disconnected");

    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();
    expect(browser.streams[1]?.track.enabled).toBe(false);

    handle.setMuted?.(false);
    expect(browser.streams[1]?.track.enabled).toBe(true);
    handle.stop();
  });

  it("emits throttled microphone and remote amplitude levels", async () => {
    vi.useFakeTimers();
    const browser = fakeBrowser({ analyserValues: [160, 224] });
    const events: VoiceDriverEvent[] = [];
    const driver = realtimeVoiceDriver(optionsWithBrowser(browser));

    const handle = driver.start({ onEvent: (event) => events.push(event) });
    await flushMicrotasks();
    browser.peers[0]?.open();
    await vi.advanceTimersByTimeAsync(30);

    const remote = browser.createStream();
    browser.peers[0]?.emitTrack(remote.stream);
    browser.peers[0]?.message({
      type: "response.audio_transcript.delta",
      response_id: "response-1",
      delta: "Hello",
    });
    await vi.advanceTimersByTimeAsync(30);

    const levels = events.flatMap((event) => event.type === "amplitude" ? [event.level] : []);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toBeGreaterThan(0);
    expect(levels[1]).toBeGreaterThan(levels[0] ?? 0);
    expect(levels.every((level) => level >= 0 && level <= 1)).toBe(true);

    handle.stop();
    expect(browser.audioSources).toHaveLength(2);
    expect(browser.audioSources.every((source) => source.disconnect.mock.calls.length === 1)).toBe(true);
    expect(browser.audioContexts[0]?.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60);
    expect(events.filter((event) => event.type === "amplitude")).toHaveLength(2);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

interface FakeStream {
  stream: MediaStream;
  track: MediaStreamTrack;
}

interface FakeBrowser {
  capabilities: unknown;
  peers: FakePeer[];
  streams: FakeStream[];
  audioContexts: Array<{ close: ReturnType<typeof vi.fn> }>;
  audioSources: Array<{ disconnect: ReturnType<typeof vi.fn> }>;
  createStream(): FakeStream;
}

function fakeBrowser(options: {
  analyserValues?: number[];
  getUserMediaError?: Error;
  responseOk?: boolean;
} = {}): FakeBrowser {
  const peers: FakePeer[] = [];
  const streams: FakeStream[] = [];
  const audioContexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const audioSources: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  const analyserValues = [...(options.analyserValues ?? [160])];

  const createStream = (): FakeStream => {
    const track = {
      enabled: true,
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream;
    const result = { stream, track };
    streams.push(result);
    return result;
  };

  class PeerConnection extends FakePeer {
    constructor() {
      super();
      peers.push(this);
    }
  }

  class TestAnalyser {
    fftSize = 256;
    private readonly value = analyserValues.shift() ?? 128;
    disconnect = vi.fn();

    getByteTimeDomainData(values: Uint8Array): void {
      values.fill(this.value);
    }
  }

  class TestAudioContext {
    createAnalyser = () => new TestAnalyser();
    createMediaStreamSource = () => {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      audioSources.push(source);
      return source;
    };
    close = vi.fn().mockResolvedValue(undefined);

    constructor() {
      audioContexts.push(this);
    }
  }

  const audio = {
    autoplay: false,
    hidden: false,
    srcObject: null,
    play: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn(),
  };
  const getUserMedia = options.getUserMediaError
    ? vi.fn().mockRejectedValue(options.getUserMediaError)
    : vi.fn(async () => createStream().stream);
  const responseOk = options.responseOk ?? true;

  return {
    peers,
    streams,
    audioContexts,
    audioSources,
    createStream,
    capabilities: {
      mediaDevices: { getUserMedia },
      PeerConnection,
      document: {
        createElement: vi.fn(() => audio),
        body: { appendChild: vi.fn() },
      },
      fetch: vi.fn(async () => ({
        ok: responseOk,
        status: responseOk ? 200 : 502,
        text: async () => "answer",
      })),
      AudioContext: TestAudioContext,
    },
  };
}

class FakePeer {
  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: ((event: Event) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  readonly channel = new FakeChannel();
  close = vi.fn();
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "offer" }) as RTCSessionDescriptionInit);
  setLocalDescription = vi.fn(async () => undefined);
  setRemoteDescription = vi.fn(async () => undefined);
  createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel);

  open(): void {
    this.channel.open();
  }

  changeConnectionState(state: "disconnected" | "failed"): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
  }

  emitTrack(stream: MediaStream): void {
    this.ontrack?.({ streams: [stream] } as RTCTrackEvent);
  }

  message(data: unknown): void {
    this.channel.message(JSON.stringify(data));
  }
}

class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = "closed";
  });
  send = vi.fn();

  open(): void {
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }

  message(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function optionsWithBrowser(
  browser: FakeBrowser,
  overrides: Partial<RealtimeVoiceDriverOptions> = {},
): RealtimeVoiceDriverOptions {
  return {
    getSession: async () => ({ clientSecret: "ephemeral" }),
    ...overrides,
    __internal: {
      browserCapabilities: () => browser.capabilities,
    },
  } as RealtimeVoiceDriverOptions;
}

function errorMessages(events: VoiceDriverEvent[]): string[] {
  return events.flatMap((event) => event.type === "error" ? [event.error.message] : []);
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
