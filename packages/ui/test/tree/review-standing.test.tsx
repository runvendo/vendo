// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { VENDO_TREE_FORMAT, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { TreeView } from "../../src/tree/index.js";
import type { InClientVenue } from "../../src/tree/renderer.js";

afterEach(() => cleanup());

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

/** A review-kind payload as the server ships it while unapproved: the venue
 *  says pending-review and NO fork source travels (open() strips it). */
function pendingTree(inClient: InClientVenue): UIPayload {
  const tree: UIPayload & { inClient?: InClientVenue } = {
    formatVersion: VENDO_TREE_FORMAT,
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["fork"] },
      { id: "fork", component: "Widget", source: "generated" },
    ],
  };
  tree.inClient = inClient;
  return tree;
}

describe("review-kind standing (remix final shape 2026-08-02)", () => {
  it("a pending-review payload renders ONLY the sent-for-review standing — no jail, no skeletons", () => {
    render(
      <TreeView
        tree={pendingTree({
          granted: false,
          versionHash: "sha256:pending",
          reason: "pending-review",
          review: { status: "pending", versionHash: "sha256:pending" },
        })}
        components={{}}
        onAction={ok}
      />,
    );
    const notice = screen.getByRole("note", { name: "Sent for review" });
    expect(notice.textContent).toContain("sent to the host for review");
    // Never a jailed fork render, never the drop-back vocabulary.
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("note", { name: "In-client approval invalidated" })).toBeNull();
  });

  it("a rejected standing carries the reviewer's note back to the user", () => {
    render(
      <TreeView
        tree={pendingTree({
          granted: false,
          versionHash: "sha256:rejected",
          reason: "pending-review",
          review: {
            status: "rejected",
            versionHash: "sha256:rejected",
            note: "Keep the original balance label.",
            by: "host_reviewer",
            at: "2026-08-02T10:00:00.000Z",
          },
        })}
        components={{}}
        onAction={ok}
      />,
    );
    const notice = screen.getByRole("note", { name: "Remix rejected" });
    expect(notice.textContent).toContain("Keep the original balance label.");
    expect(notice.textContent).toContain("resubmit");
    expect(document.querySelector("iframe")).toBeNull();
  });
});
