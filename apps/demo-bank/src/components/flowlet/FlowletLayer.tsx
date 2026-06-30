"use client";

/**
 * The Flowlet layer dropped over Maple. A single client island that owns the
 * shared agent session, the docked composer, the background poller, and the
 * backstage order-inject fallback. Mounted once in the root layout so it floats
 * above the untouched bank UI — the "we dropped in one layer" thesis, literally.
 */
import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { FlowletOverlay } from "@flowlet/shell";
import { FlowletRoot } from "./FlowletRoot";
import { FlowletDock } from "./FlowletDock";
import { FlowletPoller, type FireEvent } from "./FlowletPoller";
import { FlowletSaver, type SavedView } from "./FlowletSaver";
import { SavedViews } from "./SavedViews";
import { resetDemo } from "./reset";

const SUGGESTIONS = [
  "What did I spend money on when I should've been asleep?",
  "What was that $87 DoorDash charge?",
];

export function FlowletLayer() {
  const [fire, setFire] = useState<FireEvent | null>(null);
  const [saved, setSaved] = useState<SavedView[]>([]);
  const pathname = usePathname();
  // On the dedicated Flowlet tab, that page IS the surface — hide the floating dock.
  const showDock = pathname !== "/flowlet";

  const addSaved = useCallback((v: SavedView) => {
    setSaved((prev) => (prev.some((s) => s.id === v.id) ? prev : [...prev, v]));
  }, []);

  // Stage shortcuts:
  //  - Cmd/Ctrl+Shift+Backslash: backstage inject of a late-night order (same
  //    write the order page uses) so the poller trips identically as a fallback.
  //  - Cmd/Ctrl+Shift+Period: reset the demo to a clean state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.code === "Backslash") {
        e.preventDefault();
        void fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      } else if (e.code === "Period") {
        e.preventDefault();
        void resetDemo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <FlowletRoot>
      <FlowletPoller onFire={setFire} />
      <FlowletSaver onSave={addSaved} />
      {showDock ? <FlowletDock fire={fire} onDismissFire={() => setFire(null)} /> : null}
      {showDock ? <SavedViews views={saved} /> : null}
      {/* Secondary surface: same agent + thread, reachable anywhere via Cmd/Ctrl+K. */}
      <FlowletOverlay
        shortcutKey="k"
        launcherLabel="Ask Maple"
        greeting="Ask Maple anything"
        suggestions={SUGGESTIONS}
      />
    </FlowletRoot>
  );
}
