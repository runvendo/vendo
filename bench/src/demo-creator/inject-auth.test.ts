import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AUTOLOGIN_GATE_SOURCE, renderMiddleware } from "./inject-auth.js";

/**
 * The host-binding gate is the whole security story of demo auto-login: with
 * DEMO_AUTOLOGIN=1 a request that satisfies it is signed in with no password.
 * These import the SHIPPED source string (written verbatim to a module, never
 * a hand-copy), so the matrix covers exactly what every generated clone runs —
 * the same matrix the proven apps/demo-bank/src/server/autologin.ts is held to.
 */
type Gate = (request: { headers: Headers }, env: Record<string, string | undefined>) => boolean;

let demoAutologinActive: Gate;

beforeAll(async () => {
  // The gate ships as TypeScript (it is emitted into a .ts middleware), so
  // strip the types the same way the app's build does, then import the result
  // as a real module — no eval, and still the exact shipped source.
  const { transform } = await import("esbuild");
  const { code } = await transform(
    `${AUTOLOGIN_GATE_SOURCE}\nexport { demoAutologinActive };\n`,
    { loader: "ts", format: "esm" },
  );
  const dir = await mkdtemp(path.join(tmpdir(), "autologin-gate-"));
  const file = path.join(dir, "gate.mjs");
  await writeFile(file, code);
  ({ demoAutologinActive } = (await import(pathToFileURL(file).href)) as { demoAutologinActive: Gate });
});

/** The gate's decision is stateless (only its once-per-process warning log is
 *  not), so one instance serves every case. */
const gate = (): Gate => demoAutologinActive;

const ON = { DEMO_AUTOLOGIN: "1", VENDO_BASE_URL: "https://demos.vendo.run" };
const req = (headers: HeadersInit): { headers: Headers } => ({ headers: new Headers(headers) });

describe("demo auto-login host gate", () => {
  it("signs in on the configured demo origin", () => {
    expect(gate()(req({ host: "demos.vendo.run" }), ON)).toBe(true);
  });

  it("stays off unless DEMO_AUTOLOGIN is exactly 1", () => {
    for (const flag of [undefined, "", "0", "true", "yes"]) {
      expect(gate()(req({ host: "demos.vendo.run" }), { ...ON, DEMO_AUTOLOGIN: flag })).toBe(false);
    }
  });

  it("fails closed with no configured origin — no loopback exception", () => {
    expect(gate()(req({ host: "127.0.0.1:3000" }), { DEMO_AUTOLOGIN: "1" })).toBe(false);
    expect(gate()(req({ host: "127.0.0.1:3000" }), { DEMO_AUTOLOGIN: "1", VENDO_BASE_URL: "" })).toBe(false);
    expect(gate()(req({ host: "x" }), { DEMO_AUTOLOGIN: "1", VENDO_BASE_URL: "not a url" })).toBe(false);
  });

  it("never signs in for a foreign Host", () => {
    expect(gate()(req({ host: "victim.example" }), ON)).toBe(false);
  });

  it("never signs in with no Host header at all", () => {
    expect(gate()(req({}), ON)).toBe(false);
  });

  it("rejects malformed authorities a URL parser would smuggle the demo host through", () => {
    const smuggled = [
      "victim.example@demos.vendo.run", // userinfo — URL.host would be the demo host
      "demos.vendo.run#victim.example", // fragment — discarded by a URL parser
      "demos.vendo.run/victim.example", // path — discarded by a URL parser
      "demos.vendo.run?victim.example", // query — discarded by a URL parser
      "demos.vendo.run@victim.example", // demo host in the userinfo position
      "demos.vendo.run\tx", // embedded whitespace
      "demos.vendo.run x",
      "[demos.vendo.run]", // brackets
      "demos.vendo.run:443:443", // double colon
      "demos..vendo.run", // empty label
      ".demos.vendo.run", // leading dot ⇒ empty label
      "demos.vendo.run:99999", // port out of range
    ];
    for (const host of smuggled) {
      expect(gate()(req({ host }), ON), `Host: ${JSON.stringify(host)}`).toBe(false);
    }
  });

  it("refuses an ambiguous Host instead of guessing which value routed", () => {
    const duplicate = req([
      ["host", "demos.vendo.run"],
      ["host", "victim.example"],
    ]);
    // Headers collapses duplicates with ", " — exactly what a smuggled second
    // Host looks like, and what must never be picked apart.
    expect(duplicate.headers.get("host")).toContain(",");
    expect(gate()(duplicate, ON)).toBe(false);
  });

  it("requires X-Forwarded-Host to agree with Host when the edge sets it", () => {
    // Agreement (what Railway's edge actually sends) ⇒ signs in.
    expect(gate()(req({ host: "demos.vendo.run", "x-forwarded-host": "DEMOS.VENDO.RUN:443" }), ON)).toBe(true);
    // Disagreement ⇒ refuses, even though Host alone is the demo origin.
    expect(gate()(req({ host: "demos.vendo.run", "x-forwarded-host": "victim.example" }), ON)).toBe(false);
    // Ambiguous XFH ⇒ refuses.
    const ambiguous = req([
      ["host", "demos.vendo.run"],
      ["x-forwarded-host", "demos.vendo.run"],
      ["x-forwarded-host", "victim.example"],
    ]);
    expect(gate()(ambiguous, ON)).toBe(false);
  });

  it("normalizes case and the scheme's default port on both sides", () => {
    for (const host of ["DEMOS.VENDO.RUN", "demos.vendo.run:443", "Demos.Vendo.Run:443"]) {
      expect(gate()(req({ host }), ON), host).toBe(true);
    }
    // A non-default port is a DIFFERENT origin.
    expect(gate()(req({ host: "demos.vendo.run:8443" }), ON)).toBe(false);
  });

  it("binds to a non-default port when the configured origin carries one", () => {
    const local = { DEMO_AUTOLOGIN: "1", VENDO_BASE_URL: "http://127.0.0.1:4300" };
    expect(gate()(req({ host: "127.0.0.1:4300" }), local)).toBe(true);
    expect(gate()(req({ host: "127.0.0.1" }), local)).toBe(false);
    expect(gate()(req({ host: "127.0.0.1:4301" }), local)).toBe(false);
  });
});

describe("generated middleware", () => {
  const source = renderMiddleware();

  it("signs in by setting the demo cookie and continuing, never redirecting", () => {
    expect(source).toContain("demoAutologinActive(request)");
    expect(source).toContain('response.cookies.set("vendo_demo_auth", "ok"');
  });

  it("keeps /login reachable and keeps the redirect for every other origin", () => {
    expect(source).toContain('"/login"');
    expect(source).toContain("NextResponse.redirect(login)");
  });
});
