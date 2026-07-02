import type { ReactNode } from "react";
import type { Flowlet } from "../seams/store";
import { SuggestionChips } from "./SuggestionChips";
import { FlowGallery } from "./FlowGallery";

export interface LandingProps {
  greeting?: string;
  suggestions?: string[];
  flows?: Flowlet[];
  /** Hero composer slot: on the new-tab page the input sits up top (ENG-183
   *  gate, placement A), with the saved-flowlet library beneath it. */
  composer?: ReactNode;
  onSuggestion: (text: string) => void;
  onOpenFlow: (flow: Flowlet) => void;
  onRenameFlow?: (flow: Flowlet, name: string) => void;
  onPinFlow?: (flow: Flowlet, pinned: boolean) => void;
  onDeleteFlow?: (flow: Flowlet) => void;
}

export function Landing({
  greeting = "What can I help you build?",
  suggestions = [],
  flows = [],
  composer,
  onSuggestion,
  onOpenFlow,
  onRenameFlow,
  onPinFlow,
  onDeleteFlow,
}: LandingProps) {
  return (
    <div className="fl-landing">
      <h1 className="fl-greet">{greeting}</h1>
      {composer && <div className="fl-landing-composer">{composer}</div>}
      <SuggestionChips suggestions={suggestions} onSelect={onSuggestion} />
      <FlowGallery
        flows={flows}
        onOpen={onOpenFlow}
        onRename={onRenameFlow}
        onPin={onPinFlow}
        onDelete={onDeleteFlow}
      />
    </div>
  );
}
