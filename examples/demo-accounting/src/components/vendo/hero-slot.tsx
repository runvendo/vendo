"use client";

import { useEffect, useState } from "react";
import type { UIPayload } from "@vendoai/core";
import { Remixable, VendoSlot } from "@vendoai/ui/chrome";
import { MissingDocsHero } from "@/components/dashboard/missing-docs-hero";
import { VendoRoot } from "./VendoRoot";

/** The host-authored place the director build lands in — a slot NAME
 *  (2026-08-02 pins/placements split), kept from the capture era so the
 *  scripted demo keeps working unchanged. */
const HERO_SLOT = "CadenceMissingDocsHero";

/**
 * The dashboard hero (2026-08-02 final shape): the hero itself is remixable
 * IN PLACE through the <Remixable> wrapper — a user's fork replaces the
 * wrapped element right here, for that user only, no slot involved. The
 * VendoSlot remains for director mode only, where the scripted build's final
 * view swaps in directly (no wire round-trip) and takes over the whole stat
 * row.
 */
function HeroSlotBody({
  missingCount,
  clientCount,
}: {
  missingCount: number;
  clientCount: number;
}) {
  const [directorSurface, setDirectorSurface] = useState<{ tree: unknown } | null>(null);

  // The scripted build lands here ONLY when the user pins it — the preview in
  // the overlay saves nothing to the dashboard until then.
  useEffect(() => {
    const onPin = (event: Event) => {
      const payload = (event as CustomEvent<{ payload?: unknown }>).detail?.payload;
      if (payload) setDirectorSurface({ tree: payload });
    };
    window.addEventListener("vendo:pin", onPin);
    return () => window.removeEventListener("vendo:pin", onPin);
  }, []);

  const original = <MissingDocsHero missingCount={missingCount} clientCount={clientCount} />;

  if (directorSurface) {
    // The director surface mounts as a pinned COMPONENT in the slot (ENG-223)
    // — through the tree renderer + pin error boundary, so a broken view falls
    // back to the original hero — and expands to the full stat row.
    return (
      <div
        className="group/hero relative col-span-4 h-full"
        style={{ ["--fl-slot-min-h" as string]: "0px" }}
      >
        <VendoSlot id={HERO_SLOT} pin={{ payload: directorSurface.tree as UIPayload }}>{original}</VendoSlot>
      </div>
    );
  }

  return (
    <div className="group/hero relative h-full">
      {/* The child stays a literal element (not {original}): sync's static
          scan resolves the wrapped component through this exact JSX. */}
      <Remixable>
        <MissingDocsHero missingCount={missingCount} clientCount={clientCount} />
      </Remixable>
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
