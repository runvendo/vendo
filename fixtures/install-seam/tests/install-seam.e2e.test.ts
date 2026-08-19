import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootStranger, workspaceRoot, type Stranger } from "../src/stranger.js";

/**
 * The install seam, with a permanent stranger.
 *
 * Everything a paid manual audit round used to walk by hand, once, per release:
 * pack the publish set → `pnpm add` the tarballs into an app that has never
 * heard of this monorepo → `vendo init` → typecheck → boot → ask the agent a
 * question only the app's own API can answer, and have it write one back.
 *
 * There is exactly ONE double in the chain, and it is the one a test genuinely
 * cannot call: the model. Its moves arrive in the request body and are replayed
 * by `@vendoai/apps/testing`. The package under test is a real tarball, the CLI
 * is the real binary, the server is a real `next dev`, and `/api/todos` is a
 * real route over real HTTP.
 *
 * These are OUTCOME assertions. Nothing here pins init's printed prose, so the
 * suite is indifferent to the init-output redesign landing before or after it.
 */

/** npm's own package-name grammar. The `@/lib` class of bug — a path alias
 *  mistaken for a package and shelled at a package manager — fails it. */
const NPM_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A lockfile key for one of this monorepo's packages, and how it resolved. */
const LOCKED_VENDO = /^ {2}'?(vendoai|@vendoai\/[a-z-]+)@(.+?)'?:$/gm;

const SEEDED = "Renew the passport";

let stranger: Stranger;
let stop: () => Promise<void>;

beforeAll(async () => {
  const booted = await bootStranger(
    process.env["VENDO_INSTALL_SEAM_ARTIFACTS"]
      ?? path.join(workspaceRoot, "fixtures/install-seam/.artifacts"),
  );
  stranger = booted.stranger;
  stop = booted.stop;
});

afterAll(async () => {
  await stop?.();
});

describe("the install seam", () => {
  it("installs the built packages into a stranger, declaring only real npm packages", () => {
    expect(stranger.add.code).toBe(0);
    for (const [name, spec] of Object.entries(stranger.declaredDependencies)) {
      expect(name, `${name} is not a package name npm could resolve`).toMatch(NPM_NAME);
      expect(spec, `${name} is declared as a workspace link, not an installed package`)
        .not.toMatch(/^(link:|workspace:)/);
    }
    // The umbrella really is declared — an empty dependency map would pass the
    // loop above without proving anything.
    expect(Object.keys(stranger.declaredDependencies)).toContain("@vendoai/vendo");
  });

  it("runs init to completion without writing outside the app or minting an account", () => {
    expect(stranger.init.code, stranger.init.output.slice(-4000)).toBe(0);
    // "Asks before accounts", asserted as an absence: an unattended init that
    // already has a working local key reached the console zero times.
    expect(stranger.cloudRequests).toEqual([]);
    expect(stranger.envLocal).not.toMatch(/VENDO_API_KEY/);
    // Nothing landed in the isolated HOME (~/.vendo holds the cloud session and
    // pending claims) or in the directory init was invoked from.
    expect(stranger.vendoHomeEntries).toEqual([]);
    expect(stranger.strayCwdEntries).toEqual([]);
  });

  it("generates a composition that compiles", () => {
    expect(stranger.typecheck.code, stranger.typecheck.output.slice(-4000)).toBe(0);
  });

  it("answers from the app's own API, and writes back to it", async () => {
    const list = stranger.toolFor("GET", "/api/todos");
    const create = stranger.toolFor("POST", "/api/todos");

    // A read the model cannot fake: the seeded row exists only behind
    // /api/todos, so its title reaches the client only if init's extraction,
    // the generated wiring, the guard, the approval wire and the actions
    // runtime all worked, over real HTTP, against the app's own route.
    const read = await stranger.callTool("What is on my todo list?", list, {});
    expect(read).toContain(SEEDED);

    // And a write lands where the app's own API can see it.
    const title = "Buy fig tree fertiliser";
    await stranger.callTool(`Add "${title}" to my todos.`, create, { title });
    expect((await stranger.todos()).map((todo) => todo.title)).toContain(title);
  });

  it("resolves every @vendoai package from the packed tarballs, at the packed version", () => {
    const locked = [...stranger.lockfile.matchAll(LOCKED_VENDO)];
    expect(locked.length, "the lockfile records no @vendoai packages at all").toBeGreaterThan(0);
    for (const [, name, spec] of locked) {
      const packed = stranger.packedVersions[name!];
      expect(packed, `${name} is in the stranger's tree but was never packed`).toBeDefined();
      // Provenance, not just a version string: a registry copy could carry the
      // same number and prove nothing about this commit.
      expect(spec, `${name} did not resolve to a packed tarball`).toMatch(/^file:vendor\//);
      expect(spec, `${name} resolved to a tarball that is not ${packed}`).toContain(`-${packed}.tgz`);
    }
    // The whole umbrella closure really is in there. `vendoai` is excluded: it
    // is the bare alias a host may install INSTEAD of @vendoai/vendo, so
    // nothing pulls it in transitively and its absence is correct.
    const resolved = new Set(locked.map(([, name]) => name!));
    for (const name of Object.keys(stranger.packedVersions)) {
      if (name === "vendoai") continue;
      expect([...resolved], `${name} never reached the stranger's tree`).toContain(name);
    }
  });
});
