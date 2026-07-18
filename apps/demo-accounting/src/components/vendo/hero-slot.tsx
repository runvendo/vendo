"use client";

import { useEffect, useState } from "react";
import type { UIPayload } from "@vendoai/core";
import { useSlotApp } from "@vendoai/ui";
import { VendoSlot } from "@vendoai/ui/chrome";
import { MissingDocsHero } from "@/components/dashboard/missing-docs-hero";
import { VendoRoot } from "./VendoRoot";

/** The capture slot the dashboard hero was registered under (vendo sync). */
const HERO_SLOT = "CadenceMissingDocsHero";

const REMIX_PROMPT =
  "Remix this card — show me who's behind by deadline, nudge them every morning, and post in #team the moment anything comes in.";

/**
 * The dashboard hero, slot-wrapped (06-apps §8). A remix pinned to this slot
 * mounts in place of the original; the original stays the fallback. In
 * director mode the scripted build's final view swaps in here directly (no
 * wire round-trip) so the demo lands on the real dashboard.
 */
function HeroSlotBody({
  missingCount,
  clientCount,
}: {
  missingCount: number;
  clientCount: number;
}) {
  const [directorSurface, setDirectorSurface] = useState<{ tree: unknown } | null>(null);

  // One-liner replacement for the old SWR polling dance: the shared hook
  // resolves the app pinned to this slot. Read here for the expand-to-full-row
  // layout decision and passed down so the slot doesn't start a second poll
  // (a bare <VendoSlot id> would discover the pin itself).
  const { appId } = useSlotApp(HERO_SLOT);

  // The remixed app lands here ONLY when the user pins it — the preview in the
  // overlay saves nothing to the dashboard until then.
  useEffect(() => {
    const onPin = (event: Event) => {
      const payload = (event as CustomEvent<{ payload?: unknown }>).detail?.payload;
      if (payload) setDirectorSurface({ tree: payload });
    };
    window.addEventListener("vendo:pin", onPin);
    return () => window.removeEventListener("vendo:pin", onPin);
  }, []);

  const original = <MissingDocsHero missingCount={missingCount} clientCount={clientCount} />;
  // Once the card becomes a full app (director surface or a pinned remix), it
  // takes over the whole stat row instead of staying crammed in one cell.
  const expanded = directorSurface !== null || Boolean(appId);

  return (
    <div
      className={`group/hero relative h-full${expanded ? " col-span-4" : ""}`}
      style={{ ["--fl-slot-min-h" as string]: "0px" }}
    >
      {/* A pinned remix (director surface or user pin) mounts as a pinned
          COMPONENT in the slot (ENG-223) — through the tree renderer + pin
          error boundary, so a broken remix falls back to the original hero
          rather than blanking the cell; otherwise the whole app takes over.
          The remix flag replaces the old hand-rolled RemixButton + vendo:remix
          event glue: the slot's own affordance opens the overlay preloaded. */}
      {directorSurface ? (
        <VendoSlot id={HERO_SLOT} pin={{ payload: directorSurface.tree as UIPayload }}>{original}</VendoSlot>
      ) : (
        <VendoSlot id={HERO_SLOT} appId={appId ?? undefined} remix remixPrompt={REMIX_PROMPT}>{original}</VendoSlot>
      )}
    </div>
  );
}

export function HeroSlot(props: { missingCount: number; clientCount: number }) {
  return (
    <VendoRoot director={false}>
      <HeroSlotBody {...props} />
    </VendoRoot>
  );
}
