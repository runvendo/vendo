import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSessionExpired, readCloudSession, writeCloudSession } from "./session.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("cloud session", () => {
  it("round-trips in an injected home with owner-only permissions", async () => {
    const home = await mkdtemp(join(tmpdir(), "vendo-cloud-session-"));
    cleanup.push(home);
    const session = { access_token: "jwt", refresh_token: "refresh", expires_at: 2_000_000_000 };

    await writeCloudSession(session, { home });

    expect(await readCloudSession({ home })).toEqual(session);
    expect((await stat(join(home, ".vendo", "cloud-session.json"))).mode & 0o777).toBe(0o600);
  });

  it("checks expiry using epoch seconds and a small clock skew", () => {
    expect(isSessionExpired({ access_token: "jwt", expires_at: 100 }, 71_000)).toBe(true);
    expect(isSessionExpired({ access_token: "jwt", expires_at: 100 }, 60_000)).toBe(false);
  });
});
