/**
 * The supply loop: a read the screen asks for while it renders.
 *
 * A `useQuery` input the screen COMPUTES — the invoices of whichever client is
 * selected — cannot be resolved before the component runs, so the engine keys its
 * data by tool AND input, paints `undefined` for a key nobody has answered, and
 * NAMES what it wanted. The host answers and hands the answers back.
 *
 * The one thing this file exists to pin: `supply` re-renders the component that
 * is already running. Everything `useState` holds survives it — which is the
 * whole reason the surface stopped rebooting the VM after a write.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { queryKey, warmScreenEngine } from "../../../../src/contract/genui/component/index.js";
import { bootTsx, textsOf } from "./screen-fixture.test-util.js";

beforeAll(async () => {
  await warmScreenEngine();
});

/** Two reads of ONE tool, and the second one's input is state the person set. */
const PICKER = `
import { useState } from "react";
import { Button, Stack, Text, useQuery } from "@vendo/screen";

export default function Invoices() {
  const clients = useQuery("list_clients");
  const [chosen, setChosen] = useState("c1");
  const [draft, setDraft] = useState("");
  const invoices = useQuery("list_clients", { client: chosen });
  return (
    <Stack gap={8}>
      <Text text={"clients: " + (clients ?? []).length} />
      <Text text={"draft: " + draft} />
      <Text text={invoices === undefined ? "loading" : "invoices: " + invoices.join(",")} />
      <Button label="pick c2" onClick={() => setChosen("c2")} />
      <Button label="type" onClick={() => setDraft("typed")} />
    </Stack>
  );
}
`;

describe("a read the screen asks for", () => {
  it("keys the store by tool AND input, so one tool answers two questions", () => {
    const screen = bootTsx(PICKER, { list_clients: ["c1", "c2"] });
    try {
      expect(textsOf(screen.tree())).toEqual(["clients: 2", "draft: ", "loading"]);
      expect(screen.misses()).toEqual([{ tool: "list_clients", input: { client: "c1" } }]);
      screen.supply({ [queryKey({ tool: "list_clients", input: { client: "c1" } })]: ["in_1", "in_2"] });
      expect(textsOf(screen.tree())).toEqual(["clients: 2", "draft: ", "invoices: in_1,in_2"]);
    } finally {
      screen.dispose();
    }
  });

  it("is TAKEN, so a host that answers nothing is asked once per round", () => {
    const screen = bootTsx(PICKER, { list_clients: [] });
    try {
      expect(screen.misses()).toHaveLength(1);
      expect(screen.misses()).toEqual([]);
    } finally {
      screen.dispose();
    }
  });

  it("names the NEW key when state moves the input", () => {
    const screen = bootTsx(PICKER, { list_clients: ["c1"] });
    try {
      screen.misses();
      screen.fire("h1");
      expect(screen.misses()).toEqual([{ tool: "list_clients", input: { client: "c2" } }]);
    } finally {
      screen.dispose();
    }
  });

  it("keeps everything useState holds across a supply — it re-renders, never reboots", () => {
    const screen = bootTsx(PICKER, { list_clients: ["c1"] });
    try {
      screen.fire("h2");
      expect(textsOf(screen.tree())).toContain("draft: typed");
      screen.supply({ [queryKey({ tool: "list_clients", input: { client: "c1" } })]: ["in_9"] });
      const painted = textsOf(screen.tree());
      expect(painted).toContain("draft: typed");
      expect(painted).toContain("invoices: in_9");
    } finally {
      screen.dispose();
    }
  });

  it("resolves undefined for a key nobody ever answers, and paints anyway", () => {
    const screen = bootTsx(PICKER, {});
    try {
      expect(textsOf(screen.tree())).toEqual(["clients: 0", "draft: ", "loading"]);
      expect(screen.misses().map(({ tool }) => tool)).toEqual(["list_clients", "list_clients"]);
    } finally {
      screen.dispose();
    }
  });
});
