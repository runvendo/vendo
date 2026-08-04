/** The executable host fixtures, keyed by HostName — the shape cli.ts and
 *  app/api/run/exec-run.ts lazily import (`fixtures` named export). */
import type { HostFixture, HostName } from "../runner/types";
import { cadenceFixture } from "./cadence";
import { mapleFixture } from "./maple";

export const fixtures: Partial<Record<HostName, HostFixture>> = {
  maple: mapleFixture,
  cadence: cadenceFixture,
};
