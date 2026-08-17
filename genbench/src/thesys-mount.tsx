/**
 * The browser half of the thesys column: the VENDOR's own renderer, mounted the
 * way their docs mount it, with the harness's recorder standing in for the host.
 *
 * Their DSL is proprietary and only this renderer can read it, so the page a
 * person is shown for this column has to boot it. Bundled once per run by
 * `thesys.ts` and inlined, because the page is opened with no network at all —
 * their stylesheet carries no `@import` and no remote URL, and the world's own
 * face arrives through the harness's `fontFace` injection, so nothing here
 * reaches for the Inter their setup guide would have loaded from Google Fonts.
 *
 * `window.vendo` is typed in `mount.tsx` and installed by `render.ts` before
 * this script runs.
 */
import "@crayonai/react-ui/styles/index.css";
import { C1Component, ThemeProvider } from "@thesysai/genui-sdk";
import { createRoot } from "react-dom/client";

const read = <T,>(id: string): T => JSON.parse(document.getElementById(id)!.textContent!) as T;

// `isStreaming` is false because the whole answer is already here: this column
// generates once, and the page is assembled after the generation has landed.
// `onAction` is where their product meets the harness — the action's own type
// and params, straight into the one seam every column answers through.
createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={read<Record<string, string>>("crayon-theme")}>
    <C1Component
      c1Response={read<string>("c1")}
      isStreaming={false}
      onAction={(event) => window.vendo.callTool(event.type ?? "", event.params ?? {})}
    />
  </ThemeProvider>,
);
