import {
  encodeGrantPrincipal,
  parseGrantPrincipal,
  type AccessLevel,
  type AppId,
  type Membership,
  type ResolvedPerson,
} from "@vendoai/core";
import { useState } from "react";
import { useAppGrants } from "../hooks/use-app-grants.js";
import { ChromeRoot } from "./chrome-root.js";

/**
 * Build contract §9.2–§9.6 — the Share dialog: the ONE surface that writes
 * app-access grants. Pick a principal (a person, a team, or the whole org) and
 * a level; the list below is who reaches the app today, each row revocable.
 *
 * "Share implies promote" (§9.5): handing a personal app to an org moves the
 * canonical copy into that org first, so there is one living app rather than
 * two drifting copies. The dialog says so before it does it.
 */

const LEVELS: Array<{ value: AccessLevel; label: string }> = [
  { value: "viewer", label: "Can view" },
  { value: "editor", label: "Can edit" },
  { value: "owner", label: "Can share" },
];

/** Said in two places — the standing note when a non-owner opens the dialog, and
    the refusal when a write comes back `forbidden`. One string, so the two can
    never tell the same person two different things. */
const OWNER_ONLY = "Only an owner can change who this app is shared with.";

/** The frozen §9.2 encoding lives in core, next to the parser that reads it —
    ONE encoder, so a surface can never write a shape `can()` cannot match. The
    dialog re-exports it because the pinned chrome surface names it here. */
export { encodeGrantPrincipal };

/** The picker's value for "a specific person". It is deliberately not a
    principal encoding: a person has to be typed (Vendo has no org chart of its
    own, §9.1), and the encoding is minted from what they type. */
const PERSON = "person";

/**
 * The consumer's half of a refusal. Every sentence the wire throws is written
 * for the HOST DEVELOPER — one names an environment variable, another is a
 * TypeScript snippet — and rendering `reason.message` put both on a bank
 * customer's screen, on every keyless (default OSS) deployment. The developer
 * sentence stays where developers read it (the server's own error); the person
 * reading this dialog is told what it means for THEM (design §3, the consumer
 * voice law).
 */
function refusalCopy(reason: unknown, phase: "move" | "share" | "remove" | "name"): string {
  const code = (reason as { code?: unknown } | null)?.code;
  // A vanished app reads the same in every phase, naming included.
  if (code === "not-found") return "This app isn’t available any more.";
  // The NAMING step answers for itself, before the shared codes: `forbidden`
  // there does not mean "only an owner may do this" — the person asking IS the
  // owner. It means the door refused because they hold no asserted org, so a
  // person-share could never complete and the lookup would be pure directory
  // exposure (§9.1 companion).
  if (phase === "name") {
    if (code === "not-implemented") {
      return "Sharing with one person isn’t set up here"
        + " — you can share with a team, or hand them a copy.";
    }
    if (code === "forbidden") {
      return "You’re not in a team here, so there’s nobody to share it with"
        + " — you can hand them a copy instead.";
    }
    return "We couldn’t look them up just now — try again in a moment.";
  }
  if (code === "forbidden") return OWNER_ONLY;
  if (phase === "move") {
    if (code === "cloud-required") {
      return "Moving this app into a team isn’t available here yet."
        + " You can still hand someone a copy of it instead.";
    }
    if (code === "validation") return "This app can’t be moved into that team.";
    return "The move didn’t go through. Nothing changed.";
  }
  if (phase === "remove") {
    if (code === "cloud-required") {
      return "Changing who this app is shared with isn’t turned on for this workspace yet.";
    }
    return "That access wasn’t removed — try again in a moment.";
  }
  if (code === "cloud-required") return "Sharing with your team isn’t turned on for this workspace yet.";
  if (code === "validation") return "This app can’t be shared with them yet.";
  return "Sharing didn’t go through — try again in a moment.";
}

/** Consumer voice, not the encoding: "the finance team", not "team:acme/finance". */
function describePrincipal(encoded: string, memberships: readonly Membership[]): string {
  const named = parseGrantPrincipal(encoded);
  if (named === undefined) return encoded;
  if (named.kind === "user") return named.subject;
  if (named.kind === "team") return `The ${named.team} team`;
  return memberships.find((membership) => membership.org === named.org)?.display
    ?? `Everyone at ${named.org}`;
}

