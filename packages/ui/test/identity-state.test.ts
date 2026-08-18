// @vitest-environment jsdom
/**
 * The latch's epoch rule (greptile on #1445): a refusal is evidence about the
 * moment its request BEGAN. Any open signal since — the page's identity event
 * or a successful read — makes it stale, and stale refusals must not re-close
 * the latch (the field shape: an in-flight warm's 403 landing after sign-in
 * un-rendered the composer for a signed-in visitor).
 */
import { VendoError } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { IDENTITY_CHANGED_EVENT, identityState } from "../src/hooks/identity-state.js";

const refusal = () => new VendoError("forbidden", "no identity for this request");

describe("the identity latch's epoch", () => {
  it("ignores a refusal from before the identity event, and honors a current one", () => {
    const state = identityState({});
    const before = state.epoch();
    // Sign-in lands while the refused request is still in flight…
    window.dispatchEvent(new Event(IDENTITY_CHANGED_EVENT));
    state.note(refusal(), before);
    expect(state.forbidden()).toBe(false);
    // …but a refusal issued in the CURRENT epoch closes the latch as ever.
    state.note(refusal(), state.epoch());
    expect(state.forbidden()).toBe(true);
  });

  it("a successful read is an open signal too — it stales the refusals in flight beside it", () => {
    const state = identityState({});
    const before = state.epoch();
    state.clear();
    state.note(refusal(), before);
    expect(state.forbidden()).toBe(false);
  });

  it("an unstamped note still latches — pollers with their own generation guards need no epoch", () => {
    const state = identityState({});
    state.note(refusal());
    expect(state.forbidden()).toBe(true);
  });
});
