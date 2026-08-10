// @vitest-environment jsdom
/**
 * A control whose argument is not there yet is careful, not dead.
 *
 * genbench's probe presses every control on a FRESH page and grades what the
 * press asked the host to do (`genbench/src/probe.ts`); a disabled control is
 * deliberately not a candidate. So a Form over an EMPTY `<Select>` — the
 * no-pending-transfers screen, where `list_transfers` answers `[]` and the
 * screen still shows a pressable "Cancel transfer" — fires
 * `cancel_transfer {}` and reads as a broken wire. Withholding the submit is
 * the honest render of "there is nothing to cancel".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Form } from "../../src/kit/forms/form.js";
import { Input } from "../../src/kit/forms/input.js";
import { Select } from "../../src/kit/forms/select.js";

const submit = (label: string): HTMLButtonElement => screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("Form withholds a submit whose argument cannot exist", () => {
  it("disables the submit when a Select has nothing to choose", () => {
    render(
      <Form onSubmit={() => {}} submitLabel="Cancel transfer">
        <Select label="Transfer to cancel" options={[]} labelField="id" valueField="id" />
      </Form>,
    );
    expect(submit("Cancel transfer").disabled).toBe(true);
  });

  it("still disables it when the only option is a placeholder", () => {
    render(
      <Form onSubmit={() => {}} submitLabel="Cancel transfer">
        <Select label="Transfer" options={[]} placeholder="Choose a transfer" valueField="id" />
      </Form>,
    );
    expect(submit("Cancel transfer").disabled).toBe(true);
  });

  it("keeps the submit live as soon as there is something to choose", () => {
    render(
      <Form onSubmit={() => {}} submitLabel="Cancel transfer">
        <Select label="Transfer" options={[{ id: "tr_1", to: "Ada" }]} labelField="to" valueField="id" />
      </Form>,
    );
    expect(submit("Cancel transfer").disabled).toBe(false);
  });

  // The reading has to be taken after the commit: a query that answers late
  // replaces the options, and a form that stayed disabled through that would be
  // worse than the bug it fixes.
  it("re-enables the submit when the options arrive late", () => {
    const view = render(
      <Form onSubmit={() => {}} submitLabel="Cancel transfer">
        <Select label="Transfer" options={[]} labelField="to" valueField="id" />
      </Form>,
    );
    expect(submit("Cancel transfer").disabled).toBe(true);
    view.rerender(
      <Form onSubmit={() => {}} submitLabel="Cancel transfer">
        <Select label="Transfer" options={[{ id: "tr_1", to: "Ada" }]} labelField="to" valueField="id" />
      </Form>,
    );
    expect(submit("Cancel transfer").disabled).toBe(false);
  });

  // An empty text field is not an absent argument — the person can type one.
  // Only a choice over nothing can never be filled in.
  it("leaves a form of empty text fields pressable", () => {
    render(
      <Form onSubmit={() => {}} submitLabel="Save">
        <Input label="Name" />
      </Form>,
    );
    expect(submit("Save").disabled).toBe(false);
  });
});
