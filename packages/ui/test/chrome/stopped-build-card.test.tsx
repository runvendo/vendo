// @vitest-environment jsdom
/**
 * A turn STOPPED mid-build, through the real ThreadMessage path.
 *
 * THE DEFECT this exists for: `thread.stop()` does not reconcile the aborted
 * call, so a `vendo_make` left in `input-available` keeps the turn-level
 * `pending` true forever (message.tsx says so in as many words). The forming
 * card keyed on that, so "Building your view…" and its sweeping hairline ran
 * on for good over a turn that was over — and §8 build calm is a claim about
 * the settled turn too.
 *
 * It is asserted HERE rather than on ThreadPart, because ThreadPart takes the
 * turn's liveness as a prop: handing it the right answer directly proves
 * nothing about the turn state it is actually given.
 */
import { cleanup, render } from "@testing-library/react";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadMessage } from "../../src/chrome/thread/message.js";
import { VendoProvider } from "../../src/index.js";

afterEach(cleanup);

/** The build call as `stop()` leaves it: on the wire, never reconciled. */
const makeCall = {
  type: "dynamic-tool",
  toolName: "vendo_make",
  toolCallId: "call_make",
  state: "input-available",
  input: { request: "a spending breakdown" },
} as unknown as UIMessage["parts"][number];

function renderTurn(busy: boolean, restored = false) {
  const message = { id: "msg_stop", role: "assistant", parts: [makeCall] } as unknown as UIMessage;
  return render(
    <VendoProvider>
      <ThreadMessage
        message={message}
        restored={restored}
        risks={new Map()}
        busy={busy}
        activeAssistantId={busy ? message.id : undefined}
        lastAssistantId={message.id}
        onEditLast={() => undefined}
        onRegenerateLast={() => undefined}
      />
    </VendoProvider>,
  );
}

describe("a build whose turn was stopped", () => {
  it("forms while the turn is still live", () => {
    renderTurn(true);
    expect(document.querySelector("[data-vendo-app-forming]")).not.toBeNull();
  });

  it("stands the card down once the turn is over", () => {
    renderTurn(false);
    expect(document.querySelector("[data-vendo-app-forming]")).toBeNull();
  });

  // The line is drawn at the turn we WATCHED end, because the parts alone
  // cannot tell an abandoned build from one still running on the server: a
  // reader who reloads mid-build restores exactly this shape, and hiding the
  // card there would say "nothing is happening" while the build runs.
  it("keeps forming on a restored thread, which may still be building", () => {
    renderTurn(false, true);
    expect(document.querySelector("[data-vendo-app-forming]")).not.toBeNull();
  });
});
