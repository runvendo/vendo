import { afterEach, describe, expect, it } from "vitest";
import { demoPrincipalAllowed } from "./local-guard";

const req = (host: string, url = "http://localhost/api/vendo/chat") =>
  new Request(url, { method: "POST", headers: { host } });

const priorPublic = process.env.VENDO_DEMO_PUBLIC;
const priorNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (priorPublic === undefined) delete process.env.VENDO_DEMO_PUBLIC;
  else process.env.VENDO_DEMO_PUBLIC = priorPublic;
  // NODE_ENV is read-only-ish in types; assign through a cast.
  (process.env as Record<string, string | undefined>).NODE_ENV = priorNodeEnv;
});

describe("demoPrincipalAllowed", () => {
  it("allows local requests in development", () => {
    delete process.env.VENDO_DEMO_PUBLIC;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(demoPrincipalAllowed(req("localhost:3000"))).toBe(true);
    expect(demoPrincipalAllowed(req("127.0.0.1:3001"))).toBe(true);
  });

  it("denies a non-local host even in development", () => {
    delete process.env.VENDO_DEMO_PUBLIC;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(demoPrincipalAllowed(req("cadence-preview.example.com"))).toBe(false);
  });

  it("denies a spoofed Host: localhost on a production build", () => {
    delete process.env.VENDO_DEMO_PUBLIC;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    // The attack the dual review found: client-controlled Host header.
    expect(demoPrincipalAllowed(req("localhost", "https://deployed.example.com/api/vendo/chat"))).toBe(false);
  });

  it("allows anything with the explicit operator opt-in", () => {
    process.env.VENDO_DEMO_PUBLIC = "1";
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(demoPrincipalAllowed(req("cadence-preview.example.com"))).toBe(true);
  });
});
