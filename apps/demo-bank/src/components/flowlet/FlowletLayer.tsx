"use client";

/**
 * The Flowlet layer dropped over Maple. A single client island that owns the
 * shared agent session, the docked composer, the background poller, and the
 * backstage order-inject fallback. Mounted once in the root layout so it floats
 * above the untouched bank UI — the "we dropped in one layer" thesis, literally.
 */
import { useEffect, useState } from "react";
import { FlowletRoot } from "./FlowletRoot";
import { FlowletDock } from "./FlowletDock";
import { FlowletPoller, type FireEvent } from "./FlowletPoller";

export function FlowletLayer() {
  const [fire, setFire] = useState<FireEvent | null>(null);

  // Backstage fallback: Cmd/Ctrl+Shift+Backslash injects a late-night order via
  // the same write the order page uses, so the poller trips identically if the
  // order page misbehaves on stage.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "Backslash") {
        e.preventDefault();
        void fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <FlowletRoot>
      <FlowletPoller onFire={setFire} />
      <FlowletDock fire={fire} onDismissFire={() => setFire(null)} />
    </FlowletRoot>
  );
}
