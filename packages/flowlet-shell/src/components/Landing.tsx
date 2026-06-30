import type { Flowlet } from "../seams/store";
import { SuggestionChips } from "./SuggestionChips";
import { FlowGallery } from "./FlowGallery";

export interface LandingProps {
  greeting?: string;
  suggestions?: string[];
  flows?: Flowlet[];
  onSuggestion: (text: string) => void;
  onOpenFlow: (flow: Flowlet) => void;
}

export function Landing({
  greeting = "What can I help you build?", suggestions = [], flows = [], onSuggestion, onOpenFlow,
}: LandingProps) {
  return (
    <div className="fl-landing">
      <div className="fl-greet">{greeting}</div>
      <SuggestionChips suggestions={suggestions} onSelect={onSuggestion} />
      <FlowGallery flows={flows} onOpen={onOpenFlow} />
    </div>
  );
}
