import { describe, expect, it } from "vitest";
import {
  ACCESS_RANK,
  accessForPath,
  appOfOrgPath,
  encodeGrantPrincipal,
  grantMatches,
  holdsLevel,
  isGrantPrincipal,
  orgOfPath,
  parseGrantPrincipal,
  strongerLevel,
  type AppId,
  type Membership,
  type RunContext,
} from "../src/index.js";

/**
 * The PURE half of `can()` (build contract §9.2–§9.3). Two packages resolve
 * access over real rows — @vendoai/store and @vendoai/apps' stand-in — and BOTH
 * apply these functions rather than re-deciding. So a rule that quietly changes
 * shape here changes it in every door at once, which is exactly why the grammar,
 * the level order and the path rules are pinned right beside them.
 */

const ctx = (subject: string, memberships?: Membership[]): RunContext => ({
  principal: { kind: "user", subject },
  venue: "app",
  presence: "present",
  ...(memberships === undefined ? {} : { memberships }),
});

describe("the level order", () => {
  it("ranks viewer < editor < owner", () => {
    expect(ACCESS_RANK.viewer).toBeLessThan(ACCESS_RANK.editor);
    expect(ACCESS_RANK.editor).toBeLessThan(ACCESS_RANK.owner);
  });

  it("satisfies a requirement with the level asked for or anything above it", () => {
    expect(holdsLevel("editor", "viewer")).toBe(true);
    expect(holdsLevel("editor", "editor")).toBe(true);
    expect(holdsLevel("owner", "editor")).toBe(true);
  });

  it("refuses a level below the one required", () => {
    expect(holdsLevel("viewer", "editor")).toBe(false);
    expect(holdsLevel("editor", "owner")).toBe(false);
  });

  it("treats no access at all as satisfying nothing — including viewer", () => {
    expect(holdsLevel(null, "viewer")).toBe(false);
  });

  it("takes the MAX of what applies, so a second grant can only ever add", () => {
    expect(strongerLevel("viewer", "owner")).toBe("owner");
    expect(strongerLevel("owner", "viewer")).toBe("owner");
    expect(strongerLevel("editor", "editor")).toBe("editor");
  });

  it("lets either side be absent — no access loses to any access", () => {
    expect(strongerLevel(null, "viewer")).toBe("viewer");
    expect(strongerLevel("editor", null)).toBe("editor");
    expect(strongerLevel(null, null)).toBeNull();
  });
});

describe("the §9.2 principal grammar", () => {
  it("reads the three encodings", () => {
    expect(parseGrantPrincipal("user:ada")).toEqual({ kind: "user", subject: "ada" });
    expect(parseGrantPrincipal("org:acme")).toEqual({ kind: "org", org: "acme" });
    expect(parseGrantPrincipal("team:acme/finance")).toEqual({ kind: "team", org: "acme", team: "finance" });
  });

  it("round-trips every encoding it can read", () => {
    for (const encoded of ["user:ada", "org:acme", "team:acme/finance"]) {
      expect(encodeGrantPrincipal(parseGrantPrincipal(encoded)!)).toBe(encoded);
    }
  });

  it("keeps a subject that itself contains a colon whole", () => {
    // Host subjects are opaque, and plenty of identity systems issue
    // `auth0|...`-style or URI-style ids: splitting on the LAST colon would
    // silently write a grant for a different person.
    expect(parseGrantPrincipal("user:https://idp.example/u/1")).toEqual({
      kind: "user",
      subject: "https://idp.example/u/1",
    });
  });

  it("refuses anything it cannot read, rather than guessing a principal", () => {
    for (const bad of [
      "",             // empty
      "ada",          // no kind
      "user:",        // no subject
      "org:",         // no org
      "org:acme/x",   // an org principal cannot name a team
      "team:acme",    // a team principal must name one
      "team:/finance", // …and an org
      "team:acme/",   // …and a team
      "team:acme/a/b", // exactly one team segment
      "admin:ada",    // not a kind that exists
    ]) {
      expect(parseGrantPrincipal(bad), bad).toBeUndefined();
      expect(isGrantPrincipal(bad), bad).toBe(false);
    }
  });

  it("isGrantPrincipal agrees with the parser on what is readable", () => {
    expect(isGrantPrincipal("team:acme/finance")).toBe(true);
  });
});

