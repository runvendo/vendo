/**
 * The Cloud gateway serves the vendo family as LITERAL ids and 400s anything
 * else, so every env var the Agent SDK can read a model id from has to name one.
 *
 * Pinning only `ANTHROPIC_MODEL` left every OTHER slot on the SDK's built-in
 * `claude-*` defaults. Observed live in a cloud-sandbox proof: a step that used
 * a different slot asked the gateway for `claude-opus-4-8`, and the gateway's
 * `400 Unknown model id` was printed raw into the end user's chat.
 *
 * The slot list is the SDK's OWN, not a guess — `sdk.mjs` in
 * `@anthropic-ai/claude-agent-sdk@0.3.214` carries a model-env array (`_Ne`)
 * whose model-VALUE entries are exactly these seven; its siblings in that array
 * are `_NAME` / `_DESCRIPTION` / `_SUPPORTED_CAPABILITIES` display metadata and
 * `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION`, none of which name a model to ask for.
 */
import { describe, expect, test } from "vitest";
import { inferenceEnv } from "../../src/claude-code/index.js";

/** Every env var the SDK reads a MODEL ID from. */
const MODEL_SLOTS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

/** Pin the process env for one read — `inferenceEnv()` reads it directly. */
const withEnv = (vars: Record<string, string | undefined>): Record<string, string> => {
  const source = globalThis.process.env as Record<string, string | undefined>;
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, source[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete source[key];
    else source[key] = value;
  }
  try {
    return inferenceEnv();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete source[key];
      else source[key] = value;
    }
  }
};

const CLOUD_RUNG = {
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_BASE_URL: undefined,
  VENDO_INFERENCE_KEY: undefined,
  VENDO_INFERENCE_URL: undefined,
  VENDO_API_KEY: "vnd-key",
  VENDO_CLOUD_URL: undefined,
};

describe("the box's model slots — every one the SDK reads, not just the default", () => {
  test("the Cloud rung pins EVERY slot to the gateway's family id", () => {
    const env = withEnv(CLOUD_RUNG);
    // Not `toContain`-style: a slot left out is a slot that falls back to a
    // `claude-*` id this gateway answers with 400.
    for (const slot of MODEL_SLOTS) expect(env[slot]).toBe("vendo");
  });

  test("a host that named its OWN endpoint gets no slot pinned at all", () => {
    // The explicit pair is the host choosing where inference goes, and their
    // endpoint serves their own ids — pinning `vendo` into it would break a
    // deployment that is not on the Cloud gateway. The same reasoning the
    // existing `ANTHROPIC_MODEL` pin already follows.
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: "gw-key",
      VENDO_INFERENCE_URL: "https://gateway.example/v1",
      VENDO_API_KEY: "vnd-key",
    });
    for (const slot of MODEL_SLOTS) expect(env[slot]).toBeUndefined();
  });

  test("no inference credential at all pins nothing — there is no gateway to name", () => {
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      VENDO_API_KEY: undefined,
      VENDO_CLOUD_URL: undefined,
    });
    for (const slot of MODEL_SLOTS) expect(env[slot]).toBeUndefined();
  });

  test("a whitespace-only credential is no credential", () => {
    // A blank line in a `.env` is the same misconfiguration as an empty one, and
    // treating it as a key boots a Cloud-configured box whose every call 401s.
    const env = withEnv({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      VENDO_INFERENCE_KEY: undefined,
      VENDO_INFERENCE_URL: undefined,
      VENDO_API_KEY: "   ",
      VENDO_CLOUD_URL: undefined,
    });
    for (const slot of MODEL_SLOTS) expect(env[slot]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });
});
