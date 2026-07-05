import { describe, it, expect, afterEach } from "vitest";
import { postToSlack } from "./slack";

const savedKey = process.env.COMPOSIO_API_KEY;
const savedFlag = process.env.VENDO_STAGE_FALLBACK;

afterEach(() => {
  if (savedKey === undefined) delete process.env.COMPOSIO_API_KEY;
  else process.env.COMPOSIO_API_KEY = savedKey;
  if (savedFlag === undefined) delete process.env.VENDO_STAGE_FALLBACK;
  else process.env.VENDO_STAGE_FALLBACK = savedFlag;
});

describe("postToSlack fallback gating", () => {
  it("reports failure truthfully when no API key and the stage flag is unset", async () => {
    delete process.env.COMPOSIO_API_KEY;
    delete process.env.VENDO_STAGE_FALLBACK;
    const res = await postToSlack("#general", "hi");
    expect(res.ok).toBe(false);
    expect(res.fallback).toBe(false);
  });

  it("fakes a fallback 'success' when the stage flag is set", async () => {
    delete process.env.COMPOSIO_API_KEY;
    process.env.VENDO_STAGE_FALLBACK = "1";
    const res = await postToSlack("#general", "hi");
    expect(res.ok).toBe(false);
    expect(res.fallback).toBe(true);
  });
});
