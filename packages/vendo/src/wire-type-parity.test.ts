import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const file of fixtures.splice(0)) rmSync(file, { force: true });
});

function typecheckFixture(source: string): string | null {
  const fixture = join(packageDir, `.wire-parity.${process.pid}.${Math.random().toString(36).slice(2)}.ts`);
  const config = fixture.replace(/\.ts$/, ".json");
  fixtures.push(fixture, config);
  writeFileSync(fixture, source);
  writeFileSync(config, JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: ".",
      // ui and agent intentionally expose `ai` as a peer. Force the same host
      // copy for both declarations, matching consumer resolution rather than
      // comparing their independently installed development copies.
      paths: { ai: ["./node_modules/ai"] },
    },
    files: [basename(fixture)],
  }));
  try {
    execFileSync(
      process.execPath,
      [tsc, "--project", config, "--noEmit"],
      { cwd: packageDir, stdio: "pipe" },
    );
    return null;
  } catch (error) {
    const result = error as { stdout?: Buffer; stderr?: Buffer };
    return `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
  }
}

// The repository gate runs `pnpm build` before `pnpm test`, so these package
// imports resolve freshly emitted declarations from all four owning packages.
// That keeps the fixture type-only: importing their source roots would make an
// ad-hoc tsc invocation re-check unrelated runtime implementations as well.
const imports = `
import type {
  OpenSurface as UiOpenSurface,
  EditResult as UiEditResult,
  VersionEntry as UiVersionEntry,
  RunStatus as UiRunStatus,
  RunRecord as UiRunRecord,
  RunPlan as UiRunPlan,
  AutomationEntry as UiAutomationEntry,
  EnableResult as UiEnableResult,
  Thread as UiThread,
  ThreadSummary as UiThreadSummary,
  InClientVenue as UiInClientVenue,
  ShipDiff as UiShipDiff,
  PinDrift as UiPinDrift,
  PinRebaseResult as UiPinRebaseResult,
} from "@vendoai/ui";
import type {
  OpenSurface as AppsOpenSurface,
  EditResult as AppsEditResult,
  VersionEntry as AppsVersionEntry,
  InClientVenueState as AppsInClientVenueState,
  ShipDiff as AppsShipDiff,
  PinDrift as AppsPinDrift,
  PinRebaseResult as AppsPinRebaseResult,
} from "@vendoai/apps";
import type {
  AutomationsEngine,
  RunStatus as AutomationsRunStatus,
  RunRecord as AutomationsRunRecord,
  RunPlan as AutomationsRunPlan,
} from "@vendoai/automations";
import type {
  Thread as AgentThread,
  ThreadSummary as AgentThreadSummary,
} from "@vendoai/agent";

type AutomationsEntry = Awaited<ReturnType<AutomationsEngine["list"]>>[number];
type AutomationsEnableResult = Awaited<ReturnType<AutomationsEngine["enable"]>>;
type Assignable<Source, Target> = [Source] extends [Target] ? true : false;
type Assert<T extends true> = T;
`;

describe("UI wire types stay structurally aligned with their owning blocks", () => {
  it("is assignable both ways for apps, automations, and agent responses", () => {
    const failure = typecheckFixture(`${imports}
type Checks = [
  Assert<Assignable<UiOpenSurface, AppsOpenSurface>>,
  Assert<Assignable<AppsOpenSurface, UiOpenSurface>>,
  Assert<Assignable<UiEditResult, AppsEditResult>>,
  Assert<Assignable<AppsEditResult, UiEditResult>>,
  Assert<Assignable<UiVersionEntry, AppsVersionEntry>>,
  Assert<Assignable<AppsVersionEntry, UiVersionEntry>>,
  Assert<Assignable<UiInClientVenue, AppsInClientVenueState>>,
  Assert<Assignable<AppsInClientVenueState, UiInClientVenue>>,
  Assert<Assignable<UiShipDiff, AppsShipDiff>>,
  Assert<Assignable<AppsShipDiff, UiShipDiff>>,
  Assert<Assignable<UiPinDrift, AppsPinDrift>>,
  Assert<Assignable<AppsPinDrift, UiPinDrift>>,
  Assert<Assignable<UiPinRebaseResult, AppsPinRebaseResult>>,
  Assert<Assignable<AppsPinRebaseResult, UiPinRebaseResult>>,
  Assert<Assignable<UiRunStatus, AutomationsRunStatus>>,
  Assert<Assignable<AutomationsRunStatus, UiRunStatus>>,
  Assert<Assignable<UiRunRecord, AutomationsRunRecord>>,
  Assert<Assignable<AutomationsRunRecord, UiRunRecord>>,
  Assert<Assignable<UiRunPlan, AutomationsRunPlan>>,
  Assert<Assignable<AutomationsRunPlan, UiRunPlan>>,
  Assert<Assignable<UiAutomationEntry, AutomationsEntry>>,
  Assert<Assignable<AutomationsEntry, UiAutomationEntry>>,
  Assert<Assignable<UiEnableResult, AutomationsEnableResult>>,
  Assert<Assignable<AutomationsEnableResult, UiEnableResult>>,
  Assert<Assignable<UiThread, AgentThread>>,
  Assert<Assignable<AgentThread, UiThread>>,
  Assert<Assignable<UiThreadSummary, AgentThreadSummary>>,
  Assert<Assignable<AgentThreadSummary, UiThreadSummary>>,
];
declare const checks: Checks;
void checks;
`);
    expect(failure, failure ?? "").toBeNull();
  });

  it("has teeth: a one-way incompatible wire shape fails the tsc gate", () => {
    const failure = typecheckFixture(`${imports}
type Broken = Assert<Assignable<UiThread, { definitelyNotOnTheWire: string }>>;
declare const broken: Broken;
void broken;
`);
    expect(failure).not.toBeNull();
    expect(failure).toContain("TS2344");
  });
});