export interface ShareDialogProps {
  appId: AppId;
  /** The app's display name, for the "moves into" sentence. */
  appName?: string;
  /** The orgs and teams the host asserted for this caller — the only
      principals a share can name (§9.1: Vendo has no org chart of its own). */
  memberships?: readonly Membership[];
  /** Build contract §9.1 companion — the host can turn a typed name into one of
      its own subjects (the `resolvePerson` auth-preset seam, echoed by
      /status). False ⇒ sharing with ONE PERSON is not offered at all: Vendo has
      no directory, and encoding what was typed wrote a grant matching nobody.
      Teams, orgs and fork are unaffected either way. */
  namesPeople?: boolean;
  /** The app declares an automation. Moving it into a team turns that
      automation OFF, and the dialog says so before it happens (§9.5). */
  automation?: boolean;
  onClose?(): void;
}

export function ShareDialog({
  appId,
  appName,
  memberships = [],
  namesPeople = false,
  automation = false,
  onClose,
}: ShareDialogProps) {
  // Whether this is still the caller's own copy comes from the SAME read that
  // answers their level — no caller can forget to pass it, which is exactly how
  // "share implies promote" never fired in the shipped surface.
  const { level, grants, personal, isLoading, share, unshare, promote, resolvePerson } = useAppGrants(appId);
  const [target, setTarget] = useState("");
  const [person, setPerson] = useState("");
  /** Which org a person-share moves the app into, when the caller belongs to
      more than one and the choice is therefore theirs to make. */
  const [moveInto, setMoveInto] = useState("");
  const [nextLevel, setNextLevel] = useState<AccessLevel>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** The org this app was just moved into, so the note that follows a move is
      about what happened, not about what might. */
  const [moved, setMoved] = useState<string>();
  /** The NAME the host resolved for a person-share. It is the one thing on this
      surface the person did not choose themselves — they typed "mia" and the
      host picked a subject — and the grant list can only show that subject, so
      without this a wrong match is silent. A team or org share needs no such
      note: its label is what they picked, still on screen. */
  const [sharedWith, setSharedWith] = useState<string>();

  const canShare = level === "owner";
  const orgs = memberships.map((membership) => membership.org);
  const nameOf = (org: string): string =>
    memberships.find((membership) => membership.org === org)?.display ?? org;
  /** Human labels, always — the §9.2 encoding rides underneath as the option's
      value, where nobody has to read it (F12: the old input put
      `team:acme/finance` in front of the person using it). Each option carries
      the org it belongs to, so "share implies promote" never has to re-parse an
      encoding this file just produced. */
  const options: Array<{ value: string; label: string; org?: string }> = [
    ...memberships.flatMap((membership) => [
      {
        value: encodeGrantPrincipal({ kind: "org", org: membership.org }),
        label: `Everyone at ${nameOf(membership.org)}`,
        org: membership.org,
      },
      ...(membership.teams ?? []).map((team) => ({
        value: encodeGrantPrincipal({ kind: "team", org: membership.org, team }),
        label: `The ${team} team`,
        org: membership.org,
      })),
    ]),
    // The option the old placeholder promised and never offered — and only where
    // the host can actually name a person (§9.1 companion).
    ...(namesPeople ? [{ value: PERSON, label: "A specific person…" }] : []),
  ];
  /** A personal app has to MOVE before anyone else can reach it live (§9.5), and
      with no team asserted there is nowhere for it to go. */
  const nowhereToShare = personal && orgs.length === 0;
  /** A person-share of a personal app needs an org, and with several asserted
      the dialog asks rather than picking one. */
  const asksWhichTeam = personal && target === PERSON && orgs.length > 1;

  const run = async (
    phase: "move" | "share" | "remove" | "name",
    work: () => Promise<void>,
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (reason) {
      setError(refusalCopy(reason, phase));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    const chosen = target.trim();
    if (chosen === "") {
      setError("Choose who to share this with.");
      return;
    }
    const typed = person.trim();
    if (chosen === PERSON && typed === "") {
      setError("Say who you’re sharing this with — the name or email they use at work.");
      return;
    }
    const option = options.find((entry) => entry.value === chosen);
    // §9.5 — "share implies promote", for EVERY principal (design §8: live
    // sharing implies the org workspace). A team share moves the app into the
    // org THAT SHARE NAMES; a person share has no org in it, so it moves into
    // the caller's one asserted org, or the one they chose.
    const into = chosen === PERSON ? (orgs.length === 1 ? orgs[0] : moveInto) : option?.org;
    if (personal && (into === undefined || into === "")) {
      setError("Choose which team this app should live in first.");
      return;
    }
    // A person is TYPED, not listed, and Vendo has no directory of its own
    // (§9.1) — so the host names them, and it happens BEFORE anything moves.
    // The dialog used to encode what was typed as the subject, which promoted
    // the app into the team and then wrote a grant that matched nobody.
    let principal = chosen;
    let matched: string | undefined;
    if (chosen === PERSON) {
      let found: ResolvedPerson | null | undefined;
      await run("name", async () => { found = await resolvePerson(typed); });
      // The lookup itself failed and has already been explained.
      if (found === undefined) return;
      if (found === null) {
        setError(
          `We couldn’t find ${typed} here. Check how it’s spelled,`
          + " or hand them a copy of the app instead.",
        );
        return;
      }
      principal = encodeGrantPrincipal({ kind: "user", subject: found.subject });
      matched = found.display ?? found.subject;
    }
    if (personal && into !== undefined && into !== "") {
      let landed = false;
      await run("move", async () => {
        await promote(into);
        setMoved(into);
        landed = true;
      });
      // The app did not move, so a grant on top of it would name a workspace it
      // is not in — and the person has already been told why.
      if (!landed) return;
    }
    await run("share", async () => {
      await share(principal, nextLevel);
      setSharedWith(matched);
      setTarget("");
      setPerson("");
    });
  };

  return (
    <ChromeRoot>
      <div className="fl-share">
        <div className="fl-share-head">
          <div className="fl-share-title">Share{appName === undefined ? "" : ` ${appName}`}</div>
          {onClose === undefined ? null : (
            <button type="button" className="fl-btn fl-btn-quiet" onClick={onClose}>Done</button>
          )}
        </div>

        {/* Nothing is said about access until the first read has answered: `null`
            is also what the hook holds while it is still in flight, so rendering
            it told every caller they had no access for as long as the fetch took. */}
        {canShare || isLoading ? null : (
          <p className="fl-share-note">
            {level === null ? "You don’t have access to this app." : OWNER_ONLY}
          </p>
        )}

        {canShare && personal && orgs.length > 0 ? (
          <p className="fl-share-note">
            This is your own copy. Sharing it moves it into your team, so everyone works on
            the same one.
            {automation ? " Its automation turns off in the move — automations run with a person’s"
              + " access, so it stays off until someone turns it back on." : ""}
          </p>
        ) : null}

        {/* The permission-shaped empty state: a personal app can only be shared
            live by moving into a team, and there is no team here. The spec's own
            fallback, in the person's words rather than the API's. */}
        {canShare && nowhereToShare ? (
          <p className="fl-share-note">
            This app is just yours. Sharing it live needs a team workspace, and there isn’t one
            here — you can still hand someone a copy of it instead.
          </p>
        ) : null}

        {moved === undefined ? null : (
          <p className="fl-share-note" role="status">
            Moved into <b>{nameOf(moved)}</b>.
            {automation ? " Its automation is off until someone turns it back on — automations run"
              + " with a person’s access." : ""}
          </p>
        )}

        {/* Who the host matched, by name — so the wrong Mia is visible rather
            than silent (the row below can only carry her subject). */}
        {sharedWith === undefined ? null : (
          <p className="fl-share-note" role="status">Shared with <b>{sharedWith}</b>.</p>
        )}

        {canShare && !nowhereToShare ? (
          <>
            <div className="fl-share-add">
              <select
                className="fl-share-input"
                value={target}
                aria-label="Who to share with"
                disabled={busy}
                onChange={(event) => { setTarget(event.target.value); setError(undefined); }}
              >
                <option value="">Choose who…</option>
                {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
              <select
                className="fl-share-level"
                value={nextLevel}
                aria-label="Access level"
                disabled={busy}
                onChange={(event) => setNextLevel(event.target.value as AccessLevel)}
              >
                {LEVELS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
              <button type="button" className="fl-btn fl-btn-primary" disabled={busy || target === ""} onClick={() => void submit()}>
                Share
              </button>
            </div>

            {/* Vendo has no directory of its own (§9.1), so a person is typed and
                the HOST looks them up. The label says so: what goes in is a
                search, not an identifier, and the grant is written for whoever
                comes back. The field appears with its own label rather than as a
                placeholder, because it arrives mid-task and has to explain
                itself. */}
            {target === PERSON ? (
              <div className="fl-share-field">
                <label className="fl-share-note" htmlFor={`fl-share-person-${appId}`}>
                  Look them up by name or email
                </label>
                <input
                  id={`fl-share-person-${appId}`}
                  className="fl-share-input"
                  value={person}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => { setPerson(event.target.value); setError(undefined); }}
                />
              </div>
            ) : null}

            {asksWhichTeam ? (
              <div className="fl-share-field">
                <label className="fl-share-note" htmlFor={`fl-share-org-${appId}`}>
                  Which team to move it into
                </label>
                <select
                  id={`fl-share-org-${appId}`}
                  className="fl-share-input"
                  value={moveInto}
                  disabled={busy}
                  onChange={(event) => { setMoveInto(event.target.value); setError(undefined); }}
                >
                  <option value="">Choose a team…</option>
                  {orgs.map((org) => <option key={org} value={org}>{nameOf(org)}</option>)}
                </select>
              </div>
            ) : null}
          </>
        ) : null}

        {error === undefined ? null : <p className="fl-share-error" role="alert">{error}</p>}

        <ul className="fl-share-list">
          {isLoading && grants.length === 0 ? <li className="fl-share-empty">Loading…</li> : null}
          {!isLoading && grants.length === 0 ? (
            <li className="fl-share-empty">Nobody else yet — it’s just you.</li>
          ) : null}
          {grants.map((grant) => (
            <li key={grant.id} className="fl-share-row">
              <span className="fl-share-who">{describePrincipal(grant.principal, memberships)}</span>
              <span className="fl-share-lvl">{LEVELS.find((entry) => entry.value === grant.level)?.label ?? grant.level}</span>
              {canShare ? (
                <button
                  type="button"
                  className="fl-btn fl-btn-quiet fl-share-revoke"
                  disabled={busy}
                  onClick={() => void run("remove", () => unshare(grant.principal))}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </ChromeRoot>
  );
}

export interface ForkOfferProps {
  /** What the person was trying to change, in their words. */
  instruction?: string;
  onFork(): void | PromiseLike<void>;
  onDismiss?(): void;
}

/**
 * Build contract §9.4 — what a VIEWER sees instead of a bare refusal. The
 * `forbidden` code exists precisely so this can be offered: the caller
 * provably sees the app, so "you can't" is answerable with "…but here's what
 * you can do".
 */
export function ForkOffer({ instruction, onFork, onDismiss }: ForkOfferProps) {
  const [busy, setBusy] = useState(false);
  return (
    // The class lives on an INNER div, not on ChromeRoot: a NESTED ChromeRoot
    // returns a bare fragment (chrome-root.tsx), so a container class handed to it
    // silently disappears — which is every mount inside another surface.
    <ChromeRoot>
      <div className="fl-share-fork">
        <p className="fl-share-fork-copy">
          I can’t change the team’s copy{instruction === undefined ? "" : ` to ${instruction}`} — but I can make you your own.
        </p>
        <div className="fl-share-fork-actions">
          <button
            type="button"
            className="fl-btn fl-btn-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(onFork()).finally(() => setBusy(false));
            }}
          >
            Make me my own copy
          </button>
          {onDismiss === undefined ? null : (
            <button type="button" className="fl-btn fl-btn-quiet" onClick={onDismiss}>Never mind</button>
          )}
        </div>
      </div>
    </ChromeRoot>
  );
}
