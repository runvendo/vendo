// @vitest-environment jsdom
/**
 * Pane contract: TamboPane renders the adapter's component picks through our
 * harness registry and always carries its asymmetry footnote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import TamboPane from "./TamboPane";
import type { TamboRaw, TamboThreadLike } from "../../lanes/tambo";
import type { HostFixture, LaneResult } from "../../runner/types";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "lanes", "__fixtures__", "tambo.recorded.json"), "utf8"),
) as { thread: TamboThreadLike };

const host: HostFixture = {
  name: "maple",
  catalog: {},
  tools: [],
  shapes: {},
  theme: {},
  execute: async () => ({}),
};

const raw: TamboRaw = {
  thread: fixture.thread,
  text: "Here are your account balances at a glance.",
  components: [
    {
      name: "chart",
      props: {
        title: "Account balances",
        data: [
          { label: "Everyday Checking", value: 4280.12 },
          { label: "High-Yield Savings", value: 12904.55 },
        ],
      },
    },
  ],
};

const okResult: LaneResult = { status: "ok", startedAt: 0, durationMs: 1500, raw };

afterEach(cleanup);

describe("TamboPane", () => {
  it("renders component picks through the harness registry with the asymmetry footnote", () => {
    const { container } = render(<TamboPane lane="tambo" result={okResult} host={host} />);
    expect(container.querySelector('[data-harness="chart"]')).toBeTruthy();
    expect(screen.getByText("Account balances")).toBeTruthy();
    expect(screen.getByText("High-Yield Savings")).toBeTruthy();
    expect(screen.getByText(/registered-components paradigm/)).toBeTruthy();
  });

  it("renders the no-key state", () => {
    render(<TamboPane lane="tambo" result={{ status: "no-key" }} host={host} />);
    expect(screen.getByText(/no key/)).toBeTruthy();
  });

  it("renders the failed state", () => {
    render(
      <TamboPane
        lane="tambo"
        result={{ status: "failed", startedAt: 0, durationMs: 5, error: "service down" }}
        host={host}
      />,
    );
    expect(screen.getByText(/failed: service down/)).toBeTruthy();
  });
});
