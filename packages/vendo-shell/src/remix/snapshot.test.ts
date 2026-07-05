import { describe, expect, it } from "vitest";
import { snapshotElement, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_DEPTH } from "./snapshot";

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

describe("snapshotElement", () => {
  it("keeps tags, class, role, aria-*, visible text, and table structure", () => {
    const snap = snapshotElement(
      el(
        `<div class="invoices" role="table" aria-label="Outstanding invoices">
          <table><tbody><tr><td>Acme</td><td>$1,200</td></tr></tbody></table>
        </div>`,
      ),
    );
    expect(snap).toContain('<div class="invoices" role="table" aria-label="Outstanding invoices">');
    expect(snap).toContain("<table>");
    expect(snap).toContain("<td>Acme</td>");
    expect(snap).toContain("$1,200");
  });

  it("drops input values, data-* attributes, and inline handlers", () => {
    const snap = snapshotElement(
      el(
        `<form data-secret="s3cret" onclick="steal()">
          <input type="text" value="hunter2"><textarea>drafted text</textarea>
          <select><option selected>choice</option></select>
        </form>`,
      ),
    );
    expect(snap).not.toContain("hunter2");
    expect(snap).not.toContain("s3cret");
    expect(snap).not.toContain("data-secret");
    expect(snap).not.toContain("steal");
    expect(snap).not.toContain("drafted text");
    expect(snap).toContain("<input");
  });

  it("drops hidden elements and script/style/iframe subtrees", () => {
    const snap = snapshotElement(
      el(
        `<div>
          <span style="display:none">invisible</span>
          <span hidden>also invisible</span>
          <span aria-hidden="true">assistive-hidden</span>
          <script>evil()</script><style>.x{}</style><iframe src="x"></iframe>
          <span>visible</span>
        </div>`,
      ),
    );
    expect(snap).not.toContain("invisible");
    expect(snap).not.toContain("assistive-hidden");
    expect(snap).not.toContain("evil");
    expect(snap).not.toContain("iframe");
    expect(snap).toContain("visible");
  });

  it("truncates beyond the depth cap with a visible marker", () => {
    let html = "leaf";
    for (let i = 0; i < SNAPSHOT_MAX_DEPTH + 3; i++) html = `<div>${html}</div>`;
    const snap = snapshotElement(el(html));
    expect(snap).toContain("…");
    expect(snap).not.toContain("leaf");
  });

  it("caps total size with a truncation marker the agent can see", () => {
    const wide = `<div>${"<p>row of text content here</p>".repeat(4000)}</div>`;
    const snap = snapshotElement(el(wide));
    expect(snap.length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES + 100);
    expect(snap).toContain("[truncated]");
  });
});
