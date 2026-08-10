// @vitest-environment jsdom
/**
 * The SEAM for "a form's fields ARE the submit tool's arguments": a real
 * `.vendo` document through the real wire compiler, converted by the real
 * payload converter, rendered by the real renderer, and pressed — then the
 * arguments the action actually received.
 *
 * Nothing here is stubbed on either side, because the defect this pins lived
 * exactly in the gap between them: the Kit's fields carried no `name` and
 * `Form` handed the bound action nothing, so `<Form onSubmit="cancel_transfer">`
 * over a `<Select>` of a query's rows called the tool with `{}` — measured as
 * the whole of one benchmark's `wiredActions` failures
 * (`missing required argument "id"`, 7 of 7).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Json, ToolOutcome, UIPayload } from "@vendoai/core";
import { compileWire } from "@vendoai/apps/contract";
import { TreeView } from "../../src/tree/index.js";
import { convertPayload } from "../../src/tree/convert-payload.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ok = async (): Promise<ToolOutcome> => ({ status: "ok", output: null });

const transfers: Json = {
  data: [
    { id: "tr_1", to: "Alex Rivera", amount: 25_000, status: "pending" },
    { id: "tr_2", to: "Jordan Avery", amount: 6_000, status: "pending" },
  ],
};

/** Compile a document the way the product does, then walk it. */
function mount(document: string, data: Record<string, Json>) {
  const compiled = compileWire(document);
  expect(compiled.issues).toEqual([]);
  const converted = convertPayload(compiled.tree as unknown as UIPayload);
  if (!converted.ok) throw new Error(converted.error.message);
  const onAction = vi.fn(ok);
  render(<TreeView tree={converted.tree} components={{}} data={data} onAction={onAction} />);
  return onAction;
}

describe("a Kit Form's fields are the submit tool's arguments", () => {
  it("sends the chosen row's own id, straight off the query, with no island", async () => {
    const onAction = mount(
      `<App name="Cancel a transfer">
        <Query id="transfers" tool="list_transfers"/>
        <Form onSubmit="cancel_transfer" submitLabel="Cancel transfer">
          <Select name="id" label="Transfer" options={transfers.data} labelField="to" valueField="id"/>
        </Form>
      </App>`,
      { transfers },
    );

    // The person picks the second transfer; the argument is THAT row's id.
    fireEvent.change(screen.getByLabelText("Transfer"), { target: { value: "tr_2" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      action: "cancel_transfer",
      payload: { id: "tr_2" },
    });
  });

  it("defaults to the first option, so an untouched select still names a real row", async () => {
    const onAction = mount(
      `<App name="Cancel a transfer">
        <Query id="transfers" tool="list_transfers"/>
        <Form onSubmit="cancel_transfer" submitLabel="Cancel transfer">
          <Select name="id" label="Transfer" options={transfers.data} labelField="to" valueField="id"/>
        </Form>
      </App>`,
      { transfers },
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({ payload: { id: "tr_1" } });
  });

  it("types each field by its control: text, number, checkbox, date", async () => {
    const onAction = mount(
      `<App name="New note">
        <Form onSubmit="add_note" submitLabel="Save">
          <Input name="title" label="Title"/>
          <Input name="points" label="Points" type="number"/>
          <Textarea name="body" label="Body"/>
          <Checkbox name="pinned" label="Pin it"/>
          <DatePicker name="dueDate" label="Due"/>
        </Form>
      </App>`,
      {},
    );

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Ship it" } });
    fireEvent.change(screen.getByLabelText("Points"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "the details" } });
    fireEvent.click(screen.getByLabelText("Pin it"));
    fireEvent.change(screen.getByLabelText("Due"), { target: { value: "2026-08-14" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      action: "add_note",
      payload: { title: "Ship it", points: 5, body: "the details", pinned: true, dueDate: "2026-08-14" },
    });
  });

  it("leaves an empty field OUT rather than sending it blank, and still answers unchecked", async () => {
    const onAction = mount(
      `<App name="New note">
        <Form onSubmit="add_note" submitLabel="Save">
          <Input name="title" label="Title"/>
          <Textarea name="body" label="Body"/>
          <Checkbox name="pinned" label="Pin it"/>
        </Form>
      </App>`,
      {},
    );

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Ship it" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    // An untouched text field is not an empty answer — it is no answer, so the
    // tool refuses instead of acting on a blank. Unchecked IS an answer.
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({ payload: { title: "Ship it", pinned: false } });
    expect((onAction.mock.calls[0]?.[0] as { payload: Record<string, Json> }).payload).not.toHaveProperty("body");
  });

  it("leaves the call exactly as before when no field is named", async () => {
    const onAction = mount(
      `<App name="Cancel a transfer">
        <Query id="transfers" tool="list_transfers"/>
        <Form onSubmit="cancel_transfer" submitLabel="Cancel transfer">
          <Select label="Transfer" options={transfers.data} labelField="to" valueField="id"/>
        </Form>
      </App>`,
      { transfers },
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledOnce());
    // Not even an empty `{}`: an unnamed form contributes nothing, so the call
    // is byte-identical to the one this document made before fields existed.
    expect(onAction.mock.calls[0]?.[0]).not.toHaveProperty("payload");
  });

  it("does not read a Select's change value or a Button's click as a payload", async () => {
    const onAction = mount(
      `<App name="Search">
        <Query id="transfers" tool="list_transfers"/>
        <Select name="id" label="Transfer" options={transfers.data} valueField="id" onChange="host_pick"/>
        <Button label="Remind all" onClick="send_reminders"/>
      </App>`,
      { transfers },
    );

    fireEvent.change(screen.getByLabelText("Transfer"), { target: { value: "tr_2" } });
    fireEvent.click(screen.getByRole("button", { name: "Remind all" }));

    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
    for (const call of onAction.mock.calls) expect(call[0]).not.toHaveProperty("payload");
  });
});
