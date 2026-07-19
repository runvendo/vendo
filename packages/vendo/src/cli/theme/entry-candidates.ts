/** Conventional Next.js entry-file paths (app-router layouts + pages-router
 *  `_app`), relative to a target repo's root. extract-theme.ts reads the
 *  first hit as the root layout: the anchor for the CSS import graph and part
 *  of the LLM pass's evidence (next/font imports live here). */
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
