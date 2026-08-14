// @vitest-environment jsdom
/**
 * The interactive bridge, end to end: a component-screen payload in, a LIVE
 * screen on the page.
 *
 * Nothing is stubbed on either side of the seam. The screen is real TSX,
 * compiled with the compiler this package already ships (sucrase, the jail's own
 * transform) into the CommonJS the VM hosts; the engine is the real
 * `@vendoai/apps/contract` — a QuickJS VM running the vendored Preact; the served
 * tree is that engine's own first paint, flattened the way the server flattens
 * it; and the Kit controls are the real ones. The only double is the host's
 * `onAction`, which is the host's half by definition.
 *
 * That matters because both halves of this feature were written against each
 * other: the engine emits `{$handler}` props and a flat tree, and this package is
 * the only thing that reads them. A suite where each side mocked the other could
 * never disagree.
 *
 * ONE EVENT, THEN WAIT. The VM boots asynchronously behind the served paint, and
 * a click that lands in that window is HELD and delivered on boot — so every test
 * below fires exactly one event and then waits for what it caused. Firing inside
 * a `waitFor` retry loop would deliver the event again on every retry.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { transform } from "sucrase";
import { bootScreen, flattenTree, warmScreenEngine } from "@vendoai/apps/contract";
import { VENDO_TREE_FORMAT, type Json, type ToolOutcome, type UIPayload } from "@vendoai/core";
import { PayloadView } from "../../src/tree/index.js";

afterEach(cleanup);

/** The engine's WebAssembly loads once; the bridge awaits the same warm-up in its
 *  own boot, and warming here keeps the tests off that one-time cost. */
beforeAll(async () => {
  await warmScreenEngine();
}, 30_000);

/** The screen as the VM receives it: the jail's transform with the AUTOMATIC jsx
 *  runtime, because the VM publishes `react/jsx-runtime` and has no `React`
 *  global — the same shape the server's esbuild `format: "cjs"` produces. */
const compile = (tsx: string): string =>
  transform(tsx, { transforms: ["typescript", "jsx", "imports"], production: true, jsxRuntime: "automatic" }).code;

const CATALOG = ["Stack", "Row", "Card", "Text", "Money", "Button", "Input", "Callout", "Accordion", "EnumBadge"];

/** The payload the server serves: the screen's FIRST paint, flattened, plus the
 *  interactive half that can produce the next one — built by the engine itself,
 *  exactly as the save-time gauntlet builds it. */
const payloadFor = (
  compiledSource: string,
  queries: Record<string, unknown>,
  queryPlan?: Array<{ tool: string; input?: Json }>,
): UIPayload => {
  const first = bootScreen({ compiledSource, queries, catalog: CATALOG, now: Date.UTC(2026, 1, 1) });
  try {
    const flat = flattenTree(first.tree());
    return {
      formatVersion: VENDO_TREE_FORMAT,
      root: flat.root,
      nodes: Object.values(flat.nodes),
      interactive: { compiledSource, queries, ...(queryPlan === undefined ? {} : { queryPlan }) },
    } as unknown as UIPayload;
  } finally {
    first.dispose();
  }
};

const TRANSFERS = `
import { useState } from "react";
import { Button, Card, Input, Money, Row, Stack, Text, tools, useQuery } from "@vendo/screen";

export default function PendingTransfers() {
  const pending = useQuery("list_pending");
  const [note, setNote] = useState("");
  return (
    <Stack gap={12}>
      <Text text={"Pending: " + pending.data.length} />
      <Input label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
      <Text text={"note: " + note} />
      {pending.data.map((row) => (
        <Card key={row.id} title={row.recipient}>
          <Money amount={row.amount_cents / 100} />
          <Button label={"Cancel " + row.recipient} onClick={async () => {
            await tools.cancel_transfer({ id: row.id });
            setNote("cancelled " + row.recipient);
          }} />
        </Card>
      ))}
    </Stack>
  );
}
`;

const ROWS = [
  { id: "tr_1", recipient: "Ada", amount_cents: 4_200 },
  { id: "tr_2", recipient: "Bob", amount_cents: 900 },
];

interface Call {
  nodeId: string;
  action: string;
  payload?: Json;
}

/** The host's action pipe, with a log — the renderer's own `onAction` contract. */
const hostPipe = (answer: (call: Call) => ToolOutcome | Promise<ToolOutcome>) => {
  const calls: Call[] = [];
  return {
    calls,
    onAction: async (call: Call): Promise<ToolOutcome> => {
      calls.push(call);
      return answer(call);
    },
    of: (action: string): Call[] => calls.filter((call) => call.action === action),
  };
};

