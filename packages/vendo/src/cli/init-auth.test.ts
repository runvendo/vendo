import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SelectOption } from "./pretty.js";
import { detectAuthPreset, resolveScaffoldAuth, type AuthWire, type SelectAuth } from "./init-auth.js";

/** Which vendor preset a wire names, or undefined — the shape assertions here
    care about, spelled once. */
const wiredPreset = (wire: AuthWire | null): string | undefined =>
  wire?.kind === "preset" ? wire.preset : undefined;

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
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined);
    expect(wiredPreset(auth.wired)).toBe("authJs");
    expect(auth.advice).toContain("next-auth v4");
  });

  it("the --auth flag path surfaces the advisory as advice", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": "4.24.11" } });
    const auth = await resolveScaffoldAuth(root, COMPOSITION, "authJs", undefined);
    expect(wiredPreset(auth.wired)).toBe("authJs");
    expect(auth.advice).toContain("next-auth v4");
  });

  it("accepting the pre-selected answer surfaces the advisory beside the question", async () => {
    // The question copy asks about the HOST's users and stays version-silent by
    // design; the v4 story is the ADVISORY's to tell, and pressing Enter on the
    // pre-selected family still carries it as advice.
    const root = await hostRoot({ dependencies: { "next-auth": "^4.24.11" } });
    let question = "";
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, async (asked, options, defaultIndex) => {
      question = asked;
      return options[defaultIndex!]!.value; // Enter
    });
    expect(wiredPreset(auth.wired)).toBe("authJs");
    expect(question).toBe("How do your users sign in?");
    expect(auth.advice).toContain("next-auth v4");
  });

  it("a v5 host's silent path keeps advice null when wired", async () => {
    const root = await hostRoot({ dependencies: { "next-auth": "5.0.0" } });
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined);
    expect(wiredPreset(auth.wired)).toBe("authJs");
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
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, {});
    expect(wiredPreset(auth.wired)).toBe("supabase");
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
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, {});
    expect(wiredPreset(auth.wired)).toBe("clerk");
    expect(auth.advice).toContain("CLERK_SECRET_KEY");
  });
});

/**
 * The one auth question, asked on EVERY interactive run. Init used to decide in
 * silence from the package.json scan: one match was wired without a word, and
 * an ambiguous or empty scan wrote an anonymous composition nobody chose. The
 * scan now moves the CURSOR and nothing else.
 */
describe("how do your users sign in?", () => {
  /** Answers the pre-selected option, the way Enter does. */
  const pressEnter = (asked: { question?: string; options?: SelectOption[] } = {}): SelectAuth =>
    async (question, options, defaultIndex) => {
      asked.question = question;
      asked.options = options;
      return options[defaultIndex ?? 0]!.value;
    };

  it("asks the same question with the same seven answers, whatever the scan found", async () => {
    for (const manifest of [
      {},
      { dependencies: { "next-auth": "5.0.0" } },
      { dependencies: { "next-auth": "5.0.0", "@clerk/nextjs": "6.0.0" } },
    ]) {
      const asked: { question?: string; options?: SelectOption[] } = {};
      await resolveScaffoldAuth(await hostRoot(manifest), COMPOSITION, undefined, pressEnter(asked));
      expect(asked.question).toBe("How do your users sign in?");
      expect(asked.options?.map((option) => option.value))
        .toEqual(["authJs", "clerk", "supabase", "auth0", "jwt", "custom", "none"]);
    }
  });

  it("pre-selects the one family package.json names, so Enter wires it", async () => {
    const asked: { question?: string; options?: SelectOption[] } = {};
    const root = await hostRoot({ dependencies: { "@clerk/nextjs": "6.0.0" } });
    const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, pressEnter(asked), {});
    expect(auth.wired).toMatchObject({ kind: "preset", preset: "clerk", dependency: "@clerk/nextjs" });
    // The evidence rides on the row it found, not in a reshuffled list.
    expect(asked.options?.find((option) => option.value === "clerk")?.hint).toBe("detected @clerk/nextjs");
  });

  it("pre-selects nothing but 'none yet' when the scan is ambiguous or empty — and still asks", async () => {
    for (const manifest of [{}, { dependencies: { "next-auth": "5.0.0", "@clerk/nextjs": "6.0.0" } }]) {
      const asked: { question?: string; options?: SelectOption[] } = {};
      const auth = await resolveScaffoldAuth(await hostRoot(manifest), COMPOSITION, undefined, pressEnter(asked), {});
      expect(asked.question).toBe("How do your users sign in?");
      expect(auth.wired).toBeNull();
    }
  });

  /**
   * The half that must never regress: a run nobody is watching — `--no-input`,
   * no TTY, CI, `--yes`, `--agent` — takes the scanned default SILENTLY. A
   * question that hangs an unattended install is worse than a default.
   */
  describe("no seam (non-interactive, --yes, CI): the scanned default, silently", () => {
    it("wires the one detected family with nothing asked", async () => {
      const root = await hostRoot({ dependencies: { "next-auth": "5.0.0" } });
      const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, {});
      expect(auth.wired).toMatchObject({ kind: "preset", preset: "authJs", dependency: "next-auth" });
    });

    it("stays anonymous on an empty scan, and names the line to add", async () => {
      const auth = await resolveScaffoldAuth(await hostRoot({}), COMPOSITION, undefined, undefined, {});
      expect(auth.wired).toBeNull();
      expect(auth.advice).toContain("no provider detected");
    });

    it("stays anonymous on an ambiguous scan rather than guessing one of them", async () => {
      const root = await hostRoot({ dependencies: { "next-auth": "5.0.0", "@clerk/nextjs": "6.0.0" } });
      const auth = await resolveScaffoldAuth(root, COMPOSITION, undefined, undefined, {});
      expect(auth.wired).toBeNull();
      expect(auth.advice).toContain("several providers detected");
    });
  });

  it("JWT is a real answer: it wires jwt() off an env variable, not a printed recipe", async () => {
    const root = await hostRoot({});
    const auth = await resolveScaffoldAuth(root, COMPOSITION, "jwt", undefined, {});
    expect(auth.wired).toEqual({ kind: "jwt" });
    expect(auth.advice).toContain("HOST_API_JWT_SECRET");
  });

  it("'write my own' wires the seam init scaffolds, and says what still has to be replaced", async () => {
    const auth = await resolveScaffoldAuth(await hostRoot({}), COMPOSITION, "custom", undefined, {});
    expect(auth.wired).toEqual({ kind: "custom" });
    expect(auth.advice).toContain("fixed dev subject");
    expect(auth.advice).toContain(COMPOSITION);
  });

  it("choosing a family the host has no SDK for wires it anyway, with the install hint", async () => {
    const auth = await resolveScaffoldAuth(await hostRoot({}), COMPOSITION, "clerk", undefined, {});
    expect(auth.wired).toEqual({ kind: "preset", preset: "clerk" });
    expect(auth.advice).toContain("npm install @clerk/backend");
  });

  it("'none yet' over a detected family names that family's one line for later", async () => {
    const root = await hostRoot({ dependencies: { "@clerk/nextjs": "6.0.0" } });
    const auth = await resolveScaffoldAuth(root, COMPOSITION, "none", undefined, {});
    expect(auth.wired).toBeNull();
    expect(auth.advice).toContain("auth: clerk()");
  });
});
