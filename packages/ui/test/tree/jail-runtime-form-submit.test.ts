// @vitest-environment jsdom
// Defect 2 regression (unified-try-surface try-venue generation E2E,
// 2026-07-26). Root cause, revised after real-browser verification: the jail
// sandbox carries no allow-forms (JailedComponent.tsx `sandbox="allow-
// scripts"`), and a generated ISLAND frequently writes a raw HTML
// <form onSubmit={handler}> (pretraining habit) whose handler is an async
// function taking no event argument, so it can never call
// event.preventDefault() itself.
//
// A first fix (a document-level capture-phase `submit` listener calling
// preventDefault()) looked right in jsdom and in code review, but browser-
// verified DEAD in the real double-nested jail: Chromium never dispatches a
// cancelable `submit` DOM event at all for an IMPLICIT submission (a click on
// a submit button, or Enter in a field) inside a sandboxed, non-allow-forms
// frame — it logs "Blocked form submission..." and aborts before any JS ever
// sees the event, so no `submit` listener (this module's, React's synthetic
// onSubmit, or the Kit Form's own wrapper) ever runs. jsdom does not model
// this Chromium-specific short-circuit, which is exactly why the old fix's
// jsdom test below passed while the real browser still failed.
//
// Fix: runtime-entry.tsx now intercepts the trigger ONE STEP UPSTREAM of
// `submit` — capture-phase `click` (submit buttons) and `keydown` (Enter in
// a field) — preventDefault()s THAT event, then re-dispatches a plain,
// untrusted `submit` Event at the form. An untrusted event carries no
// browser-native default action, so it safely reaches every ordinary
// `submit` listener (Kit's own, a raw island's, or this module's remaining
// defense-in-depth `submit` capture) exactly as if the browser's own
// submission had fired. These jsdom tests (which dispatch a real click, not
// a synthetic submit) exercise that SAME click-interception path end to end.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

class FakeResizeObserver implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

let postMessage: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
  await import("../../src/tree/jail/runtime-entry.js");
});

beforeEach(() => {
  postMessage.mockClear();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderSource = (source: string, props: Record<string, unknown> = {}) => {
  window.dispatchEvent(new MessageEvent("message", {
    source: window,
    data: { vendo: true, kind: "render", source, props },
  }));
};

describe("jail runtime — click/keydown-intercepted implicit submission", () => {
  it("prevents the native default action for a RAW <form> whose handler takes no event argument, while still running the handler", async () => {
    renderSource(`
      export default function RawForm() {
        const [phase, setPhase] = useState("idle");
        // The exact shape the report found: an async handler with NO event
        // parameter — it structurally cannot call preventDefault() itself.
        const handleSubmit = async () => { setPhase("submitted"); };
        return (
          <form data-raw-form onSubmit={handleSubmit}>
            <button type="submit">Create issue</button>
            <p data-phase>{phase}</p>
          </form>
        );
      }`);
    await vi.waitFor(() => expect(document.querySelector("[data-raw-form]")).toBeTruthy());
    const form = document.querySelector("[data-raw-form]") as HTMLFormElement;

    let observedDefaultPrevented: boolean | undefined;
    // A bubble-phase listener on the form fires AFTER the document's
    // capture-phase listener already ran (capture travels document -> form
    // before the event reaches its target), so this observes the outcome of
    // the fix under test without racing it.
    form.addEventListener("submit", (event) => { observedDefaultPrevented = event.defaultPrevented; });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    (form.querySelector("button") as HTMLButtonElement).click();

    // The model's own onSubmit handler still runs — the fix only suppresses
    // the native default action, it never stops propagation.
    await vi.waitFor(() => expect(document.querySelector("[data-phase]")?.textContent).toBe("submitted"));
    expect(observedDefaultPrevented).toBe(true);
    // jsdom logs "Not implemented: HTMLFormElement.prototype.requestSubmit"
    // when a form's native submission actually proceeds — its absence is
    // direct evidence the sandboxed default action never ran.
    expect(consoleError.mock.calls.some(([message]) => String(message).includes("Not implemented"))).toBe(false);
    consoleError.mockRestore();
  });

  it("also wins the race against the Kit's own <Form> preventDefault, which runs later (React's bubble-phase delegation, after this test's own target-phase check)", async () => {
    renderSource(`
      export default function Wrapped() {
        const [phase, setPhase] = useState("idle");
        return (
          <Form onSubmit={() => setPhase("submitted")} submitLabel="Save">
            <p data-phase>{phase}</p>
          </Form>
        );
      }`);
    await vi.waitFor(() => expect(document.querySelector("[data-kit='Form']")).toBeTruthy());
    const form = document.querySelector("[data-kit='Form']") as HTMLFormElement;
    let observedDefaultPrevented: boolean | undefined;
    form.addEventListener("submit", (event) => { observedDefaultPrevented = event.defaultPrevented; });
    (form.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("[data-phase]")?.textContent).toBe("submitted"));
    expect(observedDefaultPrevented).toBe(true);
  });
});
