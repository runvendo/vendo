import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAuthPreset, resolveScaffoldAuth } from "./init-auth.js";

const roots: string[] = [];

async function hostRoot(manifest: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-init-auth-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify(manifest), "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const COMPOSITION = "vendo/server.ts";

describe("next-auth v4 advisory (#871)", () => {
  it("detection carries a v4 advisory when next-auth resolves to major 4", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": "^4.24.11" } });
    const detection = await detectAuthPreset(root);
    expect(detection.wired?.preset).toBe("authJs");
    expect(detection.wired?.advisory).toContain("next-auth v4");
    expect(detection.wired?.advisory).toContain("^4.24.11");
  });

  it("v5 ranges carry no advisory", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": ">=5.0.0-beta.32" } });
    const detection = await detectAuthPreset(root);
    expect(detection.wired?.preset).toBe("authJs");
    expect(detection.wired?.advisory).toBeUndefined();
  });

  it("an @auth/* match without next-auth carries no advisory", async () => {
    const root = await hostRoot({ dependencies: { "@auth/prisma-adapter": "^2.7.4" } });
    const detection = await detectAuthPreset(root);
    expect(detection.wired?.preset).toBe("authJs");
    expect(detection.wired?.advisory).toBeUndefined();
  });

  it("unparseable ranges (workspace:, latest) carry no advisory", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": "workspace:*" } });
    const detection = await detectAuthPreset(root);
    expect(detection.wired?.advisory).toBeUndefined();
  });

  it("the silent (non-interactive) path surfaces the advisory as advice", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": "~4.2.0" } });
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, undefined);
    expect(auth.wired?.preset).toBe("authJs");
    expect(auth.advice).toContain("next-auth v4");
  });

  it("the --auth flag path surfaces the advisory as advice", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": "4.24.11" } });
    const auth = await resolveScaffoldAuth(root, COMPOSITION, "authJs", undefined, undefined);
    expect(auth.wired?.preset).toBe("authJs");
    expect(auth.advice).toContain("next-auth v4");
  });

  it("the confirm-accept path surfaces the advisory beside the decision question", async () => {
    // The question copy asks what is being DECIDED ("act as your signed-in
    // Auth.js user?") and stays version-silent by design; the v4 story is the
    // ADVISORY's to tell, and an accept still carries it as advice.
    const root = await hostRoot({ dependencies: { "next-auth": "^4.24.11" } });
    let question = "";
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, async (asked) => {
      question = asked;
      return true;
    }, undefined);
    expect(auth.wired?.preset).toBe("authJs");
    expect(question).toContain("act as your signed-in");
    expect(auth.advice).toContain("next-auth v4");
  });

  it("a v5 host's silent path keeps advice null when wired", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": "5.0.0" } });
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, undefined);
    expect(auth.wired?.preset).toBe("authJs");
    expect(auth.advice).toBeNull();
  });
});
