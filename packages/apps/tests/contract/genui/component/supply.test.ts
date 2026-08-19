/**
 * The supply loop: a read the screen asks for while it renders.
 *
 * A `useQuery` input the screen COMPUTES — the invoices of whichever client is
 * selected — cannot be resolved before the component runs, so the engine keys its
 * data by tool AND input, paints `{ data: undefined }` for a key nobody has
 * answered, and NAMES what it wanted. The host answers and hands the answers
 * back.
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

/** Two reads of ONE tool, and the second one's input is state the person set.
 *  Both read `.data` off the result, the way a host's tools really answer. */
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
      <Text text={"clients: " + (clients.data ?? []).length} />
      <Text text={"draft: " + draft} />
      <Text text={invoices.data === undefined ? "loading" : "invoices: " + invoices.data.join(",")} />
      <Button label="pick c2" onClick={() => setChosen("c2")} />
      <Button label="type" onClick={() => setDraft("typed")} />
    </Stack>
  );
}
`;

const answer = (...clients: string[]): Record<string, unknown> => ({ list_clients: { data: clients } });

describe("a read the screen asks for", () => {
  it("keys the store by tool AND input, so one tool answers two questions", () => {
    const screen = bootTsx(PICKER, answer("c1", "c2"));
    try {
      expect(textsOf(screen.tree())).toEqual(["clients: 2", "draft: ", "loading"]);
      expect(screen.misses()).toEqual([{ tool: "list_clients", input: { client: "c1" } }]);
      screen.supply({ [queryKey({ tool: "list_clients", input: { client: "c1" } })]: { data: ["in_1", "in_2"] } });
      expect(textsOf(screen.tree())).toEqual(["clients: 2", "draft: ", "invoices: in_1,in_2"]);
    } finally {
      screen.dispose();
    }
  });

  it("is TAKEN, so a host that answers nothing is asked once per round", () => {
    const screen = bootTsx(PICKER, answer());
    try {
      expect(screen.misses()).toHaveLength(1);
      expect(screen.misses()).toEqual([]);
    } finally {
      screen.dispose();
    }
  });

  it("names the NEW key when state moves the input", () => {
    const screen = bootTsx(PICKER, answer("c1"));
    try {
      screen.misses();
      screen.fire("h1");
      expect(screen.misses()).toEqual([{ tool: "list_clients", input: { client: "c2" } }]);
    } finally {
      screen.dispose();
    }
  });

  it("keeps everything useState holds across a supply — it re-renders, never reboots", () => {
    const screen = bootTsx(PICKER, answer("c1"));
    try {
      screen.fire("h2");
      expect(textsOf(screen.tree())).toContain("draft: typed");
      screen.supply({ [queryKey({ tool: "list_clients", input: { client: "c1" } })]: { data: ["in_9"] } });
      const painted = textsOf(screen.tree());
      expect(painted).toContain("draft: typed");
      expect(painted).toContain("invoices: in_9");
    } finally {
      screen.dispose();
    }
  });

  it("resolves an empty result for a key nobody ever answers, and paints anyway", () => {
    const screen = bootTsx(PICKER, {});
    try {
      expect(textsOf(screen.tree())).toEqual(["clients: 0", "draft: ", "loading"]);
      expect(screen.misses().map(({ tool }) => tool)).toEqual(["list_clients", "list_clients"]);
    } finally {
      screen.dispose();
    }
  });
});

/**
 * What a read with no answer YET hands back.
 *
 * The bench caught a screen writing `stages.data` on a query whose input it
 * computed, and the first paint threw `cannot read property 'data' of undefined`
 * before the host ever got to answer it. The trained idiom is react-query's,
 * where `useQuery` always returns an object and only its fields vary — so the
 * engine matches it rather than teaching every screen a guard.
 */
describe("a read with no answer yet", () => {
  const RAW = `
import { useState } from "react";
import { Button, Stack, Text, useQuery } from "@vendo/screen";

export default function Raw() {
  const [chosen, setChosen] = useState("c1");
  const invoices = useQuery("list_clients", { client: chosen });
  const rows = invoices.data;
  return (
    <Stack gap={8}>
      <Text text={"rows: " + String(rows)} />
      <Text text={"or empty: " + (rows ?? []).length} />
      <Text text={"optional: " + String(invoices?.data)} />
      <Button label="pick c2" onClick={() => setChosen("c2")} />
    </Stack>
  );
}
`;

  it("is an object, so reading a field off it paints instead of throwing", () => {
    const screen = bootTsx(RAW, {});
    try {
      expect(textsOf(screen.tree())).toEqual(["rows: undefined", "or empty: 0", "optional: undefined"]);
      expect(screen.misses()).toEqual([{ tool: "list_clients", input: { client: "c1" } }]);
      screen.supply({ [queryKey({ tool: "list_clients", input: { client: "c1" } })]: { data: ["in_1"] } });
      expect(textsOf(screen.tree())).toEqual(["rows: in_1", "or empty: 1", "optional: in_1"]);
    } finally {
      screen.dispose();
    }
  });

  it("is the SAME object every render, so a dependency on a pending read does not churn", () => {
    // One shared value, not a fresh literal per call: a `useMemo`/`useEffect` dep
    // on a read that has not landed would recompute on every paint otherwise.
    const STABLE = `
import { useRef, useState } from "react";
import { Button, Stack, Text, useQuery } from "@vendo/screen";

export default function Stable() {
  const [draft, setDraft] = useState("");
  const invoices = useQuery("list_clients", { client: "c1" });
  const first = useRef(invoices);
  return (
    <Stack gap={8}>
      <Text text={"draft: " + draft} />
      <Text text={"same: " + (first.current === invoices)} />
      <Button label="type" onClick={() => setDraft("typed")} />
    </Stack>
  );
}
`;
    const screen = bootTsx(STABLE, {});
    try {
      screen.fire("h1");
      expect(textsOf(screen.tree())).toEqual(["draft: typed", "same: true"]);
    } finally {
      screen.dispose();
    }
  });
});
