/**
 * The sealed screen engine, run for real: one QuickJS VM, real Preact, real
 * hooks, real re-renders — and DATA coming out.
 *
 * Everything here goes through the production path end to end: the TSX is
 * compiled by the same esbuild call the save-time gauntlet makes, the VM runs the
 * vendored Preact, and the assertions are made on the tree and the intents the
 * engine hands back. Nothing is stubbed, because there is nothing to stub — the
 * screen has no DOM, no network, no clock and no host object.
 *
 * The failure taxonomy lives in ./screen-errors.test.ts and the seal in
 * ./seal.test.ts; this file is what a working screen does.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  isHandlerRef,
  warmScreenEngine,
  type Intent,
} from "../../../../src/contract/genui/component/index.js";
import { bootTsx, handlersOf, nodeOf, textsOf } from "./screen-fixture.test-util.js";

/** Running a screen is synchronous; the WebAssembly behind it loads once. */
beforeAll(async () => {
  await warmScreenEngine();
});

const TRANSFERS = `
import { useState } from "react";
import { Button, Card, Money, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending");
  const [note, setNote] = useState("");
  return (
    <Stack gap={12}>
      <Text text="Transfers waiting to go out" variant="heading" />
      {note === "" ? null : <Text text={note} />}
      {pending.data.map((row) => (
        <Card key={row.id} title={row.recipient}>
          <Money amount={row.amount_cents / 100} />
          <Button label={"Cancel " + row.id} onClick={async () => {
            setNote("cancelling " + row.id);
            const answer = await tools.cancel_transfer({ id: row.id });
            setNote("cancelled: " + JSON.stringify(answer));
          }} />
        </Card>
      ))}
    </Stack>
  );
}
`;

const PENDING = {
  list_pending: {
    data: [
      { id: "tr_1", recipient: "Ada", amount_cents: 4_200 },
      { id: "tr_2", recipient: "Bob", amount_cents: 900 },
    ],
  },
};

const transfers = () => bootTsx(TRANSFERS, PENDING);

