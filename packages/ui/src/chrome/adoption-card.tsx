import { VendoError, type ApprovalRequest } from "@vendoai/core";
import { useState } from "react";
import { useVendoProvider, useVendoTools } from "../context.js";
import type { AdoptionVenue } from "../wire-types.js";
import { toolPresentation } from "./build-beat.js";
import {
  CardActions,
  CardHead,
  CardLine,
  CardList,
  CardShell,
  CARD_EYEBROWS,
  SHIELD_GLYPH,
  TICK_GLYPH,
  ToolkitLogo,
} from "./card-shell.js";
import { ChromeRoot } from "./chrome-root.js";
import { GrantSetCard, grantRowWord } from "./grant-set-card.js";

/** Build contract §9.9 / design §13 — the adoption card.
 *
 * An automation always runs as a named person. When that sponsorship lapses —
 * they left, their permissions went, or somebody else edited the app — the
 * automation STOPS and this card waits IN the app for whoever can edit it. It
 * is not an approval addressed to a set of people (approvals stay strictly
 * self-subject): the first editor to open the app and take it on approves the
 * automation's reads and writes AS THEMSELVES.
 *
 * Presentational, like {@link GrantSetCard}: the caller owns the adopt call and
 * the approvals that follow it.
 */

export interface AdoptionCardProps {
  card: AdoptionVenue;
  /** waiting → actionable; adopted → the settled record. */
  state?: "waiting" | "adopted";
  onAdopt?(): void | PromiseLike<void>;
}

/** `sponsor` is absent once that person's data is erased, and then the card stays
 *  anonymous instead of naming somebody it no longer knows. */
const STOPPED_BECAUSE: Record<AdoptionVenue["reason"], (sponsor: string | undefined) => string> = {
  edit: (sponsor) => `It changed after ${sponsor ?? "the person who set it up"} allowed it, so it is paused.`,
  departure: (sponsor) => sponsor === undefined
    ? "The person it ran as no longer has access to this app, so it is paused."
    : `${sponsor} no longer has access to this app, so it is paused.`,
  grants: (sponsor) =>
    `${sponsor ?? "The person who set it up"}'s permissions for this app were removed, so it is paused.`,
};

/**
 * The consumer's half of a refusal (design §3, the consumer-voice law). Every
 * sentence the wire throws is written for the HOST DEVELOPER — one names an
 * environment variable, another carries an app id — and rendering
 * `reason.message` put all of them in front of whoever was using the app. The
 * developer sentence keeps its home (the server's own error, the browser
 * console); the person looking at this card is told what it means for THEM.
 * Same treatment the Share dialog (`refusalCopy`) and the apps page
 * (`refusalSentence`) already carry.
 */
function refusalCopy(reason: unknown): string {
  const code = (reason as { code?: unknown } | null)?.code;
  // §9.9 — the first editor to accept wins, and the loser is told what actually
  // happened rather than "something went wrong".
  if (code === "conflict") return "Someone else already took this automation on.";
  if (code === "forbidden") return "Only someone who can edit this app can take its automation on.";
  if (code === "not-found") return "This automation isn’t available any more.";
  if (code === "cloud-required") return "Taking an automation on isn’t turned on for this workspace yet.";
  return "That didn’t go through — nothing changed. Try again in a moment.";
}

/** The declared arguments, as the automation will actually send them: "invoice
 *  inv_42". §12 wants the material arguments on the card, not a promise that
 *  they exist somewhere. */
