import { useState } from "react";
import { useShell } from "../context";
import { OverlayPanel } from "../components/OverlayPanel";
import { VendoThread } from "../VendoThread";

export interface VendoSlotProps {
  vendoId: string;
  emptyLabel?: string;
  greeting?: string;
  suggestions?: string[];
  voice?: import("../voice/voice-session").VoiceDriver;
}

export function VendoSlot({
  vendoId,
  emptyLabel = "Design a view",
  greeting,
  suggestions = [],
  voice,
}: VendoSlotProps) {
  const { productName } = useShell();
  const [open, setOpen] = useState(false);
  const slotGreeting =
    greeting ?? (productName ? `What can ${productName} build here?` : "What can I build here?");

  return (
    <div className="fl-slot" data-vendo-id={vendoId}>
      <button type="button" className="fl-slot-ghost" onClick={() => setOpen(true)}>
        <span className="fl-slot-cta">
          <span className="fl-slot-cta-label">{emptyLabel}</span>
          <small>describe it, I&apos;ll render it</small>
        </span>
      </button>
      <OverlayPanel open={open} onClose={() => setOpen(false)} ariaLabel="Design view">
        <VendoThread greeting={slotGreeting} suggestions={suggestions} voice={voice} />
      </OverlayPanel>
    </div>
  );
}
