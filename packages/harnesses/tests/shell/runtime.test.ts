/**
 * Whether THIS runtime can host a worker thread. Asked through the runtime
 * built-in accessor, so this module carries no static Node import and still
 * bundles for an edge target.
 */
import { describe, expect, it } from "vitest";
import { workerThreadsAvailable } from "../../src/vendo/shell/runtime.js";

describe("the worker-thread probe", () => {
  it("says yes under Node", () => {
    expect(workerThreadsAvailable()).toBe(true);
  });

  it("says no where there is no Node built-in accessor at all", () => {
    const proc = (globalThis as { process?: unknown }).process;
    try {
      delete (globalThis as { process?: unknown }).process;
      expect(workerThreadsAvailable()).toBe(false);
    } finally {
      (globalThis as { process?: unknown }).process = proc;
    }
  });

  it("says no where the accessor exists but the module does not", () => {
    const proc = (globalThis as { process?: unknown }).process;
    try {
      (globalThis as { process?: unknown }).process = {
        getBuiltinModule: (id: string) => (id === "node:worker_threads" ? undefined : {}),
      };
      expect(workerThreadsAvailable()).toBe(false);
    } finally {
      (globalThis as { process?: unknown }).process = proc;
    }
  });
});
