import { describe, expect, it } from "vitest";
import { runServiceKey } from "./service-key.js";

const KEY_PATTERN = /vsk_[0-9a-f]{48}/g;

function output() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, sink: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) } };
}

describe("vendo service-key new", () => {
  it("prints exactly one key, once, with what to do with it", async () => {
    const messages = output();
    expect(await runServiceKey(["new"], { output: messages.sink })).toBe(0);
    const printed = messages.logs.join("\n");

    const keys = printed.match(KEY_PATTERN) ?? [];
    expect(keys).toHaveLength(1);
    expect(printed).toContain(`VENDO_SERVICE_KEY=${keys[0]}`);
    expect(printed).toContain("shown once and cannot be recovered");
    expect(printed).toContain("mcp: { serviceAuth: { keys:");
    expect(messages.errors).toEqual([]);
  });

  it("mints a different key every time", async () => {
    const first = output();
    const second = output();
    await runServiceKey(["new"], { output: first.sink });
    await runServiceKey(["new"], { output: second.sink });
    expect(first.logs.join("\n").match(KEY_PATTERN)![0]).not.toBe(second.logs.join("\n").match(KEY_PATTERN)![0]);
  });

  it("prints the key and the label as JSON", async () => {
    const messages = output();
    expect(await runServiceKey(["new", "--name", "backend", "--json"], { output: messages.sink })).toBe(0);
    const body = JSON.parse(messages.logs.join("\n")) as { key: string; name: string };
    expect(body.key).toMatch(new RegExp(`^${KEY_PATTERN.source}$`));
    expect(body.name).toBe("backend");
  });

  it("names the label in the human output, and omits it from JSON when unset", async () => {
    const labelled = output();
    await runServiceKey(["new", "--name", "payments"], { output: labelled.sink });
    expect(labelled.logs.join("\n")).toContain("(payments)");

    const plain = output();
    await runServiceKey(["new", "--json"], { output: plain.sink });
    expect(Object.keys(JSON.parse(plain.logs.join("\n")) as object)).toEqual(["key"]);
  });

  it("refuses an unknown subcommand, with the usage", async () => {
    const messages = output();
    expect(await runServiceKey(["rotate"], { output: messages.sink })).toBe(1);
    expect(messages.errors.join("\n")).toContain("Unknown service-key command: rotate");
    expect(messages.errors.join("\n")).toContain("vendo service-key new");
    expect(messages.logs).toEqual([]);
  });

  it("refuses an unknown flag instead of minting a key that drops it", async () => {
    const messages = output();
    expect(await runServiceKey(["new", "--nmae", "backend"], { output: messages.sink })).toBe(1);
    expect(messages.errors.join("\n")).toContain("unknown option: --nmae");
    expect(messages.logs).toEqual([]);
    expect([...messages.logs, ...messages.errors].join("\n").match(KEY_PATTERN)).toBeNull();
  });

  it("shows the usage for `new --help` and mints nothing", async () => {
    const messages = output();
    await runServiceKey(["new", "--help"], { output: messages.sink });
    const printed = [...messages.logs, ...messages.errors].join("\n");
    expect(printed).toContain("vendo service-key new [--name <label>] [--json]");
    expect(printed.match(KEY_PATTERN)).toBeNull();
  });

  it("prints the usage for --help", async () => {
    const messages = output();
    expect(await runServiceKey(["--help"], { output: messages.sink })).toBe(0);
    expect(messages.logs.join("\n")).toContain("vendo service-key new [--name <label>] [--json]");
  });
});