describe("bootScreen", () => {
  it("runs the component and hands back the tree it painted, as data", () => {
    const screen = transfers();
    try {
      const tree = screen.tree();

      expect(tree.component).toBe("Stack");
      expect(tree.props).toEqual({ gap: 12 });
      // A component's children are the components it wrote, with the keys it
      // wrote — a component of its own (Card) survives, a fragment and a
      // component wrapper would not, because the host has never heard of them.
      expect(tree.children.map((child) => typeof child === "string" ? child : `${child.component}:${child.key}`))
        .toEqual(["Text:undefined", "Card:tr_1", "Card:tr_2"]);
      // Props are DATA, at the type the component wrote them: a number stays a
      // number (setAttribute would have stringified it), and the arithmetic ran
      // inside the VM.
      expect(nodeOf(tree, "Money")?.props).toEqual({ amount: 42 });
      expect(textsOf(tree)).toEqual(["Transfers waiting to go out"]);
    } finally {
      screen.dispose();
    }
  });

  it("emits a function-valued prop as a handler reference, one per row", () => {
    const screen = transfers();
    try {
      expect(handlersOf(screen.tree())).toEqual(["Cancel tr_1.onClick=h1", "Cancel tr_2.onClick=h2"]);
      // The reference is all that crosses: a function cannot leave the VM. The
      // renderer's own guard is what turns it back into a callback.
      const onClick = nodeOf(screen.tree(), "Button")?.props.onClick;
      expect(isHandlerRef(onClick)).toBe(true);
      expect(isHandlerRef({ $handler: 3 })).toBe(false);
      expect(isHandlerRef({ $action: "pay" })).toBe(false);
      expect(isHandlerRef(null)).toBe(false);
      expect(isHandlerRef("h1")).toBe(false);
    } finally {
      screen.dispose();
    }
  });

  it("paints the same screen over the same data identically, twice", () => {
    const first = transfers();
    const second = transfers();
    try {
      expect(JSON.stringify(first.tree())).toBe(JSON.stringify(second.tree()));
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("carries an element-valued prop through as a nested node", () => {
    // The slot shapes the wire dialect could never express are ordinary in JSX,
    // so a component in a prop has to arrive as a node rather than as `{}`.
    const screen = bootTsx(`
import { Accordion, Text } from "@vendo/screen";
export default function S() {
  return <Accordion items={[{ label: "Terms", content: <Text text="the terms" /> }]} />;
}`);
    try {
      expect(screen.tree().props.items).toEqual([
        { label: "Terms", content: { $element: true, component: "Text", props: { text: "the terms" }, children: [] } },
      ]);
    } finally {
      screen.dispose();
    }
  });

  it("stamps $element on a prop's element, and on no other node", () => {
    // The sigil is the WHOLE difference between a cell slot and a data object on
    // the read side (ui/tree/renderer.tsx binds on it), so it belongs to a prop's
    // element only — a painted node arrives where a node already belongs.
    const screen = bootTsx(`
import { DataTable, EnumBadge, Row, Text } from "@vendo/screen";
export default function S() {
  return (
    <DataTable
      rows={[{ id: "tr_1", status: "in_review" }]}
      columns={[
        { key: "status", cell: <Row gap={4}><EnumBadge field="status" />flagged</Row> },
      ]}
    />
  );
}`);
    try {
      const tree = screen.tree();
      expect(tree.component).toBe("DataTable");
      expect(tree).not.toHaveProperty("$element");
      expect((tree.props.columns as Array<Record<string, unknown>>)[0]).toEqual({
        key: "status",
        cell: {
          $element: true,
          component: "Row",
          props: { gap: 4 },
          // Nested elements are the slot's own children, not further props.
          children: [{ component: "EnumBadge", props: { field: "status" }, children: [] }, "flagged"],
        },
      });
    } finally {
      screen.dispose();
    }
  });

  it("keeps a text run as a string child, and drops what has no data spelling", () => {
    const screen = bootTsx(`
import { Card } from "@vendo/screen";
export default function S() {
  return <Card title="t" description={undefined} tone={Symbol("nope")}>plain text {41 + 1}</Card>;
}`);
    try {
      const tree = screen.tree();
      expect(tree.children).toEqual(["plain text ", "42"]);
      // A prop with no JSON spelling is absent, never `null` or `"Symbol()"`.
      expect(tree.props).toEqual({ title: "t" });
    } finally {
      screen.dispose();
    }
  });
});

describe("fire", () => {
  it("has already landed the handler's state update when it returns", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, Stack, Text } from "@vendo/screen";
export default function S() {
  const [count, setCount] = useState(0);
  return (
    <Stack>
      <Text text={"clicked " + count} />
      <Button label="bump" onClick={() => setCount(count + 1)} />
    </Stack>
  );
}`);
    try {
      expect(textsOf(screen.tree())).toEqual(["clicked 0"]);
      // Synchronous: no awaiting a scheduler, because the engine owns the queue
      // Preact schedules into.
      expect(textsOf(screen.fire("h1").tree)).toEqual(["clicked 1"]);
      expect(textsOf(screen.fire("h1").tree)).toEqual(["clicked 2"]);
      expect(textsOf(screen.tree())).toEqual(["clicked 2"]);
    } finally {
      screen.dispose();
    }
  });

  it("runs a passive effect the update scheduled, in the same turn", () => {
    const screen = bootTsx(`
import { useEffect, useState } from "react";
import { Button, Stack, Text } from "@vendo/screen";
export default function S() {
  const [step, setStep] = useState("idle");
  const [seen, setSeen] = useState("");
  useEffect(() => { setSeen("effect saw " + step); }, [step]);
  return (
    <Stack>
      <Text text={seen} />
      <Button label="go" onClick={() => setStep("clicked")} />
    </Stack>
  );
}`);
    try {
      expect(textsOf(screen.tree())).toEqual(["effect saw idle"]);
      expect(textsOf(screen.fire("h1").tree)).toEqual(["effect saw clicked"]);
    } finally {
      screen.dispose();
    }
  });

  it("delivers the event React-shaped, whatever the host pushed in", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Input, Stack, Text } from "@vendo/screen";
export default function S() {
  const [value, setValue] = useState("");
  const [key, setKey] = useState("none");
  return (
    <Stack>
      <Text text={"value=" + value + " key=" + key} />
      <Input value={value} onChange={(e) => { setValue(String(e.target.value)); setKey(String(e.key)); }} />
    </Stack>
  );
}`);
    try {
      // A bare value IS the value, so a control that reports a string works.
      expect(textsOf(screen.fire("h1", "ada").tree)).toEqual(["value=ada key=undefined"]);
      // A real event bag keeps its own fields alongside `target.value`.
      expect(textsOf(screen.fire("h1", { target: { value: "bob" }, key: "Enter" }).tree))
        .toEqual(["value=bob key=Enter"]);
      // `{ value }` is the shape a Kit control synthesizes.
      expect(textsOf(screen.fire("h1", { value: "cyd" }).tree)).toEqual(["value=cyd key=undefined"]);
      // And a click carries nothing at all.
      expect(textsOf(screen.fire("h1").tree)).toEqual(["value=undefined key=undefined"]);
    } finally {
      screen.dispose();
    }
  });

  it("records a tool call as an intent and leaves the screen showing its working state", () => {
    const screen = transfers();
    try {
      const fired = screen.fire("h1");

      expect(fired.intents).toEqual([{ id: "i1", tool: "cancel_transfer", args: { id: "tr_1" } }]);
      // The handler ran up to the await and its state update painted, so the
      // screen already says what it is doing — nothing left the VM.
      expect(textsOf(fired.tree)).toContain("cancelling tr_1");
      expect(textsOf(screen.tree())).toContain("cancelling tr_1");
    } finally {
      screen.dispose();
    }
  });

  it("names a nested tool the way a host reads it, and carries the first argument", () => {
    const screen = bootTsx(`
import { Button, Stack, tools } from "@vendo/screen";
export default function S() {
  return (
    <Stack>
      <Button label="deep" onClick={() => { tools.transfers.cancel({ id: "tr_9" }); }} />
      <Button label="bare" onClick={() => { tools.ping(); }} />
    </Stack>
  );
}`);
    try {
      expect(screen.fire("h1").intents).toEqual([{ id: "i1", tool: "transfers.cancel", args: { id: "tr_9" } }]);
      expect(screen.fire("h2").intents).toEqual([{ id: "i2", tool: "ping", args: undefined }]);
    } finally {
      screen.dispose();
    }
  });
});

