import { describe, expect, it, vi } from "vitest";
import { runLogin, runWhoami } from "./auth.js";
import type { CloudSession } from "./session.js";

function output(): { logs: string[]; errors: string[]; sink: { log(message: string): void; error(message: string): void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (message) => logs.push(message), error: (message) => errors.push(message) } };
}

describe("cloud auth", () => {
  it("rejects login without either an email or token", async () => {
    const messages = output();
    expect(await runLogin([], { output: messages.sink })).toBe(1);
    expect(messages.errors.join("\n")).toContain("email or --token");
  });

  it("stores the token fallback without making a request", async () => {
    const messages = output();
    const writeSession = vi.fn<(session: CloudSession) => Promise<void>>().mockResolvedValue(undefined);
    const fetcher = vi.fn();

    expect(await runLogin(["--token", "header.payload.signature"], {
      output: messages.sink,
      fetcher,
      writeSession,
    })).toBe(0);
    expect(writeSession).toHaveBeenCalledWith({ access_token: "header.payload.signature" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(messages.logs[0]!)).toMatchObject({ loggedIn: true, mode: "token" });
  });

  it("returns one when the token fallback cannot be stored", async () => {
    const messages = output();
    expect(await runLogin(["--token", "jwt"], {
      output: messages.sink,
      writeSession: async () => { throw new Error("read-only home"); },
    })).toBe(1);
    expect(messages.errors).toEqual(["read-only home"]);
  });

  it("starts and verifies an email OTP", async () => {
    const messages = output();
    const session = { access_token: "jwt", refresh_token: "refresh", expires_at: 2_000_000_000 };
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ sent: true })
      .mockResolvedValueOnce(session);
    const writeSession = vi.fn().mockResolvedValue(undefined);

    expect(await runLogin(["person@example.com", "--otp", "123456"], {
      output: messages.sink,
      fetcher,
      writeSession,
    })).toBe(0);
    expect(fetcher.mock.calls).toEqual([
      ["/api/v1/auth/otp/start", expect.objectContaining({ method: "POST", body: { email: "person@example.com" } })],
      ["/api/v1/auth/otp/verify", expect.objectContaining({ method: "POST", body: { email: "person@example.com", token: "123456" } })],
    ]);
    expect(writeSession).toHaveBeenCalledWith(session);
  });

  it("uses an ephemeral token for whoami", async () => {
    const messages = output();
    const fetcher = vi.fn().mockResolvedValue([{ id: "org_1" }]);

    expect(await runWhoami(["--token=jwt", "--api-url", "https://api.test"], {
      output: messages.sink,
      fetcher,
    })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/orgs", expect.objectContaining({
      auth: "user",
      accessToken: "jwt",
      apiUrl: "https://api.test",
    }));
    expect(JSON.parse(messages.logs[0]!)).toEqual([{ id: "org_1" }]);
  });
});
