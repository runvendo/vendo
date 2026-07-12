import type { Suite } from "../types.js";
import { treeValidateSuite } from "./tree-validate.js";
import { treeRenderSuite } from "./tree-render.js";
import { storeSuite } from "./store.js";
import { guardCallSuite } from "./guard-call.js";
import { appsApiSuite } from "./apps-api.js";
import { genScriptedSuite } from "./gen-scripted.js";
import { genLiveSuite } from "./gen-live.js";
import { e2bSuite } from "./e2b.js";

/** All registered suites, in run order. */
export const SUITES: Suite[] = [
  treeValidateSuite,
  treeRenderSuite,
  storeSuite,
  guardCallSuite,
  appsApiSuite,
  genScriptedSuite,
  genLiveSuite,
  e2bSuite,
];

export const DETERMINISTIC_SUITES = SUITES.filter((s) => s.kind === "deterministic");
export const LIVE_SUITES = SUITES.filter((s) => s.kind === "live");

export const suiteByName = (name: string): Suite | undefined => SUITES.find((s) => s.name === name);
