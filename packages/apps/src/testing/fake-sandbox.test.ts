import { describe, expect, it } from "vitest";
import { fakeSandbox } from "./fake-sandbox.js";

const decoder = new TextDecoder();

describe("fakeSandbox v2 seam semantics", () => {
  it("creates with template, env, and allowedDomains, all inspectable", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({
      template: "vendo-base",
      env: { PORT: "8080", VALUE: "alpha" },
      allowedDomains: ["api.example.com"],
    });
    expect(machine.template).toBe("vendo-base");
    expect(machine.env).toEqual({ PORT: "8080", VALUE: "alpha" });
    expect(machine.allowedDomains).toEqual(["api.example.com"]);
  });

  it("routes requests to the box $PORT by default and records the port", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({ env: { PORT: "9090" } });
    const response = await machine.request({ method: "GET", path: "/" });
    expect(response.status).toBe(200);
    expect(machine.requests[0]?.port).toBe(9090);
    const explicit = await machine.request({ method: "GET", path: "/", port: 9090 });
    expect(explicit.status).toBe(200);
  });

  it("refuses requests to a port nothing listens on", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({ env: { PORT: "8080" } });
    await expect(machine.request({ method: "GET", path: "/", port: 9999 }))
      .rejects.toThrow(/port 9999/);
  });

  it("dispatches the machine env and egress policy to the app handler", async () => {
    const adapter = fakeSandbox({
      app: (request, ctx) => ({
        status: 200,
        headers: {},
        body: JSON.stringify({ value: ctx.env.VALUE, domains: ctx.allowedDomains }),
      }),
    });
    const machine = await adapter.create({
      env: { PORT: "8080", VALUE: "from-env" },
      allowedDomains: ["one.example"],
    });
    const response = await machine.request({ method: "GET", path: "/" });
    expect(JSON.parse(decoder.decode(response.body))).toEqual({
      value: "from-env",
      domains: ["one.example"],
    });
  });

  it("carries env, policy, and app through snapshot and resume on a fresh adapter", async () => {
    const first = fakeSandbox({
      app: (_request, ctx) => ({ status: 200, headers: {}, body: ctx.env.VALUE ?? "" }),
    });
    const machine = await first.create({
      env: { PORT: "8080", VALUE: "durable" },
      allowedDomains: ["api.example.com"],
    });
    const ref = await machine.snapshot();
    expect(ref).toMatch(/^fake:/);

    const resumed = await fakeSandbox().resume(ref);
    expect(resumed.id).not.toBe(machine.id);
    expect(resumed.env).toEqual({ PORT: "8080", VALUE: "durable" });
    expect(resumed.allowedDomains).toEqual(["api.example.com"]);
    const response = await resumed.request({ method: "GET", path: "/" });
    expect(decoder.decode(response.body)).toBe("durable");
  });

  it("stop() is a sleep: requests refuse but a prior snapshot still resumes", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({ env: { PORT: "8080", VALUE: "asleep" } });
    const ref = await machine.snapshot();
    await machine.stop();
    await machine.stop(); // idempotent
    await expect(machine.request({ method: "GET", path: "/" })).rejects.toThrow(/asleep|stopped/);
    await expect(machine.snapshot()).rejects.toThrow(/asleep|stopped/);
    const resumed = await adapter.resume(ref);
    await expect(resumed.request({ method: "GET", path: "/" })).resolves.toMatchObject({ status: 200 });
  });

  it("destroy() ends the machine for good, including after stop()", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({ env: { PORT: "8080" } });
    const ref = await machine.snapshot();
    await machine.stop();
    await machine.destroy();
    await machine.destroy(); // idempotent
    expect(machine.destroyed).toBe(true);
    await expect(machine.request({ method: "GET", path: "/" })).rejects.toThrow(/destroyed/);
    // previously taken snapshot refs stay valid
    const resumed = await adapter.resume(ref);
    await expect(resumed.request({ method: "GET", path: "/" })).resolves.toMatchObject({ status: 200 });
  });

  it("resuming one snapshot twice yields independent machines", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({ env: { PORT: "8080" } });
    const ref = await machine.snapshot();
    const left = await adapter.resume(ref);
    const right = await adapter.resume(ref);
    expect(left.id).not.toBe(right.id);
    await left.destroy();
    await expect(right.request({ method: "GET", path: "/" })).resolves.toMatchObject({ status: 200 });
  });

  it("rejects an unknown snapshot ref", async () => {
    await expect(fakeSandbox().resume("fake:snap_nope")).rejects.toThrow(/Unknown fake sandbox snapshot/);
  });

  it("keeps the v1 compat surface working: files, exec, and egress simulation", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({
      env: { PORT: "8080" },
      files: { "/app/seed.txt": "seed" },
      egress: ["api.example.com", "*.wild.example"],
    });
    expect(decoder.decode(await machine.files.read("/app/seed.txt"))).toBe("seed");
    expect(machine.allowedDomains).toEqual(["api.example.com", "*.wild.example"]);
    const allowed = await machine.exec(
      "timeout 5 node -e \"fetch('https://api.example.com').then(() => process.exit(0)).catch(() => process.exit(1))\"",
    );
    expect(allowed.code).toBe(0);
    const blocked = await machine.exec(
      "timeout 5 node -e \"fetch('https://evil.example').then(() => process.exit(0)).catch(() => process.exit(1))\"",
    );
    expect(blocked.code).toBe(1);
  });

  it("prefers allowedDomains over the deprecated egress alias when both are given", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({
      env: { PORT: "8080" },
      allowedDomains: ["v2.example"],
      egress: ["v1.example"],
    });
    expect(machine.allowedDomains).toEqual(["v2.example"]);
  });
});
