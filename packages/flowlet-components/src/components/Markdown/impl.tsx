import { MarkDownRenderer } from "../../openui";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { markdownSchema } from "./descriptor";
import { flowletUrlTransform } from "../../impl-helpers/safe-url";

/**
 * Security: MarkDownRenderer wraps react-markdown without rehype-raw or allowDangerousHtml.
 * Raw HTML in markdown input is escaped to text by react-markdown's default sanitisation.
 * No <script> or raw HTML elements are ever injected into the DOM.
 *
 * URL policy: `urlTransform` enforces an allowlist on markdown-generated links and images.
 * - Links (href): https and mailto only; javascript:, http:, and bare paths are dropped.
 * - Images (src): safe data:image types only via allowlistUrl (remote/https dropped to
 *   match the sandbox CSP `img-src data:`).
 */
export const Markdown = createPrewiredImpl(markdownSchema, (p) => (
  <MarkDownRenderer
    textMarkdown={p.content}
    options={{ urlTransform: flowletUrlTransform }}
  />
));
