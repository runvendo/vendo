import type { ReactNode } from "react";
import { SuggestionChips } from "./SuggestionChips";

export interface LandingProps {
  greeting?: string;
  suggestions?: string[];
  /** Hero composer slot. */
  composer?: ReactNode;
  onSuggestion: (text: string) => void;
}

export function Landing({
  greeting = "What can I help you build?",
  suggestions = [],
  composer,
  onSuggestion,
}: LandingProps) {
  return (
    <div className="fl-landing">
      <h1 className="fl-greet">{greeting}</h1>
      {composer && <div className="fl-landing-composer">{composer}</div>}
      <SuggestionChips suggestions={suggestions} onSelect={onSuggestion} />
    </div>
  );
}
