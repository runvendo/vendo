/**
 * Minimal CSS custom-property declaration scanner. Not a full CSS parser —
 * tracks brace depth and whether the enclosing block/at-rule looks dark-scoped
 * (`.dark`, `[data-theme="dark"]`, `@media (prefers-color-scheme: dark)`).
 * Good enough for design-token sheets; anything it misses is hand-editable output.
 */
export interface CssVarDecl {
  name: string;
  value: string;
  file: string;
  darkScope: boolean;
}

const DARK_SELECTOR = /(\.dark\b|\[data-theme=["']?dark["']?\]|prefers-color-scheme:\s*dark)/;

export function parseCssVars(css: string, file: string): CssVarDecl[] {
  const out: CssVarDecl[] = [];
  // Strip comments first.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Stack of "is this block dark-scoped" flags.
  const darkStack: boolean[] = [];
  let selectorBuf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const parentDark = darkStack.some(Boolean);
      darkStack.push(parentDark || DARK_SELECTOR.test(selectorBuf));
      selectorBuf = "";
    } else if (ch === "}") {
      darkStack.pop();
      selectorBuf = "";
    } else if (ch === ";") {
      const decl = selectorBuf.trim();
      const m = decl.match(/^(--[\w-]+)\s*:\s*(.+)$/s);
      if (m && m[1] && m[2]) {
        out.push({ name: m[1], value: m[2].trim(), file, darkScope: darkStack.some(Boolean) });
      }
      selectorBuf = "";
    } else {
      selectorBuf += ch;
    }
  }
  return out;
}
