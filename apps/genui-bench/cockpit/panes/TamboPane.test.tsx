// @vitest-environment jsdom
/**
 * Pane contract: TamboPane renders the adapter's component picks through our
 * harness registry and always carries its asymmetry footnote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import TamboPane from "./TamboPane";
import { createTamboAdapter, type TamboThreadLike } from "../../lanes/tambo";
import type { HostFixture, LaneResult } from "../../runner/types";
import { stubHostFixture } from "../../fixtures/stub";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "lanes", "__fixtures__", "tambo.recorded.json"), "utf8"),
) as { thread: TamboThreadLike };

const host: HostFixture = stubHostFixture("maple");

/** The pane is proved end to end from the live recording: the real adapter
 *  extracts the recorded thread, the pane renders what it produced. */
let okResult: LaneResult;

beforeAll(async () => {
  process.env.TAMBO_API_KEY = "test-key";
  okResult = await createTamboAdapter({ run: async () => fixture.thread }).generate("balances", host);
  delete process.env.TAMBO_API_KEY;
});

afterEach(cleanup);

describe("TamboPane", () => {
  it("renders component picks through the harness registry with the asymmetry footnote", () => {
    const { container } = render(<TamboPane lane="tambo" result={okResult} host="maple" runId="run_test" />);
    expect(container.querySelector('[data-harness="chart"]')).toBeTruthy();
    expect(screen.getByText("Account balances")).toBeTruthy();
    // Both live picks label the same accounts, hence getAllByText.
    expect(screen.getAllByText("High-Yield Savings (••9917)").length).toBeGreaterThan(0);
    expect(screen.getByText(/registered-components paradigm/)).toBeTruthy();
  });

  it("renders the live table pick whose rows came back index-keyed rather than as arrays", () => {
    const { container } = render(<TamboPane lane="tambo" result={okResult} host="maple" runId="run_test" />);
    const table = container.querySelector('[data-harness="table"]');
    expect(table).toBeTruthy();
    expect(table?.querySelectorAll("tbody tr").length).toBe(3);
    expect(table?.querySelectorAll("tbody tr")[0]?.querySelectorAll("td").length).toBe(3);
    expect(table?.textContent).toContain("Everyday Checking (••4832)");
  });

  it("renders the no-key state", () => {
    render(<TamboPane lane="tambo" result={{ status: "no-key" }} host="maple" runId="run_test" />);
    expect(screen.getByText(/no key/)).toBeTruthy();
  });

  it("renders the failed state", () => {
    render(
      <TamboPane
        lane="tambo"
        result={{ status: "failed", startedAt: 0, durationMs: 5, error: "service down" }}
        host="maple"
        runId="run_test"
      />,
    );
    expect(screen.getByText(/failed: service down/)).toBeTruthy();
  });
});
