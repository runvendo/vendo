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
    const promptOtp = vi.fn().mockResolvedValue("123456");

    expect(await runLogin(["person@example.com", "--api-url", "https://cloud.example"], {
      output: messages.sink,
      fetcher,
      writeSession,
      promptOtp,
    })).toBe(0);
    expect(fetcher.mock.calls).toEqual([
      ["/api/v1/auth/otp/start", expect.objectContaining({
        apiUrl: "https://cloud.example",
        method: "POST",
        body: { email: "person@example.com" },
      })],
      ["/api/v1/auth/otp/verify", expect.objectContaining({
        apiUrl: "https://cloud.example",
        method: "POST",
        body: { email: "person@example.com", token: "123456" },
      })],
    ]);
    expect(promptOtp).toHaveBeenCalledWith("Enter the code sent to person@example.com");
    expect(writeSession).toHaveBeenCalledWith(session);
    expect(JSON.parse(messages.logs[0]!)).toMatchObject({
      loggedIn: true,
      mode: "email",
      email: "person@example.com",
    });
  });

  it("accepts an eight-digit email code", async () => {
    const messages = output();
    const session = { access_token: "jwt", refresh_token: "refresh", expires_at: 2_000_000_000 };
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ sent: true })
      .mockResolvedValueOnce(session);
    const writeSession = vi.fn().mockResolvedValue(undefined);

    expect(await runLogin(["person@example.com"], {
      output: messages.sink,
      fetcher,
      writeSession,
      promptOtp: vi.fn().mockResolvedValue("12345678"),
    })).toBe(0);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/auth/otp/verify", expect.objectContaining({
      body: { email: "person@example.com", token: "12345678" },
    }));
    expect(writeSession).toHaveBeenCalledWith(session);
  });

  it.each(["12345", "12345678901", "12 3456", "abcdef"])(
    "rejects the out-of-range email code %j before verification",
    async (code) => {
      const messages = output();
      const fetcher = vi.fn().mockResolvedValue({ sent: true });
      const writeSession = vi.fn();

      expect(await runLogin(["person@example.com"], {
        output: messages.sink,
        fetcher,
        writeSession,
        promptOtp: vi.fn().mockResolvedValue(code),
      })).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(writeSession).not.toHaveBeenCalled();
      expect(messages.errors).toEqual(["Email OTP must be a 6-10 digit code"]);
    },
  );

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
