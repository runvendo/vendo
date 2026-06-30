import { MarkDownRenderer } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { markdownSchema } from "./descriptor";

/**
 * Security: MarkDownRenderer wraps react-markdown without rehype-raw or allowDangerousHtml.
 * Raw HTML in markdown input is escaped to text by react-markdown's default sanitisation.
 * No <script> or raw HTML elements are ever injected into the DOM.
 */
export const Markdown = createPrewiredImpl(markdownSchema, (p) => (
  <MarkDownRenderer textMarkdown={p.content} />
));
