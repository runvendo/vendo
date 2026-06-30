export interface SuggestionChipsProps {
  suggestions: string[];
  onSelect: (text: string) => void;
}

export function SuggestionChips({ suggestions, onSelect }: SuggestionChipsProps) {
  if (suggestions.length === 0) return null;
  return (
    <div className="fl-chips">
      {suggestions.map((s) => (
        <button type="button" key={s} className="fl-chip" onClick={() => onSelect(s)}>{s}</button>
      ))}
    </div>
  );
}