function argsLine(args: Record<string, string> | undefined): string | undefined {
  if (args === undefined) return undefined;
  const parts = Object.entries(args).map(([key, value]) => `${key} ${value}`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

export function AdoptionCard({ card, state = "waiting", onAdopt }: AdoptionCardProps) {
  const tools = useVendoTools();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const adopt = async () => {
    if (onAdopt === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await onAdopt();
    } catch (reason) {
      setError(refusalCopy(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ChromeRoot>
      <CardShell
        label={`Take on — ${card.automation}`}
        className="fl-approval fl-grantset fl-item-in"
        data-vendo-adoption-card=""
        data-state={state}
      >
        <CardHead
          icon={<ToolkitLogo fallback={SHIELD_GLYPH} />}
          eyebrow={CARD_EYEBROWS.pausedAdoption}
          title={card.sponsor === undefined
            ? `${card.automation} is paused`
            : `${card.automation} ran with ${card.sponsor}'s access`}
        />
        <CardLine>
          {STOPPED_BECAUSE[card.reason](card.sponsor)} Take it on and it runs with yours instead.
        </CardLine>
        <CardList className="fl-grants">
          {card.needs.map((need, index) => {
            const presentation = toolPresentation(need.tool, undefined, tools[need.tool]);
            // Host-authored only — `need.description` is the tool descriptor's
            // model-facing line (see RISK_WORD).
            const description = (presentation.description ?? "").trim();
            const args = argsLine(need.args);
            return (
              // One line per read and write, in the order they happen: two calls
              // to the same tool are two lines, so the key is positional.
              <li className="fl-grant" key={`${need.tool}-${index}`}>
                <ToolkitLogo {...(presentation.logoUrl === undefined ? {} : { src: presentation.logoUrl })} />
                <span className="fl-grant-copy">
                  <b>{grantRowWord(need.risk)}: {presentation.title || need.title}</b>
                  {description.length > 0 ? <span>{description}</span> : null}
                  {args === undefined ? null : <span>{args}</span>}
                </span>
              </li>
            );
          })}
        </CardList>
        {error ? <div role="alert" className="fl-error">{error}</div> : null}
        {state === "waiting" ? (
          <CardActions>
            <button className="fl-btn fl-btn-primary" type="button" disabled={busy} onClick={() => void adopt()}>
              Take it on
            </button>
          </CardActions>
        ) : (
          <div className="fl-grantset-outcome" role="status">
            <span className="fl-connect-done-ic" aria-hidden="true">{TICK_GLYPH}</span>
            Running again with your access
          </div>
        )}
      </CardShell>
    </ChromeRoot>
  );
}

/** The payload key the adoption ask rides on the app's open surface
 *  (`payload.adoption`). Re-exported from core (integration, 2026-08-01) so
 *  the renderer, the composition seam and the automations engine all read ONE
 *  definition — the server composes the key but cannot import this file. */
export { ADOPTION_VENUE_KEY } from "@vendoai/core";

/**
 * The card as the APP SURFACE renders it: bound to the client, so taking it on
 * posts through the adopt door and then walks the adopter through the rest of
 * the ceremony.
 *
 * Adoption is TWO steps, and the card must not skip the second: taking it on
 * re-mints the automation's grants under the adopter, and until they decide that
 * set the automation is NOT running. So a non-empty `missing` renders the same
 * enable-flow set card the panel uses, and only an empty one — or an approved
 * set — says it runs again.
 *
 * Split from the presentational card for the same reason every other chrome
 * surface is: the tree renderer mounts this from the payload's venue state,
 * while the card itself stays testable and reusable with no transport.
 */
export function AdoptionVenueCard({ card }: { card: AdoptionVenue }) {
  const { client } = useVendoProvider();
  const [state, setState] = useState<"waiting" | "adopted">("waiting");
  const [set, setSet] = useState<{
    asks: ApprovalRequest[];
    grantSetId?: string;
    state: "parked" | "denied";
  }>();

  if (set !== undefined) {
    return (
      <GrantSetCard
        name={card.automation}
        permissions={set.asks.map((ask) => ({
          approvalId: ask.id,
          tool: ask.call.tool,
          risk: ask.descriptor.risk,
        }))}
        state={set.state}
        onDecide={async (approve) => {
          await client.approvals.decide(
            set.asks.map((ask) => ask.id),
            { approve },
            set.grantSetId === undefined ? undefined : { grantSetId: set.grantSetId },
          );
          if (!approve) {
            // Declining leaves the automation theirs but ungranted — the set
            // card's own settled record ("the automation stays paused") is the
            // honest thing to leave on screen.
            setSet({ ...set, state: "denied" });
            return;
          }
          setSet(undefined);
          setState("adopted");
        }}
      />
    );
  }

  return (
    <AdoptionCard
      card={card}
      state={state}
      onAdopt={async () => {
        const result = await client.automations.adopt(card.appId, card.triggerId);
        // A lost race is not an error to swallow: the person who tapped is told
        // that somebody else got there first, which is what actually happened.
        // Raised WITH its code so the card's own copy names it — the card owns
        // every consumer sentence it shows, and a message smuggled up from a
        // caller is the shape that let developer sentences onto the screen.
        if (!result.adopted) throw new VendoError("conflict", `adoption of ${card.appId} was lost to another editor`);
        if (result.missing.length > 0) {
          setSet({
            asks: result.missing,
            ...(result.grantSetId === undefined ? {} : { grantSetId: result.grantSetId }),
            state: "parked",
          });
          return;
        }
        setState("adopted");
      }}
    />
  );
}
