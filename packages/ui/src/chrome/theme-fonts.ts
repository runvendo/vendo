/** Install the host's `.vendo/fonts.css` — the `@font-face` rules `vendo sync`
    resolved and inlined for the theme's families.

    ONE sheet per document, holding the CURRENT brand: a document has one host,
    so a second provider mounting into it is a theme change, not a duplicate.
    Last writer wins, updated in place — a tag left by an earlier mount must
    never outrank the value the page is configured with now. Per DOCUMENT is the
    whole scope: a surface that is its own document (the MCP Apps shim, the box
    template) has its own `document`, and so its own sheet.

    An empty `css` means "this surface has nothing to contribute" and leaves
    whatever is installed alone, so a provider without fonts cannot blank the
    brand for one that has them.

    Deliberately NOT part of `ensureChromeStyles`: the faces and the chrome are
    wanted independently. A surface rendering inside someone else's client takes
    the faces and none of the chrome; a host page, conversely, already has its
    own faces and only needs the chrome. */
export function ensureThemeFontStyles(css: string): void {
  if (css === "" || typeof document === "undefined") return;
  const installed = document.querySelector<HTMLStyleElement>("style[data-vendo-fonts]");
  if (installed !== null) {
    if (installed.textContent !== css) installed.textContent = css;
    return;
  }
  const style = document.createElement("style");
  style.dataset.vendoFonts = "";
  style.textContent = css;
  document.head.append(style);
}
