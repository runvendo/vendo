import { CodeBlock as UICodeBlock } from "../../openui.js";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { codeBlockSchema } from "./descriptor.js";

export const CodeBlock = createPrewiredImpl(codeBlockSchema, (p) => (
  <UICodeBlock
    codeString={p.code}
    language={p.language ?? "text"}
  />
));
