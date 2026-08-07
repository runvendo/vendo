/** ENG-218 — extreme-content solidity. Shared bound for how much of a single
    message body is rendered before it collapses behind an expand affordance.
    Huge pasted logs / model dumps otherwise (a) force react-markdown to parse a
    six-figure string on every keystroke-sized re-render and (b) blow the DOM up
    with thousands of nodes. Chat prose sits far below this; only outliers clip. */
export const LONG_TEXT_CAP = 6000;

/** Cut `text` to at most `cap` characters, preferring the last line break within
    the final 20% of the budget so a collapsed markdown block breaks on a
    paragraph rather than mid-token. Returns the head only — callers add the
    expand control. */
export function truncateHead(text: string, cap: number = LONG_TEXT_CAP): string {
  if (text.length <= cap) return text;
  const hard = text.slice(0, cap);
  const lastBreak = hard.lastIndexOf("\n", cap);
  return lastBreak > cap * 0.8 ? hard.slice(0, lastBreak) : hard;
}
