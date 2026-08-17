// @vitest-environment jsdom
/**
 * H2-E / #1372 — a forbidden refusal is a full stop for the poll, not a
 * transient to retry. On a preset-authed deployment every wire read for a
 * signed-out visitor correctly 403s; the chrome's job is to stop asking, hold
 * quiet through tab switches, and wake on the page's identity signal.
 */
import { VendoError } from "@vendoai/core";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { IDENTITY_CHANGED_EVENT } from "../src/hooks/identity-state.js";
import { useResource } from "../src/hooks/use-resource.js";

const CADENCE_MS = 20;
const WINDOW_MS = 200;
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function Probe({ fetcher }: { fetcher: () => Promise<string> }) {
  const { error } = useResource(fetcher, "", { pollMs: CADENCE_MS });
  return <span data-testid="err">{error?.message ?? ""}</span>;
}

afterEach(cleanup);

describe("useResource under a forbidden wire", () => {
  it("stops polling after the first forbidden refusal, and a tab switch does not resurrect it", async () => {
    let calls = 0;
    const fetcher = async (): Promise<string> => {
      calls += 1;
      throw new VendoError("forbidden", "no identity for this request");
    };
    const view = render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(view.getByTestId("err").textContent).toContain("no identity"));
    // One refusal is the whole story: a full window of cadences passes with no
    // second ask (the field failure was endless 403 retries).
    const after = calls;
    await settle(WINDOW_MS);
    expect(calls).toBe(after);
    // A tab switch is not a sign-in.
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(WINDOW_MS);
    expect(calls).toBe(after);
  });

  it("any other failure keeps the cadence — forbidden is the only full stop", async () => {
    let calls = 0;
    const fetcher = async (): Promise<string> => {
      calls += 1;
      throw new Error("upstream 500");
    };
    render(<Probe fetcher={fetcher} />);
    await settle(WINDOW_MS);
    expect(calls).toBeGreaterThan(2);
  });

  it("wakes on the page's identity signal and heals on the first success", async () => {
    let signedIn = false;
    let calls = 0;
    const fetcher = async (): Promise<string> => {
      calls += 1;
      if (!signedIn) throw new VendoError("forbidden", "no identity for this request");
      return "rows";
    };
    const view = render(<Probe fetcher={fetcher} />);
    await waitFor(() => expect(view.getByTestId("err").textContent).toContain("no identity"));
    const latched = calls;
    await settle(WINDOW_MS);
    expect(calls).toBe(latched);
    // The host announces a sign-in; the poll re-reads immediately and resumes.
    signedIn = true;
    window.dispatchEvent(new Event(IDENTITY_CHANGED_EVENT));
    await waitFor(() => expect(view.getByTestId("err").textContent).toBe(""));
    await settle(WINDOW_MS);
    expect(calls).toBeGreaterThan(latched + 1);
  });
});
