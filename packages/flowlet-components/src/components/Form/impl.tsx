import { FormControl, Label, Input, TextArea } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { formSchema } from "./descriptor";
import type { z } from "zod";
import type { formFieldSchema } from "./descriptor";

type FormField = z.infer<typeof formFieldSchema>;

function renderInput(f: FormField) {
  switch (f.type) {
    case "text":
      return <Input type="text" name={f.name} placeholder={f.placeholder} required={f.required} />;
    case "number":
      return <Input type="number" name={f.name} placeholder={f.placeholder} required={f.required} />;
    case "textarea":
      return <TextArea name={f.name} placeholder={f.placeholder} required={f.required} />;
    case "checkbox":
      return <Input type="checkbox" name={f.name} required={f.required} />;
    case "switch":
      return <Input type="checkbox" role="switch" name={f.name} />;
    case "slider":
      return <Input type="range" name={f.name} min={f.min} max={f.max} />;
    case "date":
      return <Input type="date" name={f.name} />;
    case "select":
      return (
        <select name={f.name} disabled>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    case "radio":
      return (
        <div role="radiogroup">
          {f.options.map((o) => (
            <label key={o.value}>
              <input type="radio" name={f.name} value={o.value} disabled />
              {o.label}
            </label>
          ))}
        </div>
      );
    case "toggle":
      return (
        <div role="group">
          {f.options.map((o) => (
            <button key={o.value} type="button" value={o.value} disabled>{o.label}</button>
          ))}
        </div>
      );
  }
}

export const Form = createPrewiredImpl(formSchema, (p) => (
  <form onSubmit={(e) => e.preventDefault()}>
    {p.title ? <h3>{p.title}</h3> : null}
    {p.fields.map((f) => (
      <FormControl key={f.name}>
        <Label htmlFor={f.name}>{f.label}</Label>
        {renderInput(f)}
      </FormControl>
    ))}
    <button type="submit" disabled>{p.submitLabel}</button>
  </form>
));
