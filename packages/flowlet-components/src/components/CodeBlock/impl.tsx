import { CodeBlock as UICodeBlock } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { codeBlockSchema } from "./descriptor";

export const CodeBlock = createPrewiredImpl(codeBlockSchema, (p) => (
  <UICodeBlock
    codeString={p.code}
    language={p.language ?? "text"}
  />
));
