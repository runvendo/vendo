import { sandboxAdapterConformance } from "../adapter-conformance.js";
import type { SandboxConformanceHarness } from "../adapter-conformance.js";
import { FakeSandboxMachine, fakeSandbox, type MachineApp } from "./fake-sandbox.js";

const encoder = new TextEncoder();

/** The conformance app contract, in-process: env from ctx, egress simulated
    with the fake's provider-faithful allowlist rule. */
const conformanceApp: MachineApp = (request, ctx) => {
  const env = /^\/conformance\/env\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(request.path);
  if (env?.[1] !== undefined) {
    return { status: 200, headers: {}, body: ctx.env[env[1]] ?? "" };
  }
  const egress = /^\/conformance\/egress\/(.+)$/.exec(request.path);
  if (egress?.[1] !== undefined) {
    const host = decodeURIComponent(egress[1]);
    const allowed = ctx.allowedDomains === undefined || ctx.allowedDomains.some((rule) =>
      rule === host || (rule.startsWith("*.") && host.endsWith(rule.slice(1))));
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed }),
    };
  }
  if (request.method.toUpperCase() === "POST" && request.path === "/fn/echo") {
    return {
      status: 200,
      headers: {},
      body: request.body === undefined
        ? new Uint8Array()
        : typeof request.body === "string" ? encoder.encode(request.body) : request.body,
    };
  }
  return { status: 404, headers: {}, body: "" };
};

const harness: SandboxConformanceHarness = {
  makeAdapter: () => fakeSandbox(),
  async bootstrap(machine) {
    if (!(machine instanceof FakeSandboxMachine)) throw new Error("fake harness got a non-fake machine");
    machine.setApp(conformanceApp);
  },
  enforcesAllowedDomains: true,
};

sandboxAdapterConformance("fake", harness);
