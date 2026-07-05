/**
 * Externalized bundle entry — same components as entry.tsx but React is NOT
 * bundled in. "react", "react-dom/client", and "react/jsx-runtime" are left
 * as external imports that the sandbox resolves via its import map.
 *
 * The explicit `import React` / `import { createRoot }` lines are kept so
 * that window.__React and window.__createRoot are set from the SHARED shim,
 * matching what the self-contained bundle path sets today.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { Card } from "./Card";
import { Boom } from "./Boom";
import { Row } from "./Row";
import { Badge } from "./Badge";
import { ThemeProbe, installThemeWrap } from "./ThemeProbe";

(globalThis as any).__React = React;
(globalThis as any).__createRoot = createRoot;
(globalThis as any).__VENDO_HOST__ = { Card, Boom, __row: Row, __badge: Badge, ThemeProbe };
installThemeWrap();
