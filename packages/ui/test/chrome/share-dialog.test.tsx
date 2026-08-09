// @vitest-environment jsdom
// Build contract §9.5 — "share implies promote", and it promotes into the org
// the CHOSEN principal names. The dialog is the only surface that writes grants,
// so a wrong org here silently hands an app to the wrong team.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AccessLevel } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
import { encodeGrantPrincipal as coreEncode } from "@vendoai/core";
import { VendoProvider, type VendoClient } from "../../src/index.js";
import { ShareDialog, encodeGrantPrincipal as chromeEncode } from "../../src/chrome/index.js";

afterEach(cleanup);

const memberships = [
  { org: "acme", display: "Acme" },
  { org: "other", display: "Other Co", teams: ["finance"] },
];

interface FakeOptions {
  personal: boolean;
  memberships?: Array<{ org: string; display?: string; teams?: string[] }>;
  /** Throw from `promote` (F2's reachable-through-share developer sentence). */
  promoteFails?: unknown;
  /** Throw from `share` (F1's keyless-deployment refusal). */
  shareFails?: unknown;
  /** §9.1 companion — the host's own directory. Absent = it knows nobody. */
  roster?: Record<string, { subject: string; display?: string }>;
  /** Throw from the lookup (a host whose `resolvePerson` seam is unset). */
  resolveFails?: unknown;
}

function fakeClient(options: FakeOptions) {
  const calls: Array<{ verb: string; args: unknown[] }> = [];
  const client = {
    async status() { return { posture: "unconfigured", memberships: options.memberships ?? memberships }; },
    apps: {
      async grants() {
        calls.push({ verb: "grants", args: [] });
        return { level: "owner" as AccessLevel, grants: [], personal: options.personal };
      },
      async promote(id: string, orgId: string) {
        calls.push({ verb: "promote", args: [id, orgId] });
        if (options.promoteFails !== undefined) throw options.promoteFails;
        return {};
      },
      async share(id: string, principal: string, level: AccessLevel) {
        calls.push({ verb: "share", args: [id, principal, level] });
        if (options.shareFails !== undefined) throw options.shareFails;
        return { grants: [] };
      },
      async unshare() { return { grants: [] }; },
      async resolvePerson(id: string, query: string) {
        calls.push({ verb: "resolvePerson", args: [id, query] });
        if (options.resolveFails !== undefined) throw options.resolveFails;
        return { person: options.roster?.[query.trim().toLowerCase()] ?? null };
      },
    },
  } as unknown as VendoClient;
  return { client, calls };
}

/** Pick a principal the way a person does: by its human label. The encoding
    rides underneath, where nobody has to read it. */
const choose = async (label: string | RegExp): Promise<void> => {
  const picker = await screen.findByLabelText("Who to share with");
  const option = within(picker).getByRole("option", { name: label }) as HTMLOptionElement;
  fireEvent.change(picker, { target: { value: option.value } });
};

const clickShare = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
};

const shareWith = async (label: string | RegExp): Promise<void> => {
  await choose(label);
  clickShare();
};

const mount = (options: FakeOptions, props: Record<string, unknown> = {}): {
  calls: Array<{ verb: string; args: unknown[] }>;
} => {
  const { client, calls } = fakeClient(options);
  render(
    <VendoProvider client={client}>
      <ShareDialog
        appId="app_1"
        appName="Dash"
        memberships={options.memberships ?? memberships}
        // §9.1 companion — most cases below are about a host that CAN name a
        // person; the ones about a host that cannot say so explicitly.
        namesPeople
        {...props}
      />
    </VendoProvider>,
  );
  return { calls };
};

/** Type a person's name into the field the dialog opens for it. The label says
    LOOK THEM UP, because that is what happens: the host resolves it. */
const PERSON_FIELD = "Look them up by name or email";
const typePerson = async (value: string): Promise<void> => {
  fireEvent.change(await screen.findByLabelText(PERSON_FIELD), { target: { value } });
};

