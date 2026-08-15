/** Inject the host's `.vendo/fonts.css` once — the `@font-face` rules `vendo
    sync` resolved and inlined for the theme's families.

    Deliberately NOT part of `ensureChromeStyles`: the faces and the chrome are
    wanted independently. The MCP Apps shim renders inside someone else's
    client and must keep THAT host's look, so it takes the faces and none of
    the chrome; a host page, conversely, already has its own faces and only
    needs the chrome. */
export function ensureThemeFontStyles(css: string): void {
  if (css === "" || typeof document === "undefined" || document.querySelector("style[data-vendo-fonts]")) return;
  const style = document.createElement("style");
  style.dataset.vendoFonts = "";
  style.textContent = css;
  document.head.append(style);
}
