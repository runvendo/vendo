/**
 * Spec §10 — every harness shares ONE file model. A sandboxed harness already
 * materialises whatever the workspace says the caller can see, so a conversation's
 * files and a staged drop reach a box with no code here at all. This test is the
 * DECISION, pinned: staging is deliberately NOT excluded the way `scratch` is,
 * because a staged file is the file the user just handed the agent, and the turn
 * sweeps it anyway.
 *
 * `SCRATCH` gates PERSISTENCE, not the checkout (materialize.ts:186,205): every
 * in-mount path reaches the disk — the agent needs its scratch directory to
 * exist — and scratch alone is barred from syncing home. So the decision shows up
 * in the baseline, which is where "never-persisted junk" actually means something.
 */
import { describe, expect, it } from "vitest";
import { checkoutWorkspace, emptyTree } from "../src/materialize.js";
import { testWorkspace } from "../src/test-doubles.test-util.js";

describe("what reaches a machine's disk", () => {
  it("carries a thread's files and a staged drop, and still drops scratch", async () => {
    const workspace = testWorkspace({
      "/user/threads/thr_1/files/ledger.csv": "jan,31000\n",
      "/user/uploads/9f2a1c04-report.pdf": "%PDF-1.4\n",
      "/user/files/kept.csv": "feb,39000\n",
      "/user/scratch/junk.txt": "throwaway\n",
    });

    const tree = emptyTree();
    const laid = await checkoutWorkspace(workspace, tree, true);
    const paths = laid.files.map((file) => file.path);

    // Nothing is excluded from the disk itself — the frozen line.
    expect(paths).toContain("/user/threads/thr_1/files/ledger.csv");
    expect(paths).toContain("/user/uploads/9f2a1c04-report.pdf");
    expect(paths).toContain("/user/files/kept.csv");
    expect(paths).toContain("/user/scratch/junk.txt");

    // And the decision: a staged drop persists home like any real file, while
    // scratch — and only scratch — is barred from ever coming back.
    expect([...tree.hashes.keys()]).toContain("/user/uploads/9f2a1c04-report.pdf");
    expect([...tree.hashes.keys()]).toContain("/user/threads/thr_1/files/ledger.csv");
    expect([...tree.hashes.keys()]).toContain("/user/files/kept.csv");
    expect([...tree.hashes.keys()]).not.toContain("/user/scratch/junk.txt");
  });
});
