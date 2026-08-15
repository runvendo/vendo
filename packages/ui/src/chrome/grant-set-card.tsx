import { serviceToolSlug, type ApprovalRequest, type RiskLabel } from "@vendoai/core";
import { useState } from "react";
import { useVendoTools } from "../context.js";
import { toolPresentation } from "./build-beat.js";
import {
  CardActions,
  CardHead,
  CardLine,
  CardList,
  CardShell,
  CARD_EYEBROWS,
  TICK_GLYPH,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";

/** demo-live-readiness 2026-07 — the grant-SET consent card (approved mockup,
 * section 2): an automation that needs several standing grants asks for ALL of
 * them in one card — every permission enumerated, ONE Approve that grants the
 * whole set, one Deny that declines it. The decided card stays in the
 * transcript as the settled record ("Enabled · N permissions granted" /
 * "Denied — the automation stays paused."). Presentational: the caller owns
 * deciding the guard approvals and resuming the parked turn.
 *
 * spec §16 — contents only: the geometry is the one card shell.
 */

export interface GrantSetPermission {
  /** The pending guard approval this row settles. */
  approvalId: string;
  tool: string;
  /** The service action this row is for, when the tool is the connector
      dispatcher. It, not the tool name, is what the person is allowing — two
      service actions on one card are otherwise the same row twice. */
  slug?: string;
  risk: RiskLabel;
}

/** The consent rows for a set of pending asks — ONE mapping for every surface
    that renders them (the workspace panel's arming and failed-run cards, and
    the in-thread automation consent), so a permission reads the same words
    everywhere. A connector ask is FOR its service action, not the dispatcher —
    two service actions on one card are otherwise the same row twice. */
export function grantSetPermissions(asks: readonly ApprovalRequest[]): GrantSetPermission[] {
  return asks.map(ask => {
    const slug = serviceToolSlug(ask.call);
    return {
      approvalId: ask.id,
      tool: ask.call.tool,
      ...(slug === undefined ? {} : { slug }),
      risk: ask.descriptor.risk,
    };
  });
}

/** What a permission LETS the automation do, in our words. spec §16 law 3 —
 *  a grant row used to print the tool descriptor's `description`, and that
 *  sentence is authored for the MODEL: demo-bank's own catalog put "Amounts are
 *  integer cents (e.g. 285000 = $2,850.00): divide by 100 exactly once before
 *  displaying" on a bank customer's consent card (live, `standing-01-pending`).
 *  The row now says the verb and the thing — the cadence is the card's own
 *  plain-words line — and the only sentence allowed under it is one the HOST
 *  wrote for people (`ToolMeta.description`). Shared across consent cards so
 *  both consent surfaces speak one vocabulary. */
const RISK_WORD: Record<string, string> = {
  read: "Reads",
  write: "Changes",
  // Ruling 15 — an irreversible permission may NEVER share a word with an
  // ordinary write. This is the approval card's own chip vocabulary, so one
  // grade reads the same on every consent surface.
  destructive: "Irreversible",
  // #747's word for the state, taken verbatim from the approval card's chip.
  ungraded: "Not reviewed",
};

/**
 * The word a permission row leads with — FROM THE GRADE, and only the grade.
 *
 * This briefly took the word from the ask's own verb instead (ruling 15, to
 * stop a `read`-graded send tool rendering "Reads: Email send"). Yousef's
 * grading ruling retires that mechanism: no code path may conclude anything
 * from a tool's NAME, because a word list misses silently and its existence
 * reads as coverage. The honest fix for a mis-graded tool is to fix the GRADE —
 * the judge and `overrides.json` exist for exactly that — not to have the
 * highest-stakes card in the product second-guess it from a slug.
 *
 * An UNGRADED permission says so. It may not borrow "Reads": that is the
 * safest-sounding word available and the one thing nobody has established.
 */
export function grantRowWord(risk: RiskLabel | string): string {
  return RISK_WORD[risk] ?? RISK_WORD.ungraded!;
}

export interface GrantSetCardProps {
  /** The automation's display name. */
  name: string;
  permissions: GrantSetPermission[];
  /** parked → actionable; approved/denied → the settled record. */
  state: "parked" | "approved" | "denied";
  onDecide?(approve: boolean): void | PromiseLike<void>;
}

const permissionCount = (count: number): string => count === 1 ? "1 permission" : `${count} permissions`;

/** Mockup copy: "Allow both & enable" for the pair; sensible words either side. */
export function allowLabel(count: number): string {
  if (count === 1) return "Allow & enable";
  if (count === 2) return "Allow both & enable";
  return `Allow all ${count} & enable`;
}

const revokePronoun = (count: number): string =>
  count === 1 ? "it" : count === 2 ? "either" : "any of them";

/** The consumer's half of a refusal (spec §16 law 3) — the same defect the
 *  connect card carried: this card rendered whatever `onDecide` threw, and the
 *  wire's sentences carry app and grant-set ids. `refusalCopy` here
 *  is the pattern; the developer sentence keeps its home in the server log. */
function refusalCopy(reason: unknown): string {
  const code = (reason as { code?: unknown } | null)?.code;
  if (code === "not-found") return "This automation isn’t available any more.";
  if (code === "forbidden") return "Only someone who can edit this app can allow these.";
  if (code === "conflict") return "Someone else already decided this one.";
  if (code === "cloud-required") return "Standing access isn’t turned on for this workspace yet.";
  return "That didn’t go through — nothing was granted. Try again in a moment.";
}

export function GrantSetCard({ name, permissions, state, onDecide }: GrantSetCardProps) {
  const tools = useVendoTools();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const decide = async (approve: boolean) => {
    if (onDecide === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await onDecide(approve);
    } catch (reason) {
      setError(refusalCopy(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot>
      <CardShell
        label={`Standing access — ${name}`}
        className="fl-approval fl-grantset fl-item-in"
        data-vendo-grant-set-card=""
        data-state={state}
      >
        <CardHead
          eyebrow={CARD_EYEBROWS.standingAccess}
          title={`${name} needs ${permissionCount(permissions.length)}`}
        />
        <CardLine>
          Granted once, used every run. You can revoke {revokePronoun(permissions.length)} any time in Settings.
        </CardLine>
        <CardList className="fl-grants">
          {permissions.map(permission => {
            const presentation = toolPresentation(
              permission.tool,
              permission.slug === undefined ? undefined : { slug: permission.slug },
              tools[permission.tool],
            );
            // Host-authored only: `toolPresentation` carries `ToolMeta.description`
            // (the host's own sentence) or one we compose ourselves — never the
            // descriptor's model-facing line. A connector row's `slug` reaches
            // presentation above, so the service action names itself without
            // that line being needed.
            const description = (presentation.description ?? "").trim();
            return (
              <li className="fl-grant" key={permission.approvalId}>
                {/* A glyph is DRAWN for a well; a brand's logo is not — the 28px
                    well's radius and fill cropped the real marks (the Gmail M),
                    which is the defect the connect row was redrawn for. So a row
                    that has a logo shows it RAW, and a host tool's glyph keeps
                    the well it was drawn for (law 2's one size, unchanged). */}
                <ToolkitLogo
                  className={presentation.logoUrl === undefined ? "fl-card-ic" : "fl-mark-raw"}
                  {...(presentation.logoUrl === undefined ? {} : { src: presentation.logoUrl })}
                />
                <span className="fl-grant-copy">
                  <b>{grantRowWord(permission.risk)}: {presentation.title}</b>
                  {description.length > 0 ? <span>{description}</span> : null}
                </span>
                {state === "approved" ? (
                  <span className="fl-grant-check" aria-hidden="true">{TICK_GLYPH}</span>
                ) : null}
              </li>
            );
          })}
        </CardList>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {state === "parked" ? (
          <CardActions>
            <button className="fl-btn fl-btn-primary" type="button" disabled={busy} onClick={() => void decide(true)}>
              {allowLabel(permissions.length)}
            </button>
            <button className="fl-btn" type="button" disabled={busy} onClick={() => void decide(false)}>Deny</button>
          </CardActions>
        ) : (
          <div className="fl-grantset-outcome" role="status">
            {state === "approved" ? (
              <>
                <span className="fl-connect-done-ic" aria-hidden="true">{TICK_GLYPH}</span>
                Enabled · {permissionCount(permissions.length)} granted
              </>
            ) : (
              <>Denied — the automation stays paused.</>
            )}
          </div>
        )}
      </CardShell>
    </ChromeRoot>
  );
}
