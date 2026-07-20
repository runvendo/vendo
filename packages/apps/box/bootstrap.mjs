#!/usr/bin/env node
/**
 * execution-v2 Wave 3 — the box entrypoint. The base box template's start
 * command runs this; all logic lives in createHarness() (harness.mjs) so it
 * stays unit-testable without binding a port.
 */
import { createHarness } from "./harness.mjs";

createHarness().start();
