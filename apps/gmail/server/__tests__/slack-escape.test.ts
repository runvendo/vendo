/**
 * JSON-repair middleware moved to @flowlet/runtime (engine wraps every model);
 * its tests moved with it. What remains here is the colocated Slack
 * markup-injection defense, which is gmail-specific.
 */
import { describe, expect, it } from "vitest";
import { escapeSlackText } from "../flowlet/slack";

describe("escapeSlackText", () => {
  it("neutralizes mentions and links from untrusted email content", () => {
    expect(escapeSlackText("Subject <!channel> & <http://evil|click>")).toBe(
      "Subject &lt;!channel&gt; &amp; &lt;http://evil|click&gt;",
    );
  });
  it("leaves ordinary text untouched", () => {
    expect(escapeSlackText("PR #482 merged — all checks passed")).toBe(
      "PR #482 merged — all checks passed",
    );
  });
});
