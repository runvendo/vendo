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


const MODEL = "c1/anthropic/claude-sonnet-4.6/v-20260331";

const okResult: LaneResult = {
  status: "ok",
  startedAt: 0,
  durationMs: 1200,
  raw: {
    model: MODEL,
    c1Response: fixture.finalCompletion.choices[0].message.content,
    messages: [],
  },
};

afterEach(cleanup);

describe("ThesysPane", () => {
  it("renders the recorded live C1 response through their SDK with the asymmetry footnote", () => {
    const { container } = render(<ThesysPane lane="thesys-c1" result={okResult} host="maple" runId="run_test" />);
    expect(container.querySelector('[data-pane="thesys-c1"]')).toBeTruthy();
    // The footnote names the model that produced the pane (C1 is multi-provider).
    expect(screen.getByText(new RegExp(`their renderer/theme · same prompt \\+ tools · ${MODEL}`))).toBeTruthy();
    // Their SDK parsed the `<content … version="2">` envelope and rendered the
    // openui-lang program: the generated header text is on screen.
    expect(screen.getByText("Account Balances")).toBeTruthy();
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