describe("settle", () => {
  const settled = (result: unknown): { texts: string[]; intents: Intent[] } => {
    const screen = transfers();
    try {
      const fired = screen.fire("h1");
      const step = screen.settle(fired.intents[0]?.id ?? "", result);
      if (step === null) throw new Error("expected the settle to move the screen");
      return { texts: textsOf(step.tree), intents: [...step.intents] };
    } finally {
      screen.dispose();
    }
  };

  it("resolves an ok outcome with the OUTPUT alone — the screen never sees an envelope", () => {
    // What a model writes is `const rows = await tools.list()`, and what the
    // typings promise is the tool's own result; the envelope is the host's.
    expect(settled({ status: "ok", output: { cancelled: "tr_1" } }).texts)
      .toContain('cancelled: {"cancelled":"tr_1"}');
  });

  it("resolves a bare value that is not an outcome as itself", () => {
    expect(settled({ cancelled: true }).texts).toContain('cancelled: {"cancelled":true}');
    expect(settled(7).texts).toContain("cancelled: 7");
  });

  it("resolves an answer of `undefined` as null, which a screen can actually read", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, Stack, Text, tools } from "@vendo/screen";
export default function S() {
  const [said, setSaid] = useState("idle");
  return (
    <Stack>
      <Text text={said} />
      <Button label="go" onClick={async () => {
        const answer = await tools.audit();
        setSaid("answer is null: " + (answer === null));
      }} />
    </Stack>
  );
}`);
    try {
      const fired = screen.fire("h1");
      // `undefined` has no JSON, and a screen reading the string "undefined"
      // would be worse than reading nothing.
      const step = screen.settle(fired.intents[0]?.id ?? "", undefined);
      expect(textsOf(step?.tree ?? screen.tree())).toEqual(["answer is null: true"]);
    } finally {
      screen.dispose();
    }
  });

  it("rejects error and blocked with the host's own sentence, for a handler's try/catch", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, Stack, Text, tools } from "@vendo/screen";
export default function S() {
  const [said, setSaid] = useState("idle");
  return (
    <Stack>
      <Text text={said} />
      <Button label="pay" onClick={async () => {
        try { await tools.pay({ id: 1 }); setSaid("paid"); } catch (error) { setSaid("caught: " + error.message); }
      }} />
    </Stack>
  );
}`);
    try {
      const failed = screen.fire("h1");
      expect(textsOf(screen.settle(failed.intents[0]?.id ?? "", {
        status: "error",
        error: { code: "bank", message: "the bank said no" },
      })?.tree ?? screen.tree())).toEqual(["caught: the bank said no"]);

      const blocked = screen.fire("h1");
      expect(textsOf(screen.settle(blocked.intents[0]?.id ?? "", {
        status: "blocked",
        reason: "this deployment does not allow that",
      })?.tree ?? screen.tree())).toEqual(["caught: this deployment does not allow that"]);
    } finally {
      screen.dispose();
    }
  });

  it("stays pending for an approval to collect or a connection to make", () => {
    const screen = transfers();
    try {
      const fired = screen.fire("h1");
      const id = fired.intents[0]?.id ?? "";

      // Not an answer either way: the screen keeps the working state it set, and
      // the call is still awaiting — so the host may settle it again.
      expect(screen.settle(id, { status: "pending-approval", approvalId: "ap_1" })).toBeNull();
      expect(screen.settle(id, { status: "connect-required", connect: { provider: "bank" } })).toBeNull();
      expect(textsOf(screen.tree())).toContain("cancelling tr_1");

      const answered = screen.settle(id, { status: "ok", output: { cancelled: true } });
      expect(textsOf(answered?.tree ?? screen.tree())).toContain('cancelled: {"cancelled":true}');
    } finally {
      screen.dispose();
    }
  });

  it("answers null when the result moved nothing the screen renders", () => {
    const screen = bootTsx(`
import { Button, Stack, Text, tools } from "@vendo/screen";
export default function S() {
  return (
    <Stack>
      <Text text="static" />
      <Button label="log" onClick={async () => { await tools.audit({ seen: true }); }} />
    </Stack>
  );
}`);
    try {
      const fired = screen.fire("h1");
      expect(screen.settle(fired.intents[0]?.id ?? "", { status: "ok", output: null })).toBeNull();
    } finally {
      screen.dispose();
    }
  });

  it("keeps a handler's SECOND tool call an event's, so the chain is recorded", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, Stack, Text, tools } from "@vendo/screen";