describe("the §9.2 grammar has ONE encoder", () => {
  it("re-exports core's, rather than keeping a second copy in the chrome", () => {
    // Two encoders of a frozen encoding is exactly the duplication the
    // conformance round removed everywhere else.
    expect(chromeEncode).toBe(coreEncode);
  });

  it("still encodes all three principal shapes", () => {
    expect(chromeEncode({ kind: "user", subject: "kim" })).toBe("user:kim");
    expect(chromeEncode({ kind: "org", org: "acme" })).toBe("org:acme");
    expect(chromeEncode({ kind: "team", org: "acme", team: "finance" })).toBe("team:acme/finance");
  });
});

describe("ShareDialog — the first read", () => {
  it("says nothing about access while the first grants read is still in flight", async () => {
    // "You don't have access to this app." is what a level of `null` means, and
    // `null` is also what the hook holds before the first answer arrives — so
    // the dialog used to open by telling everyone they had no access.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = {
      async status() { return { posture: "unconfigured", memberships }; },
      apps: {
        async grants() {
          await gate;
          return { level: "owner" as AccessLevel, grants: [], personal: true };
        },
        async promote() { return {}; },
        async share() { return { grants: [] }; },
        async unshare() { return { grants: [] }; },
      },
    } as unknown as VendoClient;

    render(
      <VendoProvider client={client}>
        <ShareDialog appId="app_slow" memberships={memberships} />
      </VendoProvider>,
    );
    expect(screen.queryByText(/have access to this app/i)).toBeNull();

    release();
    // ...and once the answer lands, the owner gets the share controls.
    expect(await screen.findByLabelText("Who to share with")).toBeTruthy();
    expect(screen.queryByText(/have access to this app/i)).toBeNull();
  });

  it("says the read failed, instead of two contradictory guesses about it", async () => {
    // A failed grants read leaves the hook's data at its EMPTY initial value and
    // files the failure in `error`, which this dialog never read. So the surface
    // stated two things, both untrue and each contradicting the other: "You
    // don't have access to this app." (level null is also "we don't know") and
    // "Nobody else yet — it's just you." (an empty list is also "we never got
    // one"). A failure to READ who can reach the app is evidence about the
    // service, not about the app.
    const client = {
      async status() { return { posture: "unconfigured", memberships }; },
      apps: {
        async grants() { throw new Error("app-access read failed: 503"); },
        async promote() { return {}; },
        async share() { return { grants: [] }; },
        async unshare() { return { grants: [] }; },
      },
    } as unknown as VendoClient;

    render(
      <VendoProvider client={client}>
        <ShareDialog appId="app_down" memberships={memberships} />
      </VendoProvider>,
    );

    expect(await screen.findByText(/can’t confirm who this app is shared with/i)).toBeTruthy();
    expect(screen.queryByText(/have access to this app/i)).toBeNull();
    expect(screen.queryByText(/just you/i)).toBeNull();
    // The wire's own sentence is the developer's, and stays theirs.
    expect(document.body.textContent).not.toContain("503");
    // Nothing is offered that would be a guess: with no known level, the write
    // controls stay away, and the one thing that can help is here.
    expect(screen.queryByLabelText("Who to share with")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("stops offering the write once a REFRESH has failed — a level is not data", async () => {
    // The first read answered, so the hook holds a real level and a real list.
    // When a LATER read fails it keeps both, and the level is what gates every
    // write on this surface: leaving it in place offers to change who can reach
    // an app on the strength of an answer we no longer have. Stale information is
    // worth showing with a note; a stale PERMISSION is a wrong affordance.
    let reads = 0;
    const client = {
      async status() { return { posture: "unconfigured", memberships }; },
      apps: {
        async grants() {
          reads += 1;
          if (reads > 1) throw new Error("app-access read failed: 503");
          return {
            level: "owner" as AccessLevel,
            grants: [{
              id: "grant_1",
              appId: "app_live",
              orgId: "other",
              principal: "team:other/finance",
              level: "viewer" as AccessLevel,
              createdBy: "user_1",
              createdAt: "2026-07-01T00:00:00.000Z",
            }],
            personal: false,
          };
        },
        async promote() { return {}; },
        async share() { return { grants: [] }; },
        async unshare() { return { grants: [] }; },
      },
    } as unknown as VendoClient;

    render(
      <VendoProvider client={client}>
        <ShareDialog appId="app_live" memberships={memberships} />
      </VendoProvider>,
    );
    // While the read stands, the owner has every control.
    await screen.findByLabelText("Who to share with");
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();

    // A share writes and then re-reads — and that re-read is the one that fails.
    await shareWith("Everyone at Acme");
    await screen.findByText(/can’t confirm who this app is shared with/i);

    // Fail closed on everything a level authorises.
    expect(screen.queryByLabelText("Who to share with")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    // The row itself STAYS. A failure to read is not evidence that access was
    // revoked, and the note above it says it is unconfirmed.
    expect(screen.getByText("The finance team")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("503");
  });
});

describe("ShareDialog — share implies promote", () => {
  it("promotes into the org the chosen principal names, not the first one", async () => {
    const { calls } = mount({ personal: true });
    await shareWith("The finance team");

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([
      { verb: "promote", args: ["app_1", "other"] },
      { verb: "share", args: ["app_1", "team:other/finance", "viewer"] },
    ]);
  });

  it("does not promote an app that already lives in an org", async () => {
    const { calls } = mount({ personal: false });
    await shareWith("Everyone at Acme");

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.some((call) => call.verb === "promote")).toBe(false);
  });

  it("says plainly that moving the app turns its automation off", async () => {
    // Promote DISARMS an automation: it runs with a person's access, and the
    // person who armed it may not be in the team.
    mount({ personal: true }, { automation: true });
    const note = await screen.findByText(/automations run with a person’s access/i);
    expect(note.textContent).toMatch(/off until someone turns it back on/i);
  });
});

/**
 * F6 — "Live sharing implies the org workspace" (design §8), ruled 2026-08-01 to
 * hold for EVERY principal. Sharing a personal app with a PERSON never promoted,
 * so the files stayed in the owner's `/user` mount and the grantee's agent opened
 * an empty directory.
 */
describe("ShareDialog — sharing with a person also promotes", () => {
  const soleOrg = [{ org: "acme", display: "Acme" }];
  /** What Acme's OWN identity system answers — Vendo has no directory (§9.1). */
  const roster = {
    "mia": { subject: "acme-mia", display: "Mia Nakamura" },
    "mia@acme.test": { subject: "acme-mia", display: "Mia Nakamura" },
  };

  it("promotes into the ONE asserted org, then grants", async () => {
    const { calls } = mount({ personal: true, memberships: soleOrg, roster });
    await choose(/specific person/i);
    await typePerson("mia@acme.test");
    clickShare();

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([
      { verb: "resolvePerson", args: ["app_1", "mia@acme.test"] },
      { verb: "promote", args: ["app_1", "acme"] },
      { verb: "share", args: ["app_1", "user:acme-mia", "viewer"] },
    ]);
  });

  it("ASKS which team when there are several — never silently the first", async () => {
    const { calls } = mount({ personal: true, roster });
    await choose(/specific person/i);
    await typePerson("mia");
    clickShare();

    // Nothing moved and nothing was granted: the dialog is waiting to be told
    // which team the app should live in.
    const orgPicker = await screen.findByLabelText("Which team to move it into");
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([]);

    // Once she says, both halves run against the org SHE chose.
    fireEvent.change(orgPicker, { target: { value: "other" } });
    clickShare();
    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([
      { verb: "resolvePerson", args: ["app_1", "mia"] },
      { verb: "promote", args: ["app_1", "other"] },
      { verb: "share", args: ["app_1", "user:acme-mia", "viewer"] },
    ]);
  });

  it("refuses in consumer voice and offers a copy when there is no team at all", async () => {
    // The spec's own fallback: "To hand someone a copy instead, fork."
    const { calls } = mount({ personal: true, memberships: [] });
    const note = await screen.findByText(/hand someone a copy/i);
    expect(note.textContent).not.toMatch(/promote|grant|fork\(|org:/);
    // ...and there is no way to write a grant that could never work.
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(calls.filter((call) => call.verb !== "grants")).toEqual([]);
  });
});

/**
 * B1 — a person-share used to encode whatever was typed VERBATIM as the subject,
 * so "Mia" became `user:Mia`: a grant that matched nobody. And because the same
 * wave made sharing imply promote, the app had ALREADY been moved into the team
 * by the time that useless grant landed. Vendo holds no directory (§9.1 — the
 * host's identity system IS the org), so the host names the person, and nothing
 * moves until it has.
 */
describe("ShareDialog — a person-share needs the HOST to name the person", () => {
  const soleOrg = [{ org: "acme", display: "Acme" }];
  const roster = { "mia": { subject: "acme-mia", display: "Mia Nakamura" } };

  it("does not offer to share with one person where the host has no directory", async () => {
    mount({ personal: true, memberships: soleOrg }, { namesPeople: false });
    const picker = await screen.findByLabelText("Who to share with");
    const labels = within(picker).getAllByRole("option").map((option) => option.textContent ?? "");
    expect(labels.some((label) => /specific person/i.test(label))).toBe(false);
    // Teams and orgs are untouched by the absence — this is one option, not a mode.
    expect(labels).toContain("Everyone at Acme");
  });

  it("grants the SUBJECT the host resolved, and confirms who that was", async () => {
    const { calls } = mount({ personal: false, memberships: soleOrg, roster });
    await choose(/specific person/i);
    await typePerson("Mia");
    clickShare();

    await waitFor(() => expect(calls.some((call) => call.verb === "share")).toBe(true));
    // Never `user:Mia`.
    expect(calls.find((call) => call.verb === "share")?.args)
      .toEqual(["app_1", "user:acme-mia", "viewer"]);
    // ...and the person is told WHO was matched, by name, so a wrong match is
    // visible instead of silent.
    expect((await screen.findByRole("status")).textContent).toMatch(/Mia Nakamura/);
  });

  it("leaves the app PERSONAL and ungranted when the host does not know them", async () => {
    // The whole defect in one case: the app must not move for a grant that is
    // never going to be written.
    const { calls } = mount({ personal: true, memberships: soleOrg, roster });
    await choose(/specific person/i);
    await typePerson("Mia from the other company");
    clickShare();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn’t find|copy/i);
    expect(alert.textContent).not.toMatch(/user:|principal|subject|resolvePerson/);
    expect(calls.some((call) => call.verb === "promote")).toBe(false);
    expect(calls.some((call) => call.verb === "share")).toBe(false);
  });

  it("says they have no team to share into, rather than talking about ownership", async () => {
    // The door refuses an owner who is in NO org: a person-share implies an org
    // workspace (§9.5), so the lookup could only ever expose the host's
    // directory. `forbidden` normally means "only an owner may do this", which is
    // the one thing this person definitely IS — so the naming step answers for
    // itself.
    const { calls } = mount({
      personal: false,
      memberships: soleOrg,
      roster,
      resolveFails: Object.assign(new Error("no org is asserted for this caller"), { code: "forbidden" }),
    });
    await choose(/specific person/i);
    await typePerson("Mia");
    clickShare();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/team/i);
    expect(alert.textContent).toMatch(/copy/i);
    expect(alert.textContent).not.toMatch(/owner/i);
    expect(calls.some((call) => call.verb === "promote")).toBe(false);
    expect(calls.some((call) => call.verb === "share")).toBe(false);
  });

  it("says so in the consumer's voice when the lookup is not set up at all", async () => {
    // A host that mounted the dialog with the option on but wired no seam. The
    // wire's own sentence names a config key; this one names what they can do.
    const { calls } = mount({
      personal: true,
      memberships: soleOrg,
      roster,
      resolveFails: Object.assign(new Error("needs the auth preset's `resolvePerson` seam"), {
        code: "not-implemented",
      }),
    });
    await choose(/specific person/i);
    await typePerson("Mia");
    clickShare();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/isn’t set up here/i);
    expect(alert.textContent).toMatch(/team|copy/i);
    expect(alert.textContent).not.toMatch(/resolvePerson|auth preset|seam/);
    expect(calls.some((call) => call.verb === "promote")).toBe(false);
    expect(calls.some((call) => call.verb === "share")).toBe(false);
  });
});

/**
 * F12 — the picker exposed the raw grant grammar, promised a "Person" option
 * that did not exist, and turned an unparseable principal into a grant row that
 * could never match.
 */
describe("ShareDialog — the picker speaks human", () => {
  it("never shows the encoding, only what each principal IS", async () => {
    mount({ personal: false });
    const picker = await screen.findByLabelText("Who to share with");
    const labels = within(picker).getAllByRole("option").map((option) => option.textContent ?? "");
    expect(labels.some((label) => /team:|org:|user:|\//.test(label))).toBe(false);
    expect(labels).toContain("The finance team");
    expect(labels).toContain("Everyone at Acme");
    // The promise the old placeholder made, now kept.
    expect(labels.some((label) => /specific person/i.test(label))).toBe(true);
  });

  it("refuses an empty person in consumer voice instead of writing a dead grant row", async () => {
    const { calls } = mount({ personal: false });
    await choose(/specific person/i);
    await typePerson("   ");
    clickShare();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/who/i);
    expect(alert.textContent).not.toMatch(/user:|principal|encoding/);
    expect(calls.some((call) => call.verb === "share")).toBe(false);
  });
});

/**
 * F1 + F2 — the wire's sentences are written for the HOST DEVELOPER: one names
 * an environment variable, the other is a TypeScript snippet. Both reached a
 * bank customer's screen verbatim, on every keyless (default OSS) deployment.
 */
describe("ShareDialog — refusals in the consumer's voice", () => {
  const cloudRequired = (message: string): Error =>
    Object.assign(new Error(message), { code: "cloud-required" });

  it("renders a consumer sentence for a keyless deployment, never the env var", async () => {
    const { calls } = mount({
      personal: false,
      shareFails: cloudRequired(
        "sharing needs Vendo Cloud: set VENDO_API_KEY (or pass a hosted store)"
        + " — apps you own alone keep working without it",
      ),
    });
    await shareWith("Everyone at Acme");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/VENDO_API_KEY|hosted store|Vendo Cloud/);
    expect(alert.textContent).toMatch(/isn’t turned on/i);
    expect(calls.some((call) => call.verb === "share")).toBe(true);
  });

  it("renders a consumer sentence when the MOVE is refused, never the code snippet", async () => {
    const { calls } = mount({
      personal: true,
      promoteFails: cloudRequired(
        "moving an app into a team workspace isn't available on the hosted store yet — "
        + "wire your own Postgres with createVendo({ store: createStore({ url }) }) to move it, "
        + "or share a copy with fork instead",
      ),
    });
    await shareWith("Everyone at Acme");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/createVendo|createStore|Postgres|hosted store/);
    expect(alert.textContent).toMatch(/copy/i);
    // The move failed, so no grant was written on top of it.
    expect(calls.some((call) => call.verb === "share")).toBe(false);
  });

  it("keeps a viewer's own refusal consumer-voiced too", async () => {
    mount({
      personal: false,
      shareFails: Object.assign(new Error("owner access is required for app_7c2f9b"), { code: "forbidden" }),
    });
    await shareWith("Everyone at Acme");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/app_7c2f9b|access is required/);
    expect(alert.textContent).toMatch(/owner/i);
  });
});
