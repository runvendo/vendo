// @vitest-environment jsdom
/**
 * The `{$handler}` bridge's Kit half — the mark that tells a control its change
 * handler belongs to a LIVE screen rather than to a one-shot host action.
 *
 * The two want opposite behaviour, which is the whole reason the mark exists: an
 * action handler leaves the DOM owning the text (`defaultValue`, report the value
 * on change), while a screen handler owns the value itself and re-renders it on
 * every keystroke — so that control has to be CONTROLLED, or the box and the
 * screen disagree about what is in it. Every assertion below is made through a
 * real Kit control, because "controlled" is a claim about the DOM.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  controlledHandler,
  isHandlerCallback,
  markHandlerCallback,
  screenEvent,
} from "../../src/kit/handler.js";
import { Checkbox } from "../../src/kit/forms/checkbox.js";
import { Form } from "../../src/kit/forms/form.js";
import { Input } from "../../src/kit/forms/input.js";
import { Select } from "../../src/kit/forms/select.js";
import { Textarea } from "../../src/kit/forms/textarea.js";

describe("the mark", () => {
  it("tells a renderer-bound screen handler apart from any other onChange", () => {
    const plain = vi.fn();
    const bound = markHandlerCallback(vi.fn());

    expect(isHandlerCallback(plain)).toBe(false);
    expect(isHandlerCallback(bound)).toBe(true);
    // A control receives all sorts of things in that slot; only a function the
    // renderer stamped is a screen's.
    for (const value of [undefined, null, "onChange", 3, {}, { $handler: "h1" }, [markHandlerCallback(vi.fn())]]) {
      expect(isHandlerCallback(value)).toBe(false);
    }
  });

  it("stamps in place, so the callback the renderer built is the one that runs", () => {
    const inner = vi.fn();
    const bound = markHandlerCallback(inner);

    expect(bound).toBe(inner);
    bound("ada");
    expect(inner).toHaveBeenCalledWith("ada");
  });
});

describe("controlledHandler", () => {
  it("is the controlled decision, and it takes BOTH halves", () => {
    const bound = markHandlerCallback(vi.fn());
    const plain = vi.fn();

    expect(controlledHandler(true, bound)).toBe(bound);
    // A screen handler with nothing to render is not controlled: there is no
    // value to put in the box.
    expect(controlledHandler(false, bound)).toBeNull();
    // A host action keeps the uncontrolled DOM it has today, value or not.
    expect(controlledHandler(true, plain)).toBeNull();
    expect(controlledHandler(false, plain)).toBeNull();
    expect(controlledHandler(true, undefined)).toBeNull();
  });
});

describe("a Kit control with a screen handler", () => {
  it("hands a text field's keystroke over as an event, and keeps the screen's value in the box", () => {
    const fire = markHandlerCallback(vi.fn());
    render(<Input label="Note" value="from the screen" onChange={fire} />);
    const box = screen.getByLabelText("Note") as HTMLInputElement;

    expect(box.value).toBe("from the screen");
    fireEvent.change(box, { target: { value: "typed" } });

    // The event shape is what a screen's own `onChange={(e) => …e.target.value}`
    // was written against.
    expect(fire).toHaveBeenCalledWith({ target: { value: "typed" } });
    // Controlled: nothing re-rendered the screen here, so the box still shows
    // what the SCREEN says it holds rather than what the DOM collected.
    expect(box.value).toBe("from the screen");
  });

  it("reports a checkbox as checked-ness, and a textarea as text", () => {
    const box = markHandlerCallback(vi.fn());
    const area = markHandlerCallback(vi.fn());
    render(
      <>
        <Checkbox label="Include paid" checked={false} onChange={box} />
        <Textarea label="Why" value="because" onChange={area} />
      </>,
    );

    fireEvent.click(screen.getByLabelText("Include paid"));
    expect(box).toHaveBeenCalledWith({ target: { checked: true } });
    expect((screen.getByLabelText("Include paid") as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByLabelText("Why"), { target: { value: "rewritten" } });
    expect(area).toHaveBeenCalledWith({ target: { value: "rewritten" } });
    expect((screen.getByLabelText("Why") as HTMLTextAreaElement).value).toBe("because");
  });

  it("controls a single Select, and leaves a multiple one to the DOM", () => {
    const one = markHandlerCallback(vi.fn());
    const many = markHandlerCallback(vi.fn());
    render(
      <>
        <Select label="Account" value="c2" options={["c1", "c2"]} onChange={one} />
        <Select label="Accounts" multiple options={["c1", "c2"]} onChange={many} />
      </>,
    );

    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "c1" } });
    expect(one).toHaveBeenCalledWith({ target: { value: "c1" } });
    expect((screen.getByLabelText("Account") as HTMLSelectElement).value).toBe("c2");

    // A multi-select's value is a LIST, which one `value` string cannot express,
    // so it keeps the uncontrolled DOM — and its screen handler is handed the
    // list, which is plain data and crosses into the VM as it is.
    const many_options = screen.getByLabelText("Accounts") as HTMLSelectElement;
    for (const option of many_options.options) option.selected = true;
    fireEvent.change(many_options);
    expect(many).toHaveBeenCalledWith(["c1", "c2"]);
  });
});

describe("a Kit control with a host action", () => {
  it("keeps the uncontrolled DOM, and reports the bare value", () => {
    const onChange = vi.fn();
    render(<Input label="Search" value="start" onChange={onChange} />);
    const box = screen.getByLabelText("Search") as HTMLInputElement;

    fireEvent.change(box, { target: { value: "typed" } });

    // Every pre-screen payload stays byte-identical: the value is a default, the
    // DOM owns the text, and the handler is told the new value.
    expect(onChange).toHaveBeenCalledWith("typed");
    expect(box.value).toBe("typed");
  });

  it("reports a checkbox's new checked-ness the same way", () => {
    const onChange = vi.fn();
    render(<Checkbox label="Include paid" checked={false} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("Include paid"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect((screen.getByLabelText("Include paid") as HTMLInputElement).checked).toBe(true);
  });

  it("leaves a screen handler with no value uncontrolled", () => {
    const fire = markHandlerCallback(vi.fn());
    render(<Input label="Note" onChange={fire} />);
    const box = screen.getByLabelText("Note") as HTMLInputElement;

    fireEvent.change(box, { target: { value: "typed" } });
    // No `value` to render, so there is nothing to control — the handler is told
    // the bare value, the DOM keeps the text.
    expect(fire).toHaveBeenCalledWith("typed");
    expect(box.value).toBe("typed");
  });
});

describe("screenEvent", () => {
  it("passes plain data through untouched — the VM can hold all of it", () => {
    const bag = { target: { value: "ada" } };

    expect(screenEvent(bag)).toBe(bag);
    expect(screenEvent("ada")).toBe("ada");
    expect(screenEvent(42)).toBe(42);
    expect(screenEvent(true)).toBe(true);
    expect(screenEvent(null)).toBeNull();
    expect(screenEvent(undefined)).toBeUndefined();
    const list = ["a", "b"];
    expect(screenEvent(list)).toBe(list);
  });

  it("projects a real DOM event down to the two fields a handler reads", () => {
    // `Form`'s onSubmit is the exception: it carries the DOM event, whose `target`
    // is a live element. Only plain data crosses into a screen, so a host object
    // must be projected rather than fail the crossing.
    let submitted: unknown;
    const view = render(
      <Form onSubmit={(event) => { submitted = screenEvent(event); }} submitLabel="Save">
        <Input label="Name" />
      </Form>,
    );

    fireEvent.submit(view.container.querySelector("form") as HTMLFormElement);

    expect(submitted).toEqual({ target: { value: undefined, checked: undefined } });
    // The projection is DATA: no prototype, no element, nothing that could not be
    // serialized into the VM.
    expect(JSON.stringify(submitted)).toBe("{\"target\":{}}");
  });

  it("answers undefined for a host object with no target at all", () => {
    class Synthetic {
      readonly type = "click";
    }
    expect(screenEvent(new Synthetic())).toBeUndefined();
    expect(screenEvent(new Date())).toBeUndefined();
  });
});
