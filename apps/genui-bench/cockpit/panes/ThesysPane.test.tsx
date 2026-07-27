// @vitest-environment jsdom
/**
 * Pane contract: ThesysPane renders each LaneResult status, feeding the
 * recorded-fixture C1 DSL into their real SDK renderer, and always carries
 * its asymmetry footnote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ThesysPane from "./ThesysPane";
import type { LaneResult } from "../../runner/types";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "lanes", "__fixtures__", "thesys-c1.recorded.json"), "utf8"),
) as { finalCompletion: { choices: Array<{ message: { content: string } }> } };


const okResult: LaneResult = {
  status: "ok",
  startedAt: 0,
  durationMs: 1200,
  raw: {
    model: "c1/anthropic/claude-sonnet-4/v-20251230",
    c1Response: fixture.finalCompletion.choices[0].message.content,
    messages: [],
  },
};

afterEach(cleanup);

describe("ThesysPane", () => {
  it("renders the fixture C1 response through their SDK with the asymmetry footnote", () => {
    const { container } = render(<ThesysPane lane="thesys-c1" result={okResult} host="maple" runId="run_test" />);
    expect(container.querySelector('[data-pane="thesys-c1"]')).toBeTruthy();
    expect(screen.getByText(/their renderer\/theme · same prompt \+ tools/)).toBeTruthy();
  });

  it("renders the no-key state", () => {
    render(<ThesysPane lane="thesys-c1" result={{ status: "no-key" }} host="maple" runId="run_test" />);
    expect(screen.getByText(/no key/)).toBeTruthy();
  });

  it("renders the failed state with the error", () => {
    render(
      <ThesysPane
        lane="thesys-c1"
        result={{ status: "failed", startedAt: 0, durationMs: 10, error: "api down" }}
        host="maple"
        runId="run_test"
      />,
    );
    expect(screen.getByText(/failed: api down/)).toBeTruthy();
  });
});
