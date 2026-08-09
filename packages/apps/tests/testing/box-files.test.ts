import { describe, expect, it } from "vitest";
import type { SandboxAdapter } from "../../src/sandbox.js";
import { fakeBoxSandbox } from "../../src/testing/fake-box.js";
import { fakeSandbox } from "../../src/testing/fake-sandbox.js";
import { fakeStatefulSandbox } from "../../src/testing/fake-sandbox-stateful.js";

/**
 * `inMemoryBoxFiles` serves `files` for every fake sandbox, and each fake
 * supplies its own lifecycle guard. A fake that forgets to pass one accepts a
 * write to a machine the provider has already killed — behaviour no real
 * adapter has, so a suite can pass on a code path that dies in production.
 */
const fakes: Array<[string, () => SandboxAdapter]> = [
  ["fakeSandbox", fakeSandbox],
  ["fakeStatefulSandbox", fakeStatefulSandbox],
  ["fakeBoxSandbox", fakeBoxSandbox],
];

describe("every fake sandbox guards the box filesystem by machine lifecycle", () => {
  for (const [name, makeAdapter] of fakes) {
    it(`${name} refuses a write and a list after destroy(), and still reads`, async () => {
      const machine = await makeAdapter().create({ env: {} });
      await machine.files.write("/app/a.txt", "before");
      await machine.destroy();

      await expect(machine.files.write("/app/b.txt", "after")).rejects.toThrow();
      await expect(machine.files.list("/app")).rejects.toThrow();
      // A read stays open on purpose (box-files.ts): the fakes double as a
      // post-mortem probe for what a torn-down machine held.
      expect(new TextDecoder().decode(await machine.files.read("/app/a.txt"))).toBe("before");
    });
  }
});