export default function S() {
  const [said, setSaid] = useState("idle");
  return (
    <Stack>
      <Text text={said} />
      <Button label="chain" onClick={async () => {
        const account = await tools.find_account({ name: "Ada" });
        const paid = await tools.pay({ account: account });
        setSaid("paid " + JSON.stringify(paid));
      }} />
    </Stack>
  );
}`);
    try {
      const first = screen.fire("h1");
      expect(first.intents).toEqual([{ id: "i1", tool: "find_account", args: { name: "Ada" } }]);

      // The code resuming after the await is still the handler's — a `tools` call
      // there would otherwise read as a render-time call and throw.
      const second = screen.settle("i1", { status: "ok", output: "acct_7" });
      expect(second?.intents).toEqual([{ id: "i2", tool: "pay", args: { account: "acct_7" } }]);

      const done = screen.settle("i2", { status: "ok", output: { ok: true } });
      expect(textsOf(done?.tree ?? screen.tree())).toEqual(['paid {"ok":true}']);
    } finally {
      screen.dispose();
    }
  });
});

describe("handler ids", () => {
  const LIST = `
import { useState } from "react";
import { Button, Card, Stack } from "@vendo/screen";
export default function S() {
  const [rows, setRows] = useState([{ id: "b" }, { id: "c" }]);
  return (
    <Stack>
      <Button label="prepend" onClick={() => setRows([{ id: "a" }, ...rows])} />
      {rows.map((row) => (
        <Card key={row.id} title={row.id}>
          <Button label={"pick " + row.id} onClick={() => setRows(rows)} />
        </Card>
      ))}
    </Stack>
  );
}`;

  it("keeps a keyed row's handler when a row is inserted above it", () => {
    const screen = bootTsx(LIST);
    try {
      expect(handlersOf(screen.tree())).toEqual([
        "prepend.onClick=h1",
        "pick b.onClick=h2",
        "pick c.onClick=h3",
      ]);

      // A click already in flight still names the same handler after the repaint:
      // the id is minted against the structural slot (the row's key), not against
      // a counter that renumbers everything below an insert.
      expect(handlersOf(screen.fire("h1").tree)).toEqual([
        "prepend.onClick=h1",
        "pick a.onClick=h4",
        "pick b.onClick=h2",
        "pick c.onClick=h3",
      ]);
      // And the surviving ids still reach the rows they name.
      expect(screen.fire("h2")).toBeTruthy();
    } finally {
      screen.dispose();
    }
  });

  it("mints nothing new across hundreds of re-renders, and the VM stays inside its heap", () => {
    const screen = bootTsx(`
import { useState } from "react";
import { Button, DataTable, Stack, Text } from "@vendo/screen";
export default function S() {
  const [round, setRound] = useState(0);
  const rows = [];
  for (let index = 0; index < 60; index += 1) rows.push({ id: index, label: "row " + index + " of round " + round });
  return (
    <Stack>
      <Text text={"round " + round} />
      <DataTable rows={rows} />
      <Button label="again" onClick={() => setRound((value) => value + 1)} />
    </Stack>
  );
}`);
    try {
      for (let turn = 0; turn < 400; turn += 1) screen.fire("h1");

      // Two claims in one: the handler drawer is rebuilt per paint against slots
      // that are reused (so ids do not climb with renders), and 400 renders of a
      // 60-row table never approach the VM's 32MB heap — a per-render leak of any
      // size would raise an out-of-memory ScreenError long before here.
      expect(handlersOf(screen.tree())).toEqual(["again.onClick=h1"]);
      expect(textsOf(screen.tree())).toContain("round 400");
    } finally {
      screen.dispose();
    }
  });
});

describe("dispose", () => {
  it("keeps the last paint readable, refuses to move, and is idempotent", () => {
    const screen = transfers();
    const painted = screen.tree();

    screen.dispose();
    screen.dispose();

    // `tree()` is the last paint, already serialized — a surface that unmounted
    // its VM can still show what it was showing.
    expect(screen.tree()).toEqual(painted);
    expect(() => screen.fire("h1")).toThrow(/this screen was disposed/u);
    expect(() => screen.settle("i1", null)).toThrow(/this screen was disposed/u);
  });
});