describe("matching a stored grant against ASSERTED memberships", () => {
  it("matches a user grant only for that exact subject", () => {
    expect(grantMatches(ctx("ada"), "user:ada")).toBe(true);
    expect(grantMatches(ctx("bob"), "user:ada")).toBe(false);
  });

  it("matches an org grant for any member of that org", () => {
    expect(grantMatches(ctx("bob", [{ org: "acme" }]), "org:acme")).toBe(true);
  });

  it("matches a team grant only for someone the host asserts is on that team", () => {
    const onFinance = ctx("bob", [{ org: "acme", teams: ["finance"] }]);
    expect(grantMatches(onFinance, "team:acme/finance")).toBe(true);
    expect(grantMatches(onFinance, "team:acme/legal")).toBe(false);
  });

  it("never matches an org or team the ctx asserts no membership in — Vendo holds no org chart", () => {
    expect(grantMatches(ctx("bob"), "org:acme")).toBe(false);
    expect(grantMatches(ctx("bob", [{ org: "other" }]), "org:acme")).toBe(false);
    expect(grantMatches(ctx("bob", [{ org: "other", teams: ["finance"] }]), "team:acme/finance")).toBe(false);
  });

  it("does not treat plain org membership as membership of every team in it", () => {
    expect(grantMatches(ctx("bob", [{ org: "acme" }]), "team:acme/finance")).toBe(false);
  });

  it("matches nothing at all on an unreadable principal", () => {
    expect(grantMatches(ctx("ada"), "nonsense")).toBe(false);
  });
});

describe("deriving the owner of a path (§9.7)", () => {
  it("reads the org out of an org mount, root included", () => {
    expect(orgOfPath("/orgs/acme")).toBe("acme");
    expect(orgOfPath("/orgs/acme/apps/app_1/app.vendo")).toBe("acme");
  });

  it("answers nothing for a path that is not an org mount", () => {
    expect(orgOfPath("/user/notes.md")).toBeUndefined();
    expect(orgOfPath("/orgsacme/x")).toBeUndefined();
  });

  it("reads the app out of an org app path, INCLUDING its root", () => {
    // The root has to belong to the app: otherwise a member holding no grant
    // could write it as a plain file and the app's subtree could never exist.
    expect(appOfOrgPath("/orgs/acme/apps/app_1")).toBe("app_1");
    expect(appOfOrgPath("/orgs/acme/apps/app_1/src/main.vendo")).toBe("app_1");
  });

  it("answers nothing for org paths outside the apps mount", () => {
    expect(appOfOrgPath("/orgs/acme/policy.json")).toBeUndefined();
    expect(appOfOrgPath("/user/apps/app_1")).toBeUndefined();
  });
});

describe("accessForPath — decided as far as rows allow", () => {
  const APP = "app_1" as AppId;

  it("gives the bound subject their own /user mount at every level", () => {
    for (const level of ["viewer", "editor", "owner"] as const) {
      expect(accessForPath(ctx("ada"), level, "/user")).toEqual({ decision: true });
      expect(accessForPath(ctx("ada"), level, "/user/notes.md")).toEqual({ decision: true });
    }
  });

  it("refuses a path that is neither the user mount nor an org mount", () => {
    expect(accessForPath(ctx("ada"), "viewer", "/etc/passwd")).toEqual({ decision: false });
  });

  it("refuses an org mount the ctx asserts no membership in", () => {
    expect(accessForPath(ctx("ada"), "viewer", "/orgs/acme/notes.md")).toEqual({ decision: false });
  });

  it("gives a member the rest of their org's mount", () => {
    expect(accessForPath(ctx("ada", [{ org: "acme" }]), "editor", "/orgs/acme/notes.md"))
      .toEqual({ decision: true });
  });

  it("lets every member READ the org policy file but only an admin rewrite it", () => {
    const member = ctx("ada", [{ org: "acme" }]);
    const admin = ctx("dana", [{ org: "acme", admin: true }]);
    const policy = "/orgs/acme/policy.json";
    expect(accessForPath(member, "viewer", policy)).toEqual({ decision: true });
    expect(accessForPath(member, "editor", policy)).toEqual({ decision: false });
    expect(accessForPath(admin, "editor", policy)).toEqual({ decision: true });
  });

  it("hands an app subtree back to the app's own grants instead of deciding it", () => {
    const member = ctx("ada", [{ org: "acme" }]);
    expect(accessForPath(member, "editor", "/orgs/acme/apps/app_1")).toEqual({ app: APP });
    expect(accessForPath(member, "editor", "/orgs/acme/apps/app_1/app.vendo")).toEqual({ app: APP });
  });
});
