// Stick-to-bottom is the only writer of the message list's scrollTop. Browser
// scroll anchoring is a second one: mid-reply the transcript shrinks (a
// settling step folds its rail away) while the tail grows, and anchoring moves
// scrollTop by a different amount than the height changed. The reader, who
// touched nothing, lands a few pixels off the bottom — measured at 33px against
// the hook's 32px slack — and the hook can only read that as a scroll-away, so
// the stick releases mid-stream and never re-arms. jsdom implements no scroll
// anchoring at all, so the opt-out is asserted where it lives.
import { describe, expect, it } from "vitest";
import { CHROME_CSS } from "../../src/chrome/chrome-css.js";

describe("the message list opts out of browser scroll anchoring", () => {
  it("declares overflow-anchor: none on .fl-msglist", () => {
    const rule = /^\.fl-msglist \{[\s\S]*?\}/m.exec(CHROME_CSS)?.[0];
    expect(rule, ".fl-msglist rule not found").toBeTruthy();
    expect(rule).toContain("overflow-anchor: none");
  });
});