const ok = (output: unknown): ToolOutcome => ({ status: "ok", output: output as Json });

/** The screen's own mirror of what it thinks is in the box. */
const noteText = (): string => screen.getByText(/^note:/u).textContent ?? "";

const transfersView = (
  host: { onAction: (call: Call) => Promise<ToolOutcome> },
  queryPlan?: Array<{ tool: string; input?: Json }>,
) => render(
  <PayloadView
    payload={payloadFor(compile(TRANSFERS), { list_pending: { data: ROWS } }, queryPlan)}
    components={{}}
    onAction={host.onAction}
  />,
);

describe("a component screen on the page", () => {
  it("paints the served tree at once and boots the VM behind it", async () => {
    const host = hostPipe(() => ok(null));
    transfersView(host);

    // Synchronously, before any await: the served paint is on screen, so an
    // interactive screen is never slower to appear than a static one.
    expect(screen.getByText("Pending: 2")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel Ada" })).toBeTruthy();
    expect(screen.getByLabelText("Note")).toBeTruthy();
    expect(host.calls).toEqual([]);

    // …and the same tree is a live screen the moment the VM is up. This keystroke
    // may land before that, in which case it is held and delivered on boot.
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "typed" } });
    await waitFor(() => expect(noteText()).toBe("note: typed"));
  });

  it("round-trips a controlled input through the VM on every keystroke", async () => {
    // The screen NORMALIZES what it is given, which is the only way to see who
    // owns the box: a controlled input shows the screen's value, an uncontrolled
    // one shows the characters the DOM collected.
    const compiled = compile(`
import { useState } from "react";
import { Input, Stack, Text } from "@vendo/screen";

export default function Reference() {
  const [code, setCode] = useState("");
  return (
    <Stack>
      <Input label="Reference" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      <Text text={"code: " + code} />
    </Stack>
  );
}`);
    const host = hostPipe(() => ok(null));
    render(<PayloadView payload={payloadFor(compiled, {})} components={{}} onAction={host.onAction} />);
    const input = screen.getByLabelText("Reference") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "inv-14" } });
    await waitFor(() => expect(screen.getByText("code: INV-14")).toBeTruthy());
    // The keystroke went to the VM, the VM re-rendered, and the box shows what the
    // SCREEN says it holds. Left uncontrolled, the box would still read "inv-14"
    // and the two would disagree about what is in it.
    expect(input.value).toBe("INV-14");

    fireEvent.change(input, { target: { value: "INV-14b" } });
    expect(screen.getByText("code: INV-14B")).toBeTruthy();
    expect(input.value).toBe("INV-14B");
    // Nothing reached the host: a keystroke is the screen's own business.
    expect(host.calls).toEqual([]);
  });

  it("routes a handler's tool call through the host pipe, then re-reads and re-boots", async () => {
    let rows = [...ROWS];
    const host = hostPipe((call) => {
      if (call.action !== "cancel_transfer") return ok({ data: rows });
      rows = rows.filter((row) => row.id !== (call.payload as { id: string }).id);
      return ok({ cancelled: true });
    });
    transfersView(host, [{ tool: "list_pending" }]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Ada" }));

    // The intent went out as an action on the node that fired it — the renderer's
    // existing pipe, so the guard, approvals and per-node notices are the ones
    // already there rather than a second call path.
    await waitFor(() => expect(host.of("cancel_transfer")).toEqual([
      { nodeId: "root.Card:tr_1.1", action: "cancel_transfer", payload: { id: "tr_1" } },
    ]));

    // A successful mutation makes the screen's own data stale, so the served query
    // plan re-runs and the screen re-boots on the answer. That is the whole
    // refresh story: no generated handler hand-patches a list it did not fetch.
    await waitFor(() => expect(screen.getByText("Pending: 1")).toBeTruthy());
    expect(host.of("list_pending")).toHaveLength(1);
    expect(screen.queryByText("Ada")).toBeNull();
    expect(screen.getByText("Bob")).toBeTruthy();
    // The re-boot starts from the source's own initial state — the accepted cost
    // of never showing a row that is no longer there.
    expect(noteText()).toBe("note: ");
  });

  it("drops the second click while the first is in flight, and disables the control", async () => {
    let release: (() => void) | undefined;
    const host = hostPipe(async (call) => {
      if (call.action !== "cancel_transfer") return ok({ data: ROWS });
      await new Promise<void>((resolve) => { release = resolve; });
      return ok({ cancelled: true });
    });
    transfersView(host, [{ tool: "list_pending" }]);
    const cancel = () => screen.getByRole("button", { name: "Cancel Ada" }) as HTMLButtonElement;

    fireEvent.click(cancel());
    await waitFor(() => expect(host.of("cancel_transfer")).toHaveLength(1));

    // The control renders disabled while its intent is out…
    await waitFor(() => expect(cancel().disabled).toBe(true));
    fireEvent.click(cancel());
    expect(host.of("cancel_transfer")).toHaveLength(1);

    release?.();
    // …and it stays disabled through the refresh, not merely through the call:
    // re-arming over data already known to be stale is the same hole with one
    // extra step in it.
    await waitFor(() => expect(host.of("list_pending")).toHaveLength(1));
    await waitFor(() => expect(cancel().disabled).toBe(false));

    // Rapid fire is dropped BEFORE that render, too — two clicks in one tick,
    // which is the hole a greyed-out button alone does not close: the second
    // click happens while the render that would have disabled it is still
    // pending.
    const button = cancel();
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.of("cancel_transfer")).toHaveLength(2);
    release?.();
    await waitFor(() => expect(host.of("list_pending")).toHaveLength(2));
  });

  it("queues ONE more read when a second mutation settles mid-refresh", async () => {
    let rows = [...ROWS];
    const held: Array<() => void> = [];
    const host = hostPipe(async (call) => {
      if (call.action !== "list_pending") {
        rows = rows.filter((row) => row.id !== (call.payload as { id: string }).id);
        return ok({ cancelled: true });
      }
      // Hold every read open, so the second mutation lands while the first
      // refresh is still out.
      await new Promise<void>((resolve) => held.push(resolve));
      return ok({ data: rows });
    });
    transfersView(host, [{ tool: "list_pending" }]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Ada" }));
    await waitFor(() => expect(host.of("list_pending")).toHaveLength(1));

    // A different button, so single-flight does not speak for this: its mutation
    // succeeds while the first refresh is mid-flight.
    fireEvent.click(screen.getByRole("button", { name: "Cancel Bob" }));
    await waitFor(() => expect(host.of("cancel_transfer")).toHaveLength(2));
    // Its handler ran to the end (it sets this after the await), so the refresh
    // decision has been made — and it QUEUED rather than starting a second set of
    // reads against the first.
    await waitFor(() => expect(noteText()).toBe("note: cancelled Bob"));
    expect(host.of("list_pending")).toHaveLength(1);

    held.shift()?.();
    // One more cycle, not a second set of reads racing the first.
    await waitFor(() => expect(host.of("list_pending")).toHaveLength(2));
    held.shift()?.();
    await waitFor(() => expect(screen.getByText("Pending: 0")).toBeTruthy());
    expect(host.of("list_pending")).toHaveLength(2);
  });

  it("keeps the old screen alive when the re-boot after a refresh cannot paint", async () => {
    const host = hostPipe((call) => call.action === "list_pending"
      // The read failed, so that query's key is absent and this screen — which
      // maps over `pending.data` — cannot render the answer at all.
      ? { status: "error", error: { code: "ledger", message: "the ledger is down" } }
      : ok({ cancelled: true }));
    transfersView(host, [{ tool: "list_pending" }]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Ada" }));
    await waitFor(() => expect(host.of("list_pending")).toHaveLength(1));

    // Boot BEFORE dispose: the screen the re-boot would have replaced is still
    // there, still interactive, showing the tree it already had.
    // The engine's own sentence about the screen it could not boot — the read
    // failed, so that query's key is simply absent from the fresh answer.
    await waitFor(() => expect(screen.getByText(/this screen declared no such query/u)).toBeTruthy());
    expect(screen.getByText("Pending: 2")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "still live" } });
    await waitFor(() => expect(noteText()).toBe("note: still live"));
  });

  it("does not re-read when the tool refused, and re-arms the control", async () => {
    const host = hostPipe((call) => call.action === "cancel_transfer"
      ? { status: "error", error: { code: "bank", message: "the account is closed" } }
      : ok({ data: ROWS }));
    transfersView(host, [{ tool: "list_pending" }]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel Ada" }));

    // The refusal reached the screen's handler as a rejection, and the failure is
    // reported on the node that fired — but nothing changed, so nothing is re-read.
    await waitFor(() => expect(screen.getByText(/the account is closed/u)).toBeTruthy());
    expect(host.of("list_pending")).toEqual([]);
    expect((screen.getByRole("button", { name: "Cancel Ada" }) as HTMLButtonElement).disabled).toBe(false);

    // …and the screen is still the screen: the rest of it still works.
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "still here" } });
    await waitFor(() => expect(noteText()).toBe("note: still here"));
  });

  it("contains a handler that throws inside the VM, and keeps the screen standing", async () => {
    const compiled = compile(`
import { useState } from "react";
import { Button, Stack, Text } from "@vendo/screen";

export default function Broken() {
  const [count, setCount] = useState(0);
  return (
    <Stack>
      <Text text={"clicked " + count} />
      <Button label="Break" onClick={() => { throw new Error("this row is already gone"); }} />
      <Button label="Works" onClick={() => setCount(count + 1)} />
    </Stack>
  );
}`);
    const host = hostPipe(() => ok(null));
    render(<PayloadView payload={payloadFor(compiled, {})} components={{}} onAction={host.onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Break" }));
    await waitFor(() => expect(screen.getByText(/this row is already gone/u)).toBeTruthy());

    // One broken button does not take the screen down.
    expect(screen.getByText("clicked 0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Works" }));
    await waitFor(() => expect(screen.getByText("clicked 1")).toBeTruthy());
  });

  it("says why on the root when the screen cannot boot, and keeps the served paint", async () => {
    const served = payloadFor(compile(TRANSFERS), { list_pending: { data: ROWS } }) as unknown as Record<string, unknown>;
    const host = hostPipe(() => ok(null));

    render(
      <PayloadView
        // The served tree is fine; the source behind it is not a screen at all.
        payload={{ ...served, interactive: { compiledSource: "module.exports = 42;", queries: {} } } as unknown as UIPayload}
        components={{}}
        onAction={host.onAction}
      />,
    );

    await waitFor(() => expect(screen.getByText(/exports no component/u)).toBeTruthy());
    // A screen that cannot boot cannot move — but it is still on screen, rather
    // than the surface quietly ignoring every click from here on.
    expect(screen.getByText("Pending: 2")).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("holds a click that landed while the engine was still loading", async () => {
    const host = hostPipe(() => ok({ cancelled: true }));
    transfersView(host);

    // No wait first: this click lands in the one window where the screen looks
    // ready and isn't. It must be held and delivered, not dropped.
    fireEvent.click(screen.getByRole("button", { name: "Cancel Bob" }));

    await waitFor(() => expect(host.of("cancel_transfer")).toEqual([
      { nodeId: "root.Card:tr_2.1", action: "cancel_transfer", payload: { id: "tr_2" } },
    ]));
  });

  it("keeps the DOM a keyed row owns — a focused input survives a repaint above it", async () => {
    const compiled = compile(`
import { useState } from "react";
import { Button, Card, Input, Stack } from "@vendo/screen";

export default function Rows() {
  const [rows, setRows] = useState([{ id: "b" }, { id: "c" }]);
  const [notes, setNotes] = useState({});
  return (
    <Stack>
      <Button label="Add a row" onClick={() => setRows([{ id: "a" }].concat(rows))} />
      {rows.map((row) => (
        <Card key={row.id} title={"row " + row.id}>
          <Input
            label={"note " + row.id}
            value={notes[row.id] === undefined ? "" : notes[row.id]}
            onChange={(e) => setNotes(Object.assign({}, notes, { [row.id]: e.target.value }))}
          />
        </Card>
      ))}
    </Stack>
  );
}`);
    const host = hostPipe(() => ok(null));
    render(<PayloadView payload={payloadFor(compiled, {})} components={{}} onAction={host.onAction} />);

    fireEvent.change(screen.getByLabelText("note b"), { target: { value: "mine" } });
    await waitFor(() => expect((screen.getByLabelText("note b") as HTMLInputElement).value).toBe("mine"));

    const box = screen.getByLabelText("note b") as HTMLInputElement;
    box.focus();
    expect(document.activeElement).toBe(box);

    fireEvent.click(screen.getByRole("button", { name: "Add a row" }));
    await waitFor(() => expect(screen.getByLabelText("note a")).toBeTruthy());

    // The row's node id came from its KEY, not from its position, so React kept
    // the same element — with the caret still in it and the text still there. Ids
    // from a running counter would have renamed every row below the insert and
    // remounted them, taking the focus and the draft with them.
    expect(screen.getByLabelText("note b")).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("mine");
  });

  it("boots once per screen: a caller that rebuilds its payload every render does not restart it", async () => {
    const compiled = compile(TRANSFERS);
    const host = hostPipe(() => ok(null));
    const payload = () => payloadFor(compiled, { list_pending: { data: ROWS } });
    const view = render(<PayloadView payload={payload()} components={{}} onAction={host.onAction} />);

    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "typed" } });
    await waitFor(() => expect(noteText()).toBe("note: typed"));

    // A fresh payload OBJECT carrying the same compiled source — what a host does
    // on any parent re-render. The boot's identity is the source string, so
    // nothing re-boots and nothing the user typed is discarded.
    view.rerender(<PayloadView payload={payload()} components={{}} onAction={host.onAction} />);
    expect(noteText()).toBe("note: typed");
    view.rerender(<PayloadView payload={payload()} components={{ Extra: () => null }} onAction={host.onAction} />);
    expect(noteText()).toBe("note: typed");
  });

  it("paints a component's string children as text", async () => {
    // The Kit's own Callout example is written with a string child, so the engine
    // flattens it into a text node of its own kind (`#text`) — the one node in a
    // screen's tree that is not a component anybody registered.
    const compiled = compile(`
import { Callout, Stack } from "@vendo/screen";

export default function Notice() {
  return (
    <Stack>
      <Callout tone="warning" title="Heads up">Three invoices are overdue.</Callout>
    </Stack>
  );
}`);
    const host = hostPipe(() => ok(null));
    render(<PayloadView payload={payloadFor(compiled, {})} components={{}} onAction={host.onAction} />);

    expect(screen.getByText("Heads up")).toBeTruthy();
    expect(screen.getByText("Three invoices are overdue.")).toBeTruthy();
    expect(screen.queryByText(/Unknown component/u)).toBeNull();
  });

  it("renders a Kit element the screen put in a PROP, as that Kit component", async () => {
    // The slot round trip, with nothing stubbed on either side: the VM serializes
    // the element into `content` as `{$element}` data (vm-program.ts `emitValue`),
    // the server's own flatten leaves it inside the prop, and the renderer builds
    // the real EnumBadge back out of it (renderer.tsx `reifyElement`). An object
    // handed to React as a child is the failure this closes.
    const compiled = compile(`
import { Accordion, EnumBadge, useQuery } from "@vendo/screen";

export default function Invoice() {
  const invoice = useQuery("get_invoice");
  return (
    <Accordion
      defaultOpen={[0]}
      items={[{ label: "Status", content: <EnumBadge value={invoice.data.status} tone="warning" /> }]}
    />
  );
}`);
    const host = hostPipe(() => ok(null));
    render(
      <PayloadView
        payload={payloadFor(compiled, { get_invoice: { data: { status: "past_due" } } })}
        components={{}}
        onAction={host.onAction}
      />,
    );

    const badge = screen.getByText("Past due");
    expect(badge.getAttribute("data-kit")).toBe("EnumBadge");
    expect(badge.getAttribute("data-tone")).toBe("warning");
    // The sigil is the renderer's business and never the DOM's.
    expect(document.body.innerHTML).not.toContain("$element");
  });

  it("leaves a payload with no interactive half exactly as static as it was", async () => {
    const { interactive: _none, ...served } = payloadFor(compile(TRANSFERS), { list_pending: { data: ROWS } }) as unknown as Record<string, unknown>;
    const host = hostPipe(() => ok(null));

    render(<PayloadView payload={served as unknown as UIPayload} components={{}} onAction={host.onAction} />);

    // Every payload before component screens: nothing boots, the `{$handler}`
    // props travel as the data they are, and the served paint is the whole story.
    await waitFor(() => expect(screen.getByText("Pending: 2")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Cancel Ada" })).toBeTruthy();
    expect(host.calls).toEqual([]);
    expect(noteText()).toBe("note: ");
  });

  it("contains a click on a control no live screen is behind", async () => {
    const { interactive: _none, ...served } = payloadFor(compile(TRANSFERS), { list_pending: { data: ROWS } }) as unknown as Record<string, unknown>;
    const host = hostPipe(() => ok(null));
    render(<PayloadView payload={served as unknown as UIPayload} components={{}} onAction={host.onAction} />);

    // There is nothing behind this button, so the click does nothing at all — but
    // it must be NOTHING, not a TypeError: a `{$handler}` prop travelling as the
    // plain object it is lands in a callback slot, and `onClick?.()` on an object
    // throws where no error boundary can catch it (kit/forms/button.tsx).
    fireEvent.click(screen.getByRole("button", { name: "Cancel Ada" }));

    expect(host.calls).toEqual([]);
    expect(screen.getByText("Pending: 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel Ada" })).toBeTruthy();
  });
});
