import { describe, expect, it, vi } from "vitest";
import { createInteractor, type Interactor } from "./interact.js";

// Fakes the @clack/prompts module the real interactor is built on, so no test
// ever touches a real terminal. `isCancel` mirrors clack's actual contract:
// cancel is signaled by a unique symbol, not a thrown error or null.
const CANCEL = Symbol("clack-cancel");

vi.mock("@clack/prompts", () => ({
  password: vi.fn(),
  multiselect: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
}));

import { password, multiselect } from "@clack/prompts";

describe("createInteractor (real @clack/prompts seam)", () => {
  it("maskedInput resolves the typed value", async () => {
    vi.mocked(password).mockResolvedValueOnce("sk-ant-abc123");
    const interactor = createInteractor();
    expect(await interactor.maskedInput({ message: "Paste your API key" })).toBe("sk-ant-abc123");
    expect(password).toHaveBeenCalledWith(expect.objectContaining({ message: "Paste your API key" }));
  });

  it("maskedInput returns null on cancel (Ctrl-C)", async () => {
    vi.mocked(password).mockResolvedValueOnce(CANCEL);
    const interactor = createInteractor();
    expect(await interactor.maskedInput({ message: "x" })).toBeNull();
  });

  it("maskedInput resolves an empty string as-is (Enter-skips is the caller's decision, not this seam's)", async () => {
    vi.mocked(password).mockResolvedValueOnce("");
    const interactor = createInteractor();
    expect(await interactor.maskedInput({ message: "x" })).toBe("");
  });

  it("multiSelect resolves the chosen values", async () => {
    vi.mocked(multiselect).mockResolvedValueOnce(["a", "c"]);
    const interactor = createInteractor();
    const result = await interactor.multiSelect({
      message: "Pick components",
      options: [
        { value: "a", label: "Alpha", hint: "reason a" },
        { value: "b", label: "Beta" },
        { value: "c", label: "Gamma", hint: "reason c" },
      ],
      initialValues: ["a", "b", "c"],
    });
    expect(result).toEqual(["a", "c"]);
    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Pick components",
        initialValues: ["a", "b", "c"],
        options: [
          { value: "a", label: "Alpha", hint: "reason a" },
          { value: "b", label: "Beta", hint: undefined },
          { value: "c", label: "Gamma", hint: "reason c" },
        ],
      }),
    );
  });

  it("multiSelect forwards required:false so an empty selection is a legal submit (not a cancel)", async () => {
    vi.mocked(multiselect).mockResolvedValueOnce([]);
    const interactor = createInteractor();
    const result = await interactor.multiSelect({
      message: "Pick components",
      options: [{ value: "a", label: "Alpha" }],
      required: false,
    });
    expect(result).toEqual([]);
    expect(multiselect).toHaveBeenCalledWith(expect.objectContaining({ required: false }));
  });

  it("multiSelect leaves required undefined when omitted (clack's own default applies)", async () => {
    vi.mocked(multiselect).mockResolvedValueOnce(["a"]);
    const interactor = createInteractor();
    await interactor.multiSelect({ message: "x", options: [{ value: "a", label: "A" }] });
    expect(vi.mocked(multiselect).mock.calls.at(-1)?.[0]).toMatchObject({ required: undefined });
  });

  it("multiSelect returns null on cancel", async () => {
    vi.mocked(multiselect).mockResolvedValueOnce(CANCEL);
    const interactor = createInteractor();
    expect(await interactor.multiSelect({ message: "x", options: [{ value: "a", label: "A" }] })).toBeNull();
  });
});

describe("Interactor fake-seam round-trip (how callers/tests stub it)", () => {
  it("a fully in-memory fake satisfies the interface with no terminal involved", async () => {
    const calls: unknown[] = [];
    const fake: Interactor = {
      async maskedInput(opts) {
        calls.push(opts);
        return "sk-ant-fake";
      },
      async multiSelect(opts) {
        calls.push(opts);
        return opts.options.map((o) => o.value);
      },
    };
    expect(await fake.maskedInput({ message: "key?" })).toBe("sk-ant-fake");
    expect(
      await fake.multiSelect({ message: "pick", options: [{ value: 1, label: "one" }, { value: 2, label: "two" }] }),
    ).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it("a fake can simulate cancellation by returning null", async () => {
    const fake: Interactor = {
      maskedInput: async () => null,
      multiSelect: async () => null,
    };
    expect(await fake.maskedInput({ message: "key?" })).toBeNull();
    expect(await fake.multiSelect({ message: "pick", options: [] })).toBeNull();
  });
});
