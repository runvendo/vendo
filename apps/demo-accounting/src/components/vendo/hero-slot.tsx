"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { createVendoClient } from "@vendoai/ui";
import { VendoSlot } from "@vendoai/ui/chrome";
import { AppFrame } from "@vendoai/ui/tree";
import { MissingDocsHero } from "@/components/dashboard/missing-docs-hero";
import { cadenceHostComponents } from "@/vendo/host-components";
import { VendoRoot } from "./VendoRoot";

/** The capture slot the dashboard hero was registered under (vendo sync). */
const HERO_SLOT = "CadenceMissingDocsHero";

const REMIX_PROMPT =
  "Remix this card — show me who's behind by deadline, nudge them every morning, and post in #team the moment anything comes in.";

/** Hover affordance: the entry point to remixing the card via the Vendo overlay. */
function RemixButton() {
  return (
    <button
      type="button"
      aria-label="Remix this card with Vendo"
      onClick={() => window.dispatchEvent(new CustomEvent("vendo:remix", { detail: { prompt: REMIX_PROMPT } }))}
      className="group/remix absolute top-2.5 right-2.5 z-10 flex items-center gap-1.5 rounded-lg border border-line bg-card/90 px-2.5 py-1 text-[11.5px] font-semibold text-ink-soft opacity-0 shadow-sm backdrop-blur transition-opacity duration-150 hover:text-ink group-hover/hero:opacity-100"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" />
      </svg>
      Remix
    </button>
  );
}

/**
 * The dashboard hero, slot-wrapped (06-apps §8). A remix pinned to this slot
 * mounts in place of the original; the original stays the fallback. In
 * director mode the scripted build's final view swaps in here directly (no
 * wire round-trip) so the demo lands on the real dashboard.
 */
export function HeroSlot({
  missingCount,
  clientCount,
}: {
  missingCount: number;
  clientCount: number;
}) {
  const client = useMemo(() => createVendoClient({ baseUrl: "/api/vendo" }), []);
  const [directorSurface, setDirectorSurface] = useState<{ tree: unknown } | null>(null);

  const { data: appId } = useSWR(
    "vendo-slot:" + HERO_SLOT,
    async () => {
      const apps = await client.apps.list();
      const pinned = apps.filter(app => app.pins?.some(pin => pin.slot === HERO_SLOT));
      return pinned.at(-1)?.id;
    },
    { refreshInterval: 5000, revalidateOnFocus: true },
  );

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
    <VendoRoot director={false}>
      <div
        className={`group/hero relative h-full${expanded ? " col-span-4" : ""}`}
        style={{ ["--fl-slot-min-h" as string]: "0px" }}
      >
        {!expanded ? <RemixButton /> : null}
        {directorSurface ? (
          <AppFrame
            surface={{ kind: "tree", payload: directorSurface.tree as never }}
            components={cadenceHostComponents}
          />
        ) : (
          <VendoSlot id={HERO_SLOT} appId={appId ?? undefined}>{original}</VendoSlot>
        )}
      </div>
    </VendoRoot>
  );
}
