import { describe, expect, it } from "vitest";
import { toolBrief } from "../src/screen-agent.js";

/** A mutating host tool and a read one read identically in the brief until the
 *  grade crosses into it — and `validate` must never carry the mark, because the
 *  brief's own floor instruction tells the writer to call it. */
describe("the tool brief's risk mark", () => {
  const listings = [
    { name: "list_transfers", title: "List", description: "Pending transfers", risk: "read" as const },
    { name: "cancel_transfer", title: "Cancel", description: "Cancels one", risk: "destructive" as const },
    { name: "send_payment", title: "Send", description: "Sends money", risk: "write" as const },
    { name: "reindex", title: "Reindex", description: "Nobody graded this", risk: "ungraded" as const },
    { name: "validate", title: "Validate", description: "The floor", risk: "write" as const },
  ];

  it("marks every mutating host tool and leaves reads and the assembly verbs bare", () => {
    const brief = toolBrief(listings);

    expect(brief).toContain("- cancel_transfer [CHANGES DATA] —");
    expect(brief).toContain("- send_payment [CHANGES DATA] —");
    expect(brief).toContain("- reindex [CHANGES DATA] —");
    expect(brief).toContain("- list_transfers —");
    expect(brief).toContain("- validate —");
  });
});
