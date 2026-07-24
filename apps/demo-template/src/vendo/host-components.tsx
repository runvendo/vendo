import type { ComponentType } from "react";

// CREATOR SEAM — client-side host component registration by name. Empty in
// the template; the creator adds one entry per catalog entry in
// src/vendo/server.ts (names must mirror 1:1). See
// apps/demo-bank/src/vendo/host-components.tsx for worked entries.
export const demoHostComponents: Record<string, ComponentType> = {};
