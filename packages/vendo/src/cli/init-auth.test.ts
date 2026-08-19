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

describe("supabase server-env advisory (ENG-422 / #1370)", () => {
  const SUPABASE = { dependencies: { "@supabase/supabase-js": "^2.39.3" } };

  it("detection carries the advisory when neither server env name is anywhere", async () => {
    const root = await hostRoot(SUPABASE);
    const detection = await detectAuthPreset(root, {});
    expect(detection.wired?.preset).toBe("supabase");
    expect(detection.wired?.advisory).toContain("SUPABASE_JWT_SECRET");
    expect(detection.wired?.advisory).toContain("SUPABASE_URL");
  });

  it("an env file carrying either name silences it", async () => {
    const root = await hostRoot(SUPABASE);
    await writeFile(join(root, ".env.local"), 'SUPABASE_URL="http://127.0.0.1:54321"\n', "utf8");
    const detection = await detectAuthPreset(root, {});
    expect(detection.wired?.preset).toBe("supabase");
    expect(detection.wired?.advisory).toBeUndefined();
  });

  it("the process env carrying either name silences it", async () => {
    const root = await hostRoot(SUPABASE);
    const detection = await detectAuthPreset(root, { SUPABASE_JWT_SECRET: "s" });
    expect(detection.wired?.advisory).toBeUndefined();
  });

  it("a NEXT_PUBLIC_-only host still gets the advisory — the pair the preset reads is server-side", async () => {
    const root = await hostRoot(SUPABASE);
    await writeFile(
      join(root, ".env"),
      'NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"\nNEXT_PUBLIC_SUPABASE_ANON_KEY="anon"\n',
      "utf8",
    );
    const detection = await detectAuthPreset(root, {});
    expect(detection.wired?.advisory).toContain("NEXT_PUBLIC_");
  });

  it("the silent (non-interactive) path surfaces it as advice", async () => {
    const root = await hostRoot(SUPABASE);
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, undefined, {});
    expect(auth.wired?.preset).toBe("supabase");
    expect(auth.advice).toContain("SUPABASE_JWT_SECRET");
  });
});

// The same disease in the third preset (#1338): detection sees @clerk/* while
// the preset verifies with CLERK_SECRET_KEY/CLERK_JWT_KEY — and post-#1338 the
// keyless wire resolves signed-in users as ANONYMOUS (one loud warning), so
// naming the gap at install time is the only thing standing between a
// newcomer and a silently signed-out agent.
describe("clerk server-env advisory (#1338)", () => {
  const CLERK = { dependencies: { "@clerk/nextjs": "^6.5.0" } };

  it("detection carries the advisory when neither key name is anywhere", async () => {
    const root = await hostRoot(CLERK);
    const detection = await detectAuthPreset(root, {});
    expect(detection.wired?.preset).toBe("clerk");
    expect(detection.wired?.advisory).toContain("CLERK_SECRET_KEY");
    expect(detection.wired?.advisory).toContain("CLERK_JWT_KEY");
  });

  it("an env file carrying either name silences it", async () => {
    const root = await hostRoot(CLERK);
    await writeFile(join(root, ".env.local"), 'CLERK_SECRET_KEY="sk_test_x"\n', "utf8");
    const detection = await detectAuthPreset(root, {});
    expect(detection.wired?.preset).toBe("clerk");
    expect(detection.wired?.advisory).toBeUndefined();
  });

  it("the process env carrying either name silences it", async () => {
    const root = await hostRoot(CLERK);
    const detection = await detectAuthPreset(root, { CLERK_JWT_KEY: "-----BEGIN PUBLIC KEY-----" });
    expect(detection.wired?.advisory).toBeUndefined();
  });

  it("a publishable-key-only host still gets the advisory — the key the preset reads is server-side", async () => {
    const root = await hostRoot(CLERK);
    await writeFile(join(root, ".env"), 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_x"\n', "utf8");
    const detection = await detectAuthPreset(root, {});
    expect(detection.wired?.advisory).toContain("CLERK_SECRET_KEY");
  });

  it("the silent (non-interactive) path surfaces it as advice", async () => {
    const root = await hostRoot(CLERK);
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, undefined, {});
    expect(auth.wired?.preset).toBe("clerk");
    expect(auth.advice).toContain("CLERK_SECRET_KEY");
  });
});
