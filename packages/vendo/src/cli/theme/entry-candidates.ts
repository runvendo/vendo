/** Conventional Next.js entry-file paths (app-router layouts + pages-router
 *  `_app`), relative to a target repo's root. Shared by next-fonts.ts (font
 *  var recovery) and extract-theme.ts (CSS-import entry detection) — both walk
 *  the same small set of well-known locations before falling back to a wider
 *  tree scan. next-fonts.ts additionally checks `_document` variants; that
 *  extension lives there; this list stays scoped to what both callers need. */
export const ENTRY_FILE_CANDIDATES = [
  "app/layout.tsx",
  "app/layout.jsx",
  "app/layout.ts",
  "app/layout.js",
  "src/app/layout.tsx",
  "src/app/layout.jsx",
  "src/app/layout.ts",
  "src/app/layout.js",
  "pages/_app.tsx",
  "pages/_app.jsx",
  "pages/_app.ts",
  "pages/_app.js",
  "src/pages/_app.tsx",
  "src/pages/_app.jsx",
  "src/pages/_app.ts",
  "src/pages/_app.js",
];
